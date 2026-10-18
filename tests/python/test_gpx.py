"""GPX import sanitation and export round-tripping.

Import is the one place where a file from outside the app reaches the device
pipeline, so the hostile cases (DOCTYPE, entities, oversized input, absurd
coordinates, unknown markup) are all covered here.
"""

from __future__ import annotations

import unittest

from location_studio_bridge.gpx import build_gpx, parse_gpx
from location_studio_bridge.protocol import ErrorCode, ValidationError

SIMPLE_TRACK = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Champ de Mars loop</name>
    <trkseg>
      <trkpt lat="48.8557000" lon="2.2981000"><ele>31.0</ele></trkpt>
      <trkpt lat="48.8559000" lon="2.2983000"><ele>31.5</ele></trkpt>
      <trkpt lat="48.8561000" lon="2.2985000"></trkpt>
    </trkseg>
  </trk>
</gpx>
"""


class TestImport(unittest.TestCase):
    def test_parses_a_track_with_altitude(self) -> None:
        parsed = parse_gpx(SIMPLE_TRACK, source_name="champ.gpx")
        self.assertEqual(parsed["name"], "Champ de Mars loop")
        self.assertEqual(parsed["source"], "champ.gpx")
        self.assertEqual(parsed["geometry"], "track")
        self.assertEqual(parsed["rawPointCount"], 3)
        self.assertEqual(parsed["points"][0], {"lat": 48.8557, "lon": 2.2981, "altitude": 31.0})
        self.assertNotIn("altitude", parsed["points"][2])

    def test_track_wins_over_redundant_waypoints(self) -> None:
        document = """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <wpt lat="1.0" lon="1.0"><ele>5</ele></wpt>
          <rte>
            <name>Route name</name>
            <rtept lat="2.0" lon="2.0"></rtept>
            <rtept lat="2.1" lon="2.1"></rtept>
          </rte>
        </gpx>
        """
        parsed = parse_gpx(document)
        self.assertEqual(parsed["geometry"], "track")
        self.assertEqual([point["lat"] for point in parsed["points"]], [2.0, 2.1])
        self.assertEqual(parsed["name"], "Route name")

    def test_waypoints_are_used_when_there_is_no_ordered_geometry(self) -> None:
        document = """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <wpt lat="1.0" lon="1.0"><name>First</name></wpt>
          <wpt lat="1.1" lon="1.1"></wpt>
        </gpx>
        """
        parsed = parse_gpx(document)
        self.assertEqual(parsed["geometry"], "waypoints")
        self.assertEqual([point["lat"] for point in parsed["points"]], [1.0, 1.1])
        self.assertEqual(parsed["name"], "First")

    def test_exact_duplicates_are_collapsed(self) -> None:
        document = """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="1.0" lon="1.0"></trkpt>
            <trkpt lat="1.0" lon="1.0"></trkpt>
            <trkpt lat="1.0001" lon="1.0"></trkpt>
          </trkseg></trk>
        </gpx>
        """
        parsed = parse_gpx(document)
        self.assertEqual(len(parsed["points"]), 2)

    def test_doctype_and_entities_are_refused_before_parsing(self) -> None:
        for payload in (
            '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x "y">]><gpx/>',
            '<?xml version="1.0"?><!ENTITY lol "lol"><gpx/>',
        ):
            with self.assertRaises(ValidationError) as context:
                parse_gpx(payload, source_name="hostile.gpx")
            self.assertIn("entity", str(context.exception).lower() + " " + (context.exception.details or "").lower())

    def test_non_gpx_documents_are_refused(self) -> None:
        with self.assertRaises(ValidationError) as context:
            parse_gpx("<kml><Placemark/></kml>", source_name="places.kml")
        self.assertIn("gpx", str(context.exception).lower())

    def test_malformed_xml_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            parse_gpx("<gpx><trk>", source_name="broken.gpx")
        with self.assertRaises(ValidationError):
            parse_gpx("not xml at all", source_name="notes.txt")

    def test_out_of_range_and_nonsense_coordinates_are_dropped(self) -> None:
        document = """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><trkseg>
            <trkpt lat="91.0" lon="0.0"></trkpt>
            <trkpt lat="0.0" lon="181.0"></trkpt>
            <trkpt lat="not-a-number" lon="0.0"></trkpt>
            <trkpt lat="10.0" lon="10.0"></trkpt>
          </trkseg></trk>
        </gpx>
        """
        parsed = parse_gpx(document)
        self.assertEqual(len(parsed["points"]), 1)
        self.assertEqual(parsed["points"][0]["lat"], 10.0)

    def test_a_file_with_no_usable_points_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            parse_gpx('<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg/></trk></gpx>')

    def test_unknown_elements_are_ignored_not_copied(self) -> None:
        document = """<?xml version="1.0"?>
        <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
          <extensions><script>alert(1)</script></extensions>
          <trk><name>&lt;img src=x onerror=alert(1)&gt;</name>
            <trkseg><trkpt lat="1.0" lon="1.0"><magic>ignored</magic></trkpt></trkseg>
          </trk>
        </gpx>
        """
        parsed = parse_gpx(document)
        self.assertEqual(parsed["points"], [{"lat": 1.0, "lon": 1.0}])
        # The name is carried as text, never as markup, and is escaped on export.
        self.assertIn("<img", parsed["name"])

    def test_oversized_payloads_are_refused(self) -> None:
        huge = "<gpx>" + (" " * (16 * 1024 * 1024 + 10)) + "</gpx>"
        with self.assertRaises(ValidationError) as context:
            parse_gpx(huge, source_name="huge.gpx")
        self.assertIn("16 MB", str(context.exception))

    def test_bytes_payloads_are_accepted(self) -> None:
        parsed = parse_gpx(SIMPLE_TRACK.encode("utf-8"))
        self.assertEqual(len(parsed["points"]), 3)


class TestExport(unittest.TestCase):
    def test_multi_point_export_is_a_track_only(self) -> None:
        points = [{"lat": 1.0, "lon": 2.0}, {"lat": 1.1, "lon": 2.1}]
        document = build_gpx(points, name="Two points")
        self.assertIn("<trk>", document)
        self.assertNotIn("<wpt", document, "writing both would duplicate every point on re-import")
        self.assertEqual(document.count("<trkpt"), 2)

    def test_single_point_export_is_a_waypoint(self) -> None:
        document = build_gpx([{"lat": 1.0, "lon": 2.0}], name="One point")
        self.assertIn("<wpt", document)
        self.assertNotIn("<trkpt", document)

    def test_export_escapes_names(self) -> None:
        document = build_gpx([{"lat": 1.0, "lon": 2.0}, {"lat": 1.1, "lon": 2.1}], name='<script>"x"</script>')
        self.assertNotIn("<script>", document)
        self.assertIn("&lt;script&gt;", document)

    def test_export_round_trips_exactly(self) -> None:
        points = [
            {"lat": 48.8557, "lon": 2.2981, "altitude": 31.0},
            {"lat": 48.8559, "lon": 2.2983, "altitude": 31.5},
            {"lat": 48.8561, "lon": 2.2985},
        ]
        document = build_gpx(points, name="Round trip", speed_mps=8.0, route_options={"speedMps": 8.0, "loop": False})
        parsed = parse_gpx(document, source_name="round-trip.gpx")
        self.assertEqual(parsed["points"], points)
        self.assertEqual(parsed["name"], "Round trip")

    def test_export_defaults_altitude_for_points_without_one(self) -> None:
        document = build_gpx([{"lat": 1.0, "lon": 2.0}, {"lat": 1.1, "lon": 2.1}], altitude=42.0)
        parsed = parse_gpx(document)
        self.assertTrue(all(point["altitude"] == 42.0 for point in parsed["points"]))

    def test_export_rejects_invalid_points(self) -> None:
        with self.assertRaises(ValidationError) as context:
            build_gpx([{"lat": 100.0, "lon": 0.0}])
        self.assertEqual(context.exception.code, ErrorCode.INVALID_PARAMS)

    def test_export_metadata_is_not_imported_as_geometry(self) -> None:
        document = build_gpx(
            [{"lat": 1.0, "lon": 2.0}, {"lat": 1.1, "lon": 2.1}],
            name="Metadata",
            route_options={"speedMps": 12.5, "updateRateHz": 4.0, "interpolate": True, "loop": True},
        )
        self.assertIn("<metadata>", document)
        parsed = parse_gpx(document)
        self.assertEqual(len(parsed["points"]), 2)


if __name__ == "__main__":
    unittest.main()
