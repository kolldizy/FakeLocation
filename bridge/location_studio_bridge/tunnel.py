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
    """Owns at most one userspace RSD tunnel."""

    def __init__(self, *, open_timeout: float = 75.0) -> None:
        self._tunnel: Any = None
        self._rsd: Any = None
        self._udid: Optional[str] = None
        self._lock = asyncio.Lock()
        self._open_timeout = open_timeout
        self._established_count = 0

    @property
    def udid(self) -> Optional[str]:
        return self._udid

    @property
    def is_open(self) -> bool:
        return self._rsd is not None

    def status(self) -> dict[str, Any]:
        return {
            "open": self.is_open,
            "deviceId": self._udid,
            "establishedCount": self._established_count,
            "kind": "userspace",
        }

    async def acquire(self, udid: str) -> Any:
        """Return a connected RSD for ``udid``, opening a tunnel if required."""
        async with self._lock:
            if self._rsd is not None and self._udid == udid:
                return self._rsd
            if self._rsd is not None and self._udid != udid:
                raise BridgeError(
                    ErrorCode.TUNNEL_UNAVAILABLE,
                    "A tunnel to a different iPhone is already open.",
                    f"The active tunnel targets {self._udid}. The userspace tunnel stack only supports one "
                    "device per bridge process.",
                    remedy="Stop the active simulation (or press Disconnect) before selecting another iPhone.",
                )
            return await self._open(udid)

    async def _open(self, udid: str) -> Any:
        try:
            from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise BridgeError(
                ErrorCode.DEPENDENCY_MISSING,
                "pymobiledevice3 is not installed in the bridge environment.",
                str(exc),
                remedy="Run: pip install -r bridge/requirements.txt",
            ) from exc

        logger.info("establishing userspace RSD tunnel for %s", udid)
        tunnel = UserspaceRsdTunnel(serial=udid, autopair=False)
        try:
            rsd = await asyncio.wait_for(tunnel.aopen(), timeout=self._open_timeout)
        except asyncio.TimeoutError as exc:
            await self._safe_close(tunnel)
            raise BridgeError(
                ErrorCode.TIMEOUT,
                "Timed out while establishing the developer tunnel.",
                f"No RSD handshake within {self._open_timeout:.0f}s.",
                remedy="Unlock the iPhone, keep it connected over USB, then retry the readiness check.",
                retryable=True,
            ) from exc
        except Exception as exc:  # noqa: BLE001 - surfaced as a typed bridge error
            await self._safe_close(tunnel)
            raise self._classify_open_failure(exc) from exc

        self._tunnel = tunnel
        self._rsd = rsd
        self._udid = udid
        self._established_count += 1
        logger.info("RSD tunnel for %s established (product version %s)", udid, getattr(rsd, "product_version", "?"))
        return rsd

    @staticmethod
    def _classify_open_failure(exc: Exception) -> BridgeError:
        name = type(exc).__name__
        text = str(exc)
        if name == "UserspaceTunnelUnavailableError":
            return BridgeError(
                ErrorCode.DEPENDENCY_MISSING,
                "This iPhone cannot use the no-admin userspace tunnel.",
                f"{name}: {text}",
                remedy=(
                    "iOS 17.0-17.3 devices need a privileged tunnel, which Location Studio does not start. "
                    "Update the iPhone to iOS 17.4 or newer and reconnect."
                ),
            )
        if name in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
            return BridgeError(
                ErrorCode.NOT_PAIRED,
                "The iPhone is not paired with this PC.",
                f"{name}: {text}",
                remedy="Unlock the iPhone and press Pair device in Device Center to accept the Trust prompt.",
            )
        if name in {"ConnectionFailedToUsbmuxdError", "MuxException", "DeviceNotFoundError"}:
            return BridgeError(
                ErrorCode.DEVICE_DISCONNECTED,
                "The iPhone is no longer reachable over USB.",
                f"{name}: {text}",
                remedy="Reconnect the cable and refresh the device list.",
                retryable=True,
            )
        return BridgeError(
            ErrorCode.TUNNEL_FAILED,
            "Could not establish the developer tunnel.",
            f"{name}: {text}",
            remedy="Reconnect the iPhone, confirm Developer Mode is enabled, then retry.",
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
