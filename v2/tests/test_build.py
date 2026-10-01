"""Unit tests for the data build (curation and compaction). Run: python3 -m unittest discover v2/tests"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_v2 as build  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import osm_extract  # noqa: E402


def pub_feature(name: str, osm_id: int, **props):
    tags = props.pop("tags", {})
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-0.1, 51.5]},
        "properties": {"name": name, "osm_type": "node", "osm_id": osm_id, "tags": tags, **props},
    }


def poi_feature(identifier: str, title: str, score: int = 50, **props):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-0.12, 51.51]},
        "properties": {
            "id": identifier,
            "title": title,
            "interest_score": score,
            "categories": props.pop("categories", ["historical"]),
            "source": props.pop("source", "osm"),
            "tags": props.pop("tags", {}),
            **props,
        },
    }


class PubFlagTests(unittest.TestCase):
    def test_flags(self):
        flags = build.pub_flags(
            {
                "food": "yes",
                "real_ale": "4",
                "outdoor_seating": "garden",
                "wheelchair": "limited",
                "dog": "leashed",
                "tags": {"listed_status": "Grade II", "brand": "Wetherspoon", "microbrewery": "yes", "real_fire": "yes"},
            }
        )
        for flag in (
            build.FLAG_FOOD,
            build.FLAG_REAL_ALE,
            build.FLAG_OUTDOOR,
            build.FLAG_PARTIAL_ACCESS,
            build.FLAG_DOG,
            build.FLAG_HISTORIC,
            build.FLAG_CHAIN,
            build.FLAG_BREWPUB,
            build.FLAG_REAL_FIRE,
        ):
            self.assertTrue(flags & flag, flag)
        self.assertFalse(flags & build.FLAG_STEP_FREE)

    def test_no_means_no(self):
        self.assertEqual(build.pub_flags({"food": "no", "real_ale": "no", "outdoor_seating": "no"}), 0)

    def test_closed_pubs_are_dropped(self):
        geojson = {
            "features": [
                pub_feature("The Open Arms", 1),
                pub_feature("Gordon Bennett (closed)", 2),
                pub_feature("The Ghost", 3, tags={"disused:amenity": "pub"}),
            ]
        }
        names = [row[1] for row in build.compact_pubs(geojson)]
        self.assertEqual(names, ["The Open Arms"])

    def test_historic_ids_from_pois(self):
        rows = build.compact_pubs({"features": [pub_feature("The Blackfriar", 9)]}, {"pn9"})
        self.assertTrue(rows[0][4] & build.FLAG_HISTORIC)


class PoiCurationTests(unittest.TestCase):
    def test_drops_zoo_animals_shops_and_pubs(self):
        geojson = {
            "features": [
                poi_feature("osm:node:1", "Ostriches", tags={"attraction": "animal", "tourism": "attraction"}),
                poi_feature("osm:node:2", "Tower of London Gift Shop"),
                poi_feature("osm:node:3", "The Blackfriar", tags={"amenity": "pub", "heritage": "2"}),
                poi_feature("osm:node:4", "Tower of London", wikidata="Q62378"),
                poi_feature("osm:node:5", "Pinner Library", tags={"amenity": "library"}),
                poi_feature("osm:node:6", "The Old Curiosity Shop", wikidata="Q1"),
            ]
        }
        rows, categories, historic = build.compact_pois(geojson)
        self.assertEqual(sorted(row[1] for row in rows), ["The Old Curiosity Shop", "Tower of London"])
        self.assertEqual(historic, {"pn3"})
        self.assertIn("historical", categories)

    def test_score_adjustments(self):
        keep, grade_one = build.curate_poi(
            {"title": "St Paul's", "interest_score": 70, "tags": {"listed_status": "Grade I", "name:fr": "x", "name:de": "y"}}
        )
        self.assertTrue(keep)
        self.assertEqual(grade_one, 70 + 15 + 4)
        _, generic = build.curate_poi({"title": "Rose Garden", "interest_score": 34, "tags": {"leisure": "garden"}})
        self.assertEqual(generic, 24)
        _, famous = build.curate_poi({"title": "X", "interest_score": 90, "sitelinks": 60, "wikidata": "Q1"})
        self.assertEqual(famous, 100)

    def test_plaque_titles_cut_from_inscriptions_get_ellipsis(self):
        inscription = "This English Heritage building was the first overseas property of the Netherlands government in exile"
        title = inscription[:70].rsplit(" ", 1)[0]
        self.assertTrue(build.plaque_title({"title": title, "description": inscription, "source": "openplaques"}).endswith("…"))
        self.assertEqual(
            build.plaque_title({"title": "Alan Turing", "description": "Alan Turing lived here", "source": "osm+openplaques"}),
            "Alan Turing",
        )


class CompactionTests(unittest.TestCase):
    def test_ids_and_trimming(self):
        self.assertEqual(build.poi_id("osm:way:42"), "w42")
        self.assertEqual(build.poi_id("openplaques:7"), "q7")
        self.assertIsNone(build.poi_id("other:1"))
        self.assertEqual(build.pub_id({"osm_type": "relation", "osm_id": 5}), "pr5")
        self.assertEqual(build.trim_row(["a", "", 0, "", []]), ["a", "", 0])
        self.assertEqual(build.wikidata_id("Q42;Q43"), "Q42")
        self.assertEqual(build.wikidata_id("not-an-id"), "")

    def test_dataset_shape(self):
        dataset = build.build_dataset(
            {"features": [pub_feature("The Lamb", 1, food="yes")]},
            {"features": [poi_feature("osm:node:4", "Tower of London", wikidata="Q62378")]},
        )
        self.assertEqual(dataset["schema"], 2)
        self.assertEqual(len(dataset["pub_fields"]), len(build.PUB_FIELDS))
        self.assertEqual(dataset["pubs"][0][0], "pn1")
        self.assertEqual(dataset["pois"][0][dataset["poi_fields"].index("wikidata")], "Q62378")


class OsmExtractTests(unittest.TestCase):
    def test_fragments_parse_to_tag_filters(self) -> None:
        statements = osm_extract.parse_fragment(
            'nwr["tourism"~"attraction|viewpoint"]["name"](area.londonArea);nwr["heritage"](area.londonArea);'
        )
        self.assertEqual(statements, [[("tourism", "~", "attraction|viewpoint"), ("name", "has", "")], [("heritage", "has", "")]])
        self.assertTrue(osm_extract.matches({"tourism": "viewpoint", "name": "X"}, statements[0]))
        self.assertFalse(osm_extract.matches({"tourism": "viewpoint"}, statements[0]))

    def test_smallest_covering_geofabrik_region_wins(self) -> None:
        def square(west: float, south: float, east: float, north: float) -> list:
            return [[[west, south], [east, south], [east, north], [west, north], [west, south]]]

        index = {
            "features": [
                {"properties": {"urls": {"pbf": "england"}}, "geometry": {"type": "Polygon", "coordinates": square(-6, 49, 2, 56)}},
                {"properties": {"urls": {"pbf": "yorkshire"}}, "geometry": {"type": "MultiPolygon", "coordinates": [square(-2.5, 53.3, 0.2, 54.6)]}},
                {"properties": {"urls": {"pbf": "partial"}}, "geometry": {"type": "Polygon", "coordinates": square(-1.8, 53.7, -1.1, 54.0)}},
            ]
        }
        self.assertEqual(osm_extract.pick_geofabrik_region(index, [53.925, -1.16, 53.995, -1.02]), "yorkshire")


if __name__ == "__main__":
    unittest.main()
