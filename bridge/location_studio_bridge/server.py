"""Request dispatch for the bridge.

Design rules enforced here:

* every inbound message is validated before it reaches a service;
* mutating device operations are serialised through one lock so two UI actions
  can never fight over the same iPhone;
* a failure in one request never terminates the bridge process;
* events are one-way notifications and are never used to report command success.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import time
from typing import Any, Awaitable, Callable, Optional

from . import __version__, geo
from .device_manager import DeviceManager
from .gpx import build_gpx, parse_gpx
from .protocol import (
    BridgeError,
    ErrorCode,
    ValidationError,
    event as event_envelope,
    failure,
    success,
)
from .simulation import SimulationService
from .tunnel import TunnelManager
from .validation import (
    require_bool,
    optional_number,
    require_number,
    require_string,
    validate_points,
    validate_route_options,
    validate_udid,
)

logger = logging.getLogger(__name__)

PRESENCE_POLL_INTERVAL_S = 3.0


class BridgeServer:
    def __init__(self, *, emit: Callable[[str, Any], Awaitable[None]], log: Callable[[str], None]) -> None:
        self._emit = emit
        self._log = log
        self.tunnels = TunnelManager()
        self.devices = DeviceManager(self.tunnels)
        self.simulation = SimulationService(self.tunnels, emit)
        self._device_lock = asyncio.Lock()
        self._presence_task: Optional[asyncio.Task[None]] = None
        self._presence_signature: Optional[frozenset[tuple[str, str]]] = None
        self._started_at = time.time()
        self._handlers: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = {
            "bridge.health": self._health,
            "bridge.shutdown": self._shutdown,
            "bridge.disconnect": self._disconnect,
            "devices.discover": self._discover,
            "devices.capabilities": self._capabilities,
            "devices.readiness": self._readiness,
            "devices.pair": self._pair,
            "simulation.start": self._simulation_start,
            "simulation.startRoute": self._simulation_start_route,
            "simulation.pause": self._simulation_pause,
            "simulation.resume": self._simulation_resume,
            "simulation.stop": self._simulation_stop,
            "simulation.status": self._simulation_status,
            "simulation.screenshot": self._simulation_screenshot,
            "route.analyze": self._route_analyze,
            "route.importGpx": self._route_import,
            "route.exportGpx": self._route_export,
        }

    # ------------------------------------------------------------- lifecycle

    async def start_background_tasks(self) -> None:
        self._presence_task = asyncio.create_task(self._presence_watcher(), name="presence")

    async def close(self) -> None:
        if self._presence_task is not None:
            self._presence_task.cancel()
            try:
                await self._presence_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._presence_task = None
        await self.simulation.shutdown()
        await self.tunnels.release()

    async def _presence_watcher(self) -> None:
        """Emit device presence changes so the UI can react to cable events."""
        while True:
            try:
                await asyncio.sleep(PRESENCE_POLL_INTERVAL_S)
                from pymobiledevice3 import usbmux

                devices = await asyncio.wait_for(usbmux.list_devices(), timeout=8.0)
                signature = frozenset((device.serial, device.connection_type) for device in devices)
                if signature != self._presence_signature:
                    self._presence_signature = signature
                    await self._emit(
                        "devices.presence",
                        {
                            "devices": [
                                {"deviceId": serial, "connectionType": connection_type}
                                for serial, connection_type in sorted(signature)
                            ],
                            "changedAt": time.time(),
                        },
                    )
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the watcher must never die
                logger.debug("presence poll failed", exc_info=True)

    # ---------------------------------------------------------------- routing

    async def handle(self, message: Any) -> Optional[dict[str, Any]]:
        if not isinstance(message, dict):
            return failure(None, ValidationError("Each request must be a JSON object."))

        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params")

        if not isinstance(method, str) or not method:
            return failure(request_id, ValidationError("'method' is required and must be a non-empty string."))
        if params is not None and not isinstance(params, dict):
            return failure(request_id, ValidationError("'params' must be an object when present."))

        handler = self._handlers.get(method)
        if handler is None:
            return failure(
                request_id,
                BridgeError(
                    ErrorCode.UNKNOWN_METHOD,
                    f"Unknown method: {method}",
                    "Supported methods: " + ", ".join(sorted(self._handlers)),
                ),
            )

        try:
            result = await handler(params or {})
            return success(request_id, result)
        except BridgeError as exc:
            logger.info("request %s failed: %s (%s)", method, exc.message, exc.code)
            return failure(request_id, exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - never let a handler kill the bridge
            logger.exception("unhandled error in %s", method)
            return failure(
                request_id,
                BridgeError(
                    ErrorCode.INTERNAL,
                    "The bridge hit an unexpected error.",
                    f"{type(exc).__name__}: {exc}",
                ),
            )

    # --------------------------------------------------------------- handlers

    async def _health(self, _params: dict[str, Any]) -> dict[str, Any]:
        health = await self.devices.health()
        health["uptimeSeconds"] = round(time.time() - self._started_at, 1)
        health["pid"] = __import__("os").getpid()
        health["totalMemoryHint"] = "Device operations run in this process only."
        return health

    async def _shutdown(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Stop any simulation and close the tunnel, but keep the bridge alive."""
        await self.simulation.shutdown()
        await self.tunnels.release()
        return {"ok": True, "message": "Simulation stopped and tunnel closed.", "tunnel": self.tunnels.status()}

    async def _disconnect(self, _params: dict[str, Any]) -> dict[str, Any]:
        await self.tunnels.release()
        return {"ok": True, "tunnel": self.tunnels.status()}

    async def _discover(self, params: dict[str, Any]) -> dict[str, Any]:
        probe_identity = True
        if "probeIdentity" in params:
            probe_identity = require_bool(params["probeIdentity"], "probeIdentity")
        return await self.devices.discover(probe_identity=probe_identity)

    async def _capabilities(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = params.get("deviceId")
        if device_id is not None:
            device_id = validate_udid(device_id)
        deep = False
        if "deep" in params:
            deep = require_bool(params["deep"], "deep")
        return await self.devices.get_capabilities(device_id, deep=deep)

    async def _readiness(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = validate_udid(params.get("deviceId"))
        open_tunnel = True
        if "openTunnel" in params:
            open_tunnel = require_bool(params["openTunnel"], "openTunnel")
        async with self._device_lock:
            return await self.devices.check_readiness(device_id, open_tunnel=open_tunnel)

    async def _pair(self, params: dict[str, Any]) -> dict[str, Any]:
        """Explicitly start pairing. Only ever reached from a user action in the UI."""
        device_id = validate_udid(params.get("deviceId"))
        timeout = 60.0
        if "timeoutSeconds" in params:
            timeout = require_number(params["timeoutSeconds"], "timeoutSeconds", minimum=10.0, maximum=180.0)

        from pymobiledevice3.exceptions import PairingError
        from pymobiledevice3.lockdown import create_using_usbmux

        async with self._device_lock:
            await self._emit("device.pairing.started", {"deviceId": device_id})
            try:
                client = await asyncio.wait_for(
                    create_using_usbmux(serial=device_id, autopair=True, pair_timeout=timeout),
                    timeout=timeout + 15.0,
                )
            except asyncio.TimeoutError as exc:
                raise BridgeError(
                    ErrorCode.PAIRING_FAILED,
                    "Pairing timed out.",
                    f"No trust confirmation within {timeout:.0f}s.",
                    remedy="Unlock the iPhone, keep it connected, and tap Trust on the prompt.",
                    retryable=True,
                ) from exc
            except Exception as exc:  # noqa: BLE001
                name = type(exc).__name__
                if isinstance(exc, PairingError) or name in {"PairingError", "PasscodeRequiredError", "NotPairedError"}:
                    raise BridgeError(
                        ErrorCode.PAIRING_FAILED,
                        "The iPhone did not accept the pairing request.",
                        f"{name}: {exc}",
                        remedy=(
                            "Unlock the iPhone first. If a Trust prompt appeared, tap Trust and enter the "
                            "passcode. If it never appeared, unplug and replug the cable."
                        ),
                        retryable=True,
                    ) from exc
                raise BridgeError(
                    ErrorCode.PAIRING_FAILED,
                    "Pairing failed before the iPhone responded.",
                    f"{name}: {exc}",
                    remedy="Check the USB cable and confirm the Apple Mobile Device Service is running.",
                    retryable=True,
                ) from exc

            try:
                identity = {
                    "deviceName": await client.get_value(key="DeviceName"),
                    "productType": await client.get_value(key="ProductType"),
                    "productVersion": await client.get_value(key="ProductVersion"),
                    "buildVersion": await client.get_value(key="BuildVersion"),
                }
            finally:
                try:
                    await client.close()
                except Exception:  # noqa: BLE001
                    logger.debug("error closing lockdown client after pairing", exc_info=True)

        await self._emit("device.pairing.completed", {"deviceId": device_id, "identity": identity})
        return {"deviceId": device_id, "paired": True, "identity": identity}

    async def _simulation_start(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = validate_udid(params.get("deviceId"))
        if "coordinate" not in params:
            raise ValidationError("'coordinate' is required.")
        async with self._device_lock:
            result = await self.simulation.start_fixed(device_id, params["coordinate"])
            # The device accepted a simulated coordinate: that is the strongest
            # evidence there is for "this device can be simulated", so the device
            # card is allowed to say so from now on.
            self.devices.record_stages(device_id, simulationReady=True)
            return result

    async def _simulation_start_route(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = validate_udid(params.get("deviceId"))
        if "points" not in params:
            raise ValidationError("'points' is required for a route simulation.")
        async with self._device_lock:
            result = await self.simulation.start_route(device_id, params["points"], params.get("options"))
            self.devices.record_stages(device_id, simulationReady=True)
            return result

    async def _simulation_pause(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = params.get("deviceId")
        return await self.simulation.pause(validate_udid(device_id) if device_id else None)

    async def _simulation_resume(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = params.get("deviceId")
        return await self.simulation.resume(validate_udid(device_id) if device_id else None)

    async def _simulation_stop(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = params.get("deviceId")
        async with self._device_lock:
            return await self.simulation.stop(validate_udid(device_id) if device_id else None)

    async def _simulation_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        return await self.simulation.status()

    async def _simulation_screenshot(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = validate_udid(params.get("deviceId"))
        return await self.simulation.screenshot(device_id)

    async def _route_analyze(self, params: dict[str, Any]) -> dict[str, Any]:
        points = validate_points(params.get("points"), name="points", minimum=1)
        options = validate_route_options(params.get("options"))
        playback = geo.build_playback_points(points, options) if len(points) > 1 else list(points)
        length = geo.route_length_m(points)
        duration = geo.estimated_duration_s(points, options["speedMps"]) if len(points) > 1 else 0.0
        return {
            "waypointCount": len(points),
            "playbackPointCount": len(playback),
            "routeLengthM": round(length, 2),
            "estimatedDurationSeconds": round(duration, 2),
            "speedMps": options["speedMps"],
            "updateRateHz": options["updateRateHz"],
            "interpolate": options["interpolate"],
            "loop": options["loop"],
            "legs": [
                {
                    "fromIndex": index,
                    "toIndex": index + 1,
                    "distanceM": round(geo.haversine_m(points[index], points[index + 1]), 2),
                }
                for index in range(len(points) - 1)
            ],
        }

    async def _route_import(self, params: dict[str, Any]) -> dict[str, Any]:
        file_name = require_string(params.get("fileName", "route.gpx"), "fileName", max_length=200)
        content = params.get("content")
        if not isinstance(content, (str, bytes)):
            raise ValidationError("'content' must be the text of a GPX file.")
        parsed = parse_gpx(content, source_name=file_name)
        return parsed

    async def _route_export(self, params: dict[str, Any]) -> dict[str, Any]:
        points = validate_points(params.get("points"), name="points", minimum=1)
        name = "Location Studio route"
        if "name" in params:
            name = require_string(params["name"], "name", max_length=120)
        altitude = None
        if "altitude" in params:
            altitude = optional_number(params["altitude"], "altitude", minimum=-12000.0, maximum=12000.0)
        speed = None
        if "speedMps" in params:
            speed = optional_number(params["speedMps"], "speedMps", minimum=0.0, maximum=400.0)
        options = None
        if "options" in params:
            options = validate_route_options(params["options"])

        document = build_gpx(points, name=name, altitude=altitude, speed_mps=speed, route_options=options)
        return {
            "fileName": _safe_file_name(name) + ".gpx",
            "content": document,
            "pointCount": len(points),
            "bytes": len(document.encode("utf-8")),
        }


def _safe_file_name(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_ " else "_" for ch in value).strip()
    cleaned = cleaned.replace(" ", "-")
    return (cleaned or "location-studio-route")[:64]


def platform_summary() -> dict[str, str]:
    return {"system": platform.system(), "release": platform.release(), "version": platform.version()}


def bridge_version() -> str:
    return __version__


def event(name: str, data: Any) -> dict[str, Any]:
    return event_envelope(name, data)
