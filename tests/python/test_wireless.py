"""Wireless reachability diagnostics and transport selection.

The property these tests protect: a wireless claim is only ever made by a handshake
that completed on that transport. Seeing an advertisement, holding a pairing record,
or having paired over USB in the past proves nothing about Wi-Fi, and a probe that
could not run stays unknown instead of being guessed into False.

Device access is faked at the pymobiledevice3 boundary; the classification, the
tri-state bookkeeping and the transport threading are the production code.
"""

from __future__ import annotations

import contextlib
import importlib.util
import unittest
from unittest import mock

from location_studio_bridge import wireless
from location_studio_bridge.device_manager import DeviceManager
from location_studio_bridge.protocol import BridgeError, ErrorCode
from location_studio_bridge.server import BridgeServer
from location_studio_bridge.tunnel import TunnelManager
from location_studio_bridge.validation import ValidationError, validate_transport
from location_studio_bridge.wireless import (
    TRANSPORT_MOBDEV2,
    TRANSPORT_RSD_LAN,
    TRANSPORT_USB,
    TRANSPORT_WIFI_MUX,
    Endpoint,
    WirelessProber,
    usb_endpoint,
)

HAS_PYMOBILEDEVICE3 = importlib.util.find_spec("pymobiledevice3") is not None

UDID = "00008140-0000000000000000"
OTHER = "00008110-0000000000000001"


def identity(version: str = "18.1", developer_mode=True, **overrides) -> dict:
    payload = {
        "deviceName": "Test iPhone",
        "productType": "iPhone17,1",
        "productVersion": version,
        "buildVersion": "22B83",
        "developerModeEnabled": developer_mode,
        "wifiConnectionsEnabled": True,
    }
    payload.update(overrides)
    return payload


class FakeMuxDevice:
    def __init__(self, serial: str, connection_type: str = "USB") -> None:
        self.serial = serial
        self.connection_type = connection_type
        self.devid = 12345

    def matches_udid(self, udid: str) -> bool:
        return udid == self.serial


class FakeTunnels:
    """Stands in for TunnelManager, remembering the endpoint each session was opened for."""

    def __init__(self, *, port=54321, acquire_error=None, lan_error=None) -> None:
        self.port = port
        self.acquire_error = acquire_error
        self.lan_error = lan_error
        self.acquired: list[tuple[str, object]] = []
        self.lan_opens: list[tuple[str, str]] = []
        self.released = 0
        self._open = False
        self._udid: str | None = None
        self._endpoint: object = None
        self._kind = "userspace"

    async def acquire(self, udid: str, *, endpoint=None):
        self.acquired.append((udid, endpoint))
        if self.acquire_error is not None:
            raise self.acquire_error
        self._open = True
        self._udid = udid
        self._endpoint = endpoint
        self._kind = "userspace"
        return self

    async def open_lan_rsd(self, host: str, udid: str, *, port=None):
        self.lan_opens.append((host, udid))
        if self.lan_error is not None:
            raise self.lan_error
        self._open = True
        self._udid = udid
        self._endpoint = Endpoint(device_id=udid, transport=TRANSPORT_RSD_LAN, host=host, port=port)
        self._kind = "rsd-lan-direct"
        return self, identity(version="18.1")

    def get_service_port(self, name: str):
        if self.port is None:
            raise KeyError(name)
        return self.port

    async def release(self) -> None:
        self.released += 1
        self._open = False
        self._udid = None
        self._endpoint = None
        self._kind = "userspace"

    def status(self) -> dict:
        return {
            "open": self._open,
            "deviceId": self._udid,
            "establishedCount": len(self.acquired) + len(self.lan_opens),
            "kind": self._kind if self._open else "userspace",
            "transport": getattr(self._endpoint, "transport", None) if self._open else None,
            "wireless": bool(getattr(self._endpoint, "is_wireless", False)) if self._open else False,
        }


# ------------------------------------------------------------------ probe harness


def mdns_state(**overrides) -> dict:
    state = {"usable": True, "queriesSent": 1, "sendErrors": 0, "blocked": False, "detail": "1 query left this host"}
    state.update(overrides)
    return state


@contextlib.contextmanager
def probe_env(
    *,
    mdns=None,
    devices=None,
    remoted=None,
    mobdev2=None,
    remotepairing=None,
    remote_identifiers=(),
    mux_lockdown=None,
    lan_lockdown=None,
    mux_error=None,
):
    """Replace every pymobiledevice3 touchpoint of WirelessProber.probe()."""
    calls: dict[str, list] = {"lockdown_over_mux": [], "lockdown_over_lan": []}

    async def _mdns_host_state():
        return mdns if mdns is not None else mdns_state()

    async def _mux_devices():
        if mux_error is not None:
            raise mux_error
        return list(devices or [])

    async def _browse_remoted(timeout):
        return remoted or {"probed": True, "devices": [], "error": None}

    async def _browse_mobdev2(timeout):
        return mobdev2 or {"probed": True, "advertisements": 0, "addresses": [], "error": None}

    async def _browse_remotepairing(timeout):
        return remotepairing or {"probed": True, "advertisements": 0, "error": None}

    async def _lockdown_over_mux(udid, connection_type):
        calls["lockdown_over_mux"].append((udid, connection_type))
        if isinstance(mux_lockdown, Exception):
            raise mux_lockdown
        return (mux_lockdown or identity()), None

    async def _lockdown_over_lan(udid, timeout):
        calls["lockdown_over_lan"].append((udid, timeout))
        if isinstance(lan_lockdown, Exception):
            raise lan_lockdown
        return lan_lockdown if lan_lockdown is not None else (None, None, [])

    with contextlib.ExitStack() as stack:
        for name, replacement in (
            ("_mdns_host_state", _mdns_host_state),
            ("_mux_devices", _mux_devices),
            ("_browse_remoted", _browse_remoted),
            ("_browse_mobdev2", _browse_mobdev2),
            ("_browse_remotepairing", _browse_remotepairing),
            ("_lockdown_over_mux", _lockdown_over_mux),
            ("_lockdown_over_lan", _lockdown_over_lan),
        ):
            stack.enter_context(mock.patch.object(wireless, name, replacement))
        stack.enter_context(
            mock.patch.object(
                wireless, "_pair_record_counts", lambda: {"lockdownRecords": 1, "remotePairingRecords": 0, "note": ""}
            )
        )
        stack.enter_context(mock.patch.object(wireless, "_remote_paired_identifiers", lambda: list(remote_identifiers)))
        stack.enter_context(mock.patch.object(wireless, "BONJOUR_TIMEOUT_S", 0.01))
        yield calls


class TestEndpointModel(unittest.TestCase):
    def test_a_wireless_endpoint_demands_the_network_mux_entry(self) -> None:
        self.assertEqual(Endpoint(UDID, TRANSPORT_WIFI_MUX).connection_type, "Network")
        self.assertEqual(usb_endpoint(UDID).connection_type, "USB")
        # A pure-LAN RSD has no mux entry to pin; passing one would look the device up
        # through usbmuxd and quietly turn a LAN session into a mux one.
        self.assertIsNone(Endpoint(UDID, TRANSPORT_RSD_LAN, host="192.0.2.9").connection_type)

    def test_wireless_is_a_property_of_the_transport_not_of_the_host(self) -> None:
        self.assertFalse(usb_endpoint(UDID).is_wireless)
        self.assertTrue(Endpoint(UDID, TRANSPORT_WIFI_MUX).is_wireless)
        self.assertTrue(Endpoint(UDID, TRANSPORT_RSD_LAN).is_wireless)

    def test_an_endpoint_survives_the_json_round_trip(self) -> None:
        endpoint = Endpoint(UDID, TRANSPORT_RSD_LAN, host="192.0.2.9", port=49152, product_version="18.1")
        rebuilt = Endpoint.from_dict(endpoint.to_dict())
        self.assertEqual(rebuilt, endpoint)
        self.assertEqual(rebuilt.to_dict()["address"], "192.0.2.9:49152")

    def test_a_report_never_carries_pairing_material(self) -> None:
        payload = Endpoint(UDID, TRANSPORT_WIFI_MUX, host="192.0.2.9", port=62078).to_dict()
        self.assertEqual(
            set(payload),
            {"deviceId", "transport", "label", "wireless", "productVersion", "host", "port", "address"},
        )
        self.assertNotIn("PairRecord", str(payload))


class TestTransportAllowlist(unittest.TestCase):
    def test_only_the_three_named_transports_are_accepted(self) -> None:
        for transport in ("usb", "wifi-mux", "rsd-lan"):
            self.assertEqual(validate_transport(transport), transport)

    def test_a_caller_can_never_name_an_address_or_a_command(self) -> None:
        for value in ("192.0.2.9:62078", "cmd.exe", "USB", "", "rsd-lan; rm -rf", None, 3):
            with self.assertRaises(ValidationError, msg=repr(value)):
                validate_transport(value)


class TestMuxGrouping(unittest.TestCase):
    def test_usb_and_network_entries_are_kept_apart(self) -> None:
        grouped = wireless._mux_group([FakeMuxDevice(UDID, "USB"), FakeMuxDevice(OTHER, "Network")])
        self.assertEqual([d["deviceId"] for d in grouped["USB"]], [UDID])
        self.assertEqual([d["deviceId"] for d in grouped["Network"]], [OTHER])
        self.assertEqual(grouped["other"], [])

    def test_an_unexpected_connection_type_is_reported_not_silently_binned(self) -> None:
        grouped = wireless._mux_group([FakeMuxDevice(UDID, "Bluetooth")])
        self.assertEqual(grouped["other"][0]["connectionType"], "Bluetooth")


class TestVerdict(unittest.TestCase):
    @staticmethod
    def _report(usb=False, wifi_mux=False, rsd=False, statuses=()):
        return {
            "transports": {
                TRANSPORT_USB: {"available": usb},
                TRANSPORT_WIFI_MUX: {"available": wifi_mux},
                TRANSPORT_RSD_LAN: {"available": rsd},
            },
            "candidates": [
                {"deviceId": f"device-{index}", "capability": {"status": status}}
                for index, status in enumerate(statuses)
            ],
        }

    def test_a_usb_only_house_says_wireless_has_to_be_enabled_first(self) -> None:
        verdict = WirelessProber._verdict(self._report(usb=True))
        self.assertFalse(verdict["wirelessSeen"])
        self.assertIn("does not do it", verdict["summary"])

    def test_a_seen_device_that_never_shook_hands_is_not_ready(self) -> None:
        verdict = WirelessProber._verdict(self._report(wifi_mux=True))
        self.assertTrue(verdict["wirelessSeen"])
        self.assertEqual(verdict["wirelessHandshakeReady"], [])

    def test_nothing_reachable_is_stated_plainly(self) -> None:
        verdict = WirelessProber._verdict(self._report())
        self.assertEqual(verdict["summary"], "No iPhone was reachable over USB, Wi-Fi or the local network.")


class TestCapabilityAssessment(unittest.TestCase):
    """_assess turns handshake facts into a capability claim - and must not overshoot."""

    @staticmethod
    def _entry(*, reachable, version="18.1", developer_mode=True):
        return {
            "deviceId": UDID,
            "reachableOver": list(reachable),
            "identity": identity(version, developer_mode=developer_mode),
            "tunnel": {"required": None, "route": None, "reason": ""},
            "capability": {"wirelessLocationSimulation": None, "status": "unknown", "reason": ""},
        }

    def test_a_wifi_handshake_is_possible_unverified_never_verified(self) -> None:
        entry = self._entry(reachable=[TRANSPORT_WIFI_MUX])
        WirelessProber(FakeTunnels())._assess(entry)
        self.assertEqual(entry["capability"]["status"], "possible-unverified")
        self.assertIsNone(entry["capability"]["wirelessLocationSimulation"])
        self.assertEqual(entry["tunnel"]["route"], TRANSPORT_WIFI_MUX)

    def test_developer_mode_off_closes_the_door_on_every_transport(self) -> None:
        entry = self._entry(reachable=[TRANSPORT_WIFI_MUX], developer_mode=False)
        WirelessProber(FakeTunnels())._assess(entry)
        self.assertEqual(entry["capability"]["status"], "not-possible")
        self.assertIs(entry["capability"]["wirelessLocationSimulation"], False)

    def test_a_lan_only_endpoint_stays_unknown(self) -> None:
        entry = self._entry(reachable=[TRANSPORT_RSD_LAN])
        WirelessProber(FakeTunnels())._assess(entry)
        self.assertEqual(entry["capability"]["status"], "unknown")
        self.assertEqual(entry["tunnel"]["route"], TRANSPORT_RSD_LAN)

    def test_pre_17_over_wifi_does_not_claim_a_tunnel(self) -> None:
        entry = self._entry(reachable=[TRANSPORT_WIFI_MUX], version="16.7.11")
        WirelessProber(FakeTunnels())._assess(entry)
        self.assertIs(entry["tunnel"]["required"], False)
        self.assertIsNone(entry["tunnel"]["route"])
        self.assertIn("predates the RemoteServiceDiscovery tunnel", entry["tunnel"]["reason"])

    def test_an_unreachable_device_is_not_possible(self) -> None:
        entry = self._entry(reachable=[])
        WirelessProber(FakeTunnels())._assess(entry)
        self.assertEqual(entry["capability"]["status"], "unknown")
        self.assertIn("No wireless transport completed a handshake", entry["tunnel"]["reason"])


class TestLinkErrorClassification(unittest.TestCase):
    def test_a_refused_pairing_over_wifi_says_a_usb_pair_is_not_enough(self) -> None:
        class NotPairedError(Exception):
            pass

        error = WirelessProber._classify_link_error(TRANSPORT_WIFI_MUX, NotPairedError("no record"))
        self.assertEqual(error.code, ErrorCode.NOT_PAIRED)
        self.assertIn("not granted by a USB pairing alone", error.remedy)

    def test_a_missing_network_entry_is_wireless_unavailable_not_a_cable_problem(self) -> None:
        class DeviceNotFoundError(Exception):
            pass

        over_wifi = WirelessProber._classify_link_error(TRANSPORT_WIFI_MUX, DeviceNotFoundError())
        over_usb = WirelessProber._classify_link_error(TRANSPORT_USB, DeviceNotFoundError())
        self.assertEqual(over_wifi.code, ErrorCode.WIRELESS_UNAVAILABLE)
        self.assertEqual(over_usb.code, ErrorCode.DEVICE_DISCONNECTED)


class FakeLanLockdownClient:
    """A TcpLockdownClient stand-in: it only has to answer the four values we read."""

    def __init__(self, **overrides) -> None:
        self.values = {
            "DeviceName": "Kitchen iPhone",
            "ProductType": "iPhone16,2",
            "ProductVersion": "18.1",
            "BuildVersion": "22B83",
        }
        self.values.update(overrides)
        self.closed = False

    async def get_value(self, key=None, **_kwargs):
        return self.values.get(key)

    async def get_developer_mode_status(self):
        return True

    async def close(self) -> None:
        self.closed = True


@contextlib.contextmanager
def fake_mobdev2_lockdowns(items):
    """Stand in for the library's ``get_mobdev2_lockdowns`` with the same call shape.

    The real one is an async generator function that yields ``(address, client)`` pairs
    and leaves closing the client to the caller. A fake that was merely *awaitable* would
    let a wrong ``async with`` in production code pass, so this fixture is a generator too
    and records the arguments the bridge passed.
    """
    import pymobiledevice3.lockdown as lockdown_module

    calls: list[tuple] = []

    def factory(udid=None, pair_records=None, only_paired=False, timeout=2):
        calls.append((udid, only_paired, timeout))

        async def walk():
            for entry in items:
                yield entry

        return walk()

    with mock.patch.object(lockdown_module, "get_mobdev2_lockdowns", factory):
        yield calls


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestMobdev2Handshake(unittest.IsolatedAsyncioTestCase):
    async def test_the_library_offers_an_async_generator_not_a_context_manager(self) -> None:
        """The spelling production code uses has to match what the installed library is."""
        import inspect

        from pymobiledevice3.lockdown import get_mobdev2_lockdowns

        self.assertTrue(inspect.isasyncgenfunction(get_mobdev2_lockdowns))
        self.assertFalse(hasattr(get_mobdev2_lockdowns, "__aenter__"))

    async def test_a_completed_lan_handshake_returns_the_identity_it_read(self) -> None:
        client = FakeLanLockdownClient()
        with fake_mobdev2_lockdowns([("192.0.2.9", client)]) as calls:
            identity, error, addresses = await wireless._lockdown_over_lan(UDID, 2.0)

        self.assertIsNone(error)
        self.assertEqual(addresses, ["192.0.2.9"])
        self.assertEqual(identity["deviceName"], "Kitchen iPhone")
        self.assertEqual(identity["productVersion"], "18.1")
        self.assertIs(identity["developerModeEnabled"], True)
        self.assertIs(identity["wifiConnectionsEnabled"], True)
        self.assertTrue(client.closed)
        self.assertEqual(calls, [(UDID, True, 2.0)])

    async def test_a_browse_that_answers_nothing_is_not_called_a_failure(self) -> None:
        with fake_mobdev2_lockdowns([]):
            identity, error, addresses = await wireless._lockdown_over_lan(UDID, 2.0)

        self.assertIsNone(identity)
        self.assertIsNone(error)
        self.assertEqual(addresses, [])

    async def test_only_the_client_that_answered_is_used_and_closed(self) -> None:
        first, second = FakeLanLockdownClient(), FakeLanLockdownClient()
        with fake_mobdev2_lockdowns([("192.0.2.9", first), ("192.0.2.10", second)]):
            identity, _error, addresses = await wireless._lockdown_over_lan(UDID, 2.0)

        self.assertEqual(addresses, ["192.0.2.9"])
        self.assertEqual(identity["productType"], "iPhone16,2")
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)

    async def test_a_client_that_raises_while_reading_still_gets_closed(self) -> None:
        class Refusing(FakeLanLockdownClient):
            async def get_value(self, key=None, **_kwargs):
                raise OSError("socket reset")

        client = Refusing()
        with fake_mobdev2_lockdowns([("192.0.2.9", client)]):
            identity, _error, _addresses = await wireless._lockdown_over_lan(UDID, 2.0)

        # Every value was unreadable, so the identity says so instead of inventing one.
        self.assertTrue(client.closed)
        self.assertIsNone(identity["productVersion"])


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestProbe(unittest.IsolatedAsyncioTestCase):
    async def test_a_cable_only_house_reports_wifi_as_absent_not_unknown(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(devices=[FakeMuxDevice(UDID, "USB")]):
            report = await prober.probe()

        self.assertTrue(report["transports"][TRANSPORT_USB]["available"])
        self.assertFalse(report["transports"][TRANSPORT_WIFI_MUX]["available"])
        self.assertEqual(report["transports"][TRANSPORT_RSD_LAN]["deviceCount"], 0)
        # Discovery never opens lockdown for a device that is only on the cable: there is
        # no network entry to pin it to.
        self.assertEqual(report["candidates"], [])
        self.assertFalse(report["verdict"]["wirelessSeen"])

    async def test_a_network_entry_that_finishes_lockdown_becomes_a_candidate(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()) as calls:
            report = await prober.probe()

        candidate = report["candidates"][0]
        self.assertEqual(candidate["reachableOver"], [TRANSPORT_WIFI_MUX])
        self.assertEqual(candidate["identity"]["productVersion"], "18.1")
        self.assertEqual(candidate["capability"]["status"], "possible-unverified")
        # The handshake was pinned to the Network entry, which is what makes it evidence.
        self.assertEqual(calls["lockdown_over_mux"], [(UDID, "Network")])

    async def test_a_network_entry_that_refuses_stays_unreachable(self) -> None:
        class NotPairedError(Exception):
            pass

        prober = WirelessProber(FakeTunnels())
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=NotPairedError()):
            report = await prober.probe()

        candidate = report["candidates"][0]
        self.assertEqual(candidate["reachableOver"], [])
        self.assertEqual(candidate["capability"]["status"], "unknown")
        self.assertIsNone(candidate["identity"])

    async def test_a_blocked_multicast_dns_is_its_own_actionable_error(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(mdns=mdns_state(blocked=True, queriesSent=0, sendErrors=2, detail="all interfaces refused")):
            report = await prober.probe()

        codes = [issue["code"] for issue in report["issues"]]
        self.assertIn(ErrorCode.MULTICAST_BLOCKED, codes)
        # The browse found nothing, and the issue above says why: an empty answer here is
        # never presented as "this iPhone does not support Wi-Fi".
        self.assertFalse(report["transports"][TRANSPORT_RSD_LAN]["available"])
        self.assertTrue(report["issues"])

    async def test_a_usb_only_house_is_told_pairing_is_not_wireless(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(devices=[FakeMuxDevice(UDID, "USB")]):
            report = await prober.probe()

        infos = [issue for issue in report["issues"] if issue["severity"] == "info"]
        self.assertTrue(any("Wi-Fi sync" in issue["message"] for issue in infos))

    async def test_a_failing_usbmux_scan_is_reported_not_invented_away(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(mux_error=OSError("usbmuxd refused")):
            report = await prober.probe()

        self.assertEqual(report["transports"][TRANSPORT_USB]["deviceCount"], 0)
        codes = [issue["code"] for issue in report["issues"]]
        self.assertIn(ErrorCode.USBMUX_UNAVAILABLE, codes)

    async def test_an_advertisement_without_a_pairing_record_names_the_missing_step(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(mobdev2={"probed": True, "advertisements": 1, "addresses": ["192.0.2.9"], "error": None}):
            report = await prober.probe()

        codes = [issue["code"] for issue in report["issues"]]
        self.assertIn(ErrorCode.PAIRING_RECORD_MISSING, codes)
        self.assertEqual(report["candidates"], [])

    async def test_an_rsd_advertisement_is_listed_even_with_no_mux_entry(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(
            remoted={
                "probed": True,
                "devices": [
                    {"deviceId": UDID, "productType": "iPhone16,2", "osVersion": "18.1", "address": "192.0.2.9"}
                ],
                "error": None,
            }
        ):
            report = await prober.probe()

        self.assertTrue(report["transports"][TRANSPORT_RSD_LAN]["available"])
        candidate = report["candidates"][0]
        self.assertEqual(candidate["seenOn"], [TRANSPORT_RSD_LAN])
        # RSD answering is reachability of the endpoint, not proof that simulation works.
        self.assertIsNone(candidate["capability"]["wirelessLocationSimulation"])

    async def test_probe_identity_false_skips_every_handshake(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")]) as calls:
            report = await prober.probe(prove_lockdown=False)

        self.assertEqual(calls["lockdown_over_mux"], [])
        self.assertEqual(calls["lockdown_over_lan"], [])
        self.assertEqual(report["candidates"][0]["reachableOver"], [])

    async def test_the_last_probe_is_kept_for_the_status_report(self) -> None:
        prober = WirelessProber(FakeTunnels())
        self.assertIsNone(prober.last_probe["probedAt"])
        with probe_env():
            report = await prober.probe()
        self.assertIs(prober.last_probe, report)


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestConnect(unittest.IsolatedAsyncioTestCase):
    async def test_an_unknown_transport_is_refused_before_any_device_call(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env() as calls:
            with self.assertRaises(BridgeError) as context:
                await prober.connect(UDID, "192.0.2.9")

        self.assertEqual(context.exception.code, ErrorCode.INVALID_PARAMS)
        self.assertEqual(calls["lockdown_over_mux"], [])

    async def test_connecting_over_wifi_pins_lockdown_to_the_network_entry(self) -> None:
        tunnels = FakeTunnels()
        prober = WirelessProber(tunnels)
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()) as calls:
            report = await prober.connect(UDID, TRANSPORT_WIFI_MUX)

        self.assertEqual(calls["lockdown_over_mux"], [(UDID, "Network")])
        self.assertTrue(report["ready"])
        self.assertTrue(report["wireless"])
        self.assertEqual(report["endpoint"]["transport"], TRANSPORT_WIFI_MUX)
        # The tunnel was opened for the endpoint that just proved Wi-Fi, not for "whatever
        # usbmuxd feels like" - that pin is the difference between a wireless session and a
        # cable session wearing a wireless label.
        self.assertEqual(len(tunnels.acquired), 1)
        acquired_udid, acquired_endpoint = tunnels.acquired[0]
        self.assertEqual(acquired_udid, UDID)
        self.assertEqual(acquired_endpoint.transport, TRANSPORT_WIFI_MUX)

    async def test_a_tunnel_that_refused_is_reported_as_not_ready(self) -> None:
        refusal = BridgeError(ErrorCode.TUNNEL_FAILED, "The developer tunnel could not be opened.")
        tunnels = FakeTunnels(acquire_error=refusal)
        prober = WirelessProber(tunnels)
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")]):
            report = await prober.connect(UDID, TRANSPORT_WIFI_MUX)

        self.assertFalse(report["ready"])
        self.assertFalse(report["developerService"]["reachable"])
        self.assertEqual(report["error"]["code"], ErrorCode.TUNNEL_FAILED)
        self.assertFalse(report["tunnel"]["open"])

    async def test_a_tunnel_without_the_developer_service_is_not_simulatable(self) -> None:
        tunnels = FakeTunnels(port=None)
        prober = WirelessProber(tunnels)
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")]):
            report = await prober.connect(UDID, TRANSPORT_WIFI_MUX)

        self.assertFalse(report["ready"])
        self.assertTrue(report["tunnel"]["open"], "the tunnel is up; only the service is missing")
        step = next(item for item in report["steps"] if item["step"] == "developer service")
        self.assertFalse(step["ok"])

    async def test_a_pre_17_handshake_does_not_claim_a_tunnel(self) -> None:
        tunnels = FakeTunnels()
        prober = WirelessProber(tunnels)
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity("16.7.11")):
            report = await prober.connect(UDID, TRANSPORT_WIFI_MUX)

        self.assertFalse(report["ready"])
        self.assertEqual(tunnels.acquired, [])
        self.assertIsNone(report["developerService"]["reachable"])

    async def test_connecting_over_the_cable_is_honest_about_being_the_cable(self) -> None:
        tunnels = FakeTunnels()
        prober = WirelessProber(tunnels)
        with probe_env(devices=[FakeMuxDevice(UDID, "USB")], mux_lockdown=identity()) as calls:
            report = await prober.connect(UDID, TRANSPORT_USB)

        self.assertEqual(calls["lockdown_over_mux"], [(UDID, "USB")])
        self.assertFalse(report["wireless"])
        self.assertFalse(report["endpoint"]["wireless"])

    async def test_rsd_lan_connects_at_the_address_the_discovery_observed(self) -> None:
        tunnels = FakeTunnels()
        prober = WirelessProber(tunnels)
        with probe_env(
            remoted={
                "probed": True,
                "devices": [
                    {"deviceId": UDID, "productType": "iPhone16,2", "osVersion": "18.1", "address": "192.0.2.9"}
                ],
                "error": None,
            }
        ):
            await prober.probe()
            report = await prober.connect(UDID, TRANSPORT_RSD_LAN)

        self.assertEqual(tunnels.lan_opens, [("192.0.2.9", UDID)])
        self.assertEqual(report["endpoint"]["transport"], TRANSPORT_RSD_LAN)
        self.assertTrue(report["ready"])

    async def test_rsd_lan_without_an_advertisement_is_wireless_unavailable(self) -> None:
        prober = WirelessProber(FakeTunnels())
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")]):
            await prober.probe()
            with self.assertRaises(BridgeError) as context:
                await prober.connect(UDID, TRANSPORT_RSD_LAN)

        self.assertEqual(context.exception.code, ErrorCode.WIRELESS_UNAVAILABLE)


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestTransportSelection(unittest.IsolatedAsyncioTestCase):
    """What a probe proved must not silently become what the next command uses."""

    def setUp(self) -> None:
        self.tunnels = FakeTunnels()
        self.manager = DeviceManager(self.tunnels)

    async def test_a_probe_records_the_fact_but_selects_nothing(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.manager.probe_wireless()

        self.assertEqual(self.manager._proven[UDID]["transports"], [TRANSPORT_WIFI_MUX])
        self.assertIsNone(self.manager.selected_endpoint(UDID))
        self.assertEqual(self.manager.requested_endpoint(UDID, None), None)

    async def test_a_discovered_reachable_device_marks_the_wireless_stage(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.manager.probe_wireless()

        self.assertIs(self.manager._observed_stages[UDID]["wirelessReachable"], True)

    async def test_a_failed_connect_does_not_redirect_commands_off_the_cable(self) -> None:
        self.manager.select_endpoint(usb_endpoint(UDID))
        refusal = BridgeError(ErrorCode.WIRELESS_UNAVAILABLE, "No network entry for this iPhone.")
        with probe_env(devices=[FakeMuxDevice(UDID, "USB")], mux_lockdown=refusal):
            with self.assertRaises(BridgeError):
                await self.manager.connect_transport(UDID, TRANSPORT_WIFI_MUX)

        self.assertEqual(self.manager.selected_endpoint(UDID).transport, TRANSPORT_USB)

    async def test_a_successful_connect_selects_the_proven_transport(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            report = await self.manager.connect_transport(UDID, TRANSPORT_WIFI_MUX)

        self.assertEqual(self.manager.selected_endpoint(UDID).transport, TRANSPORT_WIFI_MUX)
        self.assertIs(report["stages"]["tunnelOverWireless"], True)
        self.assertIs(report["stages"]["simulationReady"], True)
        self.assertIs(self.manager._observed_stages[UDID]["developerServiceAvailable"], True)

    async def test_disconnecting_closes_the_session_and_drops_the_choice(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.manager.connect_transport(UDID, TRANSPORT_WIFI_MUX)

        result = await self.manager.disconnect_transport(UDID)

        self.assertIsNone(self.manager.selected_endpoint(UDID))
        self.assertEqual(self.tunnels.released, 1)
        self.assertFalse(result["tunnel"]["open"])
        self.assertIs(self.manager._observed_stages[UDID]["tunnelOverWireless"], False)

    async def test_the_default_endpoint_follows_what_is_attached(self) -> None:
        self.manager.record_proven_transport(UDID, TRANSPORT_WIFI_MUX, product_version="18.1")

        both = self.manager.default_endpoint(UDID, ["Network", "USB"])
        only_network = self.manager.default_endpoint(UDID, ["Network"])
        nothing = self.manager.default_endpoint(UDID, [])

        # usbmuxd itself prefers the cable, so a "wireless" session opened while both
        # entries exist would have been a USB one.
        self.assertEqual(both.transport, TRANSPORT_USB)
        self.assertEqual(only_network.transport, TRANSPORT_WIFI_MUX)
        self.assertEqual(nothing.transport, TRANSPORT_USB)

    async def test_the_summary_reports_facts_the_bridge_actually_measured(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.manager.connect_transport(UDID, TRANSPORT_WIFI_MUX)

        summary = self.manager.endpoint_summary(UDID)

        self.assertEqual(summary["proven"]["transports"], [TRANSPORT_WIFI_MUX])
        self.assertEqual(summary["selected"]["transport"], TRANSPORT_WIFI_MUX)
        self.assertTrue(summary["activeSession"]["wireless"])

    async def test_another_device_has_no_active_session(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.manager.connect_transport(UDID, TRANSPORT_WIFI_MUX)

        self.assertFalse(self.manager.endpoint_summary(OTHER)["activeSession"]["open"])


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestWirelessRpc(unittest.IsolatedAsyncioTestCase):
    """The four wireless methods, through the real dispatcher."""

    async def asyncSetUp(self) -> None:
        self.events: list[tuple[str, dict]] = []

        async def emit(name, payload):
            self.events.append((name, payload))

        self.tunnels = FakeTunnels()
        self.server = BridgeServer(emit=emit, log=lambda _line: None)
        self.server.devices = DeviceManager(self.tunnels)
        self.server.simulation = mock.Mock(current_session=None)

    async def asyncTearDown(self) -> None:
        with contextlib.suppress(Exception):
            await self.server.close()

    async def request(self, method: str, params=None):
        return await self.server.handle({"id": "1", "method": method, "params": params or {}})

    async def test_probe_reports_the_transports_this_pc_can_reach(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            response = await self.request("wireless.probe", {"deviceId": UDID})

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["candidates"][0]["reachableOver"], [TRANSPORT_WIFI_MUX])

    async def test_a_bad_device_id_or_transport_is_rejected_at_the_door(self) -> None:
        for method, params in (
            ("wireless.probe", {"deviceId": "../etc/passwd"}),
            ("wireless.connect", {"deviceId": UDID, "transport": "powershell"}),
            ("wireless.connect", {"deviceId": UDID}),
            ("wireless.status", {"deviceId": "not a udid at all!!"}),
        ):
            response = await self.request(method, params)
            self.assertFalse(response["ok"], method)
            self.assertIn(response["error"]["code"], {"INVALID_PARAMS", "INVALID_REQUEST"})

    async def test_connect_emits_the_state_it_just_measured(self) -> None:
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            response = await self.request("wireless.connect", {"deviceId": UDID, "transport": TRANSPORT_WIFI_MUX})

        self.assertTrue(response["ok"])
        self.assertEqual([name for name, _payload in self.events], ["wireless.state"])
        self.assertTrue(self.events[0][1]["ready"])

    async def test_status_without_a_probe_says_so_instead_of_inventing_one(self) -> None:
        response = await self.request("wireless.status", {"deviceId": UDID})

        self.assertTrue(response["ok"])
        self.assertIsNone(response["result"]["lastProbe"])
        self.assertFalse(response["result"]["tunnel"]["open"])

    async def test_disconnect_is_refused_while_the_override_is_live(self) -> None:
        from location_studio_bridge.simulation import SimulationState

        session = mock.Mock(id="sess-1", state=SimulationState.ACTIVE)
        self.server.simulation = mock.Mock(current_session=session)
        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.request("wireless.connect", {"deviceId": UDID, "transport": TRANSPORT_WIFI_MUX})
            response = await self.request("wireless.disconnect", {"deviceId": UDID})

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], ErrorCode.SIMULATION_ACTIVE)
        self.assertIn("Stop first", response["error"]["remedy"])
        self.assertEqual(self.tunnels.released, 0, "the link must stay up while the phone is overridden")

    async def test_disconnect_is_allowed_once_the_override_was_removed(self) -> None:
        from location_studio_bridge.simulation import SimulationState

        with probe_env(devices=[FakeMuxDevice(UDID, "Network")], mux_lockdown=identity()):
            await self.request("wireless.connect", {"deviceId": UDID, "transport": TRANSPORT_WIFI_MUX})
            self.server.simulation = mock.Mock(current_session=mock.Mock(id="s", state=SimulationState.STOPPED))
            response = await self.request("wireless.disconnect", {"deviceId": UDID})

        self.assertTrue(response["ok"])
        self.assertEqual(self.tunnels.released, 1)


if __name__ == "__main__":
    unittest.main()
