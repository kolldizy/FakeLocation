"""Geodesic helpers: distance, route interpolation, pacing and duration estimates.

The device API only accepts discrete ``(latitude, longitude)`` updates. Route
playback is therefore produced by interpolating between waypoints and publishing
updates at a configured rate. This module is pure maths with no device access so
it can be unit-tested exhaustively.
"""

from __future__ import annotations

import math
from typing import Any, Iterator, Sequence

EARTH_RADIUS_M = 6371008.8

Coordinate = dict[str, float]


def haversine_m(a: Coordinate, b: Coordinate) -> float:
    """Great-circle distance in metres between two ``{lat, lon}`` points."""
    lat1 = math.radians(float(a["lat"]))
    lat2 = math.radians(float(b["lat"]))
    d_lat = lat2 - lat1
    d_lon = math.radians(float(b["lon"]) - float(a["lon"]))
    h = math.sin(d_lat / 2.0) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2.0) ** 2
    return 2.0 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def cumulative_lengths(points: Sequence[Coordinate]) -> list[float]:
    """Cumulative distance from the first point, in metres."""
    lengths = [0.0]
    total = 0.0
    for index in range(1, len(points)):
        total += haversine_m(points[index - 1], points[index])
        lengths.append(total)
    return lengths


def route_length_m(points: Sequence[Coordinate]) -> float:
    return cumulative_lengths(points)[-1] if points else 0.0


def estimated_duration_s(points: Sequence[Coordinate], speed_mps: float) -> float:
    """Seconds needed to traverse the whole route at a constant ground speed."""
    if speed_mps <= 0:
        return 0.0
    return route_length_m(points) / speed_mps


def _lerp_altitude(a: Coordinate, b: Coordinate, fraction: float) -> float | None:
    altitude_a = a.get("altitude")
    altitude_b = b.get("altitude")
    if altitude_a is None and altitude_b is None:
        return None
    start = float(altitude_a if altitude_a is not None else altitude_b)
    end = float(altitude_b if altitude_b is not None else altitude_a)
    return start + (end - start) * fraction


def densify(points: Sequence[Coordinate], max_segment_m: float = 5.0) -> list[Coordinate]:
    """Split long segments so published updates look like continuous movement.

    Waypoints only anchor the route; the device receives evenly spaced updates.
    """
    if len(points) < 2:
        return [dict(point) for point in points]
    if max_segment_m <= 0:
        raise ValueError("max_segment_m must be positive")

    result: list[Coordinate] = [dict(points[0])]
    for index in range(1, len(points)):
        start, end = points[index - 1], points[index]
        distance = haversine_m(start, end)
        steps = max(1, int(math.ceil(distance / max_segment_m))) if distance > 0 else 1
        for step in range(1, steps + 1):
            fraction = step / steps
            point: Coordinate = {
                "lat": start["lat"] + (end["lat"] - start["lat"]) * fraction,
                "lon": start["lon"] + (end["lon"] - start["lon"]) * fraction,
            }
            altitude = _lerp_altitude(start, end, fraction)
            if altitude is not None:
                point["altitude"] = altitude
            result.append(point)
    return result


def build_playback_points(points: Sequence[Coordinate], options: dict[str, Any]) -> list[Coordinate]:
    """Return the ordered list of coordinates that will actually be published."""
    speed = float(options.get("speedMps", 8.0))
    update_rate = float(options.get("updateRateHz", 5.0))
    interpolate = bool(options.get("interpolate", True))
    if not interpolate:
        return [dict(point) for point in points]
    # One update must not jump further than speed / update_rate metres, otherwise
    # the device would report discrete teleports rather than movement.
    step_m = max(1.0, speed / max(update_rate, 0.001))
    return densify(points, max_segment_m=step_m)


def iter_schedule(points: Sequence[Coordinate], speed_mps: float) -> Iterator[tuple[int, Coordinate, float]]:
    """Yield ``(index, point, travel_seconds)`` where travel time is route distance / speed."""
    if speed_mps <= 0:
        raise ValueError("speed_mps must be positive")
    lengths = cumulative_lengths(points)
    for index, point in enumerate(points):
        yield index, point, lengths[index] / speed_mps


def distance_to_waypoint(points: Sequence[Coordinate], waypoint_index: int) -> float:
    lengths = cumulative_lengths(points)
    if waypoint_index < 0 or waypoint_index >= len(lengths):
        return 0.0
    return lengths[waypoint_index]
