"""Sanitised GPX import and export.

Import rules (all enforced, none optional):

* the payload is parsed with ``defusedxml`` so ``DOCTYPE``/entity-expansion
  attacks are rejected before any element is touched;
* the byte size and the element count are bounded;
* every coordinate must be a finite number inside the legal lat/lon range;
* unknown/irrelevant elements are ignored rather than copied through, so an
  imported route can never smuggle markup back out through export;
* text is never interpolated into XML without escaping.
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence
from xml.sax.saxutils import escape

from defusedxml import ElementTree as DefusedET  # type: ignore[import-untyped]

from .protocol import ValidationError
from .validation import MAX_LATITUDE, MAX_LONGITUDE, MAX_ROUTE_POINTS, validate_points

MAX_GPX_BYTES = 16 * 1024 * 1024
MAX_GPX_ELEMENTS = 400_000
GPX_NAMESPACE = "http://www.topografix.com/GPX/1/1"


def _local_name(element: Any) -> str:
    return str(element.tag).rpartition("}")[2]


def _finite_float(text: Any) -> float | None:
    try:
        value = float(str(text).strip())
    except (TypeError, ValueError):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def _point_from_element(element: Any) -> dict[str, float] | None:
    latitude = _finite_float(element.get("lat"))
    longitude = _finite_float(element.get("lon"))
    if latitude is None or longitude is None:
        return None
    if abs(latitude) > MAX_LATITUDE or abs(longitude) > MAX_LONGITUDE:
        return None

    point: dict[str, float] = {"lat": latitude, "lon": longitude}
    for child in element:
        if _local_name(child) == "ele":
            altitude = _finite_float(child.text)
            if altitude is not None and abs(altitude) <= 12000.0:
                point["altitude"] = altitude
            break
    return point


def parse_gpx(payload: str | bytes, *, source_name: str = "route.gpx") -> dict[str, Any]:
    """Parse GPX text into a validated ``{name, points, trackName}`` structure."""
    if isinstance(payload, bytes):
        if len(payload) > MAX_GPX_BYTES:
            raise ValidationError(f"'{source_name}' is larger than the {MAX_GPX_BYTES // (1024 * 1024)} MB import limit.")
        text = payload.decode("utf-8", errors="strict")
    else:
        text = payload
        if len(text.encode("utf-8", errors="ignore")) > MAX_GPX_BYTES:
            raise ValidationError(f"'{source_name}' is larger than the {MAX_GPX_BYTES // (1024 * 1024)} MB import limit.")

    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise ValidationError(
            f"'{source_name}' contains a document type or entity declaration and was rejected.",
            "GPX files must not declare entities. Re-export the file from a standard mapping tool.",
        )

    try:
        root = DefusedET.fromstring(text)
    except Exception as exc:  # noqa: BLE001 - defusedxml raises a variety of errors
        raise ValidationError(f"'{source_name}' is not a readable GPX/XML document.", str(exc)) from exc

    if _local_name(root) != "gpx":
        raise ValidationError(
            f"'{source_name}' root element is <{_local_name(root)}>, not <gpx>.",
            "Only GPX files are accepted.",
        )

    element_count = sum(1 for _ in root.iter())
    if element_count > MAX_GPX_ELEMENTS:
        raise ValidationError(f"'{source_name}' contains too many XML elements ({element_count}).")

    track_points: list[dict[str, float]] = []
    waypoints: list[dict[str, float]] = []
    track_name = ""
    waypoint_name = ""

    for element in root.iter():
        name = _local_name(element)
        if name in ("trk", "rte"):
            label = next((child.text for child in element if _local_name(child) == "name"), None)
            if label and not track_name:
                track_name = str(label).strip()[:120]
            continue
        if name not in ("trkpt", "rtept", "wpt"):
            continue

        point = _point_from_element(element)
        if point is None:
            continue

        if name == "wpt":
            waypoints.append(point)
            for child in element:
                if _local_name(child) == "name" and child.text and not waypoint_name:
                    waypoint_name = str(child.text).strip()[:120]
        else:
            track_points.append(point)
        if len(track_points) + len(waypoints) > MAX_ROUTE_POINTS:
            raise ValidationError(f"'{source_name}' has more than {MAX_ROUTE_POINTS} points.")

    # A GPX may carry waypoint markers *and* a track. Replaying both would duplicate
    # every position, so the ordered track/route wins and waypoints are only used as
    # a fallback for files that have no ordered geometry at all.
    raw_points = track_points or waypoints
    points: list[dict[str, float]] = []
    for point in raw_points:
        if points and points[-1]["lat"] == point["lat"] and points[-1]["lon"] == point["lon"]:
            continue  # collapse exact duplicates so pacing is not distorted
        points.append(point)

    if not points:
        raise ValidationError(
            f"'{source_name}' contains no usable coordinates.",
            "Coordinates must be valid and inside -90..90 latitude / -180..180 longitude.",
        )

    validated = validate_points(points, name="gpx.points", minimum=1)
    return {
        "name": track_name or waypoint_name or "Imported route",
        "points": validated,
        "rawPointCount": len(validated),
        "source": source_name,
        "geometry": "track" if track_points else ("waypoints" if waypoints else "none"),
    }


def _format_number(value: float) -> str:
    text = f"{float(value):.7f}".rstrip("0").rstrip(".")
    return text or "0"


def build_gpx(
    points: Sequence[dict[str, float]],
    *,
    name: str = "Location Studio route",
    altitude: float | None = None,
    speed_mps: float | None = None,
    route_options: dict[str, Any] | None = None,
    include_waypoints: bool | None = None,
) -> str:
    """Serialise validated points into a GPX 1.1 document.

    The geometry is written exactly once: a multi-point export becomes a
    ``<trk>``, a single point becomes a ``<wpt>``. Writing both would double every
    position when the file is imported again, so ``include_waypoints`` defaults to
    "only when there is nothing else to write".

    Every string is escaped; no caller-supplied text is ever emitted raw.
    """
    validated = validate_points(list(points), name="points", minimum=1)
    safe_name = escape(str(name)[:120] or "Location Studio route")
    if include_waypoints is None:
        include_waypoints = len(validated) < 2

    waypoints: list[str] = []
    for index, point in enumerate(validated if include_waypoints else [], start=1):
        altitude_value = point.get("altitude", altitude)
        parts = [f'  <wpt lat="{_format_number(point["lat"])}" lon="{_format_number(point["lon"])}">']
        if altitude_value is not None:
            parts.append(f"    <ele>{_format_number(float(altitude_value))}</ele>")
            parts.append("    <geoidheight>0</geoidheight>")
        parts.append(f"    <name>{escape(f'Location {index}')}</name>")
        parts.append("    <sym>Flag, Blue</sym>")
        parts.append("  </wpt>")
        waypoints.append("\n".join(parts))

    segments: list[str] = []
    if len(validated) > 1:
        track_points: list[str] = []
        for point in validated:
            altitude_value = point.get("altitude", altitude)
            entry = [f'      <trkpt lat="{_format_number(point["lat"])}" lon="{_format_number(point["lon"])}">']
            if altitude_value is not None:
                entry.append(f"        <ele>{_format_number(float(altitude_value))}</ele>")
            entry.append("      </trkpt>")
            track_points.append("\n".join(entry))
        description = ""
        if speed_mps:
            description = f"\n    <desc>{escape(f'Configured speed {float(speed_mps):.2f} m/s')}</desc>"
        segments.append(
            "  <trk>\n    <name>{name}</name>{description}\n    <trkseg>\n{body}\n    </trkseg>\n  </trk>".format(
                name=safe_name, description=description, body="\n".join(track_points)
            )
        )

    metadata = ""
    if route_options:
        hints = ", ".join(f"{escape(str(key))}={escape(str(value))}" for key, value in sorted(route_options.items()))
        metadata = f"\n  <metadata>\n    <desc>{hints}</desc>\n  </metadata>"

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<gpx version="1.1" creator="Location Studio" xmlns="{GPX_NAMESPACE}">{metadata}\n'
        + "\n".join(waypoints)
        + ("\n" + "\n".join(segments) if segments else "")
        + "\n</gpx>\n"
    )


def summarise(points: Iterable[dict[str, float]]) -> dict[str, Any]:
    point_list = list(points)
    return {
        "pointCount": len(point_list),
        "hasAltitude": any("altitude" in point for point in point_list),
    }
