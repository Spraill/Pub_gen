#!/usr/bin/env python3
"""Fetch a richer London POI dataset for the V2 crawl planner."""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode
from urllib.request import Request, urlopen

DEFAULT_RELATION_ID = 175342
DEFAULT_TIMEOUT_SECONDS = 240
DEFAULT_RETRY_ROUNDS = 3
# Public Overpass mirrors; busy ones answer 429/504, so we rotate through all of them.
DEFAULT_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
DEFAULT_USER_AGENT = "pub-crawl-planner-v2/1.0 (+local build)"
DEFAULT_OPENPLAQUES_DATA_PAGE = "https://openplaques.org/pages/data"
DEFAULT_OPENPLAQUES_FALLBACK_URL = (
    "https://openplaques.s3.eu-west-2.amazonaws.com/open-plaques-london-2025-12-15.geojson"
)

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

OVERPASS_QUERY_SPECS = (
    {
        "key": "museums",
        "fragment": 'nwr["tourism"="museum"](area.londonArea);',
        "seed_categories": {"museum", "cultural", "historical"},
    },
    {
        "key": "galleries_and_arts",
        "fragment": (
            'nwr["tourism"~"gallery|artwork"](area.londonArea);'
            'nwr["amenity"="arts_centre"](area.londonArea);'
        ),
        "seed_categories": {"cultural", "art"},
    },
    {
        "key": "performance_and_literary",
        "fragment": (
            'nwr["amenity"~"theatre|library|music_venue"](area.londonArea);'
        ),
        "seed_categories": {"cultural"},
    },
    {
        "key": "attractions_and_viewpoints",
        "fragment": (
            'nwr["tourism"~"attraction|viewpoint"]["name"](area.londonArea);'
        ),
        "seed_categories": {"landmark"},
    },
    {
        "key": "science_attractions",
        "fragment": 'nwr["tourism"~"zoo|aquarium"]["name"](area.londonArea);',
        "seed_categories": {"landmark", "science"},
    },
    {
        "key": "markets",
        "fragment": 'nwr["amenity"="marketplace"]["name"](area.londonArea);',
        "seed_categories": {"cultural", "market"},
    },
    {
        "key": "historic_sites",
        "fragment": (
            'nwr["historic"~"archaeological_site|battlefield|boundary_stone|building|castle|city_gate|fort|manor|memorial|monument|ruins|ship|tower|wayside_cross|wayside_shrine"](area.londonArea);'
        ),
        "seed_categories": {"historical"},
    },
    {
        "key": "heritage_sites",
        "fragment": 'nwr["heritage"](area.londonArea);',
        "seed_categories": {"historical", "architecture"},
    },
    {
        "key": "gardens",
        "fragment": 'nwr["leisure"="garden"]["name"](area.londonArea);',
        "seed_categories": {"natural", "garden"},
    },
    {
        "key": "parks",
        "fragment": 'nwr["leisure"="park"]["name"](area.londonArea);',
        "seed_categories": {"natural", "park"},
    },
    {
        "key": "nature_reserves",
        "fragment": 'nwr["leisure"="nature_reserve"]["name"](area.londonArea);',
        "seed_categories": {"natural"},
    },
    {
        "key": "blue_plaques_osm",
        "fragment": (
            'nwr["memorial"="blue_plaque"](area.londonArea);'
            'nwr["plaque"="blue_plaque"](area.londonArea);'
        ),
        "seed_categories": {"blue_plaque", "historical"},
    },
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch museums, gardens, blue plaques and other interesting London "
            "POIs for the V2 crawl planner."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("london_pois_v2.geojson"),
        help="GeoJSON output path. Default: %(default)s",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Per-request timeout in seconds. Default: %(default)s",
    )
    parser.add_argument("--city", default="london", help="City id from v2/cities.json. Default: %(default)s")
    parser.add_argument(
        "--skip-wikidata",
        action="store_true",
        help="Skip the Wikidata popularity enrichment step.",
    )
    parser.add_argument(
        "--retry-rounds",
        type=int,
        default=DEFAULT_RETRY_ROUNDS,
        help="How many times to cycle through Overpass endpoints. Default: %(default)s",
    )
    return parser.parse_args()


def fetch_text(url: str, timeout_seconds: int) -> str:
    request = Request(url, headers={"User-Agent": DEFAULT_USER_AGENT}, method="GET")
    with urlopen(request, timeout=timeout_seconds) as response:
        body = response.read()
    return body.decode("utf-8", errors="replace")


def post_json(url: str, data: str, timeout_seconds: int) -> dict[str, Any]:
    request = Request(
        url,
        data=urlencode({"data": data}).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": DEFAULT_USER_AGENT,
        },
        method="POST",
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def discover_openplaques_url(timeout_seconds: int) -> str:
    try:
        html = fetch_text(DEFAULT_OPENPLAQUES_DATA_PAGE, timeout_seconds)
    except (HTTPError, URLError, TimeoutError):
        return DEFAULT_OPENPLAQUES_FALLBACK_URL

    match = re.search(
        r"https://openplaques\.s3[^\"]*open-plaques-london-[^\"]*\.geojson",
        html,
        flags=re.IGNORECASE,
    )
    return match.group(0) if match else DEFAULT_OPENPLAQUES_FALLBACK_URL


CITIES_PATH = Path(__file__).resolve().parents[1] / "cities.json"
# Search area for Overpass: an OSM boundary relation or a bounding box.
OVERPASS_AREA: dict[str, Any] = {"relation": DEFAULT_RELATION_ID}
# Optional OSM extract (URL, local path or "geofabrik" to look one up) used instead of Overpass.
OSM_EXTRACT: dict[str, Any] = {}
CITY_NAME: dict[str, str] = {"name": "London"}


def load_city(city: str) -> dict[str, Any]:
    cities = json.loads(CITIES_PATH.read_text(encoding="utf-8"))
    if city not in cities:
        raise SystemExit(f"Unknown city {city!r}; choose from {', '.join(cities)}")
    return cities[city]


def use_city(city: str) -> dict[str, Any]:
    config = load_city(city)
    OVERPASS_AREA.clear()
    OVERPASS_AREA.update(config["overpassArea"])
    CITY_NAME["name"] = config.get("name", "")
    OSM_EXTRACT.clear()
    if config.get("osmExtract") and "bbox" in OVERPASS_AREA:
        OSM_EXTRACT["source"] = config["osmExtract"]
    return config


def build_query(fragment: str, timeout_seconds: int) -> str:
    # Fragments are written against "(area.londonArea)"; a bbox city swaps that out.
    if "bbox" in OVERPASS_AREA:
        south, west, north, east = OVERPASS_AREA["bbox"]
        body = fragment.replace("(area.londonArea)", f"({south},{west},{north},{east})")
        return f"[out:json][timeout:{timeout_seconds}];({body});out center tags;"
    return (
        f"[out:json][timeout:{timeout_seconds}];"
        f"rel({OVERPASS_AREA['relation']});"
        "map_to_area->.londonArea;"
        f"({fragment});"
        "out center tags;"
    )


def fetch_overpass_payload(
    fragment: str,
    timeout_seconds: int,
    retry_rounds: int,
    start_offset: int = 0,
) -> tuple[dict[str, Any], str]:
    if OSM_EXTRACT:
        # Sources tried in the order the city lists them: "ohsome" (OpenStreetMap via the ohsome API),
        # "wikidata", or downloaded OSM extracts. Overpass is the last resort.
        sources = OSM_EXTRACT["source"] if isinstance(OSM_EXTRACT["source"], list) else [OSM_EXTRACT["source"]]
        bbox = OVERPASS_AREA["bbox"]
        extracts = [item for item in sources if item not in ("wikidata", "ohsome")]
        for source in dict.fromkeys("extract" if item in extracts else item for item in sources):
            try:
                if source == "ohsome":
                    from ohsome_source import ohsome_payload

                    return ohsome_payload(bbox, fragment), "ohsome"
                if source == "wikidata":
                    from wikidata_source import wikidata_payload

                    return wikidata_payload(bbox, fragment, CITY_NAME["name"]), "wikidata"
                from osm_extract import extract_payload

                return extract_payload(extracts, bbox, fragment), "osm-extract"
            except RuntimeError as exc:
                print(json.dumps({"source_unavailable": source, "error": str(exc)[:160]}), flush=True)
    # Small (bounding-box) cities don't need long server-side timeouts.
    if "bbox" in OVERPASS_AREA:
        timeout_seconds = min(timeout_seconds, 90)
    query = build_query(fragment, timeout_seconds)
    last_error: Exception | None = None
    endpoint_count = len(DEFAULT_ENDPOINTS)
    for round_number in range(1, retry_rounds + 1):
        for endpoint_index in range(endpoint_count):
            endpoint = DEFAULT_ENDPOINTS[(start_offset + endpoint_index) % endpoint_count]
            try:
                # Give the server its own timeout plus a margin before giving up on it.
                return post_json(endpoint, query, timeout_seconds + 30), endpoint
            except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
                last_error = exc
                print(json.dumps({"overpass_retry": endpoint, "round": round_number, "error": str(exc)[:120]}), flush=True)
                continue
        if round_number < retry_rounds:
            time.sleep(20 * round_number)
    raise RuntimeError(f"Failed Overpass POI fetch: {last_error}") from last_error


def address_from_tags(tags: dict[str, Any]) -> str:
    line_one = " ".join(
        part for part in (str(tags.get("addr:housenumber", "")).strip(), str(tags.get("addr:street", "")).strip()) if part
    )
    parts = [
        line_one,
        str(tags.get("addr:suburb", "")).strip(),
        str(tags.get("addr:city", "")).strip(),
        str(tags.get("addr:postcode", "")).strip(),
    ]
    return ", ".join(part for part in parts if part)


def element_coordinates(element: dict[str, Any]) -> tuple[float | None, float | None]:
    if element.get("lat") is not None and element.get("lon") is not None:
        return float(element["lat"]), float(element["lon"])
    center = element.get("center") or {}
    if center.get("lat") is not None and center.get("lon") is not None:
        return float(center["lat"]), float(center["lon"])
    return None, None


def normalize_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def guess_title_from_inscription(inscription: str) -> str:
    cleaned = " ".join(inscription.replace("\r", " ").replace("\n", " ").split())
    if not cleaned:
        return "Blue plaque"
    primary = re.split(r"[.!?]", cleaned, maxsplit=1)[0].strip()
    if 8 <= len(primary) <= 90:
        return primary
    shortened = cleaned[:80].rsplit(" ", 1)[0].strip()
    return shortened or cleaned[:80].strip()


def sorted_categories(values: set[str]) -> list[str]:
    return sorted(
        values,
        key=lambda item: (
            CATEGORY_PRIORITY.index(item) if item in CATEGORY_PRIORITY else len(CATEGORY_PRIORITY),
            item,
        ),
    )


def categorise_osm(tags: dict[str, Any], seed_categories: set[str]) -> list[str]:
    categories: set[str] = set(seed_categories)
    tourism = str(tags.get("tourism", "")).strip()
    amenity = str(tags.get("amenity", "")).strip()
    historic = str(tags.get("historic", "")).strip()
    leisure = str(tags.get("leisure", "")).strip()
    memorial = str(tags.get("memorial", "")).strip()
    plaque = str(tags.get("plaque", "")).strip()
    building = str(tags.get("building", "")).strip()
    heritage = str(tags.get("heritage", "")).strip()

    if tourism in {"museum"}:
        categories.update({"museum", "cultural", "historical"})
    if tourism in {"gallery", "artwork"} or amenity in {"arts_centre", "theatre"}:
        categories.update({"cultural", "art"})
    if amenity == "library":
        categories.update({"cultural", "literary"})
    if amenity == "music_venue":
        categories.update({"cultural", "music"})
    if amenity == "marketplace":
        categories.update({"cultural", "market"})
    if tourism in {"attraction", "viewpoint", "zoo", "aquarium"}:
        categories.update({"landmark"})
    if tourism in {"zoo", "aquarium"}:
        categories.update({"science"})
    if tourism == "viewpoint":
        categories.update({"scenic"})
    if leisure in {"garden", "park", "nature_reserve"}:
        categories.update({"natural"})
    if leisure == "garden":
        categories.update({"garden"})
    if leisure == "park":
        categories.update({"park"})
    if historic or heritage:
        categories.update({"historical"})
    if historic in {"building", "castle", "manor", "ruins"} or building in {"yes", "historic"}:
        categories.update({"architecture"})
    if historic in {"memorial", "monument"} or memorial:
        categories.update({"memorial", "historical"})
    if memorial == "blue_plaque" or plaque == "blue_plaque":
        categories.update({"blue_plaque", "historical"})
    if amenity == "place_of_worship":
        categories.update({"religious", "architecture"})

    if not categories:
        categories.add("landmark")
    return sorted_categories(categories)


def primary_category(categories: list[str]) -> str:
    for category in CATEGORY_PRIORITY:
        if category in categories:
            return category
    return categories[0] if categories else "landmark"


def score_osm_record(tags: dict[str, Any], categories: list[str], query_key: str) -> int:
    score = 18
    tourism = str(tags.get("tourism", "")).strip()
    leisure = str(tags.get("leisure", "")).strip()
    if "museum" in categories:
        score += 24
    if "blue_plaque" in categories:
        score += 28
    if "historical" in categories:
        score += 16
    if "cultural" in categories:
        score += 12
    if "natural" in categories:
        score += 12
    if "architecture" in categories:
        score += 10
    if tags.get("wikipedia"):
        score += 16
    if tags.get("wikidata"):
        score += 14
    if tags.get("website"):
        score += 6
    if tags.get("image"):
        score += 7
    if tags.get("heritage"):
        score += 10
    if tourism in {"attraction", "viewpoint"}:
        score += 4
    if leisure in {"garden", "park"}:
        score += 4
    if "science" in categories:
        score += 8
    if "market" in categories:
        score += 6
    if "music" in categories:
        score += 6
    if "religious" in categories:
        score += 6
    if "memorial" in categories:
        score += 8
    if query_key in {"blue_plaques_osm", "historic_sites", "heritage_sites"}:
        score += 4
    if tags.get("description"):
        score += 5
    return max(10, min(100, score))


def build_osm_record(
    element: dict[str, Any],
    query_spec: dict[str, Any],
    fetched_at_utc: str,
) -> dict[str, Any] | None:
    tags = element.get("tags", {})
    lat, lon = element_coordinates(element)
    if lat is None or lon is None:
        return None

    name = str(tags.get("name", "")).strip()
    description = str(tags.get("description", "")).strip() or str(tags.get("inscription", "")).strip()
    if not name and not description and not tags.get("wikipedia"):
        return None

    categories = categorise_osm(tags, set(query_spec["seed_categories"]))
    record = {
        "id": f"osm:{element.get('type','')}:{element['id']}",
        "source": "osm",
        "title": name or description[:80].strip() or "London point of interest",
        "lat": lat,
        "lon": lon,
        "address": address_from_tags(tags),
        "description": description,
        "categories": categories,
        "primary_category": primary_category(categories),
        "interest_score": score_osm_record(tags, categories, str(query_spec["key"])),
        "website": str(tags.get("website", "")).strip(),
        "wikipedia": str(tags.get("wikipedia", "")).strip(),
        "wikidata": str(tags.get("wikidata", "")).strip(),
        "source_url": (
            f"https://www.wikidata.org/wiki/Q{element['id']}"
            if element.get("type") == "wikidata"
            else f"https://www.openstreetmap.org/{element.get('type','')}/{element['id']}"
        ),
        "fetched_at_utc": fetched_at_utc,
        "query_key": str(query_spec["key"]),
        "tags": tags,
    }
    return record


def score_openplaques_record(inscription: str, is_accurate: bool) -> int:
    score = 42
    if is_accurate:
        score += 10
    if len(inscription) > 140:
        score += 8
    return max(10, min(100, score))


def build_openplaques_record(feature: dict[str, Any], fetched_at_utc: str) -> dict[str, Any] | None:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") != "Point" or len(coordinates) != 2:
        return None

    props = feature.get("properties") or {}
    inscription = " ".join(str(props.get("inscription", "")).split())
    if not inscription:
        return None

    plaque_id = props.get("id")
    # Prefer Open Plaques' own curated fields; fall back to guessing from the inscription.
    lead_subject = " ".join(str(props.get("lead_subject_name") or "").split())
    curated_title = " ".join(str(props.get("title") or "").split())
    title = curated_title or lead_subject or guess_title_from_inscription(inscription)
    colour = str(props.get("colour") or "").strip().lower()
    categories = ["historical", "memorial"] if colour and colour != "blue" else ["blue_plaque", "historical"]
    wikipedia_url = str(props.get("lead_subject_wikipedia") or "").strip()
    wikipedia = ""
    match = re.match(r"https?://([a-z-]+)\.wikipedia\.org/wiki/(.+)$", wikipedia_url)
    if match:
        wikipedia = f"{match.group(1)}:{unquote(match.group(2)).replace('_', ' ')}"
    score = score_openplaques_record(inscription, bool(geometry.get("is_accurate")))
    if wikipedia:
        score = min(100, score + 16)
    return {
        "id": f"openplaques:{plaque_id}",
        "source": "openplaques",
        "title": title,
        "lat": float(coordinates[1]),
        "lon": float(coordinates[0]),
        "address": str(props.get("address") or "").strip(),
        "description": inscription,
        "categories": categories,
        "primary_category": primary_category(categories),
        "interest_score": score,
        "website": "",
        "wikipedia": wikipedia,
        "wikidata": "",
        "source_url": f"https://openplaques.org/plaques/{plaque_id}",
        "fetched_at_utc": fetched_at_utc,
        "tags": {
            "is_accurate": bool(geometry.get("is_accurate")),
            "openplaques_id": plaque_id,
            "colour": colour,
            "title_source": "openplaques" if (curated_title or lead_subject) else "inscription",
        },
    }


def distance_meters(a: dict[str, Any], b: dict[str, Any]) -> float:
    lat1 = math.radians(a["lat"])
    lon1 = math.radians(a["lon"])
    lat2 = math.radians(b["lat"])
    lon2 = math.radians(b["lon"])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(hav))


def dedupe_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged_by_id: dict[str, dict[str, Any]] = {}
    for record in records:
        existing = merged_by_id.get(record["id"])
        if existing is None:
            merged_by_id[record["id"]] = record
            continue

        existing["categories"] = sorted_categories(set(existing["categories"]) | set(record["categories"]))
        existing["primary_category"] = primary_category(existing["categories"])
        existing["interest_score"] = max(existing["interest_score"], record["interest_score"])
        if not existing["description"] and record["description"]:
            existing["description"] = record["description"]
        if not existing["address"] and record["address"]:
            existing["address"] = record["address"]
        if not existing["website"] and record["website"]:
            existing["website"] = record["website"]
        if not existing["wikipedia"] and record["wikipedia"]:
            existing["wikipedia"] = record["wikipedia"]
        if not existing["wikidata"] and record["wikidata"]:
            existing["wikidata"] = record["wikidata"]
        if existing["source"] != record["source"]:
            existing["source"] = f"{existing['source']}+{record['source']}"

    deduped: list[dict[str, Any]] = []
    for record in sorted(
        merged_by_id.values(),
        key=lambda item: (-item["interest_score"], item["title"].casefold(), item["source"]),
    ):
        duplicate = None
        normalized_title = normalize_text(record["title"])
        for existing in deduped:
            if record["primary_category"] != existing["primary_category"]:
                continue
            if distance_meters(record, existing) > 35:
                continue
            existing_title = normalize_text(existing["title"])
            if normalized_title and existing_title and (
                normalized_title in existing_title or existing_title in normalized_title
            ):
                duplicate = existing
                break
        if duplicate is None:
            deduped.append(record)
            continue

        duplicate["categories"] = sorted(set(duplicate["categories"]) | set(record["categories"]))
        duplicate["primary_category"] = primary_category(duplicate["categories"])
        duplicate["interest_score"] = max(duplicate["interest_score"], record["interest_score"])
        if not duplicate["description"] and record["description"]:
            duplicate["description"] = record["description"]
        if not duplicate["website"] and record["website"]:
            duplicate["website"] = record["website"]
        if not duplicate["wikipedia"] and record["wikipedia"]:
            duplicate["wikipedia"] = record["wikipedia"]
        if not duplicate["wikidata"] and record["wikidata"]:
            duplicate["wikidata"] = record["wikidata"]
        if duplicate["source"] != record["source"]:
            duplicate["source"] = f"{duplicate['source']}+{record['source']}"
    return sorted(deduped, key=lambda item: (-item["interest_score"], item["title"].casefold()))


WIKIDATA_API = "https://www.wikidata.org/w/api.php"


def enrich_with_wikidata(records: list[dict[str, Any]], timeout_seconds: int) -> int:
    """Add ``sitelinks`` (number of Wikipedia/Wikimedia language editions) to records
    that have a Wikidata id. It is a free, reputable proxy for how well known a place
    is. Failures are non-fatal: the build simply scores without it."""
    ids = sorted({str(r.get("wikidata", "")).strip() for r in records if re.fullmatch(r"Q\d+", str(r.get("wikidata", "")).strip())})
    counts: dict[str, int] = {}
    for start in range(0, len(ids), 50):
        batch = ids[start : start + 50]
        url = WIKIDATA_API + "?" + urlencode(
            {"action": "wbgetentities", "ids": "|".join(batch), "props": "sitelinks", "format": "json"}
        )
        try:
            payload = json.loads(fetch_text(url, timeout_seconds))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            print(json.dumps({"wikidata_enrichment": "stopped", "error": str(exc)}), flush=True)
            break
        for entity_id, entity in (payload.get("entities") or {}).items():
            sitelinks = entity.get("sitelinks") or {}
            counts[entity_id] = sum(1 for key in sitelinks if key.endswith("wiki") and key != "commonswiki")
        time.sleep(0.2)
    for record in records:
        count = counts.get(str(record.get("wikidata", "")).strip())
        if count is not None:
            record["sitelinks"] = count
    return len(counts)


def feature_collection(records: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [record["lon"], record["lat"]]},
                "properties": {
                    key: value for key, value in record.items() if key not in {"lat", "lon"}
                },
            }
            for record in records
        ],
    }


def main() -> int:
    args = parse_args()
    city = use_city(args.city)
    fetched_at_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    records: list[dict[str, Any]] = []
    query_summaries: list[dict[str, Any]] = []
    query_errors: list[dict[str, str]] = []
    for query_index, query_spec in enumerate(OVERPASS_QUERY_SPECS):
        try:
            payload, endpoint = fetch_overpass_payload(
                query_spec["fragment"],
                args.timeout,
                args.retry_rounds,
                start_offset=query_index,
            )
        except RuntimeError as exc:
            query_errors.append({"query": str(query_spec["key"]), "error": str(exc)})
            continue

        element_count = 0
        for element in payload.get("elements", []):
            record = build_osm_record(element, query_spec, fetched_at_utc)
            if record is not None:
                records.append(record)
                element_count += 1
        summary = {
            "query": str(query_spec["key"]),
            "records": element_count,
            "endpoint": endpoint,
        }
        query_summaries.append(summary)
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        time.sleep(1)

    if not records:
        raise RuntimeError(f"No OSM POI records fetched. Last errors: {query_errors}")

    # Open Plaques publishes a London export; other cities rely on OSM plaques.
    openplaques_url = discover_openplaques_url(args.timeout) if city.get("openPlaques") else ""
    openplaques_payload = json.loads(fetch_text(openplaques_url, args.timeout)) if openplaques_url else {}
    for feature in openplaques_payload.get("features", []):
        record = build_openplaques_record(feature, fetched_at_utc)
        if record is not None:
            records.append(record)

    deduped = dedupe_records(records)
    enriched = 0 if args.skip_wikidata else enrich_with_wikidata(deduped, args.timeout)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(feature_collection(deduped), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "output": str(args.output),
                "records": len(deduped),
                "openplaques_url": openplaques_url,
                "wikidata_enriched": enriched,
                "query_summaries": query_summaries,
                "query_errors": query_errors,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
