"""Simulation session behaviour, driven through the real state machine.

Device access is faked; everything else (session lifecycle, pacing loop, pause
semantics, watchdog, acknowledgement reporting) is the production code.

The property these tests protect: the service never reports a state it did not
observe, and it always tries to release the phone.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, __file__.rsplit("tests", 1)[0] + "bridge")

from location_studio_bridge.protocol import BridgeError, ErrorCode, UnsupportedOperation  # noqa: E402
from location_studio_bridge.simulation import (  # noqa: E402
    DvtLocationTarget,
    LegacyLocationTarget,
    SimulationService,
    SimulationState,
)
from location_studio_bridge.wireless import (  # noqa: E402
    TRANSPORT_RSD_LAN,
    TRANSPORT_WIFI_MUX,
    Endpoint,
)

HAS_PYMOBILEDEVICE3 = importlib.util.find_spec("pymobiledevice3") is not None

UDID = "00008140-0000000000000000"
PARIS = {"lat": 48.8557, "lon": 2.2981}


class FakeTarget:
    """Records every device call so the tests can assert on the real sequence."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, float, float]] = []
        self.opened = False
        self.closed = False
        self.cleared = False
        self.fail_set_after: int | None = None

    async def open(self) -> None:
        self.opened = True

    async def set(self, latitude: float, longitude: float) -> None:
        if self.fail_set_after is not None and len(self.calls) >= self.fail_set_after:
            raise BridgeError(ErrorCode.SIMULATION_FAILED, "The device stopped acknowledging updates.")
        self.calls.append(("set", latitude, longitude))

    async def clear(self) -> None:
        self.cleared = True
        self.calls.append(("clear", 0.0, 0.0))

    async def close(self) -> None:
        self.closed = True


class AcknowledgedTarget(FakeTarget):
    acknowledged = True
    kind = "dvt-rsd"


class LegacyFakeTarget(FakeTarget):
    acknowledged = False
    kind = "lockdown-dt-simulatelocation"


class FakeMuxDevice:
    def __init__(self, serial: str) -> None:
        self.serial = serial
        self.connection_type = "USB"

    def matches_udid(self, udid: str) -> bool:
        return udid == self.serial


class SimulationTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.emitted: list[tuple[str, dict]] = []
        self.target = AcknowledgedTarget()
        self.service = self._build_service()

    def _build_service(self) -> SimulationService:
        service = SimulationService(tunnels=mock.Mock(), emit=self._emit)
        self.identity_calls: list[tuple[str, str | None]] = []
        self.built_with: list[tuple[str, object]] = []

        async def read_identity(device_id: str, connection_type: str | None = None) -> dict:
            self.identity_calls.append((device_id, connection_type))
            return {"deviceName": "Test iPhone", "productVersion": "27.0.1", "developerModeEnabled": True}

        async def build_target(device_id: str, identity: dict, endpoint: object = None) -> FakeTarget:
            self.built_with.append((device_id, endpoint))
            await self.target.open()
            return self.target

        service._read_identity = read_identity  # type: ignore[assignment]
        service._build_target = build_target  # type: ignore[assignment]
        return service

    async def _emit(self, name: str, payload: dict) -> None:
        self.emitted.append((name, payload))

    async def asyncTearDown(self) -> None:
        try:
            await self.service.stop()
        except BridgeError:
            pass
        await self.service.shutdown()

    async def wait_until(self, predicate, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.01)
        return False


class TestFixedLocation(SimulationTestCase):
    async def test_start_applies_the_first_coordinate_before_reporting_active(self) -> None:
        snapshot = await self.service.start_fixed(UDID, PARIS)

        self.assertEqual(snapshot["mode"], "fixed")
        self.assertEqual(snapshot["state"], SimulationState.ACTIVE)
        self.assertTrue(snapshot["deviceAcknowledged"])
        self.assertEqual(snapshot["current"], {"lat": PARIS["lat"], "lon": PARIS["lon"]})
        # The very first device call is the coordinate itself, so a reported
        # "active" state can never precede an acknowledged device write.
        self.assertEqual(self.target.calls[0], ("set", PARIS["lat"], PARIS["lon"]))
        self.assertEqual(snapshot["locationOverrideActive"], True)

    async def test_a_rejected_first_coordinate_never_becomes_an_active_session(self) -> None:
        self.target.fail_set_after = 0
        with self.assertRaises(BridgeError) as context:
            await self.service.start_fixed(UDID, PARIS)

        self.assertEqual(context.exception.code, ErrorCode.SIMULATION_FAILED)
        self.assertIsNone(self.service._session, "a failed start must not leave a session behind")
        self.assertTrue(self.target.cleared, "the service must still try to release the device")
        self.assertTrue(self.target.closed)

    async def test_coordinates_are_validated_before_any_device_call(self) -> None:
        with self.assertRaises(BridgeError) as context:
            await self.service.start_fixed(UDID, {"lat": 91, "lon": 0})
        self.assertEqual(context.exception.code, ErrorCode.INVALID_PARAMS)
        self.assertEqual(self.target.calls, [])
        self.assertFalse(self.target.opened)

    async def test_stop_clears_the_device_and_reports_it(self) -> None:
        await self.service.start_fixed(UDID, PARIS)
        snapshot = await self.service.stop()

        self.assertEqual(snapshot["state"], SimulationState.STOPPED)
        self.assertTrue(self.target.cleared)
        self.assertTrue(self.target.closed)
        self.assertEqual(snapshot["locationOverrideActive"], False)
        reasons = [payload.get("reason") for _name, payload in self.emitted]
        self.assertIn("stopped", reasons)
        stopped_event = next(payload for _name, payload in self.emitted if payload.get("reason") == "stopped")
        self.assertTrue(stopped_event["deviceCleared"])

    async def test_a_second_session_is_refused_while_one_is_running(self) -> None:
        await self.service.start_fixed(UDID, PARIS)
        with self.assertRaises(BridgeError) as context:
            await self.service.start_fixed(UDID, {"lat": 1.0, "lon": 2.0})
        self.assertEqual(context.exception.code, ErrorCode.SIMULATION_ACTIVE)
        self.assertTrue(context.exception.remedy)

    async def test_stopping_a_finished_session_reports_the_last_outcome(self) -> None:
        await self.service.start_fixed(UDID, PARIS)
        await self.service.stop()
        snapshot = await self.service.stop()
        self.assertEqual(snapshot["state"], SimulationState.STOPPED)

    async def test_pause_and_resume_are_only_valid_on_a_route(self) -> None:
        await self.service.start_fixed(UDID, PARIS)

        # A held coordinate has no playback to suspend, so both verbs are refused
        # instead of pretending the device stopped simulating.
        for call in (self.service.pause, self.service.resume):
            with self.assertRaises(UnsupportedOperation) as context:
                await call()
            self.assertEqual(context.exception.code, ErrorCode.UNSUPPORTED_OPERATION)
            self.assertIn("fixed", str(context.exception).lower())

        self.assertEqual(self.service._session.state, SimulationState.ACTIVE)  # noqa: SLF001
        self.assertTrue(self.service._session.snapshot()["locationOverrideActive"])  # noqa: SLF001

    async def test_operations_without_a_session_report_no_active_simulation(self) -> None:
        for call in (self.service.pause, self.service.resume):
            with self.assertRaises(BridgeError) as context:
                await call()
            self.assertEqual(context.exception.code, ErrorCode.NO_ACTIVE_SIMULATION)

    async def test_status_reports_the_session_and_the_history(self) -> None:
        await self.service.start_fixed(UDID, PARIS)
        status = await self.service.status()
        self.assertEqual(status["session"]["state"], SimulationState.ACTIVE)
        self.assertIn("tunnel", status)
        self.assertEqual(len(status["history"]), 1)
        self.assertEqual(status["history"][0]["state"], SimulationState.ACTIVE)

        await self.service.stop()
        status = await self.service.status()
        self.assertEqual(status["session"]["state"], SimulationState.STOPPED)
        # One session is one history row, even though it went through several states.
        self.assertEqual(len(status["history"]), 1)
        self.assertEqual(status["history"][0]["sessionId"], status["session"]["sessionId"])
        self.assertEqual(status["history"][0]["state"], SimulationState.STOPPED)


class TestRoutePlayback(SimulationTestCase):
    ROUTE = [
        {"lat": 48.8557, "lon": 2.2981},
        {"lat": 48.8561, "lon": 2.2985},
        {"lat": 48.8565, "lon": 2.2990},
    ]

    async def _run_route(self, options: dict) -> dict:
        snapshot = await self.service.start_route(UDID, self.ROUTE, options)
        self.assertEqual(snapshot["state"], SimulationState.ACTIVE)
        completed = await self.wait_until(lambda: self.service._session.state == SimulationState.COMPLETED)  # noqa: SLF001
        self.assertTrue(completed, "route playback did not finish in time")
        return self.service._session.snapshot()  # noqa: SLF001

    async def test_route_playback_publishes_every_interpolated_point(self) -> None:
        snapshot = await self._run_route({"speedMps": 400.0, "updateRateHz": 20.0, "interpolate": True, "loop": False})

        self.assertEqual(snapshot["state"], SimulationState.COMPLETED)
        self.assertGreater(snapshot["totalPoints"], len(self.ROUTE))
        self.assertEqual(snapshot["publishedPointCount"], snapshot["totalPoints"] - 1)
        # First and last published coordinates are the route endpoints.
        self.assertAlmostEqual(self.target.calls[0][1], self.ROUTE[0]["lat"], places=6)
        last_set = [call for call in self.target.calls if call[0] == "set"][-1]
        self.assertAlmostEqual(last_set[1], self.ROUTE[-1]["lat"], places=6)
        self.assertAlmostEqual(last_set[2], self.ROUTE[-1]["lon"], places=6)

    async def test_a_completed_route_keeps_the_override_until_stopped(self) -> None:
        snapshot = await self._run_route({"speedMps": 400.0, "updateRateHz": 20.0})
        self.assertTrue(snapshot["locationOverrideActive"], "the device still holds the last coordinate")

        stopped = await self.service.stop()
        self.assertEqual(stopped["state"], SimulationState.STOPPED)
        self.assertFalse(stopped["locationOverrideActive"])

    async def test_a_completed_route_leaves_one_history_row_with_the_real_outcome(self) -> None:
        await self._run_route({"speedMps": 400.0, "updateRateHz": 20.0})

        # The route finished on its own: the history row must say "completed",
        # not the "active" state that was recorded when the session started.
        status = await self.service.status()
        self.assertEqual(len(status["history"]), 1)
        self.assertEqual(status["history"][0]["sessionId"], status["session"]["sessionId"])
        self.assertEqual(status["history"][0]["state"], SimulationState.COMPLETED)
        self.assertEqual(
            status["history"][0]["publishedPointCount"], status["session"]["publishedPointCount"]
        )

    async def test_pause_stops_publishing_and_resume_continues(self) -> None:
        await self.service.start_route(UDID, self.ROUTE, {"speedMps": 2.0, "updateRateHz": 5.0})
        await asyncio.sleep(0.05)

        paused = await self.service.pause()
        self.assertEqual(paused["state"], SimulationState.PAUSED)
        published_at_pause = paused["publishedPointCount"]

        await asyncio.sleep(0.3)
        still_paused = await self.service.status()
        self.assertEqual(still_paused["session"]["state"], SimulationState.PAUSED)
        self.assertEqual(
            still_paused["session"]["publishedPointCount"],
            published_at_pause,
            "no coordinate may be published while paused",
        )

        resumed = await self.service.resume()
        self.assertEqual(resumed["state"], SimulationState.ACTIVE)
        self.assertTrue(
            await self.wait_until(lambda: self.service._session.published_count > published_at_pause)  # noqa: SLF001
        )

    async def test_route_options_are_validated(self) -> None:
        with self.assertRaises(BridgeError) as context:
            await self.service.start_route(UDID, self.ROUTE, {"speedMps": 0})
        self.assertEqual(context.exception.code, ErrorCode.INVALID_PARAMS)

        with self.assertRaises(BridgeError) as context:
            await self.service.start_route(UDID, [PARIS], {})
        self.assertEqual(context.exception.code, ErrorCode.INVALID_PARAMS)

    async def test_progress_events_carry_distance_and_ratio(self) -> None:
        await self._run_route({"speedMps": 400.0, "updateRateHz": 20.0})
        progress_events = [payload for name, payload in self.emitted if name == "simulation.progress"]
        self.assertTrue(progress_events)
        for payload in progress_events:
            self.assertIn("distanceM", payload)
            self.assertGreaterEqual(payload["progress"], 0.0)
            self.assertLessEqual(payload["progress"], 1.0)
        self.assertEqual(progress_events[-1]["progress"], 1.0)

    async def test_a_device_error_fails_the_session_and_releases_the_device(self) -> None:
        self.target.fail_set_after = 3
        await self.service.start_route(UDID, self.ROUTE, {"speedMps": 400.0, "updateRateHz": 20.0})
        self.assertTrue(await self.wait_until(lambda: self.service._session.state == SimulationState.FAILED))  # noqa: SLF001
        snapshot = self.service._session.snapshot()  # noqa: SLF001

        self.assertEqual(snapshot["state"], SimulationState.FAILED)
        self.assertEqual(snapshot["error"]["code"], ErrorCode.SIMULATION_FAILED)
        self.assertFalse(snapshot["locationOverrideActive"])
        self.assertTrue(self.target.cleared)
        self.assertTrue(self.target.closed)

    async def test_loop_restarts_the_route_until_stopped(self) -> None:
        await self.service.start_route(UDID, self.ROUTE, {"speedMps": 400.0, "updateRateHz": 20.0, "loop": True})
        self.assertTrue(await self.wait_until(lambda: self.service._session.loop_count >= 1))  # noqa: SLF001
        self.assertEqual(self.service._session.state, SimulationState.ACTIVE)  # noqa: SLF001

        await self.service.stop()
        self.assertEqual(self.service._session.state, SimulationState.STOPPED)  # noqa: SLF001


class TestDisconnection(SimulationTestCase):
    async def test_the_watchdog_ends_the_session_when_the_device_disappears(self) -> None:
        connected = mock.Mock()
        connected.list_devices = mock.AsyncMock(return_value=[FakeMuxDevice("some-other-udid")])

        with mock.patch("pymobiledevice3.usbmux.list_devices", connected.list_devices), mock.patch(
            "location_studio_bridge.simulation.DEVICE_WATCH_INTERVAL_S", 0.02
        ):
            await self.service.start_fixed(UDID, PARIS)
            self.assertTrue(await self.wait_until(lambda: self.service._session.state == SimulationState.DISCONNECTED))  # noqa: SLF001

        snapshot = self.service._session.snapshot()  # noqa: SLF001
        self.assertEqual(snapshot["state"], SimulationState.DISCONNECTED)
        self.assertEqual(snapshot["error"]["code"], ErrorCode.DEVICE_DISCONNECTED)
        self.assertFalse(snapshot["locationOverrideActive"])
        self.assertIn("real GPS", snapshot["error"]["details"])

    async def test_a_failing_usbmux_scan_is_not_treated_as_a_disconnect(self) -> None:
        failing = mock.AsyncMock(side_effect=OSError("usbmuxd busy"))

        with mock.patch("pymobiledevice3.usbmux.list_devices", failing), mock.patch(
            "location_studio_bridge.simulation.DEVICE_WATCH_INTERVAL_S", 0.02
        ):
            await self.service.start_fixed(UDID, PARIS)
            await asyncio.sleep(0.15)
            self.assertEqual(self.service._session.state, SimulationState.ACTIVE)  # noqa: SLF001


class TestShutdown(SimulationTestCase):
    async def test_shutdown_stops_an_active_session(self) -> None:
        await self.service.start_fixed(UDID, PARIS)
        await self.service.shutdown()
        self.assertEqual(self.service._session.state, SimulationState.STOPPED)  # noqa: SLF001
        self.assertTrue(self.target.cleared)

    async def test_shutdown_is_safe_without_a_session(self) -> None:
        await self.service.shutdown()
        self.assertIsNone(self.service._session)  # noqa: SLF001


class TestTransportHonesty(unittest.TestCase):
    def test_only_the_dvt_transport_claims_device_acknowledgement(self) -> None:
        self.assertTrue(DvtLocationTarget.acknowledged)
        self.assertEqual(DvtLocationTarget.kind, "dvt-rsd")

        # The legacy lockdown service is fire-and-forget, so the UI must never be
        # told the device confirmed those writes.
        self.assertFalse(LegacyLocationTarget.acknowledged)
        self.assertEqual(LegacyLocationTarget.kind, "lockdown-dt-simulatelocation")

    def test_clear_and_close_are_no_ops_before_the_target_is_opened(self) -> None:
        import asyncio

        target = DvtLocationTarget(rsd=object())
        asyncio.run(target.clear())
        asyncio.run(target.close())
        self.assertIsNone(target._simulation)  # noqa: SLF001


class TestMediumPinning(SimulationTestCase):
    """A session must remember, and be built on, the transport it was asked for.

    usbmuxd answers from the cable whenever both entries exist, so a wireless session
    that does not pin its medium is really a USB session wearing a wireless label.
    """

    async def test_a_wireless_endpoint_is_threaded_into_every_device_call(self) -> None:
        endpoint = Endpoint(UDID, TRANSPORT_WIFI_MUX)
        snapshot = await self.service.start_fixed(UDID, PARIS, endpoint=endpoint)

        self.assertEqual(self.identity_calls, [(UDID, "Network")])
        self.assertEqual(self.built_with, [(UDID, endpoint)])
        self.assertEqual(snapshot["link"]["transport"], TRANSPORT_WIFI_MUX)
        self.assertTrue(snapshot["link"]["wireless"])

    async def test_a_session_built_without_an_endpoint_claims_no_medium(self) -> None:
        snapshot = await self.service.start_fixed(UDID, PARIS)

        # Nothing pinned: lockdown is reached through whatever usbmuxd prefers, which is
        # reported as unknown rather than guessed to be the cable.
        self.assertEqual(self.identity_calls, [(UDID, None)])
        self.assertIsNone(snapshot["link"]["transport"])
        self.assertFalse(snapshot["link"]["wireless"])

    async def test_a_direct_lan_session_skips_the_usb_watchdog(self) -> None:
        await self.service.start_fixed(
            UDID, PARIS, endpoint=Endpoint(UDID, TRANSPORT_RSD_LAN, host="192.0.2.9")
        )
        session = self.service._session  # noqa: SLF001
        self.assertIsNotNone(session)
        # The mux scan that a cable removal would show up in has no entry for a phone that
        # was reached directly over the LAN, so watching it would only produce false alarms.
        self.assertIsNone(session._watchdog)  # noqa: SLF001
        self.assertEqual(session.link["transport"], TRANSPORT_RSD_LAN)
        await self.service.stop()


@unittest.skipUnless(HAS_PYMOBILEDEVICE3, "pymobiledevice3 is not installed for this interpreter")
class TestLegacyMediumPinning(unittest.IsolatedAsyncioTestCase):
    async def test_a_wireless_legacy_session_pins_lockdown_to_the_network_entry(self) -> None:
        import pymobiledevice3.lockdown as lockdown_module

        seen: dict[str, object] = {}

        class ProbeService:
            async def close(self) -> None:
                pass

        class Client:
            async def start_lockdown_developer_service(self, name: str) -> ProbeService:
                seen["service"] = name
                return ProbeService()

            async def close(self) -> None:
                pass

        async def create_using_usbmux(**kwargs):
            seen.update(kwargs)
            return Client()

        with mock.patch.object(lockdown_module, "create_using_usbmux", create_using_usbmux):
            target = LegacyLocationTarget(UDID, "Network")
            await target.open()

        self.assertEqual(seen["serial"], UDID)
        self.assertEqual(seen["connection_type"], "Network")
        # The legacy service never confirms a write, on any medium.
        self.assertFalse(target.acknowledged)


if __name__ == "__main__":
    unittest.main()
