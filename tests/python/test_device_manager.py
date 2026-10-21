"""Device stage reporting.

Discovery cannot see everything that matters: the developer service needs a tunnel,
and "this device accepts a simulated location" is only known after a device command
succeeded. Those facts are measured elsewhere and folded back into the device list —
but only when they were really measured, and they are dropped again as soon as
evidence contradicts them.
"""

from __future__ import annotations

import importlib.util
import contextlib
import unittest
from unittest import mock

from location_studio_bridge.device_manager import DeviceManager
from location_studio_bridge.wireless import TRANSPORT_USB, TRANSPORT_WIFI_MUX

HAS_PYMOBILEDEVICE3 = importlib.util.find_spec("pymobiledevice3") is not None

UDID = "00008140-0000000000000000"
OTHER_UDID = "00008110-0000000000000001"


def scan_entry(udid: str = UDID) -> dict:
    """A device entry shaped exactly like the one discover() builds."""
    return {
        "deviceId": udid,
        "udid": udid,
        "connectionType": "USB",
        "isUsb": True,
        "isNetwork": False,
        "identity": None,
        "stages": {
            "usbDetected": True,
            "paired": None,
            "trusted": None,
            "developerModeEnabled": None,
            "developerServiceAvailable": None,
            "simulationReady": None,
            "wirelessReachable": None,
            "tunnelOverWireless": None,
        },
        "issues": [],
    }


class FakeTunnels:
    """Stands in for TunnelManager, recording the endpoint each acquire was pinned to."""

    def __init__(self, port=54321, error=None) -> None:
        self.port = port
        self.error = error
        self.acquired: list[str] = []
        self.endpoints: list[object] = []
        self.open_for = None
        self.endpoint = None

    async def acquire(self, udid: str, *, endpoint=None):
        self.acquired.append(udid)
        self.endpoints.append(endpoint)
        if self.error is not None:
            raise self.error
        self.open_for = udid
        self.endpoint = endpoint
        return self

    def get_service_port(self, name: str):
        if self.port is None:
            raise KeyError(name)
        return self.port

    def status(self) -> dict:
        return {
            "open": self.open_for is not None,
            "deviceId": self.open_for,
            "establishedCount": len(self.acquired),
            "kind": "userspace",
            "transport": getattr(self.endpoint, "transport", None),
            "wireless": bool(getattr(self.endpoint, "is_wireless", False)),
        }


class FakeLockdownClient:
    def __init__(self, version: str = "27.0.1", developer_mode: bool = True) -> None:
        self.version = version
        self.developer_mode = developer_mode
        self.closed = False

    async def get_value(self, key=None, **_kwargs):
        values = {
            "DeviceName": "iPhone",
            "ProductType": "iPhone17,1",
            "ProductVersion": self.version,
            "BuildVersion": "24A446",
            "UniqueDeviceID": UDID,
        }
        return values.get(key)

    async def get_developer_mode_status(self) -> bool:
        return self.developer_mode

    async def close(self) -> None:
        self.closed = True


class FakeMuxDevice:
    def __init__(self, udid: str = UDID, connection_type: str = "USB") -> None:
        self.serial = udid
        self.connection_type = connection_type

    def matches_udid(self, udid: str) -> bool:
        return udid == self.serial


def fake_pymobiledevice3(devices=None, client_factory=None):
    """Patch pymobiledevice3's usbmux list and lockdown factory.

    Patches the attributes on the real modules: the bridge imports them as
    ``from pymobiledevice3 import usbmux`` / ``from pymobiledevice3.lockdown import ...``,
    so a fake ``sys.modules`` entry alone would not be picked up.
    """
    import pymobiledevice3
    import pymobiledevice3.lockdown as lockdown_module

    async def list_devices():
        return list(devices if devices is not None else [FakeMuxDevice()])

    async def create_using_usbmux(serial=None, **_kwargs):
        return (client_factory or FakeLockdownClient)()

    usbmux = mock.Mock()
    usbmux.list_devices = list_devices

    stack = contextlib.ExitStack()
    stack.enter_context(mock.patch.object(pymobiledevice3, "usbmux", usbmux, create=True))
    stack.enter_context(mock.patch.object(lockdown_module, "create_using_usbmux", create_using_usbmux))
    return stack


class TestStageBookkeeping(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = DeviceManager(FakeTunnels())

    def test_recorded_stages_are_folded_into_the_last_scan(self) -> None:
        self.manager._last_scan = {"devices": [scan_entry()], "scannedAt": None}

        self.manager.record_stages(UDID, simulationReady=True, developerServiceAvailable=True)

        stages = self.manager._last_scan["devices"][0]["stages"]
        self.assertIs(stages["simulationReady"], True)
        self.assertIs(stages["developerServiceAvailable"], True)
        # The scan's own observations are untouched.
        self.assertIs(stages["usbDetected"], True)
        self.assertIsNone(stages["paired"])

    def test_unknown_keys_and_none_values_are_ignored(self) -> None:
        self.manager.record_stages(UDID, simulationReady=None, notAStage=True, paired=True)

        self.assertEqual(self.manager._observed_stages, {UDID: {"paired": True}})

    def test_recording_for_a_device_that_is_not_in_the_scan_invents_nothing(self) -> None:
        self.manager._last_scan = {"devices": [scan_entry()], "scannedAt": None}

        self.manager.record_stages(OTHER_UDID, simulationReady=True)

        self.assertEqual(len(self.manager._last_scan["devices"]), 1)
        self.assertIsNone(self.manager._last_scan["devices"][0]["stages"]["simulationReady"])
        # The fact is still remembered for the next scan that does list the device.
        self.assertEqual(self.manager._observed_stages[OTHER_UDID], {"simulationReady": True})

    def test_a_new_scan_entry_inherits_measured_stages(self) -> None:
        self.manager.record_stages(UDID, simulationReady=True)

        entry = self.manager._apply_observed_stages(scan_entry())

        self.assertIs(entry["stages"]["simulationReady"], True)
        self.assertIsNone(entry["stages"]["developerServiceAvailable"])

    def test_invalidation_clears_the_memo_and_the_entry(self) -> None:
        self.manager.record_stages(UDID, simulationReady=True, developerServiceAvailable=True)
        entry = self.manager._apply_observed_stages(scan_entry())

        self.manager._invalidate_stages(entry)

        self.assertEqual(self.manager._observed_stages, {})
        self.assertIsNone(entry["stages"]["simulationReady"])
        self.assertIsNone(entry["stages"]["developerServiceAvailable"])
        # Nothing else is reset: what the scan itself saw stays.
        self.assertIs(entry["stages"]["usbDetected"], True)


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestReadinessFoldsMeasuredStages(unittest.IsolatedAsyncioTestCase):
    async def _readiness(self, manager, *, open_tunnel=True, tunnels=None, client=None, devices=None):
        manager._usbmux_state = mock.AsyncMock(return_value={"available": True, "address": "127.0.0.1:27015"})
        with fake_pymobiledevice3(devices=devices, client_factory=lambda: client or FakeLockdownClient()):
            return await manager.check_readiness(UDID, open_tunnel=open_tunnel)

    async def test_a_ready_check_records_the_developer_service_and_simulation(self) -> None:
        tunnels = FakeTunnels()
        manager = DeviceManager(tunnels)
        manager._last_scan = {"devices": [scan_entry()], "scannedAt": None}

        report = await self._readiness(manager, tunnels=tunnels)

        self.assertTrue(report["ready"])
        self.assertEqual(manager._observed_stages[UDID], {"developerServiceAvailable": True, "simulationReady": True})
        self.assertIs(manager._last_scan["devices"][0]["stages"]["simulationReady"], True)
        # The report carries what it measured, so the UI can update the card without
        # running another scan.
        self.assertEqual(report["stages"], {"developerServiceAvailable": True, "simulationReady": True})

    async def test_an_unreachable_developer_service_is_negative_evidence(self) -> None:
        manager = DeviceManager(FakeTunnels(port=None))

        report = await self._readiness(manager, tunnels=manager._tunnels)

        self.assertFalse(report["ready"])
        self.assertEqual(manager._observed_stages[UDID], {"developerServiceAvailable": False, "simulationReady": False})

    async def test_a_skipped_tunnel_leaves_the_stages_unknown(self) -> None:
        manager = DeviceManager(FakeTunnels())

        report = await self._readiness(manager, open_tunnel=False)

        self.assertFalse(report["ready"])
        self.assertEqual(manager._observed_stages, {})
        self.assertEqual(report["stages"], {})

    async def test_developer_mode_off_invalidates_remembered_stages(self) -> None:
        manager = DeviceManager(FakeTunnels())
        manager.record_stages(UDID, simulationReady=True)
        manager._usbmux_state = mock.AsyncMock(return_value={"available": True, "address": "127.0.0.1:27015"})

        with fake_pymobiledevice3(client_factory=lambda: FakeLockdownClient(developer_mode=False)):
            result = await manager.discover(probe_identity=True)

        entry = result["devices"][0]
        self.assertIs(entry["stages"]["developerModeEnabled"], False)
        self.assertIsNone(entry["stages"]["simulationReady"])
        self.assertEqual(manager._observed_stages, {})

    async def test_a_deep_scan_keeps_measured_stages_for_a_healthy_device(self) -> None:
        manager = DeviceManager(FakeTunnels())
        manager.record_stages(UDID, simulationReady=True)
        manager._usbmux_state = mock.AsyncMock(return_value={"available": True, "address": "127.0.0.1:27015"})

        with fake_pymobiledevice3():
            result = await manager.discover(probe_identity=True)

        entry = result["devices"][0]
        self.assertIs(entry["stages"]["simulationReady"], True)
        self.assertIs(entry["stages"]["developerModeEnabled"], True)
        self.assertIs(entry["stages"]["paired"], True)

    async def test_a_cheap_scan_reports_the_stages_the_bridge_measured(self) -> None:
        manager = DeviceManager(FakeTunnels())
        manager.record_stages(UDID, simulationReady=True, developerServiceAvailable=True)

        with fake_pymobiledevice3():
            result = await manager.discover(probe_identity=False)

        stages = result["devices"][0]["stages"]
        self.assertIs(stages["simulationReady"], True)
        self.assertIs(stages["developerServiceAvailable"], True)
        # Lockdown was not opened, so those stages stay unknown rather than guessed.
        self.assertIsNone(stages["paired"])
        self.assertIsNone(stages["developerModeEnabled"])


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestScanReportsTheMedium(unittest.IsolatedAsyncioTestCase):
    """A usbmuxd entry proves that a link exists *and which kind*.

    Getting the kind wrong is how a phone that only ever appeared over the network ends
    up with a check mark under "USB" - and how a wireless handshake gets attributed to a
    cable that was not plugged in.
    """

    async def _scan(self, *devices, probe_identity: bool) -> tuple[DeviceManager, dict]:
        manager = DeviceManager(FakeTunnels())
        manager._usbmux_state = mock.AsyncMock(
            return_value={"available": True, "address": "127.0.0.1:27015", "deviceCount": len(devices)}
        )
        with fake_pymobiledevice3(devices=list(devices)):
            result = await manager.discover(probe_identity=probe_identity)
        by_type = {entry["connectionType"]: entry for entry in result["devices"]}
        return manager, by_type

    async def test_a_network_entry_is_not_claimed_as_a_cable(self) -> None:
        _, entries = await self._scan(FakeMuxDevice(UDID, "Network"), probe_identity=False)
        entry = entries["Network"]
        self.assertIs(entry["stages"]["usbDetected"], False)
        # No lockdown session ran, so the Wi-Fi path is listed as an entry, not a reach.
        self.assertIsNone(entry["stages"]["wirelessReachable"])

    async def test_a_cable_entry_still_claims_the_cable(self) -> None:
        _, entries = await self._scan(FakeMuxDevice(UDID, "USB"), probe_identity=False)
        self.assertIs(entries["USB"]["stages"]["usbDetected"], True)
        self.assertIsNone(entries["USB"]["stages"]["wirelessReachable"])

    async def test_a_handshake_over_the_network_entry_is_a_wireless_measurement(self) -> None:
        manager, entries = await self._scan(FakeMuxDevice(UDID, "Network"), probe_identity=True)
        entry = entries["Network"]
        self.assertIs(entry["stages"]["usbDetected"], False)
        self.assertIs(entry["stages"]["wirelessReachable"], True)
        self.assertIsNone(entry["stages"]["tunnelOverWireless"])
        self.assertEqual(entry["link"]["proven"]["transports"], [TRANSPORT_WIFI_MUX])
        # Observing a medium is not choosing it: nothing may redirect later commands.
        self.assertIsNone(entry["link"]["selected"])
        self.assertIsNone(manager.selected_endpoint(UDID))
        self.assertTrue(entry["transport"]["wireless"])
        self.assertEqual(entry["transport"]["observedOver"], "Network")

    async def test_a_cable_handshake_is_never_counted_as_wireless_evidence(self) -> None:
        _, entries = await self._scan(FakeMuxDevice(UDID, "USB"), probe_identity=True)
        entry = entries["USB"]
        self.assertIs(entry["stages"]["usbDetected"], True)
        self.assertIsNone(entry["stages"]["wirelessReachable"])
        self.assertEqual(entry["link"]["proven"]["transports"], [TRANSPORT_USB])
        self.assertFalse(entry["transport"]["wireless"])

    async def test_two_entries_for_one_phone_stay_two_observations(self) -> None:
        manager, entries = await self._scan(
            FakeMuxDevice(UDID, "USB"), FakeMuxDevice(UDID, "Network"), probe_identity=True
        )
        self.assertIs(entries["USB"]["stages"]["usbDetected"], True)
        self.assertIs(entries["Network"]["stages"]["usbDetected"], False)
        self.assertEqual(manager._proven[UDID]["transports"], sorted([TRANSPORT_USB, TRANSPORT_WIFI_MUX]))
        # With both media present the cable wins, exactly as usbmuxd itself prefers.
        self.assertEqual(manager.default_endpoint(UDID, ["USB", "Network"]).transport, TRANSPORT_USB)


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestReadinessWordingIsReadableAndIdentifierFree(unittest.IsolatedAsyncioTestCase):
    """Readiness details are painted in the app, so they have to read as measured facts.

    Two failures were both real and both wrong on screen: a device that left usbmuxd
    mid-check was described as "listed as nothing but not as USB", and every variant
    carried the full UDID into text the user sees and screenshots keep.
    """

    async def _readiness(self, devices, **kwargs):
        manager = DeviceManager(FakeTunnels())
        manager._usbmux_state = mock.AsyncMock(
            return_value={"available": True, "address": "127.0.0.1:27015"}
        )
        with fake_pymobiledevice3(devices=devices):
            return await manager.check_readiness(UDID, open_tunnel=False, **kwargs)

    @staticmethod
    def _presence(report):
        return next(check for check in report["checks"] if check["id"] == "device_present")

    @staticmethod
    def _painted_text(report):
        parts = [report["summary"] or ""]
        for check in report["checks"]:
            parts.extend(str(value or "") for value in (check["label"], check["detail"], check["remedy"]))
        return "\n".join(parts)

    async def test_a_cable_entry_is_named_as_a_cable(self) -> None:
        report = await self._readiness([FakeMuxDevice(UDID, "USB")])

        check = self._presence(report)
        self.assertTrue(check["ok"])
        self.assertIn("connection type USB", check["detail"])

    async def test_an_entry_on_the_other_medium_names_that_medium_instead_of_nothing(self) -> None:
        # Only a cable entry exists while the session is pinned to Wi-Fi: the check has
        # to say which medium it actually found, not that the phone is "listed as nothing".
        report = await self._readiness([FakeMuxDevice(UDID, "USB")], transport=TRANSPORT_WIFI_MUX)

        check = self._presence(report)
        self.assertFalse(check["ok"])
        self.assertIn("only as USB", check["detail"])
        self.assertIn("not as Network", check["detail"])
        self.assertNotIn("nothing", check["detail"])

    async def test_a_device_that_vanished_is_reported_as_vanished(self) -> None:
        report = await self._readiness([])

        check = self._presence(report)
        self.assertFalse(check["ok"])
        self.assertIn("no longer lists", check["detail"])
        self.assertEqual(check["remedy"], "Reconnect the cable, then refresh.")

    async def test_painted_readiness_text_never_carries_a_full_udid(self) -> None:
        cases = (
            ([FakeMuxDevice(UDID, "USB")], {}),
            ([FakeMuxDevice(UDID, "Network")], {}),
            ([FakeMuxDevice(UDID, "USB")], {"transport": TRANSPORT_WIFI_MUX}),
            ([], {}),
        )
        for devices, kwargs in cases:
            report = await self._readiness(devices, **kwargs)

            text = self._painted_text(report)
            self.assertNotIn(UDID, text)
            self.assertIn("iPhone ending", text)
            # The machine-readable field that ties the report to a device stays intact.
            self.assertEqual(report["deviceId"], UDID)


if __name__ == "__main__":
    unittest.main()
