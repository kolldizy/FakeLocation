"""Hardware acceptance run: drives the shipped bridge against a real iPhone.

This is the *product* path, not a lab experiment: it spawns
``python -m location_studio_bridge serve`` exactly as Electron does, speaks the
same newline-delimited JSON protocol on stdin/stdout, and asserts on the real
answers - including the ones that must refuse to claim success.

Usage (from the project root, with the venv interpreter):

    .venv\\Scripts\\python.exe tools\\acceptance.py
    .venv\\Scripts\\python.exe tools\\acceptance.py --device <UDID> --speed 25 --report docs/reports/hardware-acceptance.json

Exit code 0 only if every check passed. The report is written as JSON so the
result can be quoted in the acceptance record; screenshots are saved next to it
as visual evidence. The simulated location is always released before exit,
including on failure.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time
from typing import Any, Optional

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRIDGE_ROOT = ROOT / "bridge"
FIXTURE = ROOT / "tools" / "fixtures" / "champ-de-mars.gpx"

PARIS = {"lat": 48.8557, "lon": 2.2981}


class BridgeProcess:
    """One bridge child process, spoken to over its stdin/stdout protocol."""

    def __init__(self, python: str, *, verbose: bool = True) -> None:
        env = {
            **os.environ,
            "PYTHONPATH": str(BRIDGE_ROOT),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
        }
        self.stderr_lines: list[str] = []
        self.events: list[dict[str, Any]] = []
        self._responses: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self._ready = threading.Event()
        self._next_id = 1
        self._verbose = verbose
        self.process = subprocess.Popen(
            [python, "-m", "location_studio_bridge", "serve"],
            cwd=str(ROOT),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, name="bridge-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="bridge-stderr", daemon=True).start()

    # --------------------------------------------------------------- plumbing

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.stderr_lines.append(f"[unparsable stdout] {line[:200]}")
                continue
            if message.get("type") == "event":
                self.events.append(message)
            elif message.get("type") == "response":
                self._responses.put(message)
            elif message.get("type") == "ready":
                self._ready.set()

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            line = line.rstrip()
            if not line:
                continue
            self.stderr_lines.append(line)
            if self._verbose:
                print(f"    [bridge] {line}", file=sys.stderr, flush=True)

    def wait_ready(self, timeout: float = 30.0) -> None:
        """The bridge writes a handshake line before it accepts requests."""
        if not self._ready.wait(timeout):
            raise RuntimeError("the bridge did not send its ready handshake")

    def request(self, method: str, params: Optional[dict[str, Any]] = None, *, timeout: float = 150.0) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        payload = {"id": request_id, "method": method, "params": params or {}}
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"{method} did not answer within {timeout:.0f}s")
            try:
                message = self._responses.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(f"{method} did not answer within {timeout:.0f}s") from None
            if message.get("id") == request_id:
                return message

    def stop(self) -> None:
        try:
            if self.process.stdin:
                self.process.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()


class Acceptance:
    def __init__(self, bridge: BridgeProcess, device: str, speed: float, report_dir: pathlib.Path) -> None:
        self.bridge = bridge
        self.device = device
        self.speed = speed
        self.report_dir = report_dir
        self.checks: list[dict[str, Any]] = []
        self.measurements: dict[str, Any] = {}

    # -------------------------------------------------------------- recording

    def check(self, name: str, ok: bool, detail: Any = None) -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        mark = "PASS" if ok else "FAIL"
        print(f"  {mark}  {name}" + (f"  — {detail}" if detail is not None else ""), flush=True)
        return bool(ok)

    def note(self, key: str, value: Any) -> None:
        self.measurements[key] = value

    # ----------------------------------------------------------------- steps

    def step_health(self) -> dict[str, Any]:
        print("\n[1/9] Bridge health", flush=True)
        response = self.bridge.request("bridge.health")
        assert response.get("ok"), response
        health = response["result"]
        self.check(
            "bridge reports its interpreter and library",
            bool(health.get("python", {}).get("version")) and health.get("pymobiledevice3", {}).get("available") is True,
            f"python {health.get('python', {}).get('version')}, pymobiledevice3 {health.get('pymobiledevice3', {}).get('version')}",
        )
        self.check(
            "usbmuxd is reachable",
            health.get("usbmux", {}).get("available") is True,
            health.get("usbmux", {}).get("address"),
        )
        self.check(
            "Apple USB support is present on this PC",
            health.get("appleUsbDrivers", {}).get("ok") is True,
            health.get("appleUsbDrivers", {}).get("note"),
        )
        self.note("health", {k: health.get(k) for k in ("bridgeVersion", "python", "pymobiledevice3", "usbmux", "platform")})
        return health

    def step_discovery(self) -> dict[str, Any]:
        print("\n[2/9] Device discovery", flush=True)
        response = self.bridge.request("devices.discover", {"probeIdentity": True})
        assert response.get("ok"), response
        report = response["result"]
        devices = report.get("devices", [])
        self.check("usbmuxd reports the attached iPhone", len(devices) >= 1, f"{len(devices)} device(s)")
        if not devices:
            return report
        device = devices[0]
        identity = device.get("identity") or {}
        stages = device.get("stages", {})
        self.check(
            "identity is read from the device, not assumed",
            identity.get("productType") is not None and identity.get("productVersion") is not None,
            f"{identity.get('modelName')} ({identity.get('productType')}) · iOS {identity.get('productVersion')} "
            f"build {identity.get('buildVersion')}",
        )
        self.check("the device is paired with this PC", stages.get("paired") is True, device.get("stages"))
        self.check(
            "Developer Mode is read from the device and is on",
            stages.get("developerModeEnabled") is True,
            "iOS requires Developer Mode for the developer services used here",
        )
        self.check(
            "the expected transport is selected for this iOS version",
            bool(device.get("transport", {}).get("planned")),
            f"{device.get('transport', {}).get('planned')} — {device.get('transport', {}).get('rationale', '')}".strip(),
        )
        self.note("identity", identity)
        self.note("transport", device.get("transport"))
        return report

    def step_readiness(self) -> dict[str, Any]:
        print("\n[3/9] Readiness (opens the developer tunnel)", flush=True)
        response = self.bridge.request("devices.readiness", {"deviceId": self.device, "openTunnel": True}, timeout=200.0)
        assert response.get("ok"), response
        report = response["result"]
        for check in report.get("checks", []):
            print(f"        · {check['label']}: {'ok' if check['ok'] is True else check['ok']}", flush=True)
        self.check("readiness is confirmed on hardware", report.get("ready") is True, report.get("summary"))
        self.check(
            "the developer tunnel is up without administrator rights",
            any(c["id"] == "tunnel" and c["ok"] is True for c in report.get("checks", [])),
            next((c.get("detail") for c in report.get("checks", []) if c["id"] == "tunnel"), None),
        )
        self.note("readiness", {"ready": report.get("ready"), "summary": report.get("summary"), "checks": report.get("checks")})
        return report

    def step_fixed(self) -> None:
        print("\n[4/9] Fixed location", flush=True)
        response = self.bridge.request("simulation.start", {"deviceId": self.device, "coordinate": PARIS})
        assert response.get("ok"), response
        session = response["result"]
        self.check(
            "the device acknowledged the first coordinate before 'active' was reported",
            session.get("state") == "active" and session.get("deviceAcknowledged") is True,
            f"transport {session.get('transport')} · state {session.get('state')}",
        )
        self.note("fixed", {k: session.get(k) for k in ("sessionId", "state", "transport", "deviceAcknowledged", "current")})
        time.sleep(2.0)

        screenshot = self._screenshot("fixed-paris")
        if screenshot:
            self.check("device screenshot captured while the override is applied", True, screenshot)

        refusals = self.bridge.request("simulation.pause", {})
        self.check(
            "a fixed location refuses to be 'paused' (nothing can be suspended)",
            refusals.get("ok") is False and refusals.get("error", {}).get("code") == "UNSUPPORTED_OPERATION",
            f"{refusals.get('error', {}).get('code')}: {refusals.get('error', {}).get('message')}",
        )

        response = self.bridge.request("simulation.stop", {"deviceId": self.device})
        assert response.get("ok"), response
        stopped = response["result"]
        self.check(
            "stop clears the override on the device",
            stopped.get("state") == "stopped" and stopped.get("locationOverrideActive") is False,
            f"state {stopped.get('state')}",
        )
        cleared = next((e for e in self.bridge.events if e.get("data", {}).get("reason") == "stopped"), None)
        self.check(
            "the device confirmed the clear",
            bool(cleared) and cleared["data"].get("deviceCleared") is True,
            cleared["data"].get("deviceCleared") if cleared else "no stop event",
        )
        self.note("fixedStop", {"state": stopped.get("state"), "deviceCleared": (cleared or {}).get("data", {}).get("deviceCleared")})

    def step_gpx(self) -> list[dict[str, float]]:
        print("\n[5/9] GPX import, analyse and export round trip", flush=True)
        content = FIXTURE.read_text(encoding="utf-8")
        response = self.bridge.request("route.importGpx", {"fileName": FIXTURE.name, "content": content})
        assert response.get("ok"), response
        parsed = response["result"]
        points = [{"lat": p["lat"], "lon": p["lon"]} for p in parsed["points"]]
        self.check(
            "the GPX fixture parses into waypoints",
            len(points) == 4,
            f"{len(points)} points from {parsed.get('name') or FIXTURE.name}",
        )

        response = self.bridge.request(
            "route.analyze", {"points": points, "options": {"speedMps": self.speed, "updateRateHz": 5}}
        )
        assert response.get("ok"), response
        analysis = response["result"]
        expected_duration = analysis["routeLengthM"] / self.speed
        self.check(
            "route geometry and duration are computed",
            analysis["routeLengthM"] > 0 and abs(analysis["estimatedDurationSeconds"] - expected_duration) < 0.5,
            f"{analysis['routeLengthM']} m, {analysis['playbackPointCount']} playback points, "
            f"{analysis['estimatedDurationSeconds']} s at {self.speed} m/s",
        )
        self.note("analysis", analysis)

        response = self.bridge.request(
            "route.exportGpx", {"points": points, "name": "Acceptance run", "options": {"speedMps": self.speed}}
        )
        assert response.get("ok"), response
        exported = response["result"]
        response = self.bridge.request("route.importGpx", {"fileName": exported["fileName"], "content": exported["content"]})
        assert response.get("ok"), response
        reparsed = response["result"]["points"]
        parity = len(reparsed) == len(points) and all(
            abs(a["lat"] - b["lat"]) < 1e-6 and abs(a["lon"] - b["lon"]) < 1e-6 for a, b in zip(points, reparsed)
        )
        self.check(
            "export -> import returns identical coordinates",
            parity,
            f"{len(reparsed)} points, {exported['bytes']} bytes",
        )
        self.note("gpx", {"points": len(points), "exportBytes": exported["bytes"], "exportFileName": exported["fileName"]})
        return points

    def step_route(self, points: list[dict[str, float]]) -> None:
        print(f"\n[6/9] Route playback at {self.speed} m/s", flush=True)
        response = self.bridge.request(
            "simulation.startRoute",
            {
                "deviceId": self.device,
                "points": points,
                "options": {"speedMps": self.speed, "updateRateHz": 5, "interpolate": True, "loop": False},
            },
        )
        assert response.get("ok"), response
        started = response["result"]
        self.check(
            "route playback starts and the device is 'active' by acknowledgement",
            started.get("state") == "active" and started.get("deviceAcknowledged") is True,
            f"{started.get('totalPoints')} updates over {started.get('routeLengthM')} m "
            f"(estimated {started.get('estimatedDurationSeconds')} s)",
        )

        duplicate = self.bridge.request("simulation.start", {"deviceId": self.device, "coordinate": PARIS})
        self.check(
            "a second session is refused while one is running",
            duplicate.get("ok") is False and duplicate.get("error", {}).get("code") == "SIMULATION_ACTIVE",
            duplicate.get("error", {}).get("code"),
        )

        time.sleep(min(6.0, max(2.0, started.get("estimatedDurationSeconds", 10.0) / 4)))
        self._screenshot("route-in-progress")

        paused = self.bridge.request("simulation.pause", {"deviceId": self.device})
        assert paused.get("ok"), paused
        count_at_pause = paused["result"]["publishedPointCount"]
        self.check(
            "pause is accepted on a running route",
            paused["result"]["state"] == "paused",
            f"{count_at_pause} updates published before the pause",
        )
        time.sleep(3.0)
        status = self.bridge.request("simulation.status")
        still_paused = status["result"]["session"]
        self.check(
            "no coordinate is published while paused",
            still_paused["state"] == "paused" and still_paused["publishedPointCount"] == count_at_pause,
            f"published {still_paused['publishedPointCount']} (was {count_at_pause})",
        )

        resumed = self.bridge.request("simulation.resume", {"deviceId": self.device})
        assert resumed.get("ok"), resumed
        self.check("resume is accepted", resumed["result"]["state"] == "active", resumed["result"]["state"])

        deadline = time.monotonic() + max(90.0, started.get("estimatedDurationSeconds", 30.0) * 3)
        final: dict[str, Any] = {}
        while time.monotonic() < deadline:
            time.sleep(0.5)
            status = self.bridge.request("simulation.status")
            session = status["result"]["session"]
            if session["state"] in {"completed", "failed", "disconnected"}:
                final = session
                break
        self.check(
            "the route completes on the device",
            final.get("state") == "completed",
            f"state {final.get('state')} · published {final.get('publishedPointCount')}/{final.get('totalPoints')}",
        )
        self.check(
            "every interpolated point was published",
            final.get("publishedPointCount") == final.get("totalPoints") - 1,
            f"{final.get('publishedPointCount')} published, {final.get('totalPoints')} points",
        )
        drift = abs(final.get("elapsedSeconds", 0) - final.get("estimatedDurationSeconds", 0))
        self.check(
            "playback pace matches the configured speed",
            drift <= max(2.5, final.get("estimatedDurationSeconds", 0) * 0.15),
            f"elapsed {final.get('elapsedSeconds')} s vs estimated {final.get('estimatedDurationSeconds')} s (Δ {drift:.2f} s)",
        )
        self.check(
            "the device keeps the last coordinate until stop is pressed",
            final.get("locationOverrideActive") is True,
            f"locationOverrideActive={final.get('locationOverrideActive')}",
        )
        self.note("route", {k: final.get(k) for k in (
            "sessionId", "state", "totalPoints", "publishedPointCount", "routeLengthM",
            "estimatedDurationSeconds", "elapsedSeconds", "speedMps", "deviceAcknowledged",
        )})
        self.note("routePause", {"publishedAtPause": count_at_pause, "publishedAfter3s": still_paused["publishedPointCount"]})

        response = self.bridge.request("simulation.stop", {"deviceId": self.device})
        assert response.get("ok"), response
        self.check(
            "stop after a completed route restores real GPS",
            response["result"]["state"] == "stopped" and response["result"]["locationOverrideActive"] is False,
            response["result"]["state"],
        )

    def step_history(self) -> None:
        print("\n[7/9] Session history", flush=True)
        response = self.bridge.request("simulation.status")
        assert response.get("ok"), response
        history = response["result"]["history"]
        self.check(
            "each session appears exactly once in the history",
            len(history) == 2 and len({row["sessionId"] for row in history}) == 2,
            f"{len(history)} row(s): {[row['state'] for row in history]}",
        )
        self.check(
            "history rows carry the final observed state, not the initial one",
            all(row["state"] in {"stopped"} for row in history),
            [row["state"] for row in history],
        )
        self.note("history", history)

    def step_refusals(self) -> None:
        print("\n[8/9] Refusals that must never look like success", flush=True)
        response = self.bridge.request("simulation.start", {"deviceId": self.device, "coordinate": {"lat": 91, "lon": 0}})
        self.check(
            "an out-of-range coordinate is refused before any device call",
            response.get("ok") is False and response.get("error", {}).get("code") == "INVALID_PARAMS",
            response.get("error", {}).get("code"),
        )

        response = self.bridge.request("simulation.start", {"deviceId": "00000000-0000000000000000", "coordinate": PARIS})
        self.check(
            "a start against an absent device fails honestly",
            response.get("ok") is False and response.get("error", {}).get("code") in {
                "DEVICE_NOT_FOUND",
                "DEVICE_DISCONNECTED",
                "NOT_PAIRED",
                "TIMEOUT",
            },
            response.get("error", {}).get("code"),
        )

        response = self.bridge.request("simulation.pause", {})
        self.check(
            "pause without a session reports no active simulation",
            response.get("ok") is False and response.get("error", {}).get("code") == "NO_ACTIVE_SIMULATION",
            response.get("error", {}).get("code"),
        )

        response = self.bridge.request("bridge.health")
        self.check("the bridge is still healthy after the refusals", response.get("ok") is True, "no crash on error paths")

    def step_summary(self) -> None:
        print("\n[9/9] Run summary", flush=True)
        states = [e["data"].get("state") for e in self.bridge.events if e.get("event") == "simulation.state"]
        progress = [e for e in self.bridge.events if e.get("event") == "simulation.progress"]
        self.check(
            "state events were emitted for every transition and progress was reported",
            len(states) >= 6 and len(progress) >= 10,
            f"{len(states)} state events, {len(progress)} progress events",
        )
        self.note("events", {"stateEvents": len(states), "progressEvents": len(progress), "states": states})

    # ------------------------------------------------------------- utilities

    def _capture_to(self, target: pathlib.Path) -> pathlib.Path:
        response = self.bridge.request("simulation.screenshot", {"deviceId": self.device}, timeout=90.0)
        if not response.get("ok"):
            raise RuntimeError(
                f"screenshot failed: {response.get('error', {}).get('code')}: {response.get('error', {}).get('message')}"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(response["result"]["dataUrl"].split(",", 1)[1]))
        print(f"        · screenshot saved to {target} ({target.stat().st_size / 1024:.0f} KB)", flush=True)
        return target

    def _screenshot(self, label: str) -> Optional[str]:
        target = self.report_dir / "evidence" / f"{label}-{time.strftime('%H%M%S')}.png"
        try:
            self._capture_to(target)
        except RuntimeError as exc:
            self.check(f"device screenshot '{label}'", False, str(exc))
            return None
        return f"{target.name} ({target.stat().st_size / 1024:.0f} KB)"


def main() -> int:
    parser = argparse.ArgumentParser(description="Location Studio hardware acceptance run")
    parser.add_argument("--device", default=None, help="device UDID (default: the only attached device)")
    parser.add_argument("--speed", type=float, default=25.0, help="route playback speed in m/s")
    parser.add_argument("--report", default=str(ROOT / "docs" / "reports" / "hardware-acceptance.json"))
    parser.add_argument("--quiet", action="store_true", help="hide bridge stderr")
    parser.add_argument(
        "--screenshot-only",
        metavar="PATH",
        default=None,
        help="skip the checks: apply the fixed coordinate, capture one screenshot to PATH, then restore real GPS",
    )
    args = parser.parse_args()

    # The acceptance log is quoted verbatim in the documentation, so make sure a
    # legacy Windows console cannot fail on a non-ASCII character.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - not a tty
            pass

    report_path = pathlib.Path(args.report)
    report_dir = report_path.parent
    started_at = time.time()

    print("Location Studio — hardware acceptance run", flush=True)
    bridge = BridgeProcess(sys.executable, verbose=not args.quiet)
    acceptance: Optional[Acceptance] = None
    exit_code = 1
    try:
        bridge.wait_ready()

        device = args.device
        if device is None:
            response = bridge.request("devices.discover", {"probeIdentity": False})
            devices = response.get("result", {}).get("devices", []) if response.get("ok") else []
            if not devices:
                print("No iPhone is attached; connect one over USB and retry.", file=sys.stderr)
                return 2
            device = devices[0]["deviceId"]
        print(f"Device under test: {device}", flush=True)

        acceptance = Acceptance(bridge, device, args.speed, report_dir)

        if args.screenshot_only:
            # Focused capture: apply the coordinate, give the phone a moment to
            # redraw, take one screenshot, then always restore real GPS.
            print("Screenshot-only run: applying a fixed coordinate, then restoring.", flush=True)
            response = bridge.request("simulation.start", {"deviceId": device, "coordinate": PARIS})
            if not response.get("ok"):
                raise RuntimeError(f"could not apply the coordinate: {response.get('error')}")
            print(f"  device acknowledged: {response['result'].get('deviceAcknowledged')}", flush=True)
            time.sleep(4.0)
            acceptance._capture_to(pathlib.Path(args.screenshot_only))  # noqa: SLF001 - tool-local helper
            return 0

        health = acceptance.step_health()
        acceptance.step_discovery()
        acceptance.step_readiness()
        acceptance.step_fixed()
        points = acceptance.step_gpx()
        acceptance.step_route(points)
        acceptance.step_history()
        acceptance.step_refusals()
        acceptance.step_summary()

        passed = sum(1 for check in acceptance.checks if check["ok"])
        failed = [check for check in acceptance.checks if not check["ok"]]
        exit_code = 0 if not failed else 1
        print(
            f"\n{passed}/{len(acceptance.checks)} checks passed"
            + (f", {len(failed)} FAILED: " + "; ".join(c["name"] for c in failed) if failed else ""),
            flush=True,
        )

        report = {
            "kind": "hardware-acceptance",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "durationSeconds": round(time.time() - started_at, 1),
            "device": device,
            "speedMps": args.speed,
            "environment": health,
            "checks": acceptance.checks,
            "measurements": acceptance.measurements,
            "bridgeStderrTail": bridge.stderr_lines[-40:],
            "eventCount": len(bridge.events),
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(f"report written to {report_path}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"\nacceptance run aborted: {type(exc).__name__}: {exc}", file=sys.stderr)
        exit_code = 1
    finally:
        # Safety: never leave the phone pinned to a fake location.
        try:
            response = bridge.request("simulation.stop", {}, timeout=60.0)
            print(f"final safety stop: {response.get('ok')} {response.get('error', {}).get('code', '')}".rstrip(), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"final safety stop failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        bridge.stop()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
