"""Device location simulation.

Transport selection
-------------------
* **iOS 17 and newer** - DVT ``com.apple.instruments.server.services.LocationSimulation``
  over the RSD tunnel. The channel is request/response: a returned call means the
  device acknowledged it.
* **iOS 16 and older** - lockdown ``com.apple.dt.simulatelocation``. Writes are
  fire-and-forget, so results for this path are reported with
  ``acknowledged: false`` and are never labelled as hardware-confirmed.

The caller may pin which *medium* a session runs over (USB cable, Wi-Fi mux entry,
direct LAN RemoteServiceDiscovery). Whatever the device answers with is then reported
in the session snapshot, because "the GPS was moved" and "the GPS was moved over
Wi-Fi" are different claims.

What this module will not do
----------------------------
* It never reports an active override that it did not observe.
* It never invents an altitude or speed parameter: the DVT selector takes only
  latitude and longitude, so route movement is produced by publishing
  interpolated coordinates at a configured rate.
* It never keeps a session "active" after the device stopped answering.
* It never offers pause/resume where nothing can be suspended: those verbs apply
  to route playback only, and a fixed location answers ``UNSUPPORTED_OPERATION``.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
import uuid
from typing import Any, Optional

from . import geo
from .protocol import BridgeError, ErrorCode, UnsupportedOperation
from .tunnel import TunnelManager, requires_tunnel
from .validation import validate_coordinate, validate_points, validate_route_options, validate_udid

logger = logging.getLogger(__name__)

LOCKDOWN_TIMEOUT_S = 15.0
DTX_CALL_TIMEOUT_S = 10.0
PROGRESS_EVENT_MIN_INTERVAL_S = 0.25
FIXED_KEEPALIVE_S = 10.0
DEVICE_WATCH_INTERVAL_S = 2.0


class SimulationState:
    IDLE = "idle"
    PREPARING = "preparing"
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"
    DISCONNECTED = "disconnected"


# --------------------------------------------------------------------- targets


class DvtLocationTarget:
    """iOS 17+ transport. Holds the DTX channel open for the whole session."""

    acknowledged = True
    kind = "dvt-rsd"

    def __init__(self, rsd: Any) -> None:
        self._rsd = rsd
        self._provider: Any = None
        self._simulation: Any = None

    async def open(self) -> None:
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

        provider = DvtProvider(self._rsd)
        try:
            await asyncio.wait_for(provider.connect(), timeout=DTX_CALL_TIMEOUT_S * 3)
        except asyncio.TimeoutError as exc:
            raise BridgeError(
                ErrorCode.TIMEOUT,
                "The device did not open the DVT channel in time.",
                "DvtProvider.connect() timed out.",
                remedy="Keep the iPhone unlocked and retry.",
                retryable=True,
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise BridgeError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "The DVT developer service refused the connection.",
                f"{type(exc).__name__}: {exc}",
                remedy=(
                    "Confirm Developer Mode is enabled on the iPhone, then reconnect it on the transport "
                    "this session uses. If this persists, restart the phone."
                ),
                retryable=True,
            ) from exc

        simulation = LocationSimulation(provider)
        await simulation.__aenter__()
        self._provider = provider
        self._simulation = simulation

    async def set(self, latitude: float, longitude: float) -> None:
        if self._simulation is None:
            raise BridgeError(ErrorCode.SERVICE_UNAVAILABLE, "The location service is not open.")
        try:
            await asyncio.wait_for(
                self._simulation.set(latitude, longitude), timeout=DTX_CALL_TIMEOUT_S
            )
        except asyncio.TimeoutError as exc:
            raise BridgeError(
                ErrorCode.TIMEOUT,
                "The device stopped acknowledging location updates.",
                f"simulateLocationWithLatitude:longitude: did not reply within {DTX_CALL_TIMEOUT_S:.0f}s.",
                remedy="Reconnect the iPhone and start a new session.",
                retryable=True,
            ) from exc

    async def clear(self) -> None:
        if self._simulation is None:
            return
        await asyncio.wait_for(self._simulation.clear(), timeout=DTX_CALL_TIMEOUT_S)

    async def close(self) -> None:
        if self._simulation is not None:
            try:
                await self._simulation.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001 - teardown is best effort
                logger.debug("error closing LocationSimulation channel", exc_info=True)
            self._simulation = None
        if self._provider is not None:
            try:
                await self._provider.close()
            except Exception:  # noqa: BLE001
                logger.debug("error closing DvtProvider", exc_info=True)
            self._provider = None


class LegacyLocationTarget:
    """iOS 16 and older transport. Each call opens a short-lived lockdown service."""

    acknowledged = False
    kind = "lockdown-dt-simulatelocation"

    def __init__(self, device_id: str, connection_type: Optional[str] = None) -> None:
        self._device_id = device_id
        self._connection_type = connection_type
        self._client: Any = None

    async def open(self) -> None:
        from pymobiledevice3.lockdown import create_using_usbmux

        self._client = await asyncio.wait_for(
            create_using_usbmux(
                serial=self._device_id, autopair=False, connection_type=self._connection_type
            ),
            timeout=LOCKDOWN_TIMEOUT_S,
        )
        from pymobiledevice3.services.simulate_location import DtSimulateLocation

        # A dry read of the service so a broken developer image fails here, not mid-route.
        service = await self._client.start_lockdown_developer_service(DtSimulateLocation.SERVICE_NAME)
        try:
            await service.close()
        except Exception:  # noqa: BLE001 - best effort
            logger.debug("error closing probe service", exc_info=True)

    async def set(self, latitude: float, longitude: float) -> None:
        from pymobiledevice3.services.simulate_location import DtSimulateLocation

        if self._client is None:
            raise BridgeError(ErrorCode.SERVICE_UNAVAILABLE, "The legacy location service is not open.")
        await asyncio.wait_for(
            DtSimulateLocation(self._client).set(latitude, longitude), timeout=DTX_CALL_TIMEOUT_S
        )

    async def clear(self) -> None:
        from pymobiledevice3.services.simulate_location import DtSimulateLocation

        if self._client is None:
            return
        await asyncio.wait_for(DtSimulateLocation(self._client).clear(), timeout=DTX_CALL_TIMEOUT_S)

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:  # noqa: BLE001
                logger.debug("error closing legacy lockdown client", exc_info=True)
            self._client = None


# -------------------------------------------------------------------- session


class SimulationSession:
    """A single, exclusive simulation session for one device."""

    def __init__(
        self,
        *,
        device_id: str,
        mode: str,
        points: list[dict[str, float]],
        options: dict[str, Any],
        target: Any,
        emit: Any,
        identity: dict[str, Any],
        link: Optional[dict[str, Any]] = None,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.device_id = device_id
        self.mode = mode
        self.points = points
        self.options = options
        self.state = SimulationState.PREPARING
        self.target = target
        self.identity = identity
        # Which medium the developer session was actually opened over. ``transport`` says
        # DVT or legacy; this says cable, Wi-Fi mux entry, or a direct LAN endpoint.
        self.link = dict(link or {})
        self.started_at = time.time()
        self.finished_at: Optional[float] = None
        self.error: Optional[dict[str, Any]] = None
        self.published_index = 0
        self.published_count = 0
        self.current: Optional[dict[str, float]] = None
        self.loop_count = 0
        self._emit = emit
        self._task: Optional[asyncio.Task[None]] = None
        self._watchdog: Optional[asyncio.Task[None]] = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._stop_requested = False
        self._last_progress_emit = 0.0
        self.route_points = len(points)

        playback = geo.build_playback_points(points, options) if mode == "route" else list(points)
        self.playback_points = playback
        self.total_length_m = geo.route_length_m(points)
        self.speed_mps = float(options.get("speedMps", 0.0)) if mode == "route" else 0.0
        self.estimated_duration_s = (
            geo.estimated_duration_s(points, self.speed_mps) if mode == "route" else 0.0
        )

    # ------------------------------------------------------------- lifecycle

    async def run(self) -> None:
        try:
            self.state = SimulationState.ACTIVE
            await self._emit_state("simulation started", extra={"deviceAcknowledged": self.target.acknowledged})
            if self.link.get("transport") != "rsd-lan":
                self._watchdog = asyncio.create_task(self._device_watchdog(), name=f"watchdog-{self.id}")
            if self.mode == "route":
                self._task = asyncio.create_task(self._play_route(), name=f"route-{self.id}")
            else:
                self._task = asyncio.create_task(self._hold_fixed(), name=f"fixed-{self.id}")
        except BridgeError as exc:
            await self._fail(exc)
        except Exception as exc:  # noqa: BLE001
            await self._fail(
                BridgeError(ErrorCode.SIMULATION_FAILED, "The simulation stopped unexpectedly.",
                            f"{type(exc).__name__}: {exc}")
            )

    async def _hold_fixed(self) -> None:
        """Keep a single coordinate applied and prove the channel is still alive."""
        point = self.points[0]
        while not self._stop_requested:
            await asyncio.sleep(FIXED_KEEPALIVE_S)
            if self._stop_requested:
                return
            try:
                await self.target.set(point["lat"], point["lon"])
            except BridgeError as exc:
                await self._fail(exc)
                return
            except Exception as exc:  # noqa: BLE001
                await self._fail(
                    BridgeError(ErrorCode.SIMULATION_FAILED, "Lost contact with the device.",
                                f"{type(exc).__name__}: {exc}")
                )
                return

    async def _play_route(self) -> None:
        schedule_start = time.monotonic()
        published = 0
        point_count = len(self.playback_points)
        speed = max(self.speed_mps, 0.01)

        try:
            lengths = geo.cumulative_lengths(self.playback_points)
            while not self._stop_requested:
                for index, point in enumerate(self.playback_points):
                    if self._stop_requested:
                        return
                    await self._pause_event.wait()
                    if self._stop_requested:
                        return

                    due_at = schedule_start + lengths[index] / speed
                    delay = due_at - time.monotonic()
                    if delay > 0:
                        try:
                            await asyncio.wait_for(asyncio.sleep(delay), timeout=max(delay + 1.0, 2.0))
                        except asyncio.TimeoutError:
                            pass
                        if self._stop_requested:
                            return
                        await self._pause_event.wait()

                    await self.target.set(point["lat"], point["lon"])
                    self.published_index = index
                    self.published_count = published
                    self.current = {"lat": point["lat"], "lon": point["lon"]}
                    published += 1
                    await self._emit_progress(lengths[index])

                if not self.options.get("loop"):
                    break
                self.loop_count += 1
                schedule_start = time.monotonic()
                published = 0

            self.state = SimulationState.COMPLETED
            self.finished_at = time.time()
            await self._emit_state("route completed", extra={"locationOverrideActive": True})
        except BridgeError as exc:
            await self._fail(exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            await self._fail(
                BridgeError(
                    ErrorCode.SIMULATION_FAILED,
                    "Route playback aborted.",
                    f"{type(exc).__name__}: {exc}",
                )
            )

    async def _device_watchdog(self) -> None:
        """Detect a removal independently of the developer channel.

        Only the mux-backed transports are watched this way: a device reached through a
        direct LAN endpoint is *never* in usbmuxd's list, so absence there would be
        reported as a disconnection that did not happen. Such sessions prove liveness by
        writing - a fixed location is re-published and a route publishes constantly, and
        either one fails the session when the device stops answering.
        """
        from pymobiledevice3 import usbmux

        while not self._stop_requested:
            await asyncio.sleep(DEVICE_WATCH_INTERVAL_S)
            if self._stop_requested:
                return
            try:
                devices = await asyncio.wait_for(usbmux.list_devices(), timeout=8.0)
            except Exception:  # noqa: BLE001 - a failing scan is not proof of removal
                continue
            if not any(device.matches_udid(self.device_id) for device in devices):
                await self._fail(
                    BridgeError(
                        ErrorCode.DEVICE_DISCONNECTED,
                        "The iPhone was disconnected. Location simulation has ended.",
                        f"UDID {self.device_id} is no longer reported by usbmuxd. "
                        "The device returns to its real GPS position as soon as the developer session drops.",
                        remedy="Reconnect the iPhone and start a new session.",
                        retryable=True,
                    ),
                    state=SimulationState.DISCONNECTED,
                )
                return
            if self.state == SimulationState.ACTIVE and self.mode == "route":
                # Cheap liveness: the route task republishes constantly, so a stalled
                # channel surfaces through target.set() timeouts instead.
                pass

    async def pause(self) -> None:
        if self.mode != "route":
            raise UnsupportedOperation(
                "A fixed location cannot be paused.",
                "The device holds one coordinate; there is no progress to suspend. "
                "Stop the session instead to return the iPhone to its real GPS.",
            )
        if self.state != SimulationState.ACTIVE:
            raise BridgeError(
                ErrorCode.NO_ACTIVE_SIMULATION,
                f"A route can only be paused while active (current state: {self.state}).",
            )
        self._pause_event.clear()
        self.state = SimulationState.PAUSED
        await self._emit_state("paused", extra={"granularity": "one update interval"})

    async def resume(self) -> None:
        if self.mode != "route":
            raise UnsupportedOperation(
                "A fixed location cannot be resumed.",
                "Pause and resume apply to route playback only; a held coordinate has no playback to restart.",
            )
        if self.state != SimulationState.PAUSED:
            raise BridgeError(
                ErrorCode.NO_ACTIVE_SIMULATION,
                f"Nothing is paused (current state: {self.state}).",
            )
        self._pause_event.set()
        self.state = SimulationState.ACTIVE
        await self._emit_state("resumed")

    async def stop(self) -> dict[str, Any]:
        """Restore real GPS. Always attempts the clear, even after a failure."""
        already_ended = self.state in {SimulationState.STOPPED, SimulationState.FAILED, SimulationState.DISCONNECTED}
        self.state = SimulationState.STOPPING
        self._stop_requested = True
        self._pause_event.set()

        for task in (self._task, self._watchdog):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

        clear_error: Optional[BridgeError] = None
        try:
            await self.target.clear()
            cleared = True
        except Exception as exc:  # noqa: BLE001
            cleared = False
            clear_error = BridgeError(
                ErrorCode.SIMULATION_FAILED,
                "Could not confirm that the location override was removed.",
                f"{type(exc).__name__}: {exc}",
                remedy=(
                    "Reconnect the iPhone, or restart it, to guarantee the device is back on its own GPS."
                ),
            )
            logger.warning("clear() failed during stop: %s", exc)

        try:
            await self.target.close()
        except Exception:  # noqa: BLE001
            logger.debug("error closing target", exc_info=True)

        self.state = SimulationState.STOPPED
        self.finished_at = time.time()
        if clear_error is not None:
            self.error = clear_error.to_dict()

        await self._emit_state(
            "stopped",
            extra={
                "deviceCleared": cleared,
                "locationOverrideActive": False if cleared else None,
                "supersededByAlreadyEnded": already_ended,
            },
        )
        return self.snapshot()

    async def _fail(self, error: BridgeError, *, state: Optional[str] = None) -> None:
        self.state = state or SimulationState.FAILED
        self.error = error.to_dict()
        self.finished_at = time.time()
        # A failed session must still try to release the device.
        try:
            await self.target.clear()
        except Exception:  # noqa: BLE001 - expected to fail if the device is gone
            logger.debug("clear() failed after session failure", exc_info=True)
        try:
            await self.target.close()
        except Exception:  # noqa: BLE001
            logger.debug("error closing target after failure", exc_info=True)
        await self._emit_state(f"session ended: {self.state}", extra={"error": self.error})

    # ------------------------------------------------------------ reporting

    async def _emit_state(self, reason: str, extra: Optional[dict[str, Any]] = None) -> None:
        payload = self.snapshot()
        payload["reason"] = reason
        if extra:
            payload.update(extra)
        await self._emit("simulation.state", payload)

    async def _emit_progress(self, distance_m: float) -> None:
        now = time.monotonic()
        if now - self._last_progress_emit < PROGRESS_EVENT_MIN_INTERVAL_S and distance_m < self.total_length_m:
            return
        self._last_progress_emit = now
        payload = self.snapshot()
        payload["distanceM"] = round(distance_m, 2)
        payload["progress"] = (
            round(min(1.0, distance_m / self.total_length_m), 5) if self.total_length_m > 0 else 0.0
        )
        await self._emit("simulation.progress", payload)

    def snapshot(self) -> dict[str, Any]:
        elapsed = (self.finished_at or time.time()) - self.started_at
        return {
            "sessionId": self.id,
            "deviceId": self.device_id,
            "mode": self.mode,
            "state": self.state,
            "transport": self.target.kind,
            "link": self.link,
            "deviceAcknowledged": self.target.acknowledged,
            "waypointCount": self.route_points,
            "publishedPointCount": self.published_count,
            "publishedIndex": self.published_index,
            "totalPoints": len(self.playback_points) if self.mode == "route" else 1,
            "current": self.current or (self.points[0] if self.points else None),
            "speedMps": self.speed_mps,
            "updateRateHz": self.options.get("updateRateHz"),
            "loop": bool(self.options.get("loop")),
            "loopCount": self.loop_count,
            "routeLengthM": round(self.total_length_m, 2),
            "estimatedDurationSeconds": round(self.estimated_duration_s, 2),
            "elapsedSeconds": round(elapsed, 2),
            "startedAt": self.started_at,
            "locationOverrideActive": self.state
            in {SimulationState.ACTIVE, SimulationState.PAUSED, SimulationState.COMPLETED},
            "error": self.error,
            "identity": self.identity,
        }


# -------------------------------------------------------------------- service


class SimulationService:
    """Owns at most one session and the shared tunnel handle."""

    def __init__(self, tunnels: TunnelManager, emit: Any) -> None:
        self._tunnels = tunnels
        self._emit = emit
        self._session: Optional[SimulationSession] = None
        self._lock = asyncio.Lock()
        self._history: list[dict[str, Any]] = []

    # -------------------------------------------------------------- helpers

    @property
    def current_session(self) -> Optional[SimulationSession]:
        """The last session, ended or not. Callers check ``state`` themselves."""
        return self._session

    def _active_session(self) -> SimulationSession:
        session = self._session
        if session is None or session.state in {
            SimulationState.STOPPED,
            SimulationState.FAILED,
            SimulationState.DISCONNECTED,
        }:
            raise BridgeError(
                ErrorCode.NO_ACTIVE_SIMULATION,
                "No location simulation is running.",
                remedy="Start a simulation from the Location workspace first.",
            )
        return session

    async def _read_identity(self, device_id: str, connection_type: Optional[str] = None) -> dict[str, Any]:
        from .device_manager import DeviceManager

        from pymobiledevice3.lockdown import create_using_usbmux

        try:
            client = await asyncio.wait_for(
                create_using_usbmux(serial=device_id, autopair=False, connection_type=connection_type),
                timeout=LOCKDOWN_TIMEOUT_S,
            )
        except Exception as exc:  # noqa: BLE001
            error = DeviceManager._classify_lockdown_error(exc)
            if type(exc).__name__ in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
                raise BridgeError(
                    ErrorCode.NOT_PAIRED,
                    "The iPhone is not paired with this PC.",
                    f"{type(exc).__name__}: {exc}",
                    remedy="Unlock the iPhone and pair it from the Device workspace, then retry.",
                ) from exc
            raise error from exc
        try:
            identity = {
                "deviceName": await client.get_value(key="DeviceName"),
                "productType": await client.get_value(key="ProductType"),
                "productVersion": await client.get_value(key="ProductVersion"),
                "buildVersion": await client.get_value(key="BuildVersion"),
            }
            try:
                identity["developerModeEnabled"] = bool(await client.get_developer_mode_status())
            except Exception:  # noqa: BLE001
                identity["developerModeEnabled"] = None
            return identity
        finally:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                logger.debug("error closing lockdown client", exc_info=True)

    async def _build_target(self, device_id: str, identity: dict[str, Any], endpoint: Any = None) -> Any:
        product_version = identity.get("productVersion")
        if requires_tunnel(product_version):
            if identity.get("developerModeEnabled") is False:
                raise BridgeError(
                    ErrorCode.DEVELOPER_MODE_DISABLED,
                    "Developer Mode is disabled on this iPhone.",
                    f"iOS {product_version} requires Developer Mode for developer services.",
                    remedy="Settings → Privacy & Security → Developer Mode → on, then restart the iPhone.",
                )
            # ``endpoint`` is the transport the caller proved for this device. Passing it
            # through is what keeps a wireless session from quietly running over a cable.
            rsd = await self._tunnels.acquire(device_id, endpoint=endpoint)
            identity["tunnel"] = self._tunnels.status()
            target = DvtLocationTarget(rsd)
        else:
            identity["tunnel"] = None
            target = LegacyLocationTarget(device_id, getattr(endpoint, "connection_type", None))
        await target.open()
        return target

    @staticmethod
    def _link_for(endpoint: Any, identity: dict[str, Any]) -> dict[str, Any]:
        """Describe the medium a session was really built on, from what was observed."""
        requested = getattr(endpoint, "transport", None)
        tunnel = identity.get("tunnel") or {}
        wireless = bool(tunnel.get("wireless")) if tunnel.get("open") else bool(
            getattr(endpoint, "is_wireless", False)
        )
        return {
            "requested": requested,
            # The transport the developer session was actually established on. When the
            # tunnel answered, that is what it reported; otherwise nothing is claimed.
            "transport": tunnel.get("transport") or requested,
            "active": tunnel.get("transport") or requested,
            "wireless": wireless,
            "kind": tunnel.get("kind"),
            "address": getattr(endpoint, "host", None),
        }

    # ------------------------------------------------------------------ API

    async def start_fixed(self, device_id: str, coordinate: Any, endpoint: Any = None) -> dict[str, Any]:
        udid = validate_udid(device_id)
        point = validate_coordinate(coordinate, "coordinate")
        return await self._start(udid, "fixed", [point], {
            "speedMps": 0.0,
            "interpolate": False,
            "updateRateHz": 0.0,
            "loop": False,
        }, endpoint=endpoint)

    async def start_route(self, device_id: str, points: Any, options: Any, endpoint: Any = None) -> dict[str, Any]:
        udid = validate_udid(device_id)
        validated_points = validate_points(points, name="points", minimum=2)
        validated_options = validate_route_options(options)
        return await self._start(udid, "route", validated_points, validated_options, endpoint=endpoint)

    async def _start(
        self,
        device_id: str,
        mode: str,
        points: list[dict[str, float]],
        options: dict[str, Any],
        endpoint: Any = None,
    ) -> dict[str, Any]:
        async with self._lock:
            existing = self._session
            if existing is not None and existing.state in {
                SimulationState.PREPARING,
                SimulationState.ACTIVE,
                SimulationState.PAUSED,
                SimulationState.COMPLETED,
            }:
                raise BridgeError(
                    ErrorCode.SIMULATION_ACTIVE,
                    "A simulation is already running.",
                    f"Session {existing.id} is {existing.state} for device {existing.device_id}.",
                    remedy="Stop the running session before starting another one.",
                )

            identity = await self._read_identity(device_id, getattr(endpoint, "connection_type", None))
            target = await self._build_target(device_id, identity, endpoint=endpoint)

            session = SimulationSession(
                device_id=device_id,
                mode=mode,
                points=points,
                options=options,
                target=target,
                emit=self._on_session_event,
                identity=identity,
                link=self._link_for(endpoint, identity),
            )
            self._session = session

            # Apply the very first coordinate before declaring success: the UI must
            # never show "simulating" for a call the device has not taken.
            try:
                await target.set(points[0]["lat"], points[0]["lon"])
            except Exception as exc:  # noqa: BLE001
                try:
                    await target.clear()
                except Exception:  # noqa: BLE001
                    logger.debug("clear() after failed first set", exc_info=True)
                try:
                    await target.close()
                except Exception:  # noqa: BLE001
                    logger.debug("close() after failed first set", exc_info=True)
                self._session = None
                if isinstance(exc, BridgeError):
                    raise
                raise BridgeError(
                    ErrorCode.SIMULATION_FAILED,
                    "The device rejected the first location update.",
                    f"{type(exc).__name__}: {exc}",
                    remedy="Reconnect the iPhone, confirm Developer Mode, then retry.",
                ) from exc

            session.current = {"lat": points[0]["lat"], "lon": points[0]["lon"]}

        await session.run()
        return session.snapshot()

    async def pause(self, device_id: Optional[str] = None) -> dict[str, Any]:
        session = self._active_session()
        self._assert_device(session, device_id)
        await session.pause()
        return session.snapshot()

    async def resume(self, device_id: Optional[str] = None) -> dict[str, Any]:
        session = self._active_session()
        self._assert_device(session, device_id)
        await session.resume()
        return session.snapshot()

    async def stop(self, device_id: Optional[str] = None) -> dict[str, Any]:
        session = self._session
        if session is None:
            raise BridgeError(ErrorCode.NO_ACTIVE_SIMULATION, "No location simulation is running.")
        self._assert_device(session, device_id)
        if session.state in {SimulationState.STOPPED, SimulationState.FAILED, SimulationState.DISCONNECTED}:
            # Already finished on its own; report the last known outcome truthfully.
            return session.snapshot()
        return await session.stop()

    async def status(self) -> dict[str, Any]:
        session = self._session
        return {
            "session": session.snapshot() if session else None,
            "tunnel": self._tunnels.status(),
            "history": self._history[-10:],
        }

    async def screenshot(self, device_id: str, endpoint: Any = None) -> dict[str, Any]:
        """Capture the device screen. Used to verify a simulation on the phone itself."""
        udid = validate_udid(device_id)
        identity = await self._read_identity(udid, getattr(endpoint, "connection_type", None))
        if not requires_tunnel(identity.get("productVersion")):
            raise UnsupportedOperation(
                "Device screenshots require the DVT transport used on iOS 17 and newer.",
                f"Reported iOS version: {identity.get('productVersion')}.",
            )
        rsd = await self._tunnels.acquire(udid, endpoint=endpoint)
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot

        provider = DvtProvider(rsd)
        try:
            await asyncio.wait_for(provider.connect(), timeout=DTX_CALL_TIMEOUT_S * 3)
            async with Screenshot(provider) as screenshot:
                raw = await asyncio.wait_for(screenshot.get_screenshot(), timeout=20.0)
        except asyncio.TimeoutError as exc:
            raise BridgeError(ErrorCode.TIMEOUT, "The device did not return a screenshot in time.") from exc
        except Exception as exc:  # noqa: BLE001
            raise BridgeError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "The device refused a screenshot.",
                f"{type(exc).__name__}: {exc}",
                remedy="Keep the iPhone unlocked and retry; some devices restrict capture while locked.",
            ) from exc
        finally:
            try:
                await provider.close()
            except Exception:  # noqa: BLE001
                logger.debug("error closing screenshot provider", exc_info=True)

        if not raw:
            raise BridgeError(ErrorCode.SERVICE_UNAVAILABLE, "The device returned an empty screenshot.")
        if len(raw) > 12 * 1024 * 1024:
            raise BridgeError(
                ErrorCode.UNSUPPORTED_OPERATION,
                "The screenshot is too large to transfer over the bridge.",
                f"{len(raw)} bytes.",
            )
        return {
            "deviceId": udid,
            "mimeType": "image/png",
            "byteLength": len(raw),
            "capturedAt": time.time(),
            "dataUrl": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"),
        }

    # ---------------------------------------------------------------- private

    @staticmethod
    def _assert_device(session: SimulationSession, device_id: Optional[str]) -> None:
        if device_id and validate_udid(device_id) != session.device_id:
            raise BridgeError(
                ErrorCode.INVALID_PARAMS,
                "The session belongs to a different device.",
                f"Active session targets {session.device_id}.",
            )

    def _record(self, snapshot: dict[str, Any]) -> None:
        """Keep exactly one history row per session, updated as it progresses.

        Sessions last longer than a request: the same session is seen at
        ``active``, then at ``completed``/``failed``/``stopped``. Appending on
        every transition would show the same session several times in the UI.
        """
        entry = {
            "sessionId": snapshot["sessionId"],
            "deviceId": snapshot["deviceId"],
            "mode": snapshot["mode"],
            "state": snapshot["state"],
            "startedAt": snapshot["startedAt"],
            "elapsedSeconds": snapshot["elapsedSeconds"],
            "publishedPointCount": snapshot["publishedPointCount"],
            "error": snapshot.get("error"),
        }
        for index, existing in enumerate(self._history):
            if existing["sessionId"] == entry["sessionId"]:
                self._history[index] = entry
                return
        self._history.append(entry)

    async def _on_session_event(self, name: str, payload: Any) -> None:
        """Record session state changes for the run history, then forward the event."""
        if name == "simulation.state" and isinstance(payload, dict) and payload.get("sessionId"):
            self._record(payload)
        await self._emit(name, payload)

    async def shutdown(self) -> None:
        """Called on bridge shutdown: never leave the device in a simulated state."""
        session = self._session
        if session is not None and session.state in {
            SimulationState.ACTIVE,
            SimulationState.PAUSED,
            SimulationState.COMPLETED,
            SimulationState.PREPARING,
        }:
            logger.info("shutdown: stopping session %s to restore the device GPS", session.id)
            try:
                await asyncio.wait_for(session.stop(), timeout=15.0)
            except Exception:  # noqa: BLE001
                logger.warning("could not cleanly stop the session during shutdown", exc_info=True)


def simulated_summary(session: SimulationSession) -> dict[str, Any]:
    """Small helper used by tests and logs."""
    return {
        "id": session.id,
        "state": session.state,
        "mode": session.mode,
        "points": len(session.playback_points),
    }
