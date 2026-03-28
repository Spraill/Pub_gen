#!/usr/bin/env python3
"""Build the V2 static site and data payloads."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
PUBLIC_DIR = ROOT / "public"
DOCS_DIR = ROOT.parent / "docs"
CATEGORY_PRIORITY = [
    "blue_plaque",
    "museum",
    "historical",
    "cultural",
    "architecture",
    "natural",
    "garden",
    "park",
    "scenic",
    "art",
    "literary",
    "market",
    "science",
    "music",
    "religious",
    "memorial",
    "landmark",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the V2 London crawl planner site and data."
    )
    parser.add_argument("--refresh-pubs", action="store_true", help="Refresh pub data.")
    parser.add_argument("--refresh-pois", action="store_true", help="Refresh POI data.")
    parser.add_argument("--refresh-all", action="store_true", help="Refresh both datasets.")
    parser.add_argument(
        "--publish-docs",
        action="store_true",
        help="Mirror the built site into the repo-root docs/ folder for GitHub Pages.",
    )
    return parser.parse_args()


def run_checked(command: list[str]) -> None:
    subprocess.run(command, check=True)


def load_geojson(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def simplify_pubs(geojson: dict[str, Any]) -> list[dict[str, Any]]:
    simplified = []
    for feature in geojson.get("features", []):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if geometry.get("type") != "Point" or len(coordinates) != 2:
            continue
        props = feature.get("properties") or {}
        simplified.append(
            {
                "id": f"pub::{props.get('osm_type','')}::{props.get('osm_id','')}",
                "title": props.get("name") or "Unnamed pub",
                "lat": coordinates[1],
                "lon": coordinates[0],
                "address": props.get("address") or "",
                "opening_hours": props.get("opening_hours") or "",
                "website": props.get("website") or "",
                "phone": props.get("phone") or "",
                "operator": props.get("operator") or "",
                "brewery": props.get("brewery") or "",
                "cuisine": props.get("cuisine") or "",
                "food": props.get("food") or "",
                "outdoor_seating": props.get("outdoor_seating") or "",
                "real_ale": props.get("real_ale") or "",
                "wheelchair": props.get("wheelchair") or "",
                "source_url": (
                    f"https://www.openstreetmap.org/{props.get('osm_type','')}/{props.get('osm_id','')}"
                    if props.get("osm_type") and props.get("osm_id")
                    else ""
                ),
            }
        )
    return sorted(simplified, key=lambda item: item["title"].casefold())


def simplify_pois(geojson: dict[str, Any]) -> list[dict[str, Any]]:
    simplified = []
    for feature in geojson.get("features", []):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if geometry.get("type") != "Point" or len(coordinates) != 2:
            continue
        props = feature.get("properties") or {}
        simplified.append(
            {
                "id": props.get("id"),
                "title": props.get("title") or "London POI",
                "lat": coordinates[1],
                "lon": coordinates[0],
                "address": props.get("address") or "",
                "description": props.get("description") or "",
                "categories": props.get("categories") or [],
                "primary_category": props.get("primary_category") or "landmark",
                "interest_score": int(props.get("interest_score") or 0),
                "website": props.get("website") or "",
                "wikipedia": props.get("wikipedia") or "",
                "wikidata": props.get("wikidata") or "",
                "source": props.get("source") or "",
                "source_url": props.get("source_url") or "",
            }
        )
    return sorted(
        simplified,
        key=lambda item: (-item["interest_score"], item["title"].casefold(), item["primary_category"]),
    )


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def write_js_payload(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "window.__V2_DATA__=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )


def sort_categories(values: set[str]) -> list[str]:
    return sorted(
        values,
        key=lambda item: (
            CATEGORY_PRIORITY.index(item) if item in CATEGORY_PRIORITY else len(CATEGORY_PRIORITY),
            item,
        ),
    )


def mirror_public_to_docs() -> None:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PUBLIC_DIR, DOCS_DIR, dirs_exist_ok=True)


def main() -> int:
    args = parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (PUBLIC_DIR / "data").mkdir(parents=True, exist_ok=True)

    pubs_geojson = DATA_DIR / "london_pubs.geojson"
    pois_geojson = DATA_DIR / "london_pois.geojson"

    refresh_pubs = args.refresh_all or args.refresh_pubs or not pubs_geojson.exists()
    refresh_pois = args.refresh_all or args.refresh_pois or not pois_geojson.exists()

    if refresh_pubs:
        run_checked(
            [
                sys.executable,
                str((ROOT.parent / "fetch_london_pubs.py").resolve()),
                "--require-name",
                "--skip-csv",
                "--geojson",
                str(pubs_geojson),
            ]
        )
    elif not pubs_geojson.exists() and (ROOT.parent / "london_pubs.geojson").exists():
        shutil.copy2(ROOT.parent / "london_pubs.geojson", pubs_geojson)

    if refresh_pois:
        run_checked(
            [
                sys.executable,
                str((ROOT / "scripts" / "fetch_london_pois_v2.py").resolve()),
                "--output",
                str(pois_geojson),
            ]
        )

    pubs_payload = simplify_pubs(load_geojson(pubs_geojson))
    pois_payload = simplify_pois(load_geojson(pois_geojson))

    categories = sort_categories({category for poi in pois_payload for category in poi["categories"]})
    category_counts: dict[str, int] = {}
    primary_category_counts: dict[str, int] = {}
    for poi in pois_payload:
        primary = poi["primary_category"]
        primary_category_counts[primary] = primary_category_counts.get(primary, 0) + 1
        for category in poi["categories"]:
            category_counts[category] = category_counts.get(category, 0) + 1
    stats = {
        "pub_count": len(pubs_payload),
        "poi_count": len(pois_payload),
        "categories": categories,
        "category_counts": {category: category_counts.get(category, 0) for category in categories},
        "primary_category_counts": {
            category: primary_category_counts.get(category, 0)
            for category in sort_categories(set(primary_category_counts))
        },
    }

    write_json(PUBLIC_DIR / "data" / "pubs.json", pubs_payload)
    write_json(PUBLIC_DIR / "data" / "pois.json", pois_payload)
    write_json(PUBLIC_DIR / "data" / "meta.json", stats)
    write_js_payload(
        PUBLIC_DIR / "data" / "payload.js",
        {
            "pubs": pubs_payload,
            "pois": pois_payload,
            "meta": stats,
        },
    )
    (PUBLIC_DIR / ".nojekyll").write_text("", encoding="utf-8")

    if args.publish_docs:
        mirror_public_to_docs()

    print(
        json.dumps(
            {
                "public_dir": str(PUBLIC_DIR),
                "docs_dir": str(DOCS_DIR) if args.publish_docs else "",
                "pubs": len(pubs_payload),
                "pois": len(pois_payload),
                "categories": len(categories),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
