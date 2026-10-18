"""Route interpolation, pacing and duration maths.

These numbers decide what the iPhone actually receives, so they are checked
against independently-computed values rather than against the implementation.
"""

from __future__ import annotations

import math
import unittest

from location_studio_bridge import geo


class TestDistances(unittest.TestCase):
    def test_haversine_matches_reference_distances(self) -> None:
        paris = {"lat": 48.8566, "lon": 2.3522}
        london = {"lat": 51.5074, "lon": -0.1278}
        self.assertAlmostEqual(geo.haversine_m(paris, london), 343_556, delta=2_000)

        one_degree_lat = geo.haversine_m({"lat": 0, "lon": 0}, {"lat": 1, "lon": 0})
        self.assertAlmostEqual(one_degree_lat, 111_195, delta=200)

        self.assertEqual(geo.haversine_m(paris, paris), 0.0)

    def test_cumulative_lengths(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.001, "lon": 28.0}, {"lat": 47.002, "lon": 28.0}]
        lengths = geo.cumulative_lengths(points)
        self.assertEqual(len(lengths), 3)
        self.assertEqual(lengths[0], 0.0)
        self.assertAlmostEqual(lengths[1], lengths[0] + geo.haversine_m(points[0], points[1]), places=6)
        self.assertAlmostEqual(lengths[2], lengths[1] + geo.haversine_m(points[1], points[2]), places=6)
        self.assertEqual(geo.route_length_m(points), lengths[2])

    def test_route_length_of_degenerate_inputs(self) -> None:
        self.assertEqual(geo.route_length_m([]), 0.0)
        self.assertEqual(geo.route_length_m([{"lat": 1, "lon": 2}]), 0.0)

    def test_duration_is_distance_over_speed(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.01, "lon": 28.0}]
        length = geo.route_length_m(points)
        self.assertAlmostEqual(geo.estimated_duration_s(points, 8.0), length / 8.0, places=6)
        self.assertAlmostEqual(geo.estimated_duration_s(points, 4.0), 2 * length / 4.0 / 2, places=6)
        self.assertEqual(geo.estimated_duration_s(points, 0), 0.0)
        self.assertEqual(geo.estimated_duration_s(points, -1), 0.0)


class TestDensify(unittest.TestCase):
    def test_endpoints_are_preserved(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.01, "lon": 28.0}]
        dense = geo.densify(points, max_segment_m=10)
        self.assertEqual(dense[0], points[0])
        self.assertEqual(dense[-1], points[-1])
        self.assertGreater(len(dense), 50)

    def test_segments_respect_the_budget(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.02, "lon": 28.01}]
        dense = geo.densify(points, max_segment_m=25)
        for index in range(1, len(dense)):
            self.assertLessEqual(geo.haversine_m(dense[index - 1], dense[index]), 25.0001)

    def test_interpolated_points_stay_on_the_segment(self) -> None:
        start = {"lat": 10.0, "lon": 20.0}
        end = {"lat": 11.0, "lon": 21.0}
        dense = geo.densify([start, end], max_segment_m=1000)
        for point in dense[1:-1]:
            # Collinear points share the same bearing from the start.
            self.assertAlmostEqual((point["lon"] - start["lon"]) / (end["lon"] - start["lon"]),
                                   (point["lat"] - start["lat"]) / (end["lat"] - start["lat"]), places=9)

    def test_altitude_is_lerped_when_present(self) -> None:
        dense = geo.densify([{"lat": 0, "lon": 0, "altitude": 0}, {"lat": 0.01, "lon": 0, "altitude": 100}], 50)
        altitudes = [point["altitude"] for point in dense]
        self.assertEqual(altitudes[0], 0)
        self.assertAlmostEqual(altitudes[-1], 100)
        self.assertEqual(altitudes, sorted(altitudes))

    def test_altitude_is_omitted_when_absent(self) -> None:
        dense = geo.densify([{"lat": 0, "lon": 0}, {"lat": 0.01, "lon": 0}], 50)
        self.assertTrue(all("altitude" not in point for point in dense))

    def test_degenerate_inputs(self) -> None:
        self.assertEqual(geo.densify([], 5), [])
        self.assertEqual(geo.densify([{"lat": 1, "lon": 2}], 5), [{"lat": 1, "lon": 2}])
        with self.assertRaises(ValueError):
            geo.densify([{"lat": 0, "lon": 0}, {"lat": 1, "lon": 1}], 0)
        # Two identical points must not create a division-by-zero or an empty route.
        self.assertEqual(len(geo.densify([{"lat": 1, "lon": 1}, {"lat": 1, "lon": 1}], 5)), 2)


class TestPlaybackPoints(unittest.TestCase):
    def test_step_is_speed_over_rate(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.01, "lon": 28.0}]
        options = {"speedMps": 10.0, "updateRateHz": 5.0, "interpolate": True}

        playback = geo.build_playback_points(points, options)
        # 10 m/s at 5 Hz means one update every 2 m, so no gap may exceed that.
        for index in range(1, len(playback)):
            self.assertLessEqual(geo.haversine_m(playback[index - 1], playback[index]), 2.0001)

        # Updates per second must equal the requested rate, which is what makes the
        # estimated duration match the wall clock on the device.
        duration = geo.route_length_m(playback) / options["speedMps"]
        self.assertAlmostEqual(len(playback) / duration, options["updateRateHz"], delta=1.0)

    def test_interpolation_can_be_disabled(self) -> None:
        points = [{"lat": 1.0, "lon": 2.0}, {"lat": 1.5, "lon": 2.5}]
        self.assertEqual(geo.build_playback_points(points, {"interpolate": False}), points)

    def test_defaults_are_applied(self) -> None:
        points = [{"lat": 1.0, "lon": 2.0}, {"lat": 1.01, "lon": 2.0}]
        playback = geo.build_playback_points(points, {})
        step = geo.haversine_m(playback[0], playback[1])
        self.assertAlmostEqual(step, 8.0 / 5.0, delta=0.2)

    def test_a_single_point_is_returned_unchanged(self) -> None:
        point = {"lat": 5.0, "lon": 6.0}
        self.assertEqual(geo.build_playback_points([point], {}), [point])


class TestSchedule(unittest.TestCase):
    def test_iter_schedule_reports_travel_time(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.001, "lon": 28.0}, {"lat": 47.002, "lon": 28.0}]
        schedule = list(geo.iter_schedule(points, 10.0))
        self.assertEqual([index for index, _point, _time in schedule], [0, 1, 2])
        self.assertEqual(schedule[0][2], 0.0)
        self.assertLess(schedule[0][2], schedule[1][2])
        self.assertLess(schedule[1][2], schedule[2][2])
        self.assertAlmostEqual(schedule[-1][2], geo.route_length_m(points) / 10.0, places=6)

    def test_iter_schedule_rejects_a_non_positive_speed(self) -> None:
        with self.assertRaises(ValueError):
            list(geo.iter_schedule([{"lat": 0, "lon": 0}], 0))

    def test_distance_to_waypoint(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.001, "lon": 28.0}, {"lat": 47.002, "lon": 28.0}]
        self.assertEqual(geo.distance_to_waypoint(points, 0), 0.0)
        self.assertAlmostEqual(geo.distance_to_waypoint(points, 1), geo.haversine_m(points[0], points[1]), places=6)
        for index in (-1, 5):
            self.assertEqual(geo.distance_to_waypoint(points, index), 0.0)


class TestPacingConsistency(unittest.TestCase):
    """The renderer predicts the duration locally; the bridge must agree."""

    def test_round_trip_distance_is_additive(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.01, "lon": 28.01}, {"lat": 47.02, "lon": 28.0}]
        out = geo.route_length_m(points)
        back = geo.route_length_m(list(reversed(points)))
        self.assertAlmostEqual(out, back, places=6)

    def test_dense_route_length_converges_to_the_waypoint_length(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.05, "lon": 28.03}]
        sparse = geo.route_length_m(points)
        dense = geo.route_length_m(geo.densify(points, 5))
        self.assertAlmostEqual(sparse, dense, delta=max(1.0, sparse * 0.001))

    def test_duration_scales_linearly_with_speed(self) -> None:
        points = [{"lat": 47.0, "lon": 28.0}, {"lat": 47.01, "lon": 28.0}]
        slow = geo.estimated_duration_s(points, 2)
        fast = geo.estimated_duration_s(points, 20)
        self.assertAlmostEqual(slow / fast, 10.0, places=6)
        self.assertTrue(math.isfinite(slow))


if __name__ == "__main__":
    unittest.main()
