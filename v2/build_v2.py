#!/usr/bin/env python3
"""Build the V2 static site and its compact data bundle.

Source files live in ``site/``; the deployable output is written to ``public/``
(and optionally mirrored to the repo-root ``docs/`` folder for GitHub Pages).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DIR = ROOT / "site"
PUBLIC_DIR = ROOT / "public"
DOCS_DIR = ROOT.parent / "docs"
SCRIPTS_DIR = ROOT / "scripts"

VERSION_PLACEHOLDER = "__BUILD_VERSION__"
STAMPED_FILES = ("index.html", "sw.js")
DOCS_PRESERVE = ("CNAME",)

# A refreshed dataset smaller than this fraction of the previous one is treated
# as a failed/partial fetch and is not used.
MIN_REFRESH_RATIO = 0.7
COORD_DECIMALS = 5
MAX_DESCRIPTION_CHARS = 600

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

# Pub feature bit flags. Keep in sync with FLAGS in site/planner.js.
FLAG_FOOD = 1
FLAG_REAL_ALE = 2
FLAG_OUTDOOR = 4
FLAG_STEP_FREE = 8
FLAG_DOG = 16
FLAG_LIVE_MUSIC = 32
FLAG_REAL_CIDER = 64
FLAG_PARTIAL_ACCESS = 128

PUB_FIELDS = ["id", "name", "lat", "lon", "flags", "address", "hours", "website", "phone", "brewery", "cuisine"]
POI_FIELDS = ["id", "name", "lat", "lon", "score", "cats", "address", "description", "website", "wikipedia"]
OSM_TYPE_CODES = {"node": "n", "way": "w", "relation": "r"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the V2 London crawl planner site and data.")
    parser.add_argument("--refresh-pubs", action="store_true", help="Refresh pub data from OpenStreetMap.")
    parser.add_argument("--refresh-pois", action="store_true", help="Refresh POI data from OSM and Open Plaques.")
    parser.add_argument("--refresh-all", action="store_true", help="Refresh both datasets.")
    parser.add_argument(
        "--publish-docs",
        action="store_true",
        help="Mirror the built site into the repo-root docs/ folder for GitHub Pages.",
    )
    return parser.parse_args()


# --------------------------------------------------------------------------- data refresh


def feature_count(path: Path) -> int:
    if not path.exists():
        return 0
    return len(json.loads(path.read_text(encoding="utf-8")).get("features", []))


def refresh_dataset(target: Path, command: list[str], label: str) -> None:
    """Run a fetch script into a temp file and only replace ``target`` if it looks complete."""
    previous = feature_count(target)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / target.name
        subprocess.run(command + [str(tmp_path)], check=True)
        fresh = feature_count(tmp_path)
        if previous and fresh < previous * MIN_REFRESH_RATIO:
            raise RuntimeError(
                f"Refreshed {label} dataset has {fresh} features vs {previous} before; "
                "looks like a partial fetch, keeping the existing data."
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp_path), target)
    print(f"Refreshed {label}: {previous} -> {fresh} features", flush=True)


# --------------------------------------------------------------------------- compaction


def clean(value: Any) -> str:
    return " ".join(str(value or "").split())


def is_yes(value: str, extra: tuple[str, ...] = ()) -> bool:
    return value.strip().lower() in ("yes", "designated", "true", "1", *extra)


def present_and_not_no(value: str) -> bool:
    normalized = value.strip().lower()
    return bool(normalized) and normalized not in ("no", "none", "0", "false")


def pub_flags(props: dict[str, Any]) -> int:
    flags = 0
    food = clean(props.get("food"))
    if present_and_not_no(food) or (clean(props.get("cuisine")) and food.lower() != "no"):
        flags |= FLAG_FOOD
    if present_and_not_no(clean(props.get("real_ale"))):
        flags |= FLAG_REAL_ALE
    if present_and_not_no(clean(props.get("outdoor_seating"))):
        flags |= FLAG_OUTDOOR
    wheelchair = clean(props.get("wheelchair")).lower()
    if wheelchair in ("yes", "designated"):
        flags |= FLAG_STEP_FREE
    elif wheelchair == "limited":
        flags |= FLAG_PARTIAL_ACCESS
    if is_yes(clean(props.get("dog")), ("leashed", "outside")):
        flags |= FLAG_DOG
    if present_and_not_no(clean(props.get("live_music"))):
        flags |= FLAG_LIVE_MUSIC
    if present_and_not_no(clean(props.get("real_cider"))):
        flags |= FLAG_REAL_CIDER
    return flags


def trim_row(row: list[Any]) -> list[Any]:
    while row and row[-1] in ("", None, []):
        row.pop()
    return row


def round_coord(value: Any) -> float:
    return round(float(value), COORD_DECIMALS)


def truncate(text: str, limit: int = MAX_DESCRIPTION_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def point_coordinates(feature: dict[str, Any]) -> tuple[float, float] | None:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") != "Point" or len(coordinates) != 2:
        return None
    return float(coordinates[1]), float(coordinates[0])


def pub_id(props: dict[str, Any]) -> str | None:
    code = OSM_TYPE_CODES.get(str(props.get("osm_type", "")))
    osm_id = props.get("osm_id")
    if not code or osm_id in (None, ""):
        return None
    return f"p{code}{osm_id}"


def poi_id(raw_id: str) -> str | None:
    """Map ``osm:node:123`` -> ``n123`` and ``openplaques:45`` -> ``q45``."""
    parts = str(raw_id or "").split(":")
    if len(parts) == 3 and parts[0] == "osm" and parts[1] in OSM_TYPE_CODES:
        return f"{OSM_TYPE_CODES[parts[1]]}{parts[2]}"
    if len(parts) == 2 and parts[0] == "openplaques" and parts[1]:
        return f"q{parts[1]}"
    return None


def compact_pubs(geojson: dict[str, Any]) -> list[list[Any]]:
    rows = []
    seen: set[str] = set()
    for feature in geojson.get("features", []):
        coords = point_coordinates(feature)
        props = feature.get("properties") or {}
        identifier = pub_id(props)
        name = clean(props.get("name"))
        if coords is None or identifier is None or not name or identifier in seen:
            continue
        seen.add(identifier)
        rows.append(
            trim_row(
                [
                    identifier,
                    name,
                    round_coord(coords[0]),
                    round_coord(coords[1]),
                    pub_flags(props),
                    clean(props.get("address")),
                    clean(props.get("opening_hours")),
                    clean(props.get("website")),
                    clean(props.get("phone")),
                    clean(props.get("brewery")),
                    clean(props.get("cuisine")).replace("_", " "),
                ]
            )
        )
    return sorted(rows, key=lambda row: row[1].casefold())


def sort_categories(values: set[str]) -> list[str]:
    return sorted(
        values,
        key=lambda item: (
            CATEGORY_PRIORITY.index(item) if item in CATEGORY_PRIORITY else len(CATEGORY_PRIORITY),
            item,
        ),
    )


def compact_pois(geojson: dict[str, Any]) -> tuple[list[list[Any]], list[str]]:
    records = []
    seen: set[str] = set()
    all_categories: set[str] = set()
    for feature in geojson.get("features", []):
        coords = point_coordinates(feature)
        props = feature.get("properties") or {}
        identifier = poi_id(props.get("id"))
        if coords is None or identifier is None or identifier in seen:
            continue
        seen.add(identifier)
        categories = sort_categories(set(props.get("categories") or []) or {"landmark"})
        all_categories.update(categories)
        records.append((identifier, coords, props, categories))

    category_order = sort_categories(all_categories)
    category_index = {category: index for index, category in enumerate(category_order)}
    rows = []
    for identifier, coords, props, categories in records:
        title = clean(props.get("title")) or "London point of interest"
        description = clean(props.get("description"))
        if description.casefold() == title.casefold():
            description = ""
        rows.append(
            trim_row(
                [
                    identifier,
                    title,
                    round_coord(coords[0]),
                    round_coord(coords[1]),
                    int(props.get("interest_score") or 0),
                    [category_index[category] for category in categories],
                    clean(props.get("address")),
                    truncate(description),
                    clean(props.get("website")),
                    clean(props.get("wikipedia")),
                ]
            )
        )
    rows.sort(key=lambda row: (-row[4], row[1].casefold()))
    return rows, category_order


def latest_fetch_time(*geojsons: dict[str, Any]) -> str:
    stamps = []
    for geojson in geojsons:
        for feature in geojson.get("features", [])[:50]:
            stamp = (feature.get("properties") or {}).get("fetched_at_utc")
            if stamp:
                stamps.append(str(stamp))
    return max(stamps) if stamps else ""


def build_dataset(pubs_geojson: dict[str, Any], pois_geojson: dict[str, Any]) -> dict[str, Any]:
    pubs = compact_pubs(pubs_geojson)
    pois, categories = compact_pois(pois_geojson)
    category_counts = {category: 0 for category in categories}
    for row in pois:
        for index in row[5] if len(row) > 5 else []:
            category_counts[categories[index]] += 1
    return {
        "schema": 2,
        "data_fetched_at": latest_fetch_time(pubs_geojson, pois_geojson),
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "categories": categories,
        "category_counts": category_counts,
        "pub_fields": PUB_FIELDS,
        "poi_fields": POI_FIELDS,
        "pubs": pubs,
        "pois": pois,
    }


# --------------------------------------------------------------------------- site output


def dumps_compact(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def content_version(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(PUBLIC_DIR).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def write_site(dataset: dict[str, Any]) -> str:
    if PUBLIC_DIR.exists():
        shutil.rmtree(PUBLIC_DIR)
    shutil.copytree(SITE_DIR, PUBLIC_DIR)

    data_dir = PUBLIC_DIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    data_json = dumps_compact(dataset)
    (data_dir / "places.json").write_text(data_json, encoding="utf-8")
    # Fallback for opening index.html straight from disk (file:// cannot fetch JSON).
    (data_dir / "places.js").write_text(f"window.__PUBGEN_DATA__={data_json};\n", encoding="utf-8")
    (PUBLIC_DIR / ".nojekyll").write_text("", encoding="utf-8")

    files = [path for path in PUBLIC_DIR.rglob("*") if path.is_file()]
    version = content_version(files)
    for name in STAMPED_FILES:
        path = PUBLIC_DIR / name
        path.write_text(path.read_text(encoding="utf-8").replace(VERSION_PLACEHOLDER, version), encoding="utf-8")
    return version


def mirror_public_to_docs() -> None:
    preserved = {name: (DOCS_DIR / name).read_bytes() for name in DOCS_PRESERVE if (DOCS_DIR / name).exists()}
    if DOCS_DIR.exists():
        shutil.rmtree(DOCS_DIR)
    shutil.copytree(PUBLIC_DIR, DOCS_DIR)
    for name, content in preserved.items():
        (DOCS_DIR / name).write_bytes(content)


def main() -> int:
    args = parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    pubs_path = DATA_DIR / "london_pubs.geojson"
    pois_path = DATA_DIR / "london_pois.geojson"

    if args.refresh_all or args.refresh_pubs or not pubs_path.exists():
        refresh_dataset(
            pubs_path,
            [sys.executable, str(SCRIPTS_DIR / "fetch_london_pubs.py"), "--require-name", "--geojson"],
            "pubs",
        )
    if args.refresh_all or args.refresh_pois or not pois_path.exists():
        refresh_dataset(
            pois_path,
            [sys.executable, str(SCRIPTS_DIR / "fetch_london_pois_v2.py"), "--output"],
            "POIs",
        )

    pubs_geojson = json.loads(pubs_path.read_text(encoding="utf-8"))
    pois_geojson = json.loads(pois_path.read_text(encoding="utf-8"))
    dataset = build_dataset(pubs_geojson, pois_geojson)
    version = write_site(dataset)

    if args.publish_docs:
        mirror_public_to_docs()

    print(
        json.dumps(
            {
                "version": version,
                "public_dir": str(PUBLIC_DIR),
                "docs_dir": str(DOCS_DIR) if args.publish_docs else "",
                "pubs": len(dataset["pubs"]),
                "pois": len(dataset["pois"]),
                "categories": len(dataset["categories"]),
                "data_bytes": (PUBLIC_DIR / "data" / "places.json").stat().st_size,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
