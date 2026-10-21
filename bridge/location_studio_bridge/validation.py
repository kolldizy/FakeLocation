"""Strict input validation for everything the UI is allowed to send.

Nothing in this module trusts its input. Every value that reaches a device call
passes through here first.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable, Optional

from .protocol import ValidationError

# A UDID is a 40-char hex string (older devices, e.g. 00008140-0000000000000000
# carries a dash) or a 24/25-char ECID-based identifier on newer ones.
_UDID_RE = re.compile(r"^[0-9A-Fa-f][0-9A-Fa-f-]{7,63}$")

MAX_ROUTE_POINTS = 20000
MIN_ROUTE_POINTS = 2

MAX_LATITUDE = 90.0
MAX_LONGITUDE = 180.0
MAX_ABS_ALTITUDE = 12000.0
MIN_SPEED_MPS = 0.1
MAX_SPEED_MPS = 400.0
MAX_UPDATE_RATE_HZ = 20.0
MIN_UPDATE_RATE_HZ = 0.5


def require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"'{name}' must be an object.")
    return value


def require_string(value: Any, name: str, *, max_length: int = 256, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"'{name}' must be a string.")
    text = value.strip()
    if not text and not allow_empty:
        raise ValidationError(f"'{name}' must not be empty.")
    if len(text) > max_length:
        raise ValidationError(f"'{name}' must be at most {max_length} characters.")
    if any(ord(ch) < 0x20 and ch not in "\t" for ch in text):
        raise ValidationError(f"'{name}' must not contain control characters.")
    return text


def require_number(value: Any, name: str, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"'{name}' must be a number.")
    number = float(value)
    if not math.isfinite(number):
        raise ValidationError(f"'{name}' must be a finite number.")
    if number < minimum or number > maximum:
        raise ValidationError(f"'{name}' must be between {minimum} and {maximum} (received {number}).")
    return number


def require_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValidationError(f"'{name}' must be a boolean.")
    return value


def optional_number(value: Any, name: str, *, minimum: float, maximum: float) -> Optional[float]:
    if value is None:
        return None
    return require_number(value, name, minimum=minimum, maximum=maximum)


def validate_udid(value: Any) -> str:
    udid = require_string(value, "deviceId", max_length=64)
    if not _UDID_RE.match(udid):
        raise ValidationError(
            "'deviceId' is not a plausible device identifier.",
            "Expected 8-64 hexadecimal characters, optionally separated by dashes.",
        )
    return udid


#: The transports a caller may choose. This is an allowlist rather than a free-form
#: value on purpose: the renderer can never name a host, a port, a path or a command -
#: addresses are discovered by the bridge and referenced only by one of these ids.
TRANSPORTS = ("usb", "wifi-mux", "rsd-lan")


def validate_transport(value: Any, name: str = "transport") -> str:
    transport = require_string(value, name, max_length=16)
    if transport not in TRANSPORTS:
        raise ValidationError(
            f"'{name}' must be one of: {', '.join(TRANSPORTS)}.",
            "Addresses are resolved by the bridge; the caller only selects a transport.",
        )
    return transport


def validate_latitude(value: Any, name: str = "latitude") -> float:
    return require_number(value, name, minimum=-MAX_LATITUDE, maximum=MAX_LATITUDE)


def validate_longitude(value: Any, name: str = "longitude") -> float:
    return require_number(value, name, minimum=-MAX_LONGITUDE, maximum=MAX_LONGITUDE)


def validate_altitude(value: Any, name: str = "altitude") -> Optional[float]:
    return optional_number(value, name, minimum=-MAX_ABS_ALTITUDE, maximum=MAX_ABS_ALTITUDE)


def validate_coordinate(value: Any, name: str = "coordinate") -> dict[str, float]:
    """Validate a ``{lat, lon, altitude?}`` object and return a normalised copy.

    ``lat``/``lon`` are the wire format used by the renderer, which keeps the
    bridge contract deliberately different from pymobiledevice3's ``latitude``/
    ``longitude`` argument names.
    """
    obj = require_object(value, name)
    latitude = validate_latitude(obj.get("lat"), f"{name}.lat")
    longitude = validate_longitude(obj.get("lon"), f"{name}.lon")
    result: dict[str, float] = {"lat": latitude, "lon": longitude}
    if "altitude" in obj:
        altitude = validate_altitude(obj.get("altitude"), f"{name}.altitude")
        if altitude is not None:
            result["altitude"] = altitude
    return result


def validate_points(value: Any, *, name: str = "points", minimum: int = 1) -> list[dict[str, float]]:
    if not isinstance(value, list):
        raise ValidationError(f"'{name}' must be an array of coordinates.")
    if len(value) < minimum:
        raise ValidationError(f"'{name}' needs at least {minimum} coordinate(s).")
    if len(value) > MAX_ROUTE_POINTS:
        raise ValidationError(f"'{name}' must not contain more than {MAX_ROUTE_POINTS} coordinates.")
    return [validate_coordinate(item, f"{name}[{index}]") for index, item in enumerate(value)]


def validate_route_options(value: Any) -> dict[str, Any]:
    """Validate route playback options. Values that the device cannot honour are rejected, not ignored."""
    if value is None:
        value = {}
    obj = require_object(value, "options")

    speed = optional_number(obj.get("speedMps"), "options.speedMps", minimum=MIN_SPEED_MPS, maximum=MAX_SPEED_MPS)
    if speed is None:
        speed = 8.0

    interruptible = obj.get("interpolate", True)
    interpolate = require_bool(interruptible, "options.interpolate")

    update_rate = optional_number(
        obj.get("updateRateHz"), "options.updateRateHz", minimum=MIN_UPDATE_RATE_HZ, maximum=MAX_UPDATE_RATE_HZ
    )
    if update_rate is None:
        update_rate = 5.0

    loop = obj.get("loop", False)
    loop_enabled = require_bool(loop, "options.loop")

    return {
        "speedMps": speed,
        "interpolate": interpolate,
        "updateRateHz": update_rate,
        "loop": loop_enabled,
    }


def validate_method_params(params: Any) -> dict[str, Any]:
    if params is None:
        return {}
    return require_object(params, "params")


def clamp_safe_text(value: Any, limit: int = 500) -> str:
    """Reduce untrusted device- or file-supplied text to a log-safe single line."""
    if value is None:
        return ""
    text = str(value)
    text = text.replace("\r", " ").replace("\n", " ")
    text = "".join(ch for ch in text if ch == "\t" or ord(ch) >= 0x20)
    return text[:limit]


def sum_lengths(items: Iterable[Any]) -> int:
    return sum(1 for _ in items)
