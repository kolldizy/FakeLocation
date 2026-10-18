"""Validation rules for everything the UI is allowed to send to the bridge."""

from __future__ import annotations

import unittest

from location_studio_bridge.protocol import ErrorCode, ValidationError
from location_studio_bridge.validation import (
    clamp_safe_text,
    require_bool,
    require_number,
    require_object,
    require_string,
    validate_altitude,
    validate_coordinate,
    validate_latitude,
    validate_longitude,
    validate_points,
    validate_route_options,
    validate_udid,
)

UDID = "00008140-0000000000000000"


class TestStrings(unittest.TestCase):
    def test_require_string_trims_and_bounds(self) -> None:
        self.assertEqual(require_string("  hello ", "name"), "hello")
        self.assertEqual(require_string("x" * 10, "name", max_length=10), "x" * 10)

    def test_require_string_rejects_bad_values(self) -> None:
        for value in (None, 5, [], {}):
            with self.assertRaises(ValidationError):
                require_string(value, "name")
        with self.assertRaises(ValidationError):
            require_string("   ", "name")
        with self.assertRaises(ValidationError):
            require_string("x" * 11, "name", max_length=10)
        with self.assertRaises(ValidationError):
            require_string("bad\x00value", "name")

    def test_clamp_safe_text_flattens_untrusted_output(self) -> None:
        self.assertEqual(clamp_safe_text("line1\r\nline2"), "line1  line2")
        self.assertEqual(clamp_safe_text("a\x07b"), "ab")
        self.assertEqual(clamp_safe_text(None), "")
        self.assertEqual(len(clamp_safe_text("x" * 900, 10)), 10)


class TestNumbers(unittest.TestCase):
    def test_require_number_bounds_and_type(self) -> None:
        self.assertEqual(require_number(5, "n", minimum=0, maximum=10), 5.0)
        with self.assertRaises(ValidationError):
            require_number("5", "n", minimum=0, maximum=10)
        with self.assertRaises(ValidationError):
            require_number(True, "n", minimum=0, maximum=10)
        with self.assertRaises(ValidationError):
            require_number(float("nan"), "n", minimum=0, maximum=10)
        with self.assertRaises(ValidationError):
            require_number(float("inf"), "n", minimum=0, maximum=10)
        with self.assertRaises(ValidationError):
            require_number(-0.1, "n", minimum=0, maximum=10)
        with self.assertRaises(ValidationError):
            require_number(10.1, "n", minimum=0, maximum=10)

    def test_require_bool_is_strict(self) -> None:
        self.assertTrue(require_bool(True, "flag"))
        self.assertFalse(require_bool(False, "flag"))
        for value in (1, 0, "true", None):
            with self.assertRaises(ValidationError):
                require_bool(value, "flag")

    def test_require_object_rejects_arrays(self) -> None:
        self.assertEqual(require_object({}, "params"), {})
        for value in ([], None, "{}", 3):
            with self.assertRaises(ValidationError):
                require_object(value, "params")


class TestDeviceId(unittest.TestCase):
    def test_accepts_plausible_udids(self) -> None:
        self.assertEqual(validate_udid(UDID), UDID)
        self.assertEqual(validate_udid("abcdef0123456789"), "abcdef0123456789")
        self.assertEqual(validate_udid(f"  {UDID}  "), UDID)

    def test_rejects_everything_else(self) -> None:
        for value in (None, "", "   ", "short", "-starts-with-dash", "has spaces", "$(id)", "x" * 65, 1234, [UDID]):
            with self.assertRaises(ValidationError):
                validate_udid(value)


class TestCoordinates(unittest.TestCase):
    def test_validate_coordinate_normalises_and_keeps_altitude(self) -> None:
        self.assertEqual(validate_coordinate({"lat": 47, "lon": 28}), {"lat": 47.0, "lon": 28.0})
        self.assertEqual(
            validate_coordinate({"lat": 47.5, "lon": 28.5, "altitude": 12}),
            {"lat": 47.5, "lon": 28.5, "altitude": 12.0},
        )
        # An explicit null altitude is dropped rather than stored as None.
        self.assertEqual(validate_coordinate({"lat": 1, "lon": 2, "altitude": None}), {"lat": 1.0, "lon": 2.0})

    def test_boundaries_are_inclusive(self) -> None:
        self.assertEqual(validate_latitude(90), 90.0)
        self.assertEqual(validate_latitude(-90), -90.0)
        self.assertEqual(validate_longitude(180), 180.0)
        self.assertEqual(validate_longitude(-180), -180.0)
        self.assertEqual(validate_altitude(-12000), -12000.0)

    def test_out_of_range_is_an_error_not_a_clamp(self) -> None:
        with self.assertRaises(ValidationError):
            validate_latitude(90.0000001)
        with self.assertRaises(ValidationError):
            validate_longitude(-180.5)
        with self.assertRaises(ValidationError):
            validate_altitude(12001)
        with self.assertRaises(ValidationError):
            validate_coordinate({"lat": 0})
        with self.assertRaises(ValidationError):
            validate_coordinate([47, 28])
        with self.assertRaises(ValidationError):
            validate_coordinate("47,28")

    def test_validate_points_enforces_minimum_and_cap(self) -> None:
        self.assertEqual(len(validate_points([{"lat": 0, "lon": 0}])), 1)
        with self.assertRaises(ValidationError):
            validate_points([], minimum=2)
        with self.assertRaises(ValidationError):
            validate_points([{"lat": 0, "lon": 0}], minimum=2)
        with self.assertRaises(ValidationError):
            validate_points("nope")
        with self.assertRaises(ValidationError):
            validate_points([{"lat": 0, "lon": 0}] * 20_001)
        self.assertEqual(len(validate_points([{"lat": 0, "lon": 0}] * 20_000)), 20_000)

    def test_validate_points_points_at_the_bad_index(self) -> None:
        with self.assertRaises(ValidationError) as context:
            validate_points([{"lat": 0, "lon": 0}, {"lat": 100, "lon": 0}], minimum=1)
        self.assertIn("points[1].lat", str(context.exception))


class TestRouteOptions(unittest.TestCase):
    def test_defaults_are_explicit(self) -> None:
        self.assertEqual(
            validate_route_options(None),
            {"speedMps": 8.0, "interpolate": True, "updateRateHz": 5.0, "loop": False},
        )
        self.assertEqual(validate_route_options({})["speedMps"], 8.0)

    def test_values_are_honoured_within_bounds(self) -> None:
        options = validate_route_options({"speedMps": 1.5, "updateRateHz": 10, "interpolate": False, "loop": True})
        self.assertEqual(options, {"speedMps": 1.5, "interpolate": False, "updateRateHz": 10.0, "loop": True})

    def test_values_the_device_cannot_honour_are_rejected(self) -> None:
        for bad in (
            {"speedMps": 0},
            {"speedMps": 401},
            {"speedMps": "8"},
            {"updateRateHz": 0.1},
            {"updateRateHz": 21},
            {"interpolate": "yes"},
            {"loop": "yes"},
        ):
            with self.assertRaises(ValidationError):
                validate_route_options(bad)

    def test_error_code_is_invalid_params(self) -> None:
        with self.assertRaises(ValidationError) as context:
            validate_route_options({"loop": 42})
        self.assertEqual(context.exception.code, ErrorCode.INVALID_PARAMS)


if __name__ == "__main__":
    unittest.main()
