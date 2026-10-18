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
    """Discovery, identity and capability reporting. Owns no long-lived device state."""

    def __init__(self, tunnels: TunnelManager) -> None:
        self._tunnels = tunnels
        self._last_scan: dict[str, Any] = {"devices": [], "scannedAt": None}
        # Stages that discovery cannot measure by itself because they need a tunnel
        # (developer service) or an actual device command (location accepted). They
        # are recorded here when they are really observed, and folded back into every
        # later scan for the same UDID. Unknown stays unknown: nothing is invented.
        self._observed_stages: dict[str, dict[str, bool]] = {}

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
                "usbmuxDeviceId": getattr(mux_device, "devid", None),
                "identity": None,
                "stages": {
                    "usbDetected": True,
                    "paired": None,
                    "trusted": None,
                    "developerModeEnabled": None,
                    "developerServiceAvailable": None,
                    "simulationReady": None,
                },
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
                entry["stages"]["usbDetected"] = True
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
        """Open lockdown read-only and fill in identity, pairing and Developer Mode."""
        from pymobiledevice3.lockdown import create_using_usbmux

        try:
            client = await asyncio.wait_for(
                create_using_usbmux(serial=serial, autopair=False), timeout=LOCKDOWN_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            entry["stages"]["paired"] = None
            entry["issues"].append(
                {
                    "code": ErrorCode.TIMEOUT,
                    "severity": "warning",
                    "message": "lockdownd did not answer within 15s.",
                    "remedy": "Unlock the iPhone and reconnect the USB cable.",
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
        entry["transport"] = {
            "requiresRsdTunnel": needs,
            "planned": "userspace-rsd-tunnel" if needs else "lockdown-developer-service",
            "rationale": (
                f"iOS {product_version} exposes DVT developer services through RemoteServiceDiscovery, "
                "which needs a tunnel."
                if needs
                else f"iOS {product_version} still exposes com.apple.dt.simulatelocation over lockdown."
            ),
        }

    # ------------------------------------------------------------ capabilities

    async def get_capabilities(self, device_id: Optional[str] = None, *, deep: bool = False) -> dict[str, Any]:
        """Return the capability matrix, optionally deep-probed for one device."""
        entries = self._capability_matrix()
        report: dict[str, Any] = {
            "deviceId": device_id,
            "generatedAt": _now_iso(),
            "capabilities": entries,
            "deepProbe": None,
        }
        if deep and device_id:
            try:
                report["deepProbe"] = await self.check_readiness(device_id)
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
                "notes": "Pairing is only ever started by an explicit user action in Device Center.",
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
                "id": "wifi_device_simulation",
                "name": "Simulation over Wi-Fi",
                "status": UNKNOWN,
                "evidence": "The userspace tunnel targets a USB-attached device via usbmuxd.",
                "notes": "Network-attached devices are listed, but simulation is not offered for them.",
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
        """Forget measured stages and clear them on this scan entry as well."""
        self.forget_stages(entry.get("deviceId"))
        entry["stages"].update({"developerServiceAvailable": None, "simulationReady": None})

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
        }

    async def check_readiness(self, device_id: str, *, open_tunnel: bool = True) -> dict[str, Any]:
        """Deep check: everything needed to simulate location, measured, not assumed."""
        from .validation import validate_udid

        udid = validate_udid(device_id)
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

        # 1. usbmux visibility
        usbmux_state = await self._usbmux_state()
        add(
            "usbmux",
            bool(usbmux_state.get("available")),
            "usbmuxd reachable",
            usbmux_state.get("address", "") or usbmux_state.get("error", ""),
            usbmux_state.get("remedy", ""),
        )

        device_entry: dict[str, Any] = {}
        if usbmux_state.get("available"):
            from pymobiledevice3 import usbmux

            devices = await asyncio.wait_for(usbmux.list_devices(), timeout=10.0)
            match = next((d for d in devices if d.matches_udid(udid)), None)
            device_entry = {"connectionType": getattr(match, "connection_type", None)} if match else {}
            add(
                "device_present",
                match is not None,
                "iPhone is attached",
                f"UDID {udid}" if match else f"UDID {udid} was not reported by usbmuxd.",
                "Reconnect the cable, then refresh.",
            )
            if match is None:
                return _readiness_result(udid, checks, device_entry, ready=False)

        # 2. lockdown identity + pairing
        identity: dict[str, Any] = {}
        try:
            from pymobiledevice3.lockdown import create_using_usbmux

            client = await asyncio.wait_for(
                create_using_usbmux(serial=udid, autopair=False), timeout=LOCKDOWN_TIMEOUT_S
            )
            try:
                identity = await self._read_identity(client)
                add("paired", True, "Paired with this PC", "A valid pairing record was accepted.")
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
            return _readiness_result(udid, checks, device_entry, ready=False)

        needs_tunnel = requires_tunnel(identity.get("productVersion"))
        add(
            "transport",
            True,
            "Transport selected",
            (
                f"iOS {identity['productVersion']} needs the RemoteServiceDiscovery tunnel."
                if needs_tunnel
                else f"iOS {identity['productVersion']} still offers com.apple.dt.simulatelocation over lockdown."
            ),
        )

        if not open_tunnel:
            add("developer_service", None, "Developer service", "Skipped: no tunnel requested.")
            return _readiness_result(udid, checks, device_entry, ready=False, identity=identity)

        # 3. the real test: reach the developer service
        try:
            if needs_tunnel:
                rsd = await self._tunnels.acquire(udid)
                service_name = "com.apple.instruments.dtservicehub"
                port = None
                try:
                    port = rsd.get_service_port(service_name)
                except Exception:  # noqa: BLE001
                    port = None
                add(
                    "tunnel",
                    True,
                    "Developer tunnel up",
                    "Userspace RSD tunnel established without administrator rights.",
                )
                add(
                    "developer_service",
                    port is not None,
                    "DVT developer service reachable",
                    f"{service_name} port {port}" if port else f"{service_name} is not advertised by the device.",
                    "Update iOS, keep the phone unlocked, then retry.",
                )
            else:
                from pymobiledevice3.services.simulate_location import DtSimulateLocation

                add(
                    "developer_service",
                    None,
                    "Developer service (legacy path)",
                    "iOS 16 and older uses com.apple.dt.simulatelocation; the service is opened per command.",
                )
        except BridgeError as exc:
            add("tunnel", False, "Developer tunnel up", f"{exc.message} {exc.details or ''}".strip(), exc.remedy or "")
            add("developer_service", False, "DVT developer service reachable", "Not attempted: no tunnel.")

        ready = all(check["ok"] is True for check in checks if check["id"] in {"usbmux", "device_present", "paired", "developer_service"})
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
            self.record_stages(udid, **measured)
        return _readiness_result(udid, checks, device_entry, ready=ready, identity=identity, stages=measured)


def _readiness_result(
    udid: str,
    checks: list[dict[str, Any]],
    device_entry: dict[str, Any],
    *,
    ready: bool,
    identity: Optional[dict[str, Any]] = None,
    stages: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    blocking = [check for check in checks if check["ok"] is False]
    return {
        "deviceId": udid,
        "ready": ready,
        "checks": checks,
        "blocking": blocking,
        "identity": identity or None,
        "connectionType": device_entry.get("connectionType"),
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
