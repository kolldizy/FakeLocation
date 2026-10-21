"""Bridge entry point.

Two modes:

``python -m location_studio_bridge serve``
    Newline-delimited JSON RPC over stdin/stdout. This is what Electron spawns.

``python -m location_studio_bridge <command>``
    Small operator CLI used for hardware acceptance runs, e.g.
    ``discover``, ``readiness``, ``set``, ``route``, ``clear``, ``selfcheck``.

stdout is reserved strictly for the protocol. Any stray ``print`` from a
third-party library is redirected to stderr before it can corrupt a response.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import threading
from typing import Any, Optional

# --- stdout hygiene ---------------------------------------------------------
# Duplicate the real stdout for protocol traffic, then point sys.stdout at stderr
# so that any library print() cannot interleave with JSON responses.
_PROTOCOL_STDOUT = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1, newline="\n")
sys.stdout = sys.stderr

logging.basicConfig(
    level=logging.WARNING,
    stream=sys.stderr,
    format="%(levelname)s %(name)s: %(message)s",
)
for noisy in ("pymobiledevice3", "asyncio", "pmd", "pytcp", "urllib3"):
    logging.getLogger(noisy).setLevel(logging.ERROR)


class StdioTransport:
    """Blocking stdin reader feeding an asyncio queue from a worker thread."""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[Optional[str]]") -> None:
        self._loop = loop
        self._queue = queue
        self._thread = threading.Thread(target=self._read_loop, name="stdin-reader", daemon=True)
        self._closed = False
        self._last_message: Optional[str] = None

    def start(self) -> None:
        self._thread.start()

    def _read_loop(self) -> None:
        try:
            for line in sys.stdin:
                if line.strip():
                    self._last_message = line
                self._loop.call_soon_threadsafe(self._queue.put_nowait, line)
        except Exception:  # noqa: BLE001 - EOF or closed pipe
            pass
        finally:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, None)

    async def lines(self):
        while True:
            line = await self._queue.get()
            if line is None:
                return
            yield line


def write_message(payload: dict[str, Any]) -> None:
    try:
        _PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    except (BrokenPipeError, ValueError):
        # The parent process went away; nothing useful left to do.
        raise SystemExit(0) from None


def log_line(message: str) -> None:
    print(f"[bridge] {message}", file=sys.stderr, flush=True)


async def run_serve() -> int:
    from .server import BridgeServer

    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
    transport = StdioTransport(loop, queue)
    transport.start()

    async def emit(name: str, data: Any) -> None:
        write_message({"type": "event", "event": name, "data": data})

    server = BridgeServer(emit=emit, log=log_line)
    await server.start_background_tasks()
    write_message({"type": "ready", "bridge": "location-studio", "protocol": 1})

    try:
        async for line in transport.lines():
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                write_message(
                    {
                        "type": "response",
                        "id": None,
                        "ok": False,
                        "error": {
                            "code": "INVALID_REQUEST",
                            "message": "The request was not valid JSON.",
                            "details": str(exc),
                            "retryable": False,
                        },
                    }
                )
                continue
            response = await server.handle(message)
            if response is not None:
                write_message(response)
    finally:
        await server.close()
    return 0


# --------------------------------------------------------------------- CLI


def _print(payload: Any) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))


async def cli_discover(_args: argparse.Namespace) -> int:
    from .server import BridgeServer

    server = BridgeServer(emit=_emit_to_stderr, log=log_line)
    try:
        _print(await server._health({}))
        _print(await server.devices.discover())
    finally:
        await server.close()
    return 0


async def cli_readiness(args: argparse.Namespace) -> int:
    from .server import BridgeServer

    server = BridgeServer(emit=_emit_to_stderr, log=log_line)
    try:
        report = await server.devices.check_readiness(args.device)
        _print(report)
        return 0 if report.get("ready") else 1
    finally:
        await server.close()


async def cli_set(args: argparse.Namespace) -> int:
    from .server import BridgeServer

    server = BridgeServer(emit=_emit_to_stderr, log=log_line)
    try:
        result = await server.simulation.start_fixed(args.device, {"lat": args.lat, "lon": args.lon})
        _print(result)
        if args.hold:
            log_line(f"location override active; holding for {args.hold}s (Ctrl+C to stop early)")
            try:
                await asyncio.sleep(args.hold)
            except asyncio.CancelledError:
                pass
        stopped = await server.simulation.stop(args.device)
        _print(stopped)
        return 0 if stopped.get("state") == "stopped" else 1
    finally:
        await server.close()


async def cli_route(args: argparse.Namespace) -> int:
    from .gpx import parse_gpx
    from .server import BridgeServer

    with open(args.file, "r", encoding="utf-8") as handle:
        parsed = parse_gpx(handle.read(), source_name=os.path.basename(args.file))

    events: list[dict[str, Any]] = []

    async def emit(name: str, data: Any) -> None:
        if name.endswith("progress") and args.progress:
            print(
                f"[progress] {data.get('progress', 0):.3f}  {data.get('current')}  "
                f"point {data.get('publishedIndex')}/{data.get('totalPoints')}",
                file=sys.stderr,
                flush=True,
            )
        elif name.endswith("state"):
            print(f"[state] {data.get('state')} :: {data.get('reason')}", file=sys.stderr, flush=True)
            events.append(data)

    server = BridgeServer(emit=emit, log=log_line)
    try:
        options = {"speedMps": args.speed, "updateRateHz": args.rate, "interpolate": True, "loop": False}
        started = await server.simulation.start_route(args.device, parsed["points"], options)
        _print({k: started[k] for k in ("sessionId", "state", "transport", "totalPoints", "routeLengthM")})

        deadline = asyncio.get_running_loop().time() + args.timeout
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.5)
            status = await server.simulation.status()
            session = status.get("session")
            if session is None or session["state"] in {"completed", "failed", "disconnected", "stopped"}:
                break
        else:
            log_line(f"route exceeded {args.timeout:.0f}s; stopping")
            await server.simulation.stop(args.device)

        final = await server.simulation.status()
        _print(final.get("session"))
        session = final.get("session") or {}
        if session.get("state") == "completed":
            log_line("route completed; restoring real GPS")
            await server.simulation.stop(args.device)
            return 0
        return 1 if session else 1
    finally:
        await server.close()


async def _emit_to_stderr(name: str, data: Any) -> None:
    print(f"[event] {name}: {json.dumps(data, default=str)[:400]}", file=sys.stderr, flush=True)


async def cli_clear(args: argparse.Namespace) -> int:
    from .server import BridgeServer

    server = BridgeServer(emit=_emit_to_stderr, log=log_line)
    try:
        result = await server.simulation.stop(args.device)
        _print(result)
        return 0
    except Exception as exc:  # noqa: BLE001
        _print({"cleared": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1
    finally:
        await server.close()


async def cli_wireless(args: argparse.Namespace) -> int:
    """Print what this PC can really reach an iPhone on. Used by the hardware acceptance run."""
    from .server import BridgeServer

    server = BridgeServer(emit=_emit_to_stderr, log=log_line)
    params: dict[str, Any] = {}
    if args.device:
        params["deviceId"] = args.device
    if not args.identity:
        params["probeIdentity"] = False
    if args.connect and not args.device:
        log_line("--connect needs --device <udid> as well")
        return 2
    try:
        report = await server._wireless_probe(params)
        _print(
            {
                "verdict": report["verdict"],
                "host": report["host"],
                "transports": {
                    key: {
                        "available": value["available"],
                        "deviceCount": value["deviceCount"],
                        "note": value["note"],
                        **({"error": value["error"]} if value.get("error") else {}),
                    }
                    for key, value in report["transports"].items()
                },
                "candidates": [
                    {
                        "deviceId": item["deviceId"],
                        "seenOn": item["seenOn"],
                        "reachableOver": item["reachableOver"],
                        "ios": (item.get("identity") or {}).get("productVersion"),
                        "developerMode": (item.get("identity") or {}).get("developerModeEnabled"),
                        "capability": item["capability"],
                        "tunnel": item["tunnel"],
                        "failedProbes": [probe for probe in item["probes"] if probe["ok"] is not True],
                    }
                    for item in report["candidates"]
                ],
                "issues": report["issues"],
            }
        )
        if args.connect:
            _print(await server.devices.connect_transport(args.device, args.connect))
        return 0
    finally:
        await server.close()


async def cli_selfcheck(_args: argparse.Namespace) -> int:
    from . import geo
    from .gpx import build_gpx, parse_gpx
    from .validation import validate_coordinate

    checks: list[dict[str, Any]] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(condition), "detail": detail})

    point = validate_coordinate({"lat": 47.0105, "lon": 28.8638})
    check("coordinate validation", point["lat"] == 47.0105)

    try:
        validate_coordinate({"lat": 91, "lon": 0})
        check("out-of-range latitude rejected", False)
    except Exception:
        check("out-of-range latitude rejected", True)

    distance = geo.haversine_m({"lat": 0, "lon": 0}, {"lat": 0, "lon": 1})
    check("haversine sanity (1 deg at equator ~111 km)", 110000 < distance < 112000, f"{distance:.0f} m")

    track = [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 0.01}]
    length = geo.route_length_m(track)
    check("route length", 1000 < length < 1200, f"{length:.0f} m")
    duration = geo.estimated_duration_s(track, 10.0)
    check("duration at 10 m/s", abs(duration - length / 10.0) < 0.01, f"{duration:.2f} s")

    densified = geo.densify(track, max_segment_m=100.0)
    check("densify produces interpolated points", len(densified) > len(track), f"{len(densified)} points")

    document = build_gpx(track, name="selfcheck")
    reparsed = parse_gpx(document, source_name="selfcheck.gpx")
    check("GPX round trip", len(reparsed["points"]) == 2, json.dumps(reparsed["points"]))

    try:
        parse_gpx('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><gpx>&e;</gpx>')
        check("XXE payload rejected", False)
    except Exception as exc:
        check("XXE payload rejected", True, type(exc).__name__)

    _print({"checks": checks, "ok": all(item["ok"] for item in checks)})
    return 0 if all(item["ok"] for item in checks) else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="location_studio_bridge", description="Location Studio device bridge")
    parser.add_argument("--verbose", action="store_true", help="enable debug logging on stderr")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("serve", help="run the JSON-RPC bridge on stdin/stdout")
    sub.add_parser("selfcheck", help="run offline self-tests (no device needed)")
    sub.add_parser("discover", help="print device discovery information")

    readiness = sub.add_parser("readiness", help="deep readiness check for one device")
    readiness.add_argument("device", help="device UDID")
    readiness.set_defaults(func=cli_readiness)

    set_cmd = sub.add_parser("set", help="apply one simulated coordinate, then restore")
    set_cmd.add_argument("device", help="device UDID")
    set_cmd.add_argument("lat", type=float)
    set_cmd.add_argument("lon", type=float)
    set_cmd.add_argument("--hold", type=float, default=0.0, help="seconds to keep the override before restoring")
    set_cmd.set_defaults(func=cli_set)

    route = sub.add_parser("route", help="replay a GPX file through the device")
    route.add_argument("device", help="device UDID")
    route.add_argument("file", help="path to a GPX file")
    route.add_argument("--speed", type=float, default=15.0, help="metres per second")
    route.add_argument("--rate", type=float, default=5.0, help="location updates per second")
    route.add_argument("--timeout", type=float, default=900.0, help="abort the replay after this many seconds")
    route.add_argument("--progress", action="store_true", help="print each published update to stderr")
    route.set_defaults(func=cli_route)

    clear = sub.add_parser("clear", help="stop simulation and restore real GPS")
    clear.add_argument("device", nargs="?", default=None, help="device UDID (optional)")
    clear.set_defaults(func=cli_clear)

    wireless = sub.add_parser("wireless", help="probe which transports can reach an iPhone")
    wireless.add_argument("--device", default=None, help="limit the identity proof to one UDID")
    wireless.add_argument(
        "--identity",
        action="store_true",
        help="open lockdown on each network entry to prove the Wi-Fi handshake",
    )
    wireless.add_argument("--connect", default=None, help="after probing, connect this transport (usb|wifi-mux|rsd-lan)")
    wireless.set_defaults(func=cli_wireless)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if args.command in (None, "serve"):
        try:
            return asyncio.run(run_serve())
        except KeyboardInterrupt:
            return 0
    if args.command == "selfcheck":
        return asyncio.run(cli_selfcheck(args))
    if args.command == "discover":
        return asyncio.run(cli_discover(args))

    handler = getattr(args, "func", None)
    if handler is None:  # pragma: no cover - argparse guarantees a handler
        parser.print_help()
        return 2
    return asyncio.run(handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
