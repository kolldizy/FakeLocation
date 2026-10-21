"""Honest device discovery and capability reporting.

Every claim this module produces is derived from a real observation:

* a device entry only exists if usbmuxd reported it;
* ``paired`` is set only when lockdown completed a session without a pairing error;
* ``developerModeEnabled`` is read from the device, never assumed;
* ``simulationReady`` is only ``True`` after the developer service was actually
  opened for that device.

If any step cannot be completed, the corresponding stage is ``None`` ("not
checked") or ``False`` with an attached issue - never a guessed ``True``.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import time
from typing import Any, Optional

from .protocol import BridgeError, ErrorCode
from .tunnel import TunnelManager, ios_major_version, requires_tunnel
from .validation import validate_transport, validate_udid
from .wireless import (
    TRANSPORT_LABELS,
    TRANSPORT_RSD_LAN,
    TRANSPORT_USB,
    TRANSPORT_WIFI_MUX,
    WIRELESS_PREREQUISITES,
    Endpoint,
    WirelessProber,
    usb_endpoint,
)

logger = logging.getLogger(__name__)

LOCKDOWN_TIMEOUT_S = 15.0

# Marketing names for the model identifiers we have seen reported by lockdown.
# Unknown identifiers fall back to the raw ProductType, which is never wrong.
PRODUCT_TYPE_NAMES = {
    "iPhone17,1": "iPhone 16 Pro",
    "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,3": "iPhone 16",
    "iPhone17,4": "iPhone 16 Plus",
    "iPhone17,5": "iPhone 16e",
    "iPhone18,1": "iPhone 17 Pro",
    "iPhone18,2": "iPhone 17 Pro Max",
    "iPhone18,3": "iPhone 17",
    "iPhone18,4": "iPhone Air",
    "iPhone16,1": "iPhone 15 Pro",
    "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone15,4": "iPhone 15",
    "iPhone15,5": "iPhone 15 Plus",
    "iPhone14,7": "iPhone 14",
    "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro",
    "iPhone15,3": "iPhone 14 Pro Max",
}

# Capability status vocabulary, mirrored by the renderer's badges.
VERIFIED_HARDWARE = "verified_hardware"
DOCUMENTED = "documented"
UNKNOWN = "unknown"
UNSUPPORTED = "unsupported"

# The matrix describes what this build was shown to do, not what is plugged in right now.
# Every ``verified_hardware`` row below was reproduced by hand on this bench device on this
# date, so the renderer can put that provenance under the badges instead of letting a
# green "VERIFIED / HARDWARE" tag read as a measurement of the current session.
CAPABILITY_PROVENANCE = {
    "verifiedOn": "2026-10-18",
    "bench": "iPhone17,1 (iPhone 16 Pro) · iOS 27.0.1 build 24A446 · Windows 11 build 26300",
    "note": (
        "The matrix is a statement about this build, re-read from the same table on every "
        "load. It is not re-measured against whatever is attached now."
    ),
}

IDENTITY_KEYS = (
    "DeviceName",
    "ProductType",
    "ProductVersion",
    "BuildVersion",
    "DeviceClass",
    "CPUArchitecture",
    "HardwareModel",
    "HumanReadableProductVersionString",
    "RegionInfo",
    "PasswordProtected",
    "ActivationState",
)


def _apple_mobile_device_service_running() -> tuple[bool, str]:
    """Look for the Windows services that provide usbmuxd. Read-only, no drafts."""
    if platform.system() != "Windows":
        return (True, "not applicable on this platform")
    try:
        import winreg  # noqa: PLC0415 - Windows-only import kept local
    except ImportError:  # pragma: no cover
        return (False, "winreg unavailable")

    found: list[str] = []
    for hive, path in (
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Services"),
    ):
        try:
            with winreg.OpenKey(hive, path) as key:
                index = 0
                while True:
                    try:
                        name = winreg.EnumKey(key, index)
                    except OSError:
                        break
                    index += 1
                    if name.lower().startswith("apple"):
                        found.append(name)
        except OSError:
            continue
    if not found:
        return (
            False,
            "No Apple device services were found in the Windows service registry. "
            "Install “Apple Devices” from the Microsoft Store or iTunes to get Apple Mobile Device Support.",
        )
    return (True, "detected Windows services: " + ", ".join(sorted(found)[:8]))


def _friendly_model(product_type: Optional[str]) -> str:
    if not product_type:
        return "Unknown model"
    return PRODUCT_TYPE_NAMES.get(product_type, product_type)


def _shown_id(udid: str) -> str:
    """A device identifier shortened for status text.

    Readiness and wireless details are painted in the app, so the full UDID must never
    ride along in them - the tail is enough for a user to tell two phones apart.
    """
    text = str(udid or "")
    return f"iPhone ending {text[-4:]}" if len(text) > 8 else "this iPhone"


def _format_usbmux_address(address: Any) -> str:
    """Render the platform usbmux address as a readable string."""
    if address is None:
        return "platform default"
    if isinstance(address, tuple):
        target = address[0]
        if isinstance(target, tuple) and len(target) == 2:
            return f"{target[0]}:{target[1]}"
        return str(target)
    return str(address)


class DeviceManager:
    """Discovery, identity and capability reporting.

    Holds only two kinds of state, both derived from measurements taken in this process:
    stages that a device command proved (``_observed_stages``) and the transports devices
    were reached on (``_proven`` / ``_endpoints``). Device presence and identity always come
    from a fresh usbmuxd or lockdown answer.
    """

    def __init__(self, tunnels: TunnelManager) -> None:
        self._tunnels = tunnels
        self._last_scan: dict[str, Any] = {"devices": [], "scannedAt": None}
        # Stages that discovery cannot measure by itself because they need a tunnel
        # (developer service) or an actual device command (location accepted). They
        # are recorded here when they are really observed, and folded back into every
        # later scan for the same UDID. Unknown stays unknown: nothing is invented.
        self._observed_stages: dict[str, dict[str, bool]] = {}
        # The transport a device was last *proven* reachable on, and the one an explicit
        # action selected for it. Simulation and readiness resolve through these, so a
        # wireless handshake cannot quietly fall back to a cable - or the other way round.
        self._endpoints: dict[str, Endpoint] = {}
        self._proven: dict[str, dict[str, Any]] = {}
        self.wireless = WirelessProber(tunnels)

    # ----------------------------------------------------------------- endpoints

    def select_endpoint(self, endpoint: Endpoint) -> None:
        """Make ``endpoint`` the transport the bridge uses for this device from now on.

        Only an explicit action selects: connecting in the Wireless panel, or a readiness
        check that was asked for one transport by name. Discovery records what it proved
        without selecting anything, so plugging a cable back in can never quietly change
        what a simulation runs over - or claim a wireless session that was never made.
        """
        self._endpoints[endpoint.device_id] = endpoint

    def forget_endpoint(self, device_id: str) -> Optional[Endpoint]:
        return self._endpoints.pop(device_id, None)

    def selected_endpoint(self, device_id: str) -> Optional[Endpoint]:
        return self._endpoints.get(device_id)

    def requested_endpoint(self, device_id: str, transport: Optional[str]) -> Optional[Endpoint]:
        """The endpoint an explicit request means, or ``None`` when nothing was chosen."""
        if transport:
            known = self._proven.get(device_id) or {}
            return Endpoint(
                device_id=device_id,
                transport=transport,
                host=(self._endpoints.get(device_id).host if self._endpoints.get(device_id) else None),
                product_version=known.get("productVersion"),
            )
        return self._endpoints.get(device_id)

    def default_endpoint(self, device_id: str, connection_types: list[str]) -> Endpoint:
        """The transport to use when nothing was chosen, mirroring what is attached.

        Precedence follows usbmuxd's own: a cable wins. Choosing the network entry only
        when no USB entry exists keeps the wired workflow exactly as it was while still
        letting a cable-free iPhone be checked.
        """
        if "USB" in connection_types:
            return usb_endpoint(device_id, (self._proven.get(device_id) or {}).get("productVersion"))
        if "Network" in connection_types:
            return Endpoint(
                device_id=device_id,
                transport=TRANSPORT_WIFI_MUX,
                product_version=(self._proven.get(device_id) or {}).get("productVersion"),
            )
        return usb_endpoint(device_id)

    def record_proven_transport(self, device_id: str, transport: str, *, product_version: Optional[str] = None) -> None:
        """Remember that this PC reached the iPhone on ``transport`` just now."""
        entry = self._proven.setdefault(device_id, {"transports": [], "productVersion": None})
        if transport not in entry["transports"]:
            entry["transports"].append(transport)
            entry["transports"].sort()
        if product_version:
            entry["productVersion"] = product_version
        entry["provenAt"] = _now_iso()

    def endpoint_summary(self, device_id: str) -> dict[str, Any]:
        proven = self._proven.get(device_id)
        selected = self._endpoints.get(device_id)
        tunnel = self._tunnels.status()
        active_for_this = tunnel.get("open") and tunnel.get("deviceId") == device_id
        return {
            "proven": {**proven, "labels": [TRANSPORT_LABELS.get(t, t) for t in proven["transports"]]}
            if proven
            else None,
            "selected": selected.to_dict() if selected else None,
            "activeSession": {
                "open": bool(active_for_this),
                "transport": tunnel.get("transport") if active_for_this else None,
                "kind": tunnel.get("kind") if active_for_this else None,
                "wireless": bool(tunnel.get("wireless")) if active_for_this else False,
            },
        }

    # ---------------------------------------------------------------- wireless

    async def probe_wireless(self, *, device_id: Optional[str] = None, prove_identity: bool = True) -> dict[str, Any]:
        """Run the wireless diagnostics and fold what they proved into the device list.

        A candidate is only listed as reachable when a handshake completed on that
        transport. Seeing an advertisement, or holding a pairing record, is not reachability.
        """
        udid = validate_udid(device_id) if device_id else None
        report = await self.wireless.probe(device_id=udid, prove_lockdown=prove_identity)
        for candidate in report.get("candidates", []):
            product_version = (candidate.get("identity") or {}).get("productVersion")
            for transport in candidate.get("reachableOver", []):
                self.record_proven_transport(candidate["deviceId"], transport, product_version=product_version)
            if candidate.get("reachableOver"):
                self.record_stages(candidate["deviceId"], wirelessReachable=True)
        for device in report["transports"][TRANSPORT_RSD_LAN]["devices"]:
            if device.get("deviceId"):
                self.record_proven_transport(
                    device["deviceId"], TRANSPORT_RSD_LAN, product_version=device.get("osVersion")
                )
        for entry in self._last_scan.get("devices", []):
            entry["link"] = self.endpoint_summary(entry.get("deviceId"))
        return report

    async def connect_transport(self, device_id: str, transport: str) -> dict[str, Any]:
        """Prove one transport and, on iOS 17+, bring the developer session up over it.

        The selected endpoint only changes when this call gets a handshake: a failed
        wireless attempt must not redirect later commands away from a working cable.
        """
        udid = validate_udid(device_id)
        chosen = validate_transport(transport)
        report = await self.wireless.connect(udid, chosen)
        identity = report.get("identity") or {}
        if identity.get("productVersion"):
            self.record_proven_transport(udid, chosen, product_version=identity.get("productVersion"))
        if report.get("endpoint"):
            self.select_endpoint(Endpoint.from_dict(report["endpoint"]))

        tunnel = self._tunnels.status()
        session_is_this_device = bool(tunnel.get("open")) and tunnel.get("deviceId") == udid
        developer_service = bool((report.get("developerService") or {}).get("reachable"))
        stages = {
            "wirelessReachable": bool(identity) if report.get("wireless") else None,
            "tunnelOverWireless": bool(session_is_this_device and tunnel.get("wireless")),
            "developerServiceAvailable": developer_service if report.get("developerService") else None,
            # Only the device's own answer counts: the DVT service being advertised on the
            # session this call just proved is what makes simulation possible.
            "simulationReady": bool(report.get("ready")),
        }
        self.record_stages(udid, **stages)
        report["stages"] = {key: value for key, value in stages.items() if value is not None}
        report["link"] = self.endpoint_summary(udid)
        return report

    async def disconnect_transport(self, device_id: Optional[str] = None) -> dict[str, Any]:
        """Close the developer session and drop the transport that was selected for it."""
        tunnel = self._tunnels.status()
        was_wireless = bool(tunnel.get("open")) and bool(tunnel.get("wireless"))
        affected = device_id or tunnel.get("deviceId")
        await self._tunnels.release()
        if affected:
            self.forget_endpoint(affected)
            if was_wireless:
                # The session is gone, so the stage that described it is no longer a fact.
                self.record_stages(affected, tunnelOverWireless=False, simulationReady=False)
        return {
            "ok": True,
            "deviceId": affected,
            "wasWireless": was_wireless,
            "tunnel": self._tunnels.status(),
            "link": self.endpoint_summary(affected) if affected else None,
        }

    # ------------------------------------------------------------------ health

    async def health(self) -> dict[str, Any]:
        import sys

        bridge_version = _bridge_version()
        info: dict[str, Any] = {
            "bridgeVersion": bridge_version,
            "protocolVersion": 1,
            "python": {"version": platform.python_version(), "executable": sys.executable},
            "platform": {
                "system": platform.system(),
                "release": platform.release(),
                "version": platform.version(),
                "machine": platform.machine(),
            },
            "pymobiledevice3": {"available": False},
            "tunnel": self._tunnels.status(),
            "notes": [],
        }

        try:
            from pymobiledevice3 import __version__ as pmd_version  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - import guard
            try:
                from importlib.metadata import version as _pkg_version

                pmd_version = _pkg_version("pymobiledevice3")
            except Exception as exc:  # noqa: BLE001
                pmd_version = None
                info["pymobiledevice3"] = {
                    "available": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
                info["notes"].append(
                    "The device bridge cannot talk to an iPhone until pymobiledevice3 is installed "
                    "in this interpreter."
                )
                return info

        info["pymobiledevice3"] = {"available": True, "version": str(pmd_version)}

        drivers_ok, drivers_note = _apple_mobile_device_service_running()
        info["appleUsbDrivers"] = {"ok": drivers_ok, "note": drivers_note}

        usbmux_state = await self._usbmux_state()
        info["usbmux"] = usbmux_state
        return info

    async def _usbmux_state(self) -> dict[str, Any]:
        try:
            from pymobiledevice3 import usbmux
            from pymobiledevice3.osu.os_utils import get_os_utils

            address = get_os_utils().usbmux_address
        except Exception as exc:  # noqa: BLE001
            return {"available": False, "error": f"{type(exc).__name__}: {exc}"}

        try:
            devices = await asyncio.wait_for(usbmux.list_devices(), timeout=10.0)
        except asyncio.TimeoutError:
            return {
                "available": False,
                "address": _format_usbmux_address(address),
                "error": "usbmuxd did not answer within 10s.",
                "remedy": "Restart the Apple Mobile Device Service, then reconnect the iPhone.",
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "available": False,
                "address": _format_usbmux_address(address),
                "error": f"{type(exc).__name__}: {exc}",
                "remedy": (
                    "usbmuxd is the Apple service that exposes USB iPhones to applications. "
                    "Install “Apple Devices” from the Microsoft Store (or iTunes) and reconnect the cable."
                ),
            }

        return {
            "available": True,
            "address": _format_usbmux_address(address),
            "deviceCount": len(devices),
        }

    # --------------------------------------------------------------- discovery

    async def discover(self, *, probe_identity: bool = True) -> dict[str, Any]:
        """Enumerate connected iPhones and attach everything that can be observed.

        ``probe_identity=False`` performs the cheap usbmux-only scan (used while a
        simulation is running, when holding lockdown connections is undesirable).
        """
        started = time.monotonic()
        usbmux_state = await self._usbmux_state()
        result: dict[str, Any] = {
            "usbmux": usbmux_state,
            "devices": [],
            "scannedAt": _now_iso(),
            "durationMs": 0,
            "errors": [],
        }

        if not usbmux_state.get("available"):
            result["durationMs"] = int((time.monotonic() - started) * 1000)
            self._last_scan = result
            return result

        try:
            from pymobiledevice3 import usbmux

            mux_devices = await asyncio.wait_for(usbmux.list_devices(), timeout=10.0)
        except Exception as exc:  # noqa: BLE001
            result["errors"].append(f"usbmux list failed: {type(exc).__name__}: {exc}")
            result["durationMs"] = int((time.monotonic() - started) * 1000)
            self._last_scan = result
            return result

        for mux_device in mux_devices:
            entry: dict[str, Any] = {
                "deviceId": mux_device.serial,
                "udid": mux_device.serial,
                "connectionType": mux_device.connection_type,
                "isUsb": bool(getattr(mux_device, "is_usb", mux_device.connection_type == "USB")),
                "isNetwork": bool(getattr(mux_device, "is_network", mux_device.connection_type == "Network")),
                "usbmuxDeviceId": getattr(mux_device, "devid", None),
                "identity": None,
                "stages": {
                    # A usbmuxd entry is proof of *a* link, not of the cable: a phone that
                    # only appears with connection type Network has no USB presence, and
                    # claiming one would put a check mark on a stage nobody observed.
                    "usbDetected": mux_device.connection_type == "USB",
                    "paired": None,
                    "trusted": None,
                    "developerModeEnabled": None,
                    "developerServiceAvailable": None,
                    "simulationReady": None,
                    "wirelessReachable": None,
                    "tunnelOverWireless": None,
                },
                # What this process has proven about the device's transport. Kept out of
                # the stages block because it is not a boolean pipeline stage: it names
                # the medium a session is running on, or says nothing at all.
                "link": self.endpoint_summary(mux_device.serial),
                "issues": [],
            }
            # Seed the stages this process already measured (readiness, a previous
            # simulation) before the probe overwrites what it can verify itself.
            entry = self._apply_observed_stages(entry)
            if probe_identity:
                try:
                    entry = await self._probe_identity(mux_device.serial, entry)
                except BridgeError as exc:
                    entry["issues"].append(_issue_from_error(exc))
                except Exception as exc:  # noqa: BLE001 - one bad device must not break the scan
                    logger.exception("identity probe failed for %s", mux_device.serial)
                    entry["issues"].append(
                        {
                            "code": ErrorCode.INTERNAL,
                            "severity": "error",
                            "message": f"Identity probe failed: {type(exc).__name__}: {exc}",
                        }
                    )
            else:
                entry["stages"]["usbDetected"] = mux_device.connection_type == "USB"
            result["devices"].append(entry)

        if not mux_devices:
            result["errors"].append(
                "usbmuxd is running but reported no devices. Connect the iPhone with a data-capable cable and "
                "tap Trust on the phone if prompted."
            )

        result["durationMs"] = int((time.monotonic() - started) * 1000)
        self._last_scan = result
        return result

    async def _probe_identity(self, serial: str, entry: dict[str, Any]) -> dict[str, Any]:
        """Open lockdown read-only and fill in identity, pairing and Developer Mode.

        The usbmux connection type is pinned to the one this scan entry came from.
        Without pinning, a scan entry that usbmuxd reported as ``Network`` could be
        probed through the cable if that happened to be present, and the identity
        would then be evidence about the wrong transport.
        """
        from pymobiledevice3.lockdown import create_using_usbmux

        connection_type = entry.get("connectionType")
        try:
            client = await asyncio.wait_for(
                create_using_usbmux(serial=serial, autopair=False, connection_type=connection_type),
                timeout=LOCKDOWN_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            entry["stages"]["paired"] = None
            entry["issues"].append(
                {
                    "code": ErrorCode.TIMEOUT,
                    "severity": "warning",
                    "message": f"lockdownd did not answer within {LOCKDOWN_TIMEOUT_S:.0f}s.",
                    "remedy": (
                        "Unlock the iPhone and confirm it is on the same Wi-Fi network as this PC."
                        if connection_type == "Network"
                        else "Unlock the iPhone and reconnect the USB cable."
                    ),
                }
            )
            return entry
        except Exception as exc:  # noqa: BLE001
            name = type(exc).__name__
            if name in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
                entry["stages"]["paired"] = False
                entry["stages"]["trusted"] = False
                self._invalidate_stages(entry)
                entry["issues"].append(
                    {
                        "code": ErrorCode.NOT_PAIRED,
                        "severity": "error",
                        "message": "The iPhone has not been paired with this PC.",
                        "remedy": (
                            "Unlock the iPhone, then press “Pair device”. A Trust prompt appears on the "
                            "phone; tap Trust to continue."
                        ),
                    }
                )
                return entry
            entry["stages"]["paired"] = None
            entry["issues"].append(_issue_from_error(DeviceManager._classify_lockdown_error(exc)))
            return entry

        try:
            entry["stages"]["paired"] = True
            entry["stages"]["trusted"] = True
            entry["identity"] = await self._read_identity(client)
            entry["stages"]["developerModeEnabled"] = await self._read_developer_mode(client, entry)
            entry["wifiSyncEnabled"] = await self._read_wifi_connections(client)
            self._record_proven_transport(serial, entry)
            # Negative evidence invalidates whatever was measured earlier: a device that
            # is no longer paired, or has Developer Mode switched off, cannot be simulating.
            if entry["stages"]["developerModeEnabled"] is False:
                self._invalidate_stages(entry)
            await self._augment_capabilities(entry)
        finally:
            try:
                await client.close()
            except Exception:  # noqa: BLE001 - best-effort
                logger.debug("error closing lockdown client", exc_info=True)
        return entry

    async def _read_wifi_connections(self, client: Any) -> Optional[bool]:
        """Read the iPhone's own "allow Wi-Fi sync" setting. Unknown stays unknown."""
        try:
            return bool(await asyncio.wait_for(client.get_enable_wifi_connections(), timeout=10.0))
        except Exception:  # noqa: BLE001 - not every iOS version answers this query
            return None

    def _record_proven_transport(self, device_id: str, entry: dict[str, Any]) -> None:
        """Record the medium this scan entry's lockdown session actually answered on.

        A ``Network`` usbmux entry that completed a lockdown handshake is a measurement of
        the Wi-Fi path. A ``USB`` entry is not evidence about Wi-Fi at all, so
        ``wirelessReachable`` stays unknown for it rather than being inferred from pairing.
        Nothing here selects a transport: a scan observes, it does not choose.
        """
        connection_type = entry.get("connectionType")
        product_version = (entry.get("identity") or {}).get("productVersion")
        if connection_type == "Network":
            self.record_proven_transport(device_id, TRANSPORT_WIFI_MUX, product_version=product_version)
            # The handshake that just completed *is* this entry, so record the stage on it
            # directly: `record_stages` can only mirror into the entries of the previous
            # scan, which would leave the card showing "not checked" right after a
            # measurement of the Wi-Fi path succeeded.
            entry["stages"]["wirelessReachable"] = True
            self.record_stages(device_id, wirelessReachable=True)
        elif connection_type == "USB":
            self.record_proven_transport(device_id, TRANSPORT_USB, product_version=product_version)

    @staticmethod
    def _classify_lockdown_error(exc: Exception) -> BridgeError:
        name = type(exc).__name__
        if name in {"ConnectionFailedToUsbmuxdError", "MuxException", "DeviceNotFoundError"}:
            return BridgeError(
                ErrorCode.DEVICE_DISCONNECTED,
                "The iPhone went away before lockdownd could be reached.",
                f"{name}: {exc}",
                retryable=True,
            )
        return BridgeError(
            ErrorCode.INTERNAL,
            "Could not read device identity over lockdown.",
            f"{name}: {exc}",
        )

    async def _read_identity(self, client: Any) -> dict[str, Any]:
        values: dict[str, Any] = {}
        for key in IDENTITY_KEYS:
            try:
                values[key] = await asyncio.wait_for(client.get_value(key=key), timeout=LOCKDOWN_TIMEOUT_S)
            except Exception:  # noqa: BLE001 - individual keys are optional
                values[key] = None
        product_type = values.get("ProductType")
        return {
            "deviceName": values.get("DeviceName") or "iPhone",
            "productType": product_type,
            "modelName": _friendly_model(product_type),
            "productVersion": values.get("ProductVersion"),
            "buildVersion": values.get("BuildVersion"),
            "deviceClass": values.get("DeviceClass"),
            "cpuArchitecture": values.get("CPUArchitecture"),
            "hardwareModel": values.get("HardwareModel"),
            "regionInfo": values.get("RegionInfo"),
            "passcodeSet": values.get("PasswordProtected"),
            "activationState": values.get("ActivationState"),
            "iosMajor": ios_major_version(values.get("ProductVersion")),
        }

    async def _read_developer_mode(self, client: Any, entry: dict[str, Any]) -> Optional[bool]:
        try:
            enabled = await asyncio.wait_for(client.get_developer_mode_status(), timeout=10.0)
        except Exception as exc:  # noqa: BLE001
            entry["issues"].append(
                {
                    "code": ErrorCode.INTERNAL,
                    "severity": "info",
                    "message": f"Developer Mode status could not be read: {type(exc).__name__}: {exc}",
                }
            )
            return None
        if enabled is False:
            entry["issues"].append(
                {
                    "code": ErrorCode.DEVELOPER_MODE_DISABLED,
                    "severity": "error",
                    "message": "Developer Mode is disabled on the iPhone.",
                    "remedy": (
                        "On the iPhone open Settings → Privacy & Security → Developer Mode, turn it on, "
                        "then restart the phone. Location simulation cannot work without it."
                    ),
                }
            )
        return bool(enabled)

    async def _augment_capabilities(self, entry: dict[str, Any]) -> None:
        """Record which developer transport this iOS version needs. No device traffic."""
        identity = entry.get("identity") or {}
        product_version = identity.get("productVersion")
        needs = requires_tunnel(product_version)
        connection_type = entry.get("connectionType")
        wireless = connection_type == "Network"
        entry["transport"] = {
            "requiresRsdTunnel": needs,
            "planned": "userspace-rsd-tunnel" if needs else "lockdown-developer-service",
            "rationale": (
                f"iOS {product_version} exposes DVT developer services through RemoteServiceDiscovery, "
                "which needs a tunnel."
                if needs
                else f"iOS {product_version} still exposes com.apple.dt.simulatelocation over lockdown."
            ),
            # The medium this entry was observed on, and what that implies for a tunnel.
            "observedOver": connection_type,
            "wireless": wireless,
            "wifiSyncEnabledOnPhone": entry.get("wifiSyncEnabled"),
            "tunnelNote": (
                "The userspace tunnel is opened from this network entry, so developer services "
                "run over Wi-Fi with the cable unplugged."
                if wireless and needs
                else "The tunnel would be opened over the cable."
                if needs
                else "No tunnel is used on this iOS version."
            ),
        }
        # Refreshed after the probe: a session may have opened while the scan was running,
        # and the link a report shows must be the one true at report time.
        entry["link"] = self.endpoint_summary(entry.get("deviceId"))

    # ------------------------------------------------------------ capabilities

    async def get_capabilities(
        self, device_id: Optional[str] = None, *, deep: bool = False, transport: Optional[str] = None
    ) -> dict[str, Any]:
        """Return the capability matrix, optionally deep-probed for one device."""
        entries = self._capability_matrix()
        report: dict[str, Any] = {
            "deviceId": device_id,
            "generatedAt": _now_iso(),
            "capabilities": entries,
            "provenance": CAPABILITY_PROVENANCE,
            "deepProbe": None,
        }
        if deep and device_id:
            try:
                report["deepProbe"] = await self.check_readiness(device_id, transport=transport)
            except BridgeError as exc:
                report["deepProbe"] = {"error": exc.to_dict()}
        return report

    @staticmethod
    def _capability_matrix() -> list[dict[str, Any]]:
        """One row per device operation the UI can expose.

        ``status`` values are deliberately conservative:

        ``verified_hardware``
            exercised end-to-end against a physical iPhone from this codebase.
            Every such row below was reproduced on 2026-10-18 against an
            iPhone17,1 (iPhone 16 Pro) running iOS 27.0.1 build 24A446 on
            Windows 11 build 26300; see docs/ACCEPTANCE.md.
        ``documented``
            the upstream API exists and is implemented here, but this codebase
            has not run it against hardware (no compatible device was available).
        ``unknown``
            neither confirmed nor denied - treated as unsupported by the UI.
        ``unsupported``
            the protocol does not offer the operation.
        """
        return [
            {
                "id": "usb_discovery",
                "name": "USB iPhone discovery",
                "status": VERIFIED_HARDWARE,
                "evidence": "usbmuxd on Windows 11 (build 26300) reported the attached iPhone17,1 over USB.",
                "notes": "The device list is produced by usbmuxd; it is never cached across sessions.",
            },
            {
                "id": "device_identity",
                "name": "Model, iOS version and build",
                "status": VERIFIED_HARDWARE,
                "evidence": "lockdownd reported ProductType iPhone17,1, ProductVersion 27.0.1, BuildVersion 24A446.",
                "notes": "Read-only lockdown query. No profile or configuration is written.",
            },
            {
                "id": "pairing",
                "name": "Pairing state detection",
                "status": VERIFIED_HARDWARE,
                "evidence": "lockdownd accepted the existing pairing record (paired=true, trusted=true) on the test device.",
                "notes": "Read-only: the app never removes or rewrites a pairing record.",
            },
            {
                "id": "pairing_trust_prompt",
                "name": "Starting a new pairing (Trust prompt)",
                "status": DOCUMENTED,
                "evidence": "Implemented with the upstream autopair flow; not exercised here because the test device is already paired.",
                "notes": "Pairing is only ever started by an explicit user action in the Device workspace.",
            },
            {
                "id": "developer_mode_read",
                "name": "Developer Mode detection",
                "status": VERIFIED_HARDWARE,
                "evidence": "Reported true by the test device over lockdown.",
                "notes": "Location Studio never enables Developer Mode; that setting is only on the iPhone.",
            },
            {
                "id": "userspace_tunnel",
                "name": "No-admin developer tunnel (iOS 17+)",
                "status": VERIFIED_HARDWARE,
                "evidence": "An RSD tunnel was established from a non-elevated Windows process; readiness reported the DVT service port.",
                "notes": "Pure-Python userspace stack. No TUN/TAP driver, no administrator rights.",
            },
            {
                "id": "set_location",
                "name": "Set a fixed simulated location",
                "status": VERIFIED_HARDWARE,
                "evidence": (
                    "simulateLocationWithLatitude:longitude: was acknowledged, and Google Maps on the device "
                    "displayed the simulated position (docs/reports/evidence/maps-paris-visual-proof.png)."
                ),
                "notes": "Applies while the developer session is open. Altitude is not part of this API.",
            },
            {
                "id": "clear_location",
                "name": "Stop and restore real GPS",
                "status": VERIFIED_HARDWARE,
                "evidence": "Stop reported deviceCleared=true and locationOverrideActive=false on the test device.",
                "notes": "Also ends automatically if the USB cable is pulled or the session dies.",
            },
            {
                "id": "route_playback",
                "name": "Route playback",
                "status": VERIFIED_HARDWARE,
                "evidence": "130 interpolated updates over 636.4 m completed in 25.55 s at 25 m/s (estimated 25.46 s).",
                "notes": (
                    "Location Studio interpolates the route and publishes discrete updates; the device has no "
                    "native GPX player over this channel."
                ),
            },
            {
                "id": "pause_resume",
                "name": "Pause / resume a running route",
                "status": VERIFIED_HARDWARE,
                "evidence": "Pause held the published point count at 31 for 3 s; resume continued to completion.",
                "notes": (
                    "Granularity is one update interval. While paused the iPhone keeps reporting the last "
                    "published coordinate - it is not released back to the real GPS until Stop."
                ),
            },
            {
                "id": "speed_control",
                "name": "Movement speed control",
                "status": VERIFIED_HARDWARE,
                "evidence": "Playback finished 0.09 s later than the 25.46 s estimate computed for the configured speed.",
                "notes": "The device receives interpolated coordinates; it has no speed parameter of its own.",
            },
            {
                "id": "altitude",
                "name": "Altitude override",
                "status": UNSUPPORTED,
                "evidence": "The DVT selector is simulateLocationWithLatitude:longitude: - there is no altitude argument.",
                "notes": "Altitude is kept in GPX exports and previews only. It is never sent to the device.",
            },
            {
                "id": "device_screenshot",
                "name": "Device screenshot (visual verification)",
                "status": VERIFIED_HARDWARE,
                "evidence": "Screenshots were captured from the test device, including one showing Maps at the simulated position.",
                "notes": "A locked iPhone returns its lock screen; unlock it for on-screen verification of the position.",
            },
            {
                "id": "legacy_lockdown_simulation",
                "name": "iOS 16 and older simulation path",
                "status": DOCUMENTED,
                "evidence": "com.apple.dt.simulatelocation is implemented in the pinned library and in this bridge.",
                "notes": "Not hardware-tested here: the only available test device runs iOS 27.",
            },
            {
                "id": "wifi_device_discovery",
                "name": "Wi-Fi iPhone discovery",
                "status": DOCUMENTED,
                "evidence": (
                    "usbmuxd exposes devices with connection type Network, and this bridge separates them from "
                    "USB entries in every scan and probe. No wireless-capable iPhone was attached while this "
                    "build was verified, so no network entry was observed from this PC."
                ),
                "notes": (
                    "A USB pairing does not turn this on: “Sync with this iPhone over Wi-Fi” must be enabled "
                    "once per device, and the phone has to be on this network and unlocked."
                ),
            },
            {
                "id": "wifi_lockdown_identity",
                "name": "Model and iOS version over Wi-Fi",
                "status": DOCUMENTED,
                "evidence": (
                    "Lockdown requests pin the usbmux connection type, so an identity read this way can only "
                    "come from the network entry. The same queries were verified over USB on the test device."
                ),
                "notes": "Read-only. Nothing is written to the device and no pairing record is modified.",
            },
            {
                "id": "wifi_multicast_dns",
                "name": "Wireless discovery diagnostics (multicast DNS)",
                "status": DOCUMENTED,
                "evidence": (
                    "The bridge probes outbound multicast DNS and reports per-interface failures, so “no answers” "
                    "and “this PC cannot ask” are told apart instead of being guessed."
                ),
                "notes": "Firewalls, VPN adapters and client-isolated guest networks block UDP 5353.",
            },
            {
                "id": "wifi_tunnel",
                "name": "Developer tunnel over Wi-Fi (iOS 17+)",
                "status": UNKNOWN,
                "evidence": (
                    "The userspace tunnel is opened from the usbmuxd entry it is given, and a network entry "
                    "routes that pipe over Wi-Fi. This codebase has not established one without a cable."
                ),
                "notes": (
                    "Location Studio refuses to call a session wireless while the cable is attached, because "
                    "usbmuxd prefers the USB entry and the result would prove nothing about Wi-Fi."
                ),
            },
            {
                "id": "wifi_device_simulation",
                "name": "Location simulation over Wi-Fi",
                "status": UNKNOWN,
                "evidence": (
                    "Simulation needs the DVT developer service, which is only reachable through the tunnel "
                    "above. Nothing here has been exercised on a wireless device."
                ),
                "notes": (
                    "The app offers wireless simulation only after a readiness check reaches the developer "
                    "service over the wireless endpoint; until then the button stays disabled and the state "
                    "remains unknown."
                ),
            },
            {
                "id": "rsd_lan_direct",
                "name": "RemoteServiceDiscovery directly over the LAN",
                "status": UNKNOWN,
                "evidence": (
                    "The bridge can complete the RemoteServiceDiscovery handshake at an address the phone "
                    "advertised, and reads only the identity that handshake returned. No DVT location command "
                    "has ever been sent over such a session from this codebase."
                ),
                "notes": "Needs iOS 17+, a private network, and a RemotePairing record made once over USB.",
            },
        ]

    # --------------------------------------------------------------- readiness

    def record_stages(self, device_id: str, **stages: Optional[bool]) -> None:
        """Remember stages that were measured outside a scan.

        ``None`` values are ignored, so an unmeasured stage stays unknown instead of
        turning into a claim. Facts are kept per UDID and mirrored into the last scan
        so the device list can show them without another discovery round-trip.
        """
        known = {key for key in self._stage_keys()}
        recorded = {key: bool(value) for key, value in stages.items() if value is not None and key in known}
        if not recorded:
            return
        self._observed_stages.setdefault(device_id, {}).update(recorded)
        for entry in self._last_scan.get("devices", []):
            if entry.get("deviceId") == device_id:
                entry["stages"].update(recorded)

    def forget_stages(self, device_id: str) -> None:
        """Drop remembered stages for one device after evidence invalidated them."""
        self._observed_stages.pop(device_id, None)

    def _invalidate_stages(self, entry: dict[str, Any]) -> None:
        """Forget measured stages and clear them on this scan entry as well.

        The wireless facts go too: a device that no longer trusts this PC, or has Developer
        Mode switched off, is not usable over any transport.
        """
        device_id = entry.get("deviceId")
        self.forget_stages(device_id)
        self.forget_endpoint(device_id)
        self._proven.pop(device_id, None)
        entry["stages"].update(
            {
                "developerServiceAvailable": None,
                "simulationReady": None,
                "wirelessReachable": None,
                "tunnelOverWireless": None,
            }
        )
        if entry.get("link") is not None:
            entry["link"] = self.endpoint_summary(device_id)

    def _apply_observed_stages(self, entry: dict[str, Any]) -> dict[str, Any]:
        """Overlay stages measured earlier in this process onto a fresh scan entry."""
        recorded = self._observed_stages.get(entry.get("deviceId"))
        if recorded:
            entry["stages"].update(recorded)
        return entry

    @staticmethod
    def _stage_keys() -> set[str]:
        return {
            "usbDetected",
            "paired",
            "trusted",
            "developerModeEnabled",
            "developerServiceAvailable",
            "simulationReady",
            "wirelessReachable",
            "tunnelOverWireless",
        }

    async def check_readiness(
        self, device_id: str, *, open_tunnel: bool = True, transport: Optional[str] = None
    ) -> dict[str, Any]:
        """Deep check: everything needed to simulate location, measured, not assumed.

        ``transport`` pins the check to one medium, and pinning is not cosmetic: when both
        a cable and a network entry exist, usbmuxd answers on the cable, so an unpinned
        "Wi-Fi" check could pass over USB and report a wireless success that never
        happened. Without it, the transport an explicit connect selected is reused, and if
        nothing was ever selected the check follows what is attached (a cable wins).
        """
        udid = validate_udid(device_id)
        chosen = self.requested_endpoint(udid, transport)
        lan_transport = chosen is not None and chosen.transport == TRANSPORT_RSD_LAN
        checks: list[dict[str, Any]] = []

        def add(check_id: str, ok: Optional[bool], label: str, detail: str = "", remedy: str = "") -> None:
            checks.append(
                {
                    "id": check_id,
                    "ok": ok,
                    "label": label,
                    "detail": detail,
                    # A remedy is only useful when something is actually wrong.
                    "remedy": (remedy or None) if ok is False else None,
                }
            )

        # 1. the Apple Mobile Device Service, which is what enumerates iPhones on Windows
        usbmux_state = await self._usbmux_state()
        available = bool(usbmux_state.get("available"))
        add(
            "usbmux",
            available if not lan_transport else (True if available else None),
            "usbmuxd reachable",
            usbmux_state.get("address", "")
            or usbmux_state.get("error", "")
            or ("not used by this transport" if lan_transport else ""),
            usbmux_state.get("remedy", ""),
        )

        endpoint: Endpoint = chosen if chosen is not None else usb_endpoint(udid)
        device_entry: dict[str, Any] = {"transport": endpoint.transport}
        identity: dict[str, Any] = {}
        lan_host: Optional[str] = None

        # 2. the device, on *this* transport
        if lan_transport:
            # The address has to come from an advertisement the phone sent on this network
            # just now; a remembered one is not proof that it is still reachable.
            probe = await self.wireless.probe(device_id=udid, prove_lockdown=False)
            advertised = next(
                (device for device in probe["transports"][TRANSPORT_RSD_LAN]["devices"] if device["deviceId"] == udid),
                None,
            )
            lan_host = advertised["address"] if advertised else None
            add(
                "device_present",
                advertised is not None,
                "iPhone reachable on this network",
                (
                    f"{_shown_id(udid)} advertised RemoteServiceDiscovery at {lan_host}."
                    if advertised
                    else f"No _remoted._tcp advertisement resolved for {_shown_id(udid)}."
                ),
                WIRELESS_PREREQUISITES[TRANSPORT_RSD_LAN],
            )
            if advertised is None:
                return _readiness_result(udid, checks, device_entry, ready=False, endpoint=endpoint)
            identity = {
                "deviceName": "iPhone",
                "productType": advertised.get("productType"),
                "modelName": _friendly_model(advertised.get("productType")),
                "productVersion": advertised.get("osVersion"),
                "buildVersion": None,
                "deviceClass": "iPhone",
                "iosMajor": ios_major_version(advertised.get("osVersion")),
            }
            add(
                "paired",
                None,
                "Paired with this PC",
                "Trust on this transport is proven by the RemotePairing handshake of the developer session, "
                "which lockdown over usbmux cannot show.",
            )
        elif available:
            from pymobiledevice3 import usbmux

            devices = await asyncio.wait_for(usbmux.list_devices(), timeout=10.0)
            matching = [device for device in devices if device.matches_udid(udid)]
            if chosen is None:
                endpoint = self.default_endpoint(udid, [str(device.connection_type) for device in matching])
                device_entry["transport"] = endpoint.transport
            wanted = endpoint.connection_type
            pinned = [device for device in matching if getattr(device, "connection_type", None) == wanted]
            device_entry["connectionType"] = (
                pinned[0].connection_type if pinned else matching[0].connection_type if matching else None
            )
            medium = "the USB cable" if wanted == "USB" else "Wi-Fi"
            others = ", ".join(sorted({str(d.connection_type) for d in matching}))
            if pinned:
                where = f"usbmuxd lists {_shown_id(udid)} with connection type {wanted}."
            elif matching:
                where = (
                    f"usbmuxd lists {_shown_id(udid)}, but only as {others} - not as {wanted}, "
                    "which is the endpoint this session would use."
                )
            else:
                where = (
                    f"usbmuxd no longer lists {_shown_id(udid)} on any transport. "
                    "The iPhone left the device list while this check was running."
                )
            add(
                "device_present",
                bool(pinned),
                f"iPhone visible over {medium}",
                where,
                (
                    WIRELESS_PREREQUISITES[endpoint.transport]
                    if endpoint.is_wireless
                    else "Reconnect the cable, then refresh."
                ),
            )
            if not pinned:
                return _readiness_result(udid, checks, device_entry, ready=False, endpoint=endpoint)
            if endpoint.is_wireless and any(device.connection_type == "USB" for device in matching):
                # The one situation in which a wireless success would be a lie.
                add(
                    "cable_free",
                    False,
                    "Cable is unplugged",
                    "usbmuxd also lists a USB entry for this iPhone, and it prefers that one, so a tunnel "
                    "opened now would say nothing about the Wi-Fi path.",
                    "Unplug the cable, wait a few seconds for the network entry to settle, then run the "
                    "check again.",
                )
                return _readiness_result(udid, checks, device_entry, ready=False, endpoint=endpoint)

        # 3. lockdown identity + pairing
        if not lan_transport:
            try:
                from pymobiledevice3.lockdown import create_using_usbmux

                client = await asyncio.wait_for(
                    create_using_usbmux(serial=udid, autopair=False, connection_type=endpoint.connection_type),
                    timeout=LOCKDOWN_TIMEOUT_S,
                )
                try:
                    identity = await self._read_identity(client)
                    add(
                        "paired",
                        True,
                        "Paired with this PC",
                        f"A valid pairing record was accepted over {device_entry.get('connectionType') or 'usbmux'}.",
                    )
                    try:
                        developer_mode = await asyncio.wait_for(client.get_developer_mode_status(), timeout=10.0)
                    except Exception as exc:  # noqa: BLE001
                        developer_mode = None
                        add(
                            "developer_mode",
                            None,
                            "Developer Mode",
                            f"Could not be read: {type(exc).__name__}: {exc}",
                        )
                    else:
                        add(
                            "developer_mode",
                            bool(developer_mode),
                            "Developer Mode enabled",
                            "Reported by the device." if developer_mode else "Developer Mode is off on the iPhone.",
                            "Enable Settings → Privacy & Security → Developer Mode on the iPhone, then restart it.",
                        )
                    wifi_sync = await self._read_wifi_connections(client)
                    if endpoint.is_wireless:
                        add(
                            "wireless_link",
                            True,
                            "iPhone answers over Wi-Fi",
                            "lockdownd completed a session through the usbmuxd network entry with the cable out.",
                        )
                    elif wifi_sync is not None:
                        add(
                            "wifi_sync_setting",
                            wifi_sync,
                            "Wi-Fi sync enabled on the iPhone",
                            "Read from the iPhone's own setting over the cable."
                            if wifi_sync
                            else "The iPhone has not been told to sync over Wi-Fi yet.",
                            WIRELESS_PREREQUISITES[TRANSPORT_WIFI_MUX],
                        )
                finally:
                    await client.close()
            except Exception as exc:  # noqa: BLE001
                error = DeviceManager._classify_lockdown_error(exc)
                if error.code == ErrorCode.NOT_PAIRED or type(exc).__name__ in {
                    "NotPairedError",
                    "PairingError",
                    "PasscodeRequiredError",
                }:
                    add(
                        "paired",
                        False,
                        "Paired with this PC",
                        "lockdownd refused the session because the device is not paired.",
                        "Unlock the iPhone and press Pair device, then tap Trust on the phone.",
                    )
                else:
                    add("paired", False, "Paired with this PC", f"{type(exc).__name__}: {exc}")

        if not identity.get("productVersion"):
            return _readiness_result(udid, checks, device_entry, ready=False, identity=identity, endpoint=endpoint)

        reached = Endpoint(
            device_id=udid,
            transport=endpoint.transport,
            host=lan_host,
            product_version=identity.get("productVersion"),
        )
        self.record_proven_transport(
            udid, endpoint.transport, product_version=identity.get("productVersion")
        )
        # Only a transport the caller named by itself becomes the choice for later
        # commands; an auto-resolved one is recorded as a fact but not selected, so a
        # check can never quietly redirect a simulation.
        if transport:
            self.select_endpoint(reached)
        endpoint = reached
        device_entry["transport"] = endpoint.transport

        needs_tunnel = requires_tunnel(identity.get("productVersion"))
        add(
            "transport",
            True,
            "Transport in use",
            (
                f"{TRANSPORT_LABELS.get(endpoint.transport, endpoint.transport)}; iOS "
                f"{identity['productVersion']} needs the RemoteServiceDiscovery tunnel."
                if needs_tunnel
                else f"{TRANSPORT_LABELS.get(endpoint.transport, endpoint.transport)}; iOS "
                f"{identity['productVersion']} still offers com.apple.dt.simulatelocation over lockdown."
            ),
        )

        if not open_tunnel:
            add("developer_service", None, "Developer service", "Skipped: no tunnel requested.")
            return _readiness_result(udid, checks, device_entry, ready=False, identity=identity, endpoint=endpoint)

        # 4. the real test: reach the developer service over this transport
        tunnel_up = False
        try:
            if needs_tunnel:
                if lan_transport:
                    rsd, lan_identity = await self._tunnels.open_lan_rsd(lan_host, udid)
                    identity = {**identity, **{key: value for key, value in lan_identity.items() if value}}
                    tunnel_label = "RemoteServiceDiscovery session up"
                    tunnel_detail = (
                        "The iPhone's own LAN endpoint completed the RSD handshake. No tunnel driver and "
                        "no administrator rights were used."
                    )
                else:
                    rsd = await self._tunnels.acquire(udid, endpoint=endpoint)
                    tunnel_label = "Developer tunnel up"
                    tunnel_detail = (
                        "Userspace RSD tunnel established without administrator rights over "
                        f"{TRANSPORT_LABELS.get(endpoint.transport, endpoint.transport)}."
                    )
                tunnel_up = True
                service_name = "com.apple.instruments.dtservicehub"
                port = None
                try:
                    port = rsd.get_service_port(service_name)
                except Exception:  # noqa: BLE001
                    port = None
                add("tunnel", True, tunnel_label, tunnel_detail)
                add(
                    "developer_service",
                    port is not None,
                    "DVT developer service reachable",
                    f"{service_name} port {port}" if port else f"{service_name} is not advertised by the device.",
                    "Update iOS, keep the phone unlocked, then retry.",
                )
            else:
                add(
                    "developer_service",
                    None,
                    "Developer service (legacy path)",
                    "iOS 16 and older uses com.apple.dt.simulatelocation; the service is opened per command.",
                )
        except BridgeError as exc:
            add("tunnel", False, "Developer tunnel up", f"{exc.message} {exc.details or ''}".strip(), exc.remedy or "")
            add("developer_service", False, "DVT developer service reachable", "Not attempted: no tunnel.")

        required_ids = {"device_present", "developer_service"} if lan_transport else {"usbmux", "device_present", "paired", "developer_service"}
        ready = all(check["ok"] is True for check in checks if check["id"] in required_ids)
        # Only report what this check actually measured: if the developer service was
        # not probed (no tunnel requested, or the legacy per-command path), the stages
        # stay as they were instead of being guessed.
        measured: dict[str, bool] = {}
        developer_service = next((check for check in checks if check["id"] == "developer_service"), None)
        if developer_service is not None and developer_service["ok"] is not None:
            measured = {
                "developerServiceAvailable": bool(developer_service["ok"]),
                "simulationReady": ready,
            }
            if endpoint.is_wireless:
                measured["wirelessReachable"] = bool(developer_service["ok"]) or tunnel_up
                measured["tunnelOverWireless"] = tunnel_up
            self.record_stages(udid, **measured)
        return _readiness_result(
            udid, checks, device_entry, ready=ready, identity=identity, stages=measured, endpoint=endpoint
        )


def _readiness_result(
    udid: str,
    checks: list[dict[str, Any]],
    device_entry: dict[str, Any],
    *,
    ready: bool,
    identity: Optional[dict[str, Any]] = None,
    stages: Optional[dict[str, Any]] = None,
    endpoint: Optional[Endpoint] = None,
) -> dict[str, Any]:
    blocking = [check for check in checks if check["ok"] is False]
    return {
        "deviceId": udid,
        "ready": ready,
        "checks": checks,
        "blocking": blocking,
        "identity": identity or None,
        "connectionType": device_entry.get("connectionType"),
        # Which medium this check was performed over. A report that did not name it could
        # be read as "wireless" by anyone looking at a green result after the cable was
        # plugged back in.
        "transport": getattr(endpoint, "transport", None),
        "transportLabel": TRANSPORT_LABELS.get(endpoint.transport, endpoint.transport) if endpoint else None,
        "wireless": bool(endpoint.is_wireless) if endpoint else False,
        "checkedAt": _now_iso(),
        # The stages this check measured, so a caller can update its device list with
        # facts instead of starting another scan.
        "stages": stages or {},
        "summary": (
            "All prerequisites for location simulation are satisfied."
            if ready
            else (blocking[0]["label"] + ": " + (blocking[0]["detail"] or "not satisfied")) if blocking else "Prerequisites could not be confirmed."
        ),
    }


def _issue_from_error(error: BridgeError) -> dict[str, Any]:
    return {
        "code": error.code,
        "severity": "error",
        "message": error.message,
        "detail": error.details,
        "remedy": error.remedy,
    }


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _bridge_version() -> str:
    from . import __version__

    return __version__
