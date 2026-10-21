"""Protocol envelopes and error codes shared with the Electron layer."""

from __future__ import annotations

import json
import unittest

from location_studio_bridge.protocol import (
    BridgeError,
    ErrorCode,
    UnsupportedOperation,
    ValidationError,
    event,
    failure,
    success,
)


class TestErrorCodes(unittest.TestCase):
    def test_every_code_the_ui_branches_on_is_stable(self) -> None:
        expected = {
            "INVALID_REQUEST",
            "INVALID_PARAMS",
            "UNKNOWN_METHOD",
            "DEPENDENCY_MISSING",
            "USBMUX_UNAVAILABLE",
            "DEVICE_NOT_FOUND",
            "DEVICE_DISCONNECTED",
            "NOT_PAIRED",
            "PAIRING_FAILED",
            "PAIRING_RECORD_MISSING",
            "DEVELOPER_MODE_DISABLED",
            "TUNNEL_FAILED",
            "TUNNEL_UNAVAILABLE",
            "WIRELESS_UNAVAILABLE",
            "MULTICAST_BLOCKED",
            "SERVICE_UNAVAILABLE",
            "SIMULATION_ACTIVE",
            "NO_ACTIVE_SIMULATION",
            "SIMULATION_FAILED",
            "UNSUPPORTED_OPERATION",
            "TIMEOUT",
            "INTERNAL",
        }
        actual = {value for name, value in vars(ErrorCode).items() if name.isupper()}
        self.assertEqual(actual, expected)


class TestErrorSerialisation(unittest.TestCase):
    def test_to_dict_omits_empty_optional_fields(self) -> None:
        error = BridgeError(ErrorCode.INTERNAL, "Something broke.")
        self.assertEqual(error.to_dict(), {"code": "INTERNAL", "message": "Something broke.", "retryable": False})

    def test_to_dict_includes_details_and_remedy_when_present(self) -> None:
        error = BridgeError(
            ErrorCode.DEVICE_DISCONNECTED,
            "The iPhone was disconnected.",
            "UDID gone",
            remedy="Plug it back in.",
            retryable=True,
        )
        self.assertEqual(
            error.to_dict(),
            {
                "code": "DEVICE_DISCONNECTED",
                "message": "The iPhone was disconnected.",
                "details": "UDID gone",
                "remedy": "Plug it back in.",
                "retryable": True,
            },
        )

    def test_validation_error_uses_invalid_params(self) -> None:
        error = ValidationError("'lat' must be a number.", "received a string")
        self.assertEqual(error.code, ErrorCode.INVALID_PARAMS)
        self.assertEqual(error.details, "received a string")
        self.assertFalse(error.retryable)

    def test_unsupported_operation_is_never_retryable(self) -> None:
        error = UnsupportedOperation("Altitude is not part of this API.")
        self.assertEqual(error.code, ErrorCode.UNSUPPORTED_OPERATION)
        self.assertFalse(error.retryable)


class TestEnvelopes(unittest.TestCase):
    def test_success_envelope(self) -> None:
        envelope = success(7, {"session": None})
        self.assertEqual(envelope, {"type": "response", "id": 7, "ok": True, "result": {"session": None}})

    def test_failure_envelope_carries_the_error_dict(self) -> None:
        envelope = failure("abc", BridgeError(ErrorCode.NOT_PAIRED, "Not paired."))
        self.assertEqual(envelope["type"], "response")
        self.assertEqual(envelope["id"], "abc")
        self.assertFalse(envelope["ok"])
        self.assertEqual(envelope["error"]["code"], "NOT_PAIRED")
        self.assertNotIn("result", envelope)

    def test_event_envelope_is_a_notification(self) -> None:
        envelope = event("simulation.state", {"state": "active"})
        self.assertEqual(envelope["type"], "event")
        self.assertEqual(envelope["event"], "simulation.state")
        self.assertEqual(envelope["data"], {"state": "active"})
        self.assertNotIn("id", envelope)

    def test_envelopes_are_json_serialisable(self) -> None:
        for envelope in (
            success(1, {"lat": 1.0, "lon": 2.0}),
            failure(2, BridgeError(ErrorCode.TIMEOUT, "Timed out.", remedy="Retry.")),
            event("devices.presence", {"devices": []}),
        ):
            restored = json.loads(json.dumps(envelope))
            self.assertEqual(restored, envelope)


if __name__ == "__main__":
    unittest.main()
