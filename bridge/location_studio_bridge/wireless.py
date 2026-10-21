"""Wireless reachability: what this PC can actually see of an iPhone over the network.

Every field this module produces comes from a probe that ran and returned. The three
states are kept strictly apart:

``True``   the probe completed and observed the thing (a usbmuxd Network entry, an mDNS
           answer, a lockdown session that finished the handshake over TCP);
``False``  the probe completed and observed the opposite (no answer, refused handshake);
``None``   the probe could not be performed or its result does not decide the question.

Nothing here assumes that pairing enables wireless communication. Pairing is per
transport: a USB pairing record does not make a device reachable over the network, and
an mDNS answer does not prove the phone accepts commands from this PC.

Privacy: pairing records, host identifiers, keys and record file paths are never read
into a report. Counts and boolean presence are the most this module exposes, and the
device names advertised by mDNS are reduced to their service type.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

from .protocol import BridgeError, ErrorCode
from .tunnel import TunnelManager, ios_major_version, requires_tunnel

logger = logging.getLogger(__name__)

TRANSPORT_USB = "usb"
#: usbmuxd's "Network" entry: the iPhone is attached through Apple's Wi-Fi sync, so
#: lockdown (and the iOS 17+ developer tunnel) runs over the LAN while the mux pipe
#: is still the local Apple Mobile Device Service.
TRANSPORT_WIFI_MUX = "wifi-mux"
#: RemoteServiceDiscovery answered directly over the LAN (no usbmux at all).
TRANSPORT_RSD_LAN = "rsd-lan"
#: Apple's mobiledevice2cli path: lockdown completed over TCP 62078 with no usbmux
#: entry involved. Provable, but not something this bridge opens a tunnel through.
TRANSPORT_MOBDEV2 = "wifi-lockdown"

TRANSPORTS = (TRANSPORT_USB, TRANSPORT_WIFI_MUX, TRANSPORT_RSD_LAN)

#: How long a single mDNS browse window stays open. pymobiledevice3 uses 2 s on Windows.
BONJOUR_TIMEOUT_S = 3.0
LOCKDOWN_TIMEOUT_S = 15.0
CONNECT_DEADLINE_S = 120.0

DVT_SERVICE_NAME = "com.apple.instruments.dtservicehub"

TRANSPORT_LABELS = {
    TRANSPORT_USB: "USB cable",
    TRANSPORT_WIFI_MUX: "Wi-Fi (Apple Mobile Device Service, network entry)",
    TRANSPORT_RSD_LAN: "Wi-Fi (RemoteServiceDiscovery over the LAN)",
    TRANSPORT_MOBDEV2: "Wi-Fi (lockdown over TCP 62078, no network mux entry)",
}

#: One paragraph of setup guidance per transport, surfaced verbatim when a probe says
#: the prerequisite is missing.
WIRELESS_PREREQUISITES = {
    TRANSPORT_WIFI_MUX: (
        "Wi-Fi communication is not enabled by a USB pairing. On the iPhone: Settings → General → "
        "iPhone Transfer or, on Windows, in the Apple Devices / iTunes device options, turn on "
        "“Sync with this iPhone over Wi-Fi”, keep the phone on the same network as this PC, and "
        "unlock it at least once after the router or the phone changed address. The Apple Mobile "
        "Device Service must then list the phone as a network device."
    ),
    TRANSPORT_RSD_LAN: (
        "The iPhone advertises RemoteServiceDiscovery over multicast DNS on the local network. This "
        "requires the phone and this PC to be on the same subnet, a private (not client-isolated) "
        "Wi-Fi network, iOS 17 or newer, and a RemotePairing record created once while the phone was "
        "connected over USB."
    ),
    TRANSPORT_USB: "Connect the iPhone with a data-capable cable, unlock it and accept the Trust prompt.",
}


@dataclass(frozen=True)
class Endpoint:
    """Where a device was last *proven* to be reachable, and through which transport."""

    device_id: str
    transport: str
    host: Optional[str] = None
    port: Optional[int] = None
    product_version: Optional[str] = None

    @property
    def connection_type(self) -> Optional[str]:
        """The usbmux connection type this endpoint demands, or None for a pure-LAN one."""
        if self.transport == TRANSPORT_USB:
            return "USB"
        if self.transport == TRANSPORT_WIFI_MUX:
            return "Network"
        return None

    @property
    def is_wireless(self) -> bool:
        return self.transport != TRANSPORT_USB

    def to_dict(self) -> dict[str, Any]:
        return {
            "deviceId": self.device_id,
            "transport": self.transport,
            "label": TRANSPORT_LABELS.get(self.transport, self.transport),
            "wireless": self.is_wireless,
            "productVersion": self.product_version,
            "host": self.host,
            "port": self.port,
            # The address is a link-local LAN address, not a secret, but the UI has no use
            # for it beyond showing where the tunnel was opened, so it stays short.
            "address": f"{self.host}:{self.port}" if self.host and self.port else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Endpoint":
        """Rebuild an endpoint from a report, so a proven transport survives JSON."""
        return cls(
            device_id=str(payload["deviceId"]),
            transport=str(payload["transport"]),
            host=payload.get("host"),
            port=payload.get("port"),
            product_version=payload.get("productVersion"),
        )


def usb_endpoint(device_id: str, product_version: Optional[str] = None) -> Endpoint:
    return Endpoint(device_id=device_id, transport=TRANSPORT_USB, product_version=product_version)


# --------------------------------------------------------------------- host probes


async def _mdns_host_state() -> dict[str, Any]:
    """Can this host send a multicast DNS query at all? Decides what "no answers" means."""
    from pymobiledevice3.bonjour import is_multicast_blocked, probe_multicast

    state: dict[str, Any] = {"usable": None, "queriesSent": None, "sendErrors": None, "blocked": None, "detail": ""}
    try:
        sent, errors = await asyncio.wait_for(probe_multicast(), timeout=15.0)
    except asyncio.TimeoutError:
        state["detail"] = "The multicast DNS probe did not finish within 15 s."
        return state
    except OSError as exc:
        state["usable"] = False
        state["detail"] = f"No multicast DNS socket could be opened: {type(exc).__name__}: {exc}"
        return state
    except Exception as exc:  # noqa: BLE001 - a probe failure is reported, never guessed around
        state["usable"] = False
        state["detail"] = f"The multicast DNS probe failed: {type(exc).__name__}: {exc}"
        return state
    state["usable"] = True
    state["queriesSent"] = sent
    state["sendErrors"] = len(errors)
    state["blocked"] = bool(is_multicast_blocked(sent, list(errors)))
    if state["blocked"]:
        state["detail"] = (
            "Every interface refused the mDNS query. Windows firewalls, VPN adapters and "
            "client-isolated guest Wi-Fi networks do this, and no wireless discovery can succeed "
            "while it does."
        )
    elif not sent:
        state["detail"] = "No interface could send an mDNS query: this PC has no usable network adapter."
    else:
        state["detail"] = f"{sent} mDNS query/queries left this host; {len(errors)} interface(s) refused."
    return state


def _pair_record_counts() -> dict[str, Any]:
    """How many pairing records exist for this host - counts only, contents are never read."""
    from pathlib import Path

    from pymobiledevice3.osu.os_utils import get_os_utils
    from pymobiledevice3.pair_records import get_home_folder

    report: dict[str, Any] = {"lockdownRecords": None, "remotePairingRecords": None, "note": ""}
    try:
        folders = [get_home_folder(), get_os_utils().pair_record_path]
    except Exception as exc:  # noqa: BLE001
        report["note"] = f"Pairing record folders could not be located: {type(exc).__name__}: {exc}"
        return report

    lockdown = 0
    remote = 0
    for folder in folders:
        try:
            if not folder or not Path(folder).is_dir():
                continue
            for entry in Path(folder).iterdir():
                name = entry.name
                if entry.is_file() and name.endswith(".plist"):
                    if name.startswith("remote_"):
                        remote += 1
                    else:
                        lockdown += 1
        except OSError:
            # The system lockdown folder is commonly unreadable without elevation. That is
            # reported as "not countable", never as "no records".
            continue
    report["lockdownRecords"] = lockdown
    report["remotePairingRecords"] = remote
    report["note"] = (
        "Counts of pairing record files visible to this process. Their contents, host identifiers "
        "and keys are never read by Location Studio."
    )
    return report


def _remote_paired_identifiers() -> list[str]:
    from pymobiledevice3.pair_records import iter_remote_paired_identifiers

    try:
        return sorted(set(iter_remote_paired_identifiers()))
    except Exception as exc:  # noqa: BLE001
        logger.debug("remote pairing identifiers could not be listed: %s", exc)
        return []


# ------------------------------------------------------------------- usbmux split


async def _mux_devices() -> list[Any]:
    from pymobiledevice3 import usbmux

    return await asyncio.wait_for(usbmux.list_devices(), timeout=12.0)


def _mux_group(devices: list[Any]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {"USB": [], "Network": [], "other": []}
    for device in devices:
        payload = {"deviceId": device.serial, "usbmuxDeviceId": getattr(device, "devid", None)}
        if device.connection_type == "USB":
            grouped["USB"].append(payload)
        elif device.connection_type == "Network":
            grouped["Network"].append(payload)
        else:
            grouped["other"].append({**payload, "connectionType": device.connection_type})
    return grouped


# ---------------------------------------------------------------- bonjour browsing


async def _browse_remoted(timeout: float) -> dict[str, Any]:
    """Ask ``remoted`` for devices advertising RSD on the LAN, and read their handshake facts."""
    from pymobiledevice3.remote.remote_service_discovery import get_remoted_devices

    out: dict[str, Any] = {"probed": False, "devices": [], "error": None}
    try:
        devices = await asyncio.wait_for(get_remoted_devices(timeout=timeout), timeout=timeout + 25.0)
    except asyncio.TimeoutError:
        out["error"] = "The RemoteServiceDiscovery browse did not finish in time."
        return out
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out["probed"] = True
    for device in devices:
        out["devices"].append(
            {
                "deviceId": device.udid,
                "productType": device.product_type,
                "osVersion": device.os_version,
                "address": device.hostname,
            }
        )
    return out


async def _browse_mobdev2(timeout: float) -> dict[str, Any]:
    """Count the devices advertising Apple's Wi-Fi sync service. Instance names are not kept."""
    from pymobiledevice3.bonjour import browse_mobdev2

    out: dict[str, Any] = {"probed": False, "advertisements": 0, "addresses": [], "error": None}
    try:
        instances = await asyncio.wait_for(browse_mobdev2(timeout=timeout), timeout=timeout + 20.0)
    except asyncio.TimeoutError:
        out["error"] = "The _apple-mobdev2._tcp browse did not finish in time."
        return out
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out["probed"] = True
    out["advertisements"] = len(instances)
    for instance in instances:
        out["addresses"].extend(address.ip for address in instance.addresses)
    return out


async def _browse_remotepairing(timeout: float) -> dict[str, Any]:
    from pymobiledevice3.bonjour import browse_remotepairing

    out: dict[str, Any] = {"probed": False, "advertisements": 0, "error": None}
    try:
        instances = await asyncio.wait_for(browse_remotepairing(timeout=timeout), timeout=timeout + 20.0)
    except asyncio.TimeoutError:
        out["error"] = "The _remotepairing._tcp browse did not finish in time."
        return out
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out["probed"] = True
    out["advertisements"] = len(instances)
    return out


# ------------------------------------------------------------------- lockdown proof


async def _lockdown_over_mux(udid: str, connection_type: str) -> tuple[dict[str, Any], Optional[str]]:
    """Open lockdown through usbmuxd pinned to one connection type.

    Pinning is the point: a session that only succeeds when ``connection_type`` is
    ``Network`` is evidence the phone really is reachable over the LAN, not that the
    cable happened to be in.
    """
    from pymobiledevice3.lockdown import create_using_usbmux

    client = await asyncio.wait_for(
        create_using_usbmux(serial=udid, autopair=False, connection_type=connection_type),
        timeout=LOCKDOWN_TIMEOUT_S,
    )
    try:
        values: dict[str, Any] = {}
        for key in ("DeviceName", "ProductType", "ProductVersion", "BuildVersion"):
            try:
                values[key] = await asyncio.wait_for(client.get_value(key=key), timeout=LOCKDOWN_TIMEOUT_S)
            except Exception:  # noqa: BLE001 - optional
                values[key] = None
        try:
            developer_mode = await asyncio.wait_for(client.get_developer_mode_status(), timeout=10.0)
        except Exception:  # noqa: BLE001
            developer_mode = None
        wifi_setting = None
        try:
            wifi_setting = bool(await client.get_enable_wifi_connections())
        except Exception:  # noqa: BLE001 - not all iOS versions answer this
            wifi_setting = None
        return (
            {
                "deviceName": values.get("DeviceName") or "iPhone",
                "productType": values.get("ProductType"),
                "productVersion": values.get("ProductVersion"),
                "buildVersion": values.get("BuildVersion"),
                "developerModeEnabled": None if developer_mode is None else bool(developer_mode),
                "wifiConnectionsEnabled": wifi_setting,
            },
            None,
        )
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            logger.debug("error closing lockdown client", exc_info=True)


async def _lockdown_over_lan(udid: str, timeout: float) -> tuple[Optional[dict[str, Any]], Optional[str], list[str]]:
    """Try Apple's mobdev2 path: browse the LAN service and complete a lockdown handshake.

    Returns ``(identity, error, candidateAddresses)``. A returned identity means the
    phone accepted this host's pairing record over TCP 62078 - the strongest wireless
    evidence available without a tunnel.
    """
    from pymobiledevice3.lockdown import get_mobdev2_lockdowns

    addresses: list[str] = []
    try:
        # An async generator, not a context manager: each item is one (address, client)
        # handshake that succeeded, and the caller owns closing the client.
        async for address, client in get_mobdev2_lockdowns(udid=udid, only_paired=True, timeout=timeout):
            addresses.append(address)
            try:
                values: dict[str, Any] = {}
                for key in ("DeviceName", "ProductType", "ProductVersion", "BuildVersion"):
                    try:
                        values[key] = await asyncio.wait_for(client.get_value(key=key), timeout=LOCKDOWN_TIMEOUT_S)
                    except Exception:  # noqa: BLE001
                        values[key] = None
                try:
                    developer_mode = await asyncio.wait_for(client.get_developer_mode_status(), timeout=10.0)
                except Exception:  # noqa: BLE001
                    developer_mode = None
                return (
                    {
                        "deviceName": values.get("DeviceName") or "iPhone",
                        "productType": values.get("ProductType"),
                        "productVersion": values.get("ProductVersion"),
                        "buildVersion": values.get("BuildVersion"),
                        "developerModeEnabled": None if developer_mode is None else bool(developer_mode),
                        "wifiConnectionsEnabled": True,
                    },
                    None,
                    addresses,
                )
            finally:
                try:
                    await client.close()
                except Exception:  # noqa: BLE001
                    logger.debug("error closing lan lockdown client", exc_info=True)
    except asyncio.TimeoutError:
        return (None, f"The mobile device (over Wi-Fi) handshake timed out after {timeout + 15:.0f}s.", addresses)
    except Exception as exc:  # noqa: BLE001
        name = type(exc).__name__
        if name in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
            return (None, f"{name}: this host has no pairing record the phone accepts over Wi-Fi.", addresses)
        return (None, f"{name}: {exc}", addresses)
    return (None, None, addresses)


# ---------------------------------------------------------------------- diagnostics


class WirelessProber:
    """Runs the wireless diagnostics and decides which transport a device can use."""

    def __init__(self, tunnels: TunnelManager) -> None:
        self._tunnels = tunnels
        self._last_probe: dict[str, Any] = {"transports": {}, "candidates": [], "probedAt": None}

    @property
    def last_probe(self) -> dict[str, Any]:
        return self._last_probe

    # ------------------------------------------------------------------ probing

    async def probe(self, *, device_id: Optional[str] = None, prove_lockdown: bool = True) -> dict[str, Any]:
        started = time.monotonic()
        timeout = BONJOUR_TIMEOUT_S

        mdns = await _mdns_host_state()
        records = _pair_record_counts()
        remote_identifiers = _remote_paired_identifiers()

        mux_error: Optional[str] = None
        grouped: dict[str, list[dict[str, Any]]] = {"USB": [], "Network": [], "other": []}
        try:
            grouped = _mux_group(await _mux_devices())
        except asyncio.TimeoutError:
            mux_error = "usbmuxd did not answer within 12 s."
        except Exception as exc:  # noqa: BLE001
            mux_error = f"{type(exc).__name__}: {exc}"

        remoted = await _browse_remoted(timeout)
        mobdev2 = await _browse_mobdev2(timeout)
        remotepairing = await _browse_remotepairing(timeout)

        transports = {
            TRANSPORT_USB: {
                "label": TRANSPORT_LABELS[TRANSPORT_USB],
                "available": bool(grouped["USB"]),
                "deviceCount": len(grouped["USB"]),
                "devices": grouped["USB"],
                "note": "usbmuxd entries whose connection type is USB." if grouped["USB"] else "No USB-attached iPhone.",
                "prerequisite": WIRELESS_PREREQUISITES[TRANSPORT_USB],
            },
            TRANSPORT_WIFI_MUX: {
                "label": TRANSPORT_LABELS[TRANSPORT_WIFI_MUX],
                "available": bool(grouped["Network"]),
                "deviceCount": len(grouped["Network"]),
                "devices": grouped["Network"],
                "note": (
                    "usbmuxd lists these iPhones as network devices, so lockdown and the iOS 17+ "
                    "developer tunnel can run with the cable unplugged."
                    if grouped["Network"]
                    else "usbmuxd reported no iPhone with connection type Network."
                ),
                "prerequisite": WIRELESS_PREREQUISITES[TRANSPORT_WIFI_MUX],
            },
            TRANSPORT_RSD_LAN: {
                "label": TRANSPORT_LABELS[TRANSPORT_RSD_LAN],
                "available": bool(remoted["devices"]),
                "deviceCount": len(remoted["devices"]),
                "devices": remoted["devices"],
                "note": (
                    "RemoteServiceDiscovery answered directly over the LAN."
                    if remoted["devices"]
                    else "No _remoted._tcp advertisement resolved into a reachable RSD."
                ),
                "error": remoted["error"],
                "prerequisite": WIRELESS_PREREQUISITES[TRANSPORT_RSD_LAN],
            },
        }

        issues: list[dict[str, Any]] = []
        if mux_error:
            issues.append(
                {
                    "code": ErrorCode.USBMUX_UNAVAILABLE,
                    "severity": "error",
                    "message": "usbmuxd could not be queried.",
                    "detail": mux_error,
                    "remedy": "Restart the Apple Mobile Device Service, then probe again.",
                }
            )
        if mdns["blocked"]:
            issues.append(
                {
                    "code": ErrorCode.MULTICAST_BLOCKED,
                    "severity": "error",
                    "message": "This PC cannot send multicast DNS queries.",
                    "detail": mdns["detail"],
                    "remedy": (
                        "Allow outbound UDP 5353 on this network profile, or move the PC and the iPhone "
                        "onto the same non-isolated Wi-Fi network. Wireless discovery cannot work until then."
                    ),
                }
            )
        elif mdns["usable"] is False:
            issues.append(
                {
                    "code": ErrorCode.WIRELESS_UNAVAILABLE,
                    "severity": "error",
                    "message": "Multicast DNS is unavailable on this host.",
                    "detail": mdns["detail"],
                    "remedy": "Confirm the network adapter is connected, then probe again.",
                }
            )
        for transport in transports.values():
            if transport.get("error"):
                issues.append(
                    {
                        "code": ErrorCode.WIRELESS_UNAVAILABLE,
                        "severity": "warning",
                        "message": f"Discovery of {transport['label']} failed.",
                        "detail": transport["error"],
                        "remedy": "Probe again after the iPhone has been unlocked on this Wi-Fi network.",
                    }
                )
        if not mobdev2["advertisements"] and mdns["usable"] and not mdns["blocked"]:
            issues.append(
                {
                    "code": ErrorCode.WIRELESS_UNAVAILABLE,
                    "severity": "info",
                    "message": "No iPhone advertised Apple's Wi-Fi sync service.",
                    "detail": "The _apple-mobdev2._tcp browse completed and returned no answers.",
                    "remedy": WIRELESS_PREREQUISITES[TRANSPORT_WIFI_MUX],
                }
            )

        candidates = await self._build_candidates(
            transports=transports,
            grouped=grouped,
            mobdev2=mobdev2,
            remote_identifiers=remote_identifiers,
            prove_lockdown=prove_lockdown,
            issues=issues,
            only_device_id=device_id,
            browse_timeout=timeout,
        )

        seen: set[str] = set()
        for transport in transports.values():
            for device in transport["devices"]:
                seen.add(device["deviceId"])
        for candidate in candidates:
            seen.add(candidate["deviceId"])

        result = {
            "probedAt": _now_iso(),
            "durationMs": int((time.monotonic() - started) * 1000),
            "requestedDeviceId": device_id,
            "host": {
                "mdns": mdns,
                "pairRecords": records,
                "remotePairingIdentifiers": len(remote_identifiers),
                "bonjourTimeoutSeconds": timeout,
            },
            "transports": transports,
            "mobdev2": mobdev2,
            "remotepairing": {**remotepairing, "recordsPresent": len(remote_identifiers)},
            "candidates": candidates,
            "seenDeviceIds": sorted(seen),
            "issues": issues,
            "tunnel": self._tunnels.status(),
        }
        result["verdict"] = self._verdict(result)
        self._last_probe = result
        return result

    async def _build_candidates(
        self,
        *,
        transports: dict[str, Any],
        grouped: dict[str, list[dict[str, Any]]],
        mobdev2: dict[str, Any],
        remote_identifiers: list[str],
        prove_lockdown: bool,
        issues: list[dict[str, Any]],
        only_device_id: Optional[str],
        browse_timeout: float,
    ) -> list[dict[str, Any]]:
        device_ids = sorted({device["deviceId"] for device in grouped["Network"]})
        if only_device_id:
            device_ids = [udid for udid in device_ids if udid == only_device_id]

        remoted_by_udid = {device["deviceId"]: device for device in transports[TRANSPORT_RSD_LAN]["devices"]}

        candidates: list[dict[str, Any]] = []
        for udid in device_ids:
            entry: dict[str, Any] = {
                "deviceId": udid,
                "seenOn": [TRANSPORT_WIFI_MUX],
                "identity": None,
                "probes": [],
                "reachableOver": [],
                "tunnel": {"required": None, "route": None, "reason": "iOS version is not known yet."},
                "capability": {
                    "wirelessLocationSimulation": None,
                    "status": "unknown",
                    "reason": "No wireless transport has completed a handshake with this iPhone.",
                },
            }
            if prove_lockdown:
                mux_result = await self._prove_wifi_mux(udid)
                entry["probes"].append(mux_result)
                if mux_result["ok"] is True:
                    entry["reachableOver"].append(TRANSPORT_WIFI_MUX)
                    entry["identity"] = mux_result["identity"]
            lan_result = await self._prove_lan_lockdown(udid, mobdev2, enabled=prove_lockdown)
            entry["probes"].append(lan_result)
            if lan_result["ok"] is True:
                entry["reachableOver"].append(TRANSPORT_MOBDEV2)
                entry["identity"] = entry["identity"] or lan_result["identity"]
            if udid in remoted_by_udid:
                entry["seenOn"].append(TRANSPORT_RSD_LAN)
                entry["identity"] = entry["identity"] or {
                    "deviceName": "iPhone",
                    "productType": remoted_by_udid[udid]["productType"],
                    "productVersion": remoted_by_udid[udid]["osVersion"],
                    "buildVersion": None,
                    "developerModeEnabled": None,
                    "wifiConnectionsEnabled": None,
                }
                entry["rsdAddress"] = remoted_by_udid[udid]["address"]
            if udid in remote_identifiers:
                entry["remotePairingRecord"] = True
            self._assess(entry)
            if entry["identity"]:
                from .device_manager import _friendly_model

                entry["modelName"] = _friendly_model(entry["identity"].get("productType"))
                entry["displayName"] = f'{entry["identity"].get("deviceName")} · {entry["modelName"]}'
            candidates.append(entry)

        # A device only visible through RSD (never through usbmuxd at all) still deserves a row.
        for udid, advertised in remoted_by_udid.items():
            if only_device_id and udid != only_device_id:
                continue
            if any(candidate["deviceId"] == udid for candidate in candidates):
                continue
            entry = {
                "deviceId": udid,
                "seenOn": [TRANSPORT_RSD_LAN],
                "reachableOver": [],
                "modelName": None,
                "displayName": f"iPhone · {advertised['productType'] or 'unknown model'}",
                "identity": {
                    "deviceName": "iPhone",
                    "productType": advertised["productType"],
                    "productVersion": advertised["osVersion"],
                    "buildVersion": None,
                    "developerModeEnabled": None,
                    "wifiConnectionsEnabled": None,
                },
                "rsdAddress": advertised["address"],
                "probes": [],
                "tunnel": {"required": True, "route": TRANSPORT_RSD_LAN, "reason": "Advertised over the LAN."},
                "capability": {
                    "wirelessLocationSimulation": None,
                    "status": "unknown",
                    "reason": "RSD was reachable but no developer service was attempted by discovery.",
                },
            }
            from .device_manager import _friendly_model

            entry["modelName"] = _friendly_model(advertised["productType"])
            candidates.append(entry)

        if mobdev2["advertisements"] and not candidates:
            issues.append(
                {
                    "code": ErrorCode.PAIRING_RECORD_MISSING,
                    "severity": "warning",
                    "message": "An iPhone advertised Wi-Fi sync, but none could be identified from this PC.",
                    "detail": (
                        f"{mobdev2['advertisements']} advertisement(s) were seen and none matched a pairing "
                        "record this host holds."
                    ),
                    "remedy": (
                        "Pair the iPhone over USB first (tap Trust), then enable “Sync with this iPhone over "
                        "Wi-Fi”. A USB pairing record is the prerequisite, not a substitute for wireless setup."
                    ),
                }
            )
        return candidates

    async def _prove_wifi_mux(self, udid: str) -> dict[str, Any]:
        probe = {"transport": TRANSPORT_WIFI_MUX, "ok": None, "detail": "", "identity": None, "remedy": None}
        try:
            identity, error = await _lockdown_over_mux(udid, "Network")
        except asyncio.TimeoutError:
            probe["ok"] = False
            probe["detail"] = "lockdownd did not answer over the network mux entry within 15 s."
            probe["remedy"] = "Unlock the iPhone and confirm it is on this Wi-Fi network, then probe again."
            return probe
        except Exception as exc:  # noqa: BLE001
            name = type(exc).__name__
            if name in {"DeviceNotFoundError", "ConnectionFailedToUsbmuxdError", "MuxException"}:
                probe["ok"] = False
                probe["detail"] = f"{name}: usbmuxd has no Network entry for this iPhone."
                probe["remedy"] = WIRELESS_PREREQUISITES[TRANSPORT_WIFI_MUX]
                return probe
            if name in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
                probe["ok"] = False
                probe["detail"] = f"{name}: the iPhone does not accept this host's pairing record."
                probe["remedy"] = (
                    "Unlock the iPhone and reconnect the cable so it can re-trust this computer, then re-enable "
                    "Wi-Fi sync."
                )
                return probe
            probe["ok"] = False
            probe["detail"] = f"{name}: {exc}"
            return probe
        probe["ok"] = True
        probe["identity"] = identity
        probe["detail"] = (
            f"lockdownd answered over the network mux entry: iOS {identity.get('productVersion')}, "
            f"Developer Mode {'on' if identity.get('developerModeEnabled') else 'off/unreported'}."
        )
        return probe

    async def _prove_lan_lockdown(self, udid: str, mobdev2: dict[str, Any], *, enabled: bool) -> dict[str, Any]:
        probe = {"transport": TRANSPORT_MOBDEV2, "ok": None, "detail": "", "identity": None, "remedy": None}
        if not enabled:
            probe["detail"] = "Skipped: identity probing was not requested."
            return probe
        if not mobdev2["advertisements"]:
            probe["ok"] = False
            probe["detail"] = "No _apple-mobdev2._tcp advertisement: nothing to handshake with."
            probe["remedy"] = WIRELESS_PREREQUISITES[TRANSPORT_WIFI_MUX]
            return probe
        try:
            identity, error, addresses = await asyncio.wait_for(
                _lockdown_over_lan(udid, BONJOUR_TIMEOUT_S), timeout=BONJOUR_TIMEOUT_S + 40.0
            )
        except asyncio.TimeoutError:
            probe["ok"] = False
            probe["detail"] = "The mobile-device-over-Wi-Fi handshake did not finish in time."
            probe["remedy"] = "Unlock the iPhone, keep it on this Wi-Fi network and probe again."
            return probe
        if error:
            probe["ok"] = False
            probe["detail"] = error
            return probe
        if identity is None:
            probe["detail"] = (
                "The browse completed but the phone did not accept a lockdown handshake from this host. "
                "This is the normal result for an iPhone that was never paired with this PC."
            )
            probe["remedy"] = (
                "Pair once over USB (tap Trust), then enable “Sync with this iPhone over Wi-Fi”."
            )
            return probe
        probe["ok"] = True
        probe["identity"] = identity
        probe["addresses"] = [a for a in addresses]
        probe["detail"] = (
            f"lockdownd completed a handshake over TCP 62078: iOS {identity.get('productVersion')}, "
            "no cable involved."
        )
        return probe

    def _assess(self, entry: dict[str, Any]) -> None:
        """Fill in the tunnel route and the simulation capability from the probes only."""
        identity = entry.get("identity") or {}
        product_version = identity.get("productVersion")
        needs_tunnel = requires_tunnel(product_version)
        major = ios_major_version(product_version)
        entry["tunnel"]["required"] = needs_tunnel
        entry["tunnel"]["iosMajor"] = major

        if not entry["reachableOver"]:
            entry["tunnel"]["reason"] = (
                "No wireless transport completed a handshake, so no tunnel was attempted."
            )
            return

        if not needs_tunnel:
            entry["tunnel"]["route"] = None
            entry["tunnel"]["reason"] = (
                f"iOS {product_version} predates the RemoteServiceDiscovery tunnel. Location simulation "
                "would use the legacy lockdown developer service over the wireless lockdown."
            )
        elif TRANSPORT_WIFI_MUX in entry["reachableOver"]:
            entry["tunnel"]["route"] = TRANSPORT_WIFI_MUX
            entry["tunnel"]["reason"] = (
                "The userspace developer tunnel is opened from the usbmuxd network entry, so it runs over "
                "Wi-Fi with the cable unplugged. Available on iOS 17.4 and newer; iOS 17.0-17.3 falls back "
                "to RemotePairing, which needs a RemotePairing record for this iPhone."
            )
        else:
            entry["tunnel"]["route"] = TRANSPORT_RSD_LAN
            entry["tunnel"]["reason"] = (
                "Only the LAN RemoteServiceDiscovery advertisement was reachable. Location Studio reports "
                "this as a reachable developer endpoint; the DVT location channel over it has not been "
                "confirmed on hardware, so simulation stays unknown until the readiness check proves it."
            )

        developer_mode = identity.get("developerModeEnabled")
        if developer_mode is False:
            entry["capability"] = {
                "wirelessLocationSimulation": False,
                "status": "not-possible",
                "reason": "Developer Mode is off on the iPhone; the developer services stay closed on any transport.",
                "remedy": "On the iPhone: Settings → Privacy & Security → Developer Mode → on, then restart the phone.",
            }
        elif TRANSPORT_WIFI_MUX in entry["reachableOver"] and major is not None and major >= 17 and developer_mode:
            entry["capability"] = {
                "wirelessLocationSimulation": None,
                "status": "possible-unverified",
                "reason": (
                    "Lockdown over the Wi-Fi mux entry succeeded and the userspace tunnel can be opened from "
                    "it. The developer service is only confirmed by running the readiness check, which actually "
                    "opens the tunnel."
                ),
            }
        elif entry["reachableOver"]:
            entry["capability"] = {
                "wirelessLocationSimulation": None,
                "status": "unknown",
                "reason": entry["tunnel"]["reason"],
            }
        else:
            entry["capability"] = {
                "wirelessLocationSimulation": False,
                "status": "not-possible",
                "reason": "No wireless transport reached this iPhone.",
                "remedy": WIRELESS_PREREQUISITES[TRANSPORT_WIFI_MUX],
            }

    # ------------------------------------------------------------------ connect

    async def connect(self, device_id: str, transport: str) -> dict[str, Any]:
        """Prove the requested transport, then bring up the developer tunnel over it.

        Success means: lockdown answered on that transport, and - for iOS 17+ - the
        userspace tunnel opened and the DVT developer service was advertised. Anything
        else raises or returns an explicit negative, so the UI cannot show a link the
        device never made.
        """
        if transport not in TRANSPORTS:
            raise BridgeError(
                ErrorCode.INVALID_PARAMS,
                "Unsupported transport.",
                f"Expected one of: {', '.join(TRANSPORTS)}.",
            )

        started = time.monotonic()
        steps: list[dict[str, Any]] = []
        identity: dict[str, Any] = {}
        endpoint: Endpoint

        if transport == TRANSPORT_RSD_LAN:
            rsd_result = await self._connect_rsd_lan(device_id, steps)
            endpoint = rsd_result["endpoint"]
            identity = rsd_result["identity"]
        else:
            connection_type = "USB" if transport == TRANSPORT_USB else "Network"
            try:
                identity, _ = await _lockdown_over_mux(device_id, connection_type)
            except Exception as exc:  # noqa: BLE001
                error = self._classify_link_error(transport, exc)
                steps.append({"step": "lockdown", "ok": False, "detail": error.details or error.message})
                raise error from exc
            steps.append(
                {
                    "step": "lockdown",
                    "ok": True,
                    "detail": f"lockdownd answered through the {connection_type} usbmux entry (iOS {identity.get('productVersion')}).",
                }
            )
            endpoint = Endpoint(
                device_id=device_id,
                transport=transport,
                product_version=identity.get("productVersion"),
            )

        result: dict[str, Any] = {
            "deviceId": device_id,
            "transport": transport,
            "transportLabel": TRANSPORT_LABELS[transport],
            "wireless": endpoint.is_wireless,
            "identity": identity,
            "steps": steps,
            "endpoint": endpoint.to_dict(),
        }

        if not requires_tunnel(identity.get("productVersion")):
            steps.append(
                {
                    "step": "tunnel",
                    "ok": None,
                    "detail": (
                        f"iOS {identity.get('productVersion')} does not use the RemoteServiceDiscovery tunnel; "
                        "location simulation would go through the legacy lockdown developer service."
                    ),
                }
            )
            result["tunnel"] = self._tunnels.status()
            result["developerService"] = {"reachable": None, "detail": "Not probed: no tunnel needed on this iOS."}
            result["ready"] = False
            result["summary"] = "Wireless lockdown works on this iPhone, but it uses the pre-iOS 17 developer path."
            return result

        try:
            rsd = await self._tunnels.acquire(device_id, endpoint=endpoint)
        except BridgeError as exc:
            steps.append({"step": "tunnel", "ok": False, "detail": f"{exc.message} {exc.details or ''}".strip()})
            result["tunnel"] = self._tunnels.status()
            result["developerService"] = {"reachable": False, "detail": "Not attempted: the tunnel did not open."}
            result["ready"] = False
            result["summary"] = exc.message
            result["error"] = exc.to_dict()
            return result

        port: Optional[int]
        try:
            port = rsd.get_service_port(DVT_SERVICE_NAME)
        except Exception as exc:  # noqa: BLE001
            port = None
            steps.append(
                {
                    "step": "developer service",
                    "ok": None,
                    "detail": f"The tunnel is up but {DVT_SERVICE_NAME} could not be resolved: {type(exc).__name__}: {exc}",
                }
            )
        else:
            steps.append(
                {
                    "step": "developer service",
                    "ok": port is not None,
                    "detail": f"{DVT_SERVICE_NAME} advertised on port {port}." if port else f"{DVT_SERVICE_NAME} is not advertised.",
                }
            )

        steps.append(
            {
                "step": "tunnel",
                "ok": True,
                "detail": "Userspace RSD tunnel established over "
                f"{TRANSPORT_LABELS[transport]} without administrator rights.",
            }
        )
        result["tunnel"] = self._tunnels.status()
        result["developerService"] = {"reachable": bool(port), "port": port, "service": DVT_SERVICE_NAME}
        result["ready"] = bool(port)
        result["summary"] = (
            f"Connected over {TRANSPORT_LABELS[transport]} and the developer service is reachable."
            if port
            else f"Connected over {TRANSPORT_LABELS[transport]}, but the developer service was not advertised."
        )
        result["elapsedMs"] = int((time.monotonic() - started) * 1000)
        return result

    async def _connect_rsd_lan(self, device_id: str, steps: list[dict[str, Any]]) -> dict[str, Any]:
        """Open RSD directly at a LAN address found by the ``remoted`` browse."""
        probe = self._last_probe if self._last_probe.get("transports") else await self.probe(device_id=device_id)
        advertised = next(
            (
                device
                for device in probe["transports"].get(TRANSPORT_RSD_LAN, {}).get("devices", [])
                if device["deviceId"] == device_id
            ),
            None,
        )
        if advertised is None:
            error = BridgeError(
                ErrorCode.WIRELESS_UNAVAILABLE,
                "This iPhone is not advertising RemoteServiceDiscovery on the local network.",
                "The _remoted._tcp browse returned no record for the selected device.",
                remedy=WIRELESS_PREREQUISITES[TRANSPORT_RSD_LAN],
                retryable=True,
            )
            steps.append({"step": "discovery", "ok": False, "detail": error.details})
            raise error

        rsd, identity = await self._tunnels.open_lan_rsd(advertised["address"], device_id)
        steps.append(
            {
                "step": "rsd handshake",
                "ok": True,
                "detail": (
                    f"RemoteServiceDiscovery handshake completed over the LAN: iOS {identity.get('productVersion')}."
                ),
            }
        )
        endpoint = Endpoint(
            device_id=device_id,
            transport=TRANSPORT_RSD_LAN,
            host=advertised["address"],
            port=None,
            product_version=identity.get("productVersion"),
        )
        return {"endpoint": endpoint, "identity": identity, "rsd": rsd}

    @staticmethod
    def _classify_link_error(transport: str, exc: Exception) -> BridgeError:
        name = type(exc).__name__
        wireless = transport != TRANSPORT_USB
        if name in {"NotPairedError", "PairingError", "PasscodeRequiredError"}:
            return BridgeError(
                ErrorCode.NOT_PAIRED,
                "The iPhone does not accept this computer's pairing record on this transport.",
                f"{name}: {exc}",
                remedy=(
                    "Wireless access is not granted by a USB pairing alone: reconnect the cable, tap Trust "
                    "again, then re-enable “Sync with this iPhone over Wi-Fi”."
                    if wireless
                    else "Unlock the iPhone and press Pair device in the Device workspace."
                ),
            )
        if name in {"DeviceNotFoundError", "ConnectionFailedToUsbmuxdError", "MuxException"}:
            return BridgeError(
                ErrorCode.DEVICE_DISCONNECTED if not wireless else ErrorCode.WIRELESS_UNAVAILABLE,
                (
                    "usbmuxd has no network entry for this iPhone, so it is not reachable over Wi-Fi right now."
                    if wireless
                    else "The iPhone is not attached over USB."
                ),
                f"{name}: {exc}",
                remedy=WIRELESS_PREREQUISITES[transport],
                retryable=True,
            )
        return BridgeError(
            ErrorCode.WIRELESS_UNAVAILABLE if wireless else ErrorCode.TUNNEL_FAILED,
            f"Could not establish the {TRANSPORT_LABELS.get(transport, transport)} link.",
            f"{name}: {exc}",
            remedy=WIRELESS_PREREQUISITES.get(transport, "Reconnect the iPhone and try again."),
            retryable=True,
        )

    # ------------------------------------------------------------------- verdict

    @staticmethod
    def _verdict(report: dict[str, Any]) -> dict[str, Any]:
        wifi_mux = report["transports"][TRANSPORT_WIFI_MUX]
        rsd = report["transports"][TRANSPORT_RSD_LAN]
        usb = report["transports"][TRANSPORT_USB]
        ready = [
            candidate["deviceId"]
            for candidate in report["candidates"]
            if candidate["capability"]["status"] in ("possible-unverified",)
        ]
        blocked = [
            candidate["deviceId"]
            for candidate in report["candidates"]
            if candidate["capability"]["status"] == "not-possible"
        ]
        if ready:
            summary = (
                f"{len(ready)} iPhone(s) answered lockdown over Wi-Fi; the developer service still has to be "
                "confirmed by a readiness check."
            )
        elif wifi_mux["available"] or rsd["available"]:
            summary = "A wireless iPhone was seen, but no wireless handshake completed."
        elif usb["available"]:
            summary = (
                "A USB iPhone is attached but nothing was seen over Wi-Fi. Wireless communication has to be "
                "enabled once per device; a USB pairing alone does not do it."
            )
        else:
            summary = "No iPhone was reachable over USB, Wi-Fi or the local network."
        return {
            "wirelessSeen": bool(wifi_mux["available"] or rsd["available"]),
            "wirelessHandshakeReady": ready,
            "wirelessBlocked": blocked,
            "summary": summary,
        }


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")
