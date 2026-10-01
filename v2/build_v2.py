#!/usr/bin/env python3
"""Build the V2 static site and its compact data bundle.

Source files live in ``site/``; the deployable output is written to ``public/``
(and optionally mirrored to the repo-root ``docs/`` folder for GitHub Pages).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DIR = ROOT / "site"
PUBLIC_DIR = ROOT / "public"
DOCS_DIR = ROOT.parent / "docs"
SCRIPTS_DIR = ROOT / "scripts"
CITIES_PATH = ROOT / "cities.json"

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
FLAG_HISTORIC = 256
FLAG_CHAIN = 512
FLAG_BREWPUB = 1024
FLAG_REAL_FIRE = 2048

# ---- POI curation ------------------------------------------------------------
# Raw fetches are deliberately broad; these rules keep the map to places worth
# walking to on a crawl. Scores are adjusted here (not in the fetchers) so the
# rules apply to existing data without a re-fetch.

DROP_ATTRACTION_TYPES = {
    "animal",
    "train",
    "roller_coaster",
    "amusement_ride",
    "carousel",
    "water_slide",
    "kiddie_ride",
    "dark_ride",
    "swing_carousel",
    "bumper_car",
}
DROP_TITLE_PATTERN = re.compile(
    r"\b(allotments?|playing fields?|gift shop|shop|toilets?|car park|bowling|kiosk|caf[eé]|"
    r"restaurant|play ?ground|sports? (centre|ground)|leisure centre|community centre|school)\b",
    re.IGNORECASE,
)
GENERIC_GREEN_PATTERN = re.compile(
    r"^(the )?(rose|kitchen|community|rest|memorial|walled|secret|sensory|wildlife|herb|peace|"
    r"pocket|sunken|water|japanese|millennium)? ?(garden|gardens|park|green|open space|pocket park)$",
    re.IGNORECASE,
)
NOTABLE_OPERATORS = (
    "royal parks",
    "national trust",
    "english heritage",
    "historic royal palaces",
    "kew",
    "city of london",
    "corporation of london",
)
CLOSED_PUB_PATTERN = re.compile(r"\((closed|former|disused|demolished)\)|\bclosed\b|\bformerly\b", re.IGNORECASE)

PUB_FIELDS = [
    "id", "name", "lat", "lon", "flags", "address", "hours", "website", "phone", "brewery", "cuisine", "brand",
    "wikipedia", "wikidata", "commons", "built",
]
POI_FIELDS = [
    "id", "name", "lat", "lon", "score", "cats", "address", "description", "website", "wikipedia", "wikidata",
    "fame", "commons", "built",
]
OSM_TYPE_CODES = {"node": "n", "way": "w", "relation": "r", "wikidata": "d"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the crawl planner site and per-city data.")
    parser.add_argument("--refresh-pubs", action="store_true", help="Refresh pub data from OpenStreetMap.")
    parser.add_argument("--refresh-pois", action="store_true", help="Refresh POI data from OSM and Open Plaques.")
    parser.add_argument("--refresh-all", action="store_true", help="Refresh both datasets.")
    parser.add_argument(
        "--cities",
        default="all",
        help="Comma-separated city ids to refresh (from cities.json), or 'all'. Default: %(default)s",
    )
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
    tags = props.get("tags") or {}
    if tags.get("heritage") or tags.get("listed_status") or tags.get("wikipedia") or tags.get("historic"):
        flags |= FLAG_HISTORIC
    if tags.get("brand") or tags.get("brand:wikidata"):
        flags |= FLAG_CHAIN
    if is_yes(clean(tags.get("microbrewery"))):
        flags |= FLAG_BREWPUB
    if is_yes(clean(tags.get("real_fire"))):
        flags |= FLAG_REAL_FIRE
    return flags


def pub_is_closed(props: dict[str, Any]) -> bool:
    tags = props.get("tags") or {}
    if CLOSED_PUB_PATTERN.search(clean(props.get("name"))):
        return True
    if clean(tags.get("opening_hours")).lower() == "closed":
        return True
    return any(key.startswith(("disused:", "abandoned:", "was:")) or key == "end_date" for key in tags)


def trim_row(row: list[Any]) -> list[Any]:
    while row and row[-1] in ("", None, []):
        row.pop()
    return row


def wikidata_id(value: Any) -> str:
    text = clean(value).split(";")[0].strip()
    return text if re.fullmatch(r"Q\d+", text) else ""


def built_year(props: dict[str, Any]) -> int | str:
    """Year from OSM start_date / construction_date ("1872", "c1650", "1890-05-01")."""
    tags = props.get("tags") or {}
    for key in ("start_date", "construction_date"):
        match = re.search(r"(?<!\d)(\d{3,4})(?!\d)", str(tags.get(key, "")))
        if match and 40 <= int(match.group(1)) <= 2030:
            return int(match.group(1))
    return ""


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


def compact_pubs(geojson: dict[str, Any], historic_ids: set[str] | None = None) -> list[list[Any]]:
    rows = []
    seen: set[str] = set()
    historic_ids = historic_ids or set()
    for feature in geojson.get("features", []):
        coords = point_coordinates(feature)
        props = feature.get("properties") or {}
        identifier = pub_id(props)
        name = clean(props.get("name"))
        if coords is None or identifier is None or not name or identifier in seen or pub_is_closed(props):
            continue
        seen.add(identifier)
        flags = pub_flags(props)
        if identifier in historic_ids:
            flags |= FLAG_HISTORIC
        rows.append(
            trim_row(
                [
                    identifier,
                    name,
                    round_coord(coords[0]),
                    round_coord(coords[1]),
                    flags,
                    clean(props.get("address")),
                    clean(props.get("opening_hours")),
                    clean(props.get("website")),
                    clean(props.get("phone")),
                    clean(props.get("brewery")),
                    clean(props.get("cuisine")).replace("_", " ").replace(";", ", "),
                    clean((props.get("tags") or {}).get("brand")),
                    clean(props.get("wikipedia")),
                    wikidata_id(props.get("wikidata")),
                    commons_title(props),
                    built_year(props),
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


def is_notable(props: dict[str, Any]) -> bool:
    tags = props.get("tags") or {}
    return bool(
        props.get("wikipedia")
        or props.get("wikidata")
        or tags.get("heritage")
        or tags.get("listed_status")
        or (props.get("sitelinks") or 0) > 0
    )


def curate_poi(props: dict[str, Any]) -> tuple[bool, int]:
    """Return (keep, adjusted interest score) for a raw POI record."""
    tags = props.get("tags") or {}
    title = clean(props.get("title"))
    notable = is_notable(props)
    score = int(props.get("interest_score") or 0)

    if str(tags.get("attraction", "")).strip() in DROP_ATTRACTION_TYPES:
        return False, score
    if str(tags.get("amenity", "")).strip() in ("pub", "bar", "biergarten"):
        return False, score  # becomes a "historic pub" badge on the pub instead
    if not notable and DROP_TITLE_PATTERN.search(title):
        return False, score
    if not notable and tags.get("amenity") == "library":
        return False, score
    if not title or title.casefold() == "london point of interest" or re.fullmatch(r"[\d\s./:#-]+", title):
        return False, score

    listed = str(tags.get("listed_status", "")).strip().lower()
    if listed == "grade i":
        score += 15
    elif listed == "grade ii*":
        score += 8
    elif listed == "grade ii":
        score += 3
    translations = sum(1 for key in tags if key.startswith("name:"))
    score += min(12, translations * 2)
    operator = str(tags.get("operator", "")).lower()
    if any(name in operator for name in NOTABLE_OPERATORS):
        score += 10
    # Optional enrichment from the weekly refresh: number of Wikipedia
    # language editions covering the place (a free, reputable fame signal).
    score += min(25, int(props.get("sitelinks") or 0))
    if not notable and GENERIC_GREEN_PATTERN.match(title):
        score -= 10
    if not notable and tags.get("tourism") == "artwork" and not tags.get("artist_name"):
        score -= 4
    return True, max(10, min(100, score))


def fame_score(props: dict[str, Any]) -> int:
    """Uncapped "how famous is this" signal, used to pick the hero of the daily crawl.

    Interest scores saturate at 100 for hundreds of places; fame separates
    Westminster Abbey from a minor listed church. Wikidata sitelinks (added by the
    weekly refresh) dominate when present; otherwise OSM name translations do.
    """
    tags = props.get("tags") or {}
    title = clean(props.get("title"))
    if re.search(r"\bstation\b", title, re.IGNORECASE) or tags.get("railway") or tags.get("public_transport"):
        return 0
    fame = 3 * sum(1 for key in tags if key.startswith("name:") and not key.startswith("name:etymology"))
    fame += 2 * int(props.get("sitelinks") or 0)
    if tags.get("tourism") in ("attraction", "museum", "zoo", "aquarium", "viewpoint", "gallery"):
        fame += 12
    if props.get("wikipedia"):
        fame += 6
    if props.get("wikidata"):
        fame += 3
    listed = str(tags.get("listed_status", "")).strip().lower()
    fame += 8 if listed == "grade i" else 4 if listed == "grade ii*" else 0
    if any(name in str(tags.get("operator", "")).lower() for name in NOTABLE_OPERATORS[:4]):
        fame += 6
    return fame


def commons_title(props: dict[str, Any]) -> str:
    """Normalise OSM wikimedia_commons / image tags to "File:…" or "Category:…"."""
    tags = props.get("tags") or {}
    for value in (tags.get("wikimedia_commons"), tags.get("image")):
        text = clean(value).split(";")[0].strip()
        if not text:
            continue
        if re.match(r"^(File|Category):", text):
            return text.replace("_", " ")
        match = re.match(r"^https?://(?:commons\.wikimedia\.org|[a-z-]+\.wikipedia\.org)/wiki/(?:File|Datei|Fichier|Bestand):(.+)$", text)
        if match:
            return "File:" + unquote(match.group(1)).replace("_", " ")
    return ""


def is_plaque(props: dict[str, Any]) -> bool:
    tags = props.get("tags") or {}
    memorial = str(tags.get("memorial", "")).lower()
    return bool(
        "plaque" in memorial
        or memorial == "stolperstein"
        or tags.get("plaque")
        or re.search(r"\bplaque\b", clean(props.get("title")), re.IGNORECASE)
    )


def plaque_title(props: dict[str, Any]) -> str:
    """Mark titles that were cut from a longer plaque inscription."""
    title = clean(props.get("title"))
    description = clean(props.get("description"))
    if (
        props.get("source") == "openplaques"
        and len(title) >= 60
        and description.startswith(title)
        and len(description) > len(title)
        and description[len(title)] not in ".!?"
        and not title.endswith("…")
    ):
        return title.rstrip(" ,;:-") + "…"
    return title


def compact_pois(geojson: dict[str, Any]) -> tuple[list[list[Any]], list[str], set[str]]:
    records = []
    seen: set[str] = set()
    all_categories: set[str] = set()
    historic_pub_ids: set[str] = set()
    for feature in geojson.get("features", []):
        coords = point_coordinates(feature)
        props = feature.get("properties") or {}
        identifier = poi_id(props.get("id"))
        if coords is None or identifier is None or identifier in seen:
            continue
        seen.add(identifier)
        tags = props.get("tags") or {}
        if str(tags.get("amenity", "")).strip() in ("pub", "bar") and identifier[0] in "nwrd":
            historic_pub_ids.add(f"p{identifier}")
        keep, score = curate_poi(props)
        if not keep:
            continue
        props = {**props, "interest_score": score, "title": plaque_title(props)}
        categories = set(props.get("categories") or []) or {"landmark"}
        if is_plaque(props):
            categories.add("blue_plaque")  # one "Plaques" filter covers every plaque
        categories = sort_categories(categories)
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
                    wikidata_id(props.get("wikidata")),
                    fame_score(props),
                    commons_title(props),
                    built_year(props),
                ]
            )
        )
    rows.sort(key=lambda row: (-row[4], row[1].casefold()))
    return rows, category_order, historic_pub_ids


def latest_fetch_time(*geojsons: dict[str, Any]) -> str:
    stamps = []
    for geojson in geojsons:
        for feature in geojson.get("features", [])[:50]:
            stamp = (feature.get("properties") or {}).get("fetched_at_utc")
            if stamp:
                stamps.append(str(stamp))
    return max(stamps) if stamps else ""


def build_dataset(pubs_geojson: dict[str, Any], pois_geojson: dict[str, Any]) -> dict[str, Any]:
    pois, categories, historic_pub_ids = compact_pois(pois_geojson)
    pubs = compact_pubs(pubs_geojson, historic_pub_ids)
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


def city_public_config(city_id: str, config: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    """What the app needs to know about a city (no fetch details)."""
    return {
        "id": city_id,
        "name": config["name"],
        "center": config["center"],
        "bounds": config["bounds"],
        "minZoom": config.get("minZoom", 9),
        "dailyAreas": config.get("dailyAreas", []),
        "data": f"data/places-{city_id}.json",
        "pubs": len(dataset["pubs"]),
        "pois": len(dataset["pois"]),
    }


def write_site(datasets: dict[str, dict[str, Any]], cities: dict[str, dict[str, Any]]) -> str:
    if PUBLIC_DIR.exists():
        shutil.rmtree(PUBLIC_DIR)
    shutil.copytree(SITE_DIR, PUBLIC_DIR)

    data_dir = PUBLIC_DIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    for city_id, dataset in datasets.items():
        data_json = dumps_compact(dataset)
        (data_dir / f"places-{city_id}.json").write_text(data_json, encoding="utf-8")
        # Fallback for opening index.html straight from disk (file:// cannot fetch JSON).
        (data_dir / f"places-{city_id}.js").write_text(f"window.__PUBGEN_DATA__={data_json};\n", encoding="utf-8")
    public_cities = [city_public_config(city_id, cities[city_id], datasets[city_id]) for city_id in datasets]
    (data_dir / "cities.json").write_text(dumps_compact(public_cities), encoding="utf-8")
    (data_dir / "cities.js").write_text(f"window.__PUBGEN_CITIES__={dumps_compact(public_cities)};\n", encoding="utf-8")
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
    cities = json.loads(CITIES_PATH.read_text(encoding="utf-8"))
    refresh_cities = set(cities) if args.cities == "all" else set(filter(None, args.cities.split(",")))
    unknown = refresh_cities - set(cities)
    if unknown:
        raise SystemExit(f"Unknown cities: {', '.join(sorted(unknown))}")

    datasets: dict[str, dict[str, Any]] = {}
    summary: dict[str, Any] = {}
    for city_id in cities:
        pubs_path = DATA_DIR / f"{city_id}_pubs.geojson"
        pois_path = DATA_DIR / f"{city_id}_pois.geojson"
        refreshing = city_id in refresh_cities
        if refreshing and (args.refresh_all or args.refresh_pubs):
            refresh_dataset(
                pubs_path,
                [sys.executable, str(SCRIPTS_DIR / "fetch_london_pubs.py"), "--city", city_id, "--require-name", "--geojson"],
                f"{city_id} pubs",
            )
        if refreshing and (args.refresh_all or args.refresh_pois):
            refresh_dataset(
                pois_path,
                [sys.executable, str(SCRIPTS_DIR / "fetch_london_pois_v2.py"), "--city", city_id, "--output"],
                f"{city_id} POIs",
            )
        if not pubs_path.exists() or not pois_path.exists():
            print(f"Skipping {city_id}: no data yet (run with --refresh-all --cities {city_id})", flush=True)
            continue
        pubs_geojson = json.loads(pubs_path.read_text(encoding="utf-8"))
        pois_geojson = json.loads(pois_path.read_text(encoding="utf-8"))
        datasets[city_id] = build_dataset(pubs_geojson, pois_geojson)
        summary[city_id] = {"pubs": len(datasets[city_id]["pubs"]), "pois": len(datasets[city_id]["pois"])}

    if "london" not in datasets:
        raise SystemExit("London data is missing; the site needs it as the default city.")
    version = write_site(datasets, cities)
    if args.publish_docs:
        mirror_public_to_docs()

    print(json.dumps({"version": version, "public_dir": str(PUBLIC_DIR), "cities": summary}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
