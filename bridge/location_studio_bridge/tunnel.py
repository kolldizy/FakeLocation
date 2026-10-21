"""RSD tunnel lifecycle for iOS 17+ developer services.

On iOS 17 and later the DVT services moved behind RemoteServiceDiscovery and are
only reachable through a tunnel. Location Studio uses pymobiledevice3's
*userspace* tunnel (a pure-Python TCP/IP stack), which means **no administrator
rights and no driver install** are required on Windows.

Two hard constraints from the underlying implementation drive this module's API:

1. ``UserspaceRsdTunnel`` owns a process-global network stack, so only one tunnel
   can exist per bridge process at a time. :class:`TunnelManager` enforces that
   and refuses to silently switch devices while a simulation is running.
2. The tunnel wraps the device address space; it must stay alive for as long as a
   developer service is in use. The manager therefore holds an open handle
   instead of opening a tunnel per command.

Transport honesty
-----------------
The same tunnel machinery serves USB and Wi-Fi, because usbmuxd exposes both. That
makes it easy to lie: usbmuxd prefers a USB entry when a cable is present, so a
"wireless" tunnel opened while the phone is plugged in would really be a USB one.
Therefore a wireless request is pinned to an endpoint, refused outright while the
cable is attached, and the endpoint that succeeded is kept for as long as the
session lives so later reports can name the transport they actually measured.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from .protocol import BridgeError, ErrorCode

logger = logging.getLogger(__name__)

RSD_MIN_IOS_MAJOR = 17


def ios_major_version(product_version: Optional[str]) -> Optional[int]:
    if not product_version:
        return None
    head = str(product_version).split(".", 1)[0]
    try:
        return int(head)
    except ValueError:
        return None


def requires_tunnel(product_version: Optional[str]) -> bool:
    """``True`` when developer services for this iOS version live behind an RSD tunnel."""
    major = ios_major_version(product_version)
    if major is None:
        # Unknown version: assume the modern path, because that is the only one the
        # connected device can be validated against. The caller reports this honestly.
        return True
    return major >= RSD_MIN_IOS_MAJOR


class TunnelManager:
    """Owns at most one userspace RSD tunnel, or one direct LAN RSD handle."""

    def __init__(self, *, open_timeout: float = 75.0) -> None:
        self._tunnel: Any = None
        self._rsd: Any = None
        self._udid: Optional[str] = None
        # The endpoint a tunnel was opened for. Keeping it is what lets the bridge say
        # "this developer service was reached over Wi-Fi" instead of "over usbmuxd":
        # without it, the transport of an established session is unknowable after the
        # fact, and the UI would have to guess.
        self._endpoint: Any = None
        self._kind = "userspace"
        self._lock = asyncio.Lock()
        self._open_timeout = open_timeout
        self._established_count = 0

    @property
    def udid(self) -> Optional[str]:
        return self._udid

    @property
    def is_open(self) -> bool:
        return self._rsd is not None

    @property
    def endpoint(self) -> Any:
        return self._endpoint

    def status(self) -> dict[str, Any]:
        transport = getattr(self._endpoint, "transport", None) if self._rsd is not None else None
        return {
            "open": self.is_open,
            "deviceId": self._udid,
            "establishedCount": self._established_count,
            "kind": self._kind if self._rsd is not None else "userspace",
            "transport": transport,
            "wireless": bool(getattr(self._endpoint, "is_wireless", False)) if self._rsd is not None else False,
        }

    async def acquire(self, udid: str, *, endpoint: Any = None) -> Any:
        """Return a connected RSD for ``udid``, opening a tunnel if required.

        ``endpoint`` optionally pins the transport the tunnel must use. When a tunnel is
        already open for this device on a *different* transport, the call is refused
        rather than silently reused: a session established over a cable must not be
        reported as a wireless one.
        """
        async with self._lock:
            if self._rsd is not None and self._udid == udid:
                current = getattr(self._endpoint, "transport", None)
                wanted = getattr(endpoint, "transport", None)
                if wanted and current and wanted != current:
                    raise BridgeError(
                        ErrorCode.TUNNEL_UNAVAILABLE,
                        "An developer tunnel is already open for this iPhone over another transport.",
                        f"The active session is {current}; {wanted} was requested.",
                        remedy="Press Disconnect, then connect the transport you want to use.",
                    )
                return self._rsd
            if self._rsd is not None and self._udid != udid:
                raise BridgeError(
                    ErrorCode.TUNNEL_UNAVAILABLE,
                    "A tunnel to a different iPhone is already open.",
                    f"The active tunnel targets {self._udid}. The userspace tunnel stack only supports one "
                    "device per bridge process.",
                    remedy="Stop the active simulation (or press Disconnect) before selecting another iPhone.",
                )
            return await self._open(udid, endpoint)

    async def _open(self, udid: str, endpoint: Any = None) -> Any:
        transport = getattr(endpoint, "transport", None)
        if endpoint is not None and transport == "wifi-mux":
            # A wireless claim has to survive the obvious counter-argument: if the cable
            # is in, usbmuxd prefers it and the tunnel would in fact be a USB one.
            await self._assert_no_usb_entry(udid)

        try:
            from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise BridgeError(
                ErrorCode.DEPENDENCY_MISSING,
                "pymobiledevice3 is not installed in the bridge environment.",
                str(exc),
                remedy="Run: pip install -r bridge/requirements.txt",
            ) from exc

        logger.info("establishing userspace RSD tunnel for %s over %s", udid, transport or "usb")
        tunnel = UserspaceRsdTunnel(serial=udid, autopair=False)
        try:
            rsd = await asyncio.wait_for(tunnel.aopen(), timeout=self._open_timeout)
        except asyncio.TimeoutError as exc:
            await self._safe_close(tunnel)
            raise BridgeError(
                ErrorCode.TIMEOUT,
                "Timed out while establishing the developer tunnel.",
                f"No RSD handshake within {self._open_timeout:.0f}s.",
                remedy=(
                    "Unlock the iPhone and keep it reachable on this Wi-Fi network, then retry."
                    if transport and transport != "usb"
                    else "Unlock the iPhone, keep it connected over USB, then retry the readiness check."
                ),
                retryable=True,
            ) from exc
        except Exception as exc:  # noqa: BLE001 - surfaced as a typed bridge error
            await self._safe_close(tunnel)
            raise self._classify_open_failure(exc, transport=transport) from exc

        self._tunnel = tunnel
        self._rsd = rsd
        self._udid = udid
        self._endpoint = endpoint
        self._kind = "userspace"
        self._established_count += 1
        logger.info("RSD tunnel for %s established (product version %s)", udid, getattr(rsd, "product_version", "?"))
        return rsd

    @staticmethod
    async def _assert_no_usb_entry(udid: str) -> None:
        """Refuse to call a USB session wireless: usbmuxd picks USB when both exist."""
        from pymobiledevice3 import usbmux

        devices = await asyncio.wait_for(usbmux.list_devices(), timeout=12.0)
        attached = [d for d in devices if d.matches_udid(udid) and d.connection_type == "USB"]
        if attached:
            raise BridgeError(
                ErrorCode.WIRELESS_UNAVAILABLE,
                "The iPhone is attached over USB, so the tunnel would run over the cable.",
                "usbmuxd prefers a USB entry over a network one, which means a successful tunnel would "
                "prove nothing about the Wi-Fi path.",
                remedy=(
                    "Unplug the cable, wait a few seconds for the network entry to settle, then connect "
                    "over Wi-Fi again."
                ),
            )

    async def open_lan_rsd(self, host: str, udid: str, *, port: Optional[int] = None) -> tuple[Any, dict[str, Any]]:
        """Connect to RemoteServiceDiscovery directly at a LAN address and keep the handle.

        This is not a tunnel: it is the RSD the device advertises itself over the local
        network. The handshake is the proof - if it completes, this PC really reached the
        phone without a cable.
        """
        from pymobiledevice3.remote.remote_service_discovery import RSD_PORT, RemoteServiceDiscoveryService
        from pymobiledevice3.remote.remotexpc import remoted_handshake_uuid

        async with self._lock:
            if self._rsd is not None and self._udid != udid:
                raise BridgeError(
                    ErrorCode.TUNNEL_UNAVAILABLE,
                    "A session for a different iPhone is already open.",
                    f"The active session targets {self._udid}.",
                    remedy="Press Disconnect before selecting another iPhone.",
                )
            endpoint = _LanEndpoint(device_id=udid, host=host, port=port or RSD_PORT)
            handshake_uuid = await asyncio.to_thread(remoted_handshake_uuid)
            rsd = RemoteServiceDiscoveryService((host, endpoint.port), handshake_uuid=handshake_uuid)
            try:
                await asyncio.wait_for(rsd.connect(), timeout=self._open_timeout)
            except asyncio.TimeoutError as exc:
                await self._safe_close_rsd(rsd)
                raise BridgeError(
                    ErrorCode.TIMEOUT,
                    "The iPhone's RemoteServiceDiscovery did not complete the handshake.",
                    f"No response from the advertised LAN endpoint within {self._open_timeout:.0f}s.",
                    remedy="Unlock the iPhone and confirm it is on the same Wi-Fi network as this PC.",
                    retryable=True,
                ) from exc
            except Exception as exc:  # noqa: BLE001
                await self._safe_close_rsd(rsd)
                raise BridgeError(
                    ErrorCode.WIRELESS_UNAVAILABLE,
                    "The advertised LAN developer endpoint refused this PC.",
                    f"{type(exc).__name__}: {exc}",
                    remedy=(
                        "The iPhone must be paired with this computer and on this network. Re-pair over USB, "
                        "then retry."
                    ),
                    retryable=True,
                ) from exc

            self._tunnel = None
            self._rsd = rsd
            self._udid = udid
            self._endpoint = endpoint
            self._kind = "rsd-lan-direct"
            self._established_count += 1
            return rsd, _rsd_identity(rsd)

    @staticmethod
    async def _safe_close_rsd(rsd: Any) -> None:
        try:
            await rsd.close()
        except Exception:  # noqa: BLE001 - best-effort teardown
            logger.debug("error while closing a rejected RSD", exc_info=True)

    @staticmethod
    def _classify_open_failure(exc: Exception, *, transport: Optional[str] = None) -> BridgeError:
        name = type(exc).__name__
        text = str(exc)
        wireless = bool(transport) and transport != "usb"
        if name == "UserspaceTunnelUnavailableError":
            return BridgeError(
                ErrorCode.DEPENDENCY_MISSING,
                "This iPhone cannot use the no-admin userspace tunnel.",
                f"{name}: {text}",
                remedy=(
                    "iOS 17.0-17.3 devices need a tunnel this bridge cannot open without a cable, because the "
                    "RemotePairing record for this iPhone is missing. Connect over USB once, or update the "
                    "iPhone to iOS 17.4 or newer."
                    if wireless
                    else "iOS 17.0-17.3 devices need a privileged tunnel, which Location Studio does not start. "
                    "Update the iPhone to iOS 17.4 or newer and reconnect."
                ),
            )
        if name in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
            return BridgeError(
                ErrorCode.NOT_PAIRED,
                "The iPhone is not paired with this PC.",
                f"{name}: {text}",
                remedy=(
                    "A USB pairing does not by itself authorise Wi-Fi. Reconnect the cable, press Pair device "
                    "and accept the Trust prompt, then re-enable Wi-Fi sync."
                    if wireless
                    else "Unlock the iPhone and press Pair device in the Device workspace to accept the Trust prompt."
                ),
            )
        if name in {"ConnectionFailedToUsbmuxdError", "MuxException", "DeviceNotFoundError"}:
            return BridgeError(
                ErrorCode.WIRELESS_UNAVAILABLE if wireless else ErrorCode.DEVICE_DISCONNECTED,
                (
                    "The iPhone is no longer reachable through the Apple Mobile Device Service network entry."
                    if wireless
                    else "The iPhone is no longer reachable over USB."
                ),
                f"{name}: {text}",
                remedy=(
                    "Keep the iPhone unlocked on this Wi-Fi network and re-probe; reconnect the cable if it "
                    "has dropped out of the network list."
                    if wireless
                    else "Reconnect the cable and refresh the device list."
                ),
                retryable=True,
            )
        return BridgeError(
            ErrorCode.TUNNEL_FAILED,
            "Could not establish the developer tunnel.",
            f"{name}: {text}",
            remedy=(
                "Confirm Developer Mode is enabled, keep the iPhone unlocked on this Wi-Fi network, then retry."
                if wireless
                else "Reconnect the iPhone, confirm Developer Mode is enabled, then retry."
            ),
            retryable=True,
        )

    async def release(self) -> None:
        """Close the tunnel. Never raises."""
        async with self._lock:
            await self._release_locked()

    async def _release_locked(self) -> None:
        tunnel, rsd = self._tunnel, self._rsd
        self._tunnel = None
        self._rsd = None
        self._udid = None
        self._endpoint = None
        self._kind = "userspace"
        if rsd is not None:
            try:
                await rsd.close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                logger.debug("error while closing RSD", exc_info=True)
        if tunnel is not None:
            await self._safe_close(tunnel)

    @staticmethod
    async def _safe_close(tunnel: Any) -> None:
        try:
            await tunnel.aclose()
        except Exception:  # noqa: BLE001 - best-effort teardown
            logger.debug("error while closing tunnel", exc_info=True)

    def is_alive(self) -> bool:
        """Best-effort liveness: the RSD object is still held and its socket is not closed."""
        if self._rsd is None:
            return False
        connection = getattr(self._rsd, "_connection", None)
        if connection is None:
            return True
        for attribute in ("is_closing", "at_eof"):
            probe = getattr(connection, attribute, None)
            if callable(probe):
                try:
                    if probe():
                        return False
                except Exception:  # noqa: BLE001 - probe is advisory only
                    return True
        return True


class _LanEndpoint:
    """The endpoint shape of a direct LAN RSD session, compatible with wireless.Endpoint."""

    transport = "rsd-lan"
    is_wireless = True

    def __init__(self, *, device_id: str, host: str, port: int) -> None:
        self.device_id = device_id
        self.host = host
        self.port = port
        self.product_version = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "deviceId": self.device_id,
            "transport": self.transport,
            "wireless": True,
            "address": f"{self.host}:{self.port}",
        }


def _rsd_identity(rsd: Any) -> dict[str, Any]:
    """Read the identity the RSD handshake itself reported - nothing is assumed."""
    properties: dict[str, Any] = {}
    peer_info = getattr(rsd, "peer_info", None)
    if isinstance(peer_info, dict):
        raw = peer_info.get("Properties")
        if isinstance(raw, dict):
            properties = raw
    return {
        "deviceName": properties.get("UserDeviceName") or "iPhone",
        "productType": properties.get("ProductType"),
        "productVersion": properties.get("OSVersion"),
        "buildVersion": None,
        "developerModeEnabled": None,
        "wifiConnectionsEnabled": True,
    }

