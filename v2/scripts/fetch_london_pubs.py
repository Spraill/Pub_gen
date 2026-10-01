#!/usr/bin/env python3
"""Fetch named London pubs from OpenStreetMap (Overpass) as GeoJSON."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fetch_london_pois_v2 import (  # noqa: E402
    DEFAULT_RETRY_ROUNDS,
    DEFAULT_TIMEOUT_SECONDS,
    element_coordinates,
    fetch_overpass_payload,
)

PUB_FRAGMENT = 'nwr["amenity"="pub"](area.londonArea);'
TAG_FIELDS = {
    "operator": "operator",
    "brewery": "brewery",
    "website": "website",
    "phone": "phone",
    "opening_hours": "opening_hours",
    "cuisine": "cuisine",
    "food": "food",
    "drink": "drink",
    "outdoor_seating": "outdoor_seating",
    "indoor_seating": "indoor_seating",
    "internet_access": "internet_access",
    "real_ale": "real_ale",
    "real_cider": "real_cider",
    "live_music": "live_music",
    "dog": "dog",
    "wheelchair": "wheelchair",
    "toilets": "toilets",
    "smoking": "smoking",
    "wikidata": "wikidata",
    "wikipedia": "wikipedia",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch London pubs from OpenStreetMap.")
    parser.add_argument("--geojson", type=Path, default=Path("london_pubs.geojson"))
    parser.add_argument("--require-name", action="store_true", help="Skip pubs without a name.")
    parser.add_argument(
        "--skip-csv",
        action="store_true",
        help="Accepted for backwards compatibility; CSV output is no longer produced.",
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--retry-rounds", type=int, default=DEFAULT_RETRY_ROUNDS)
    return parser.parse_args()


def tag(tags: dict[str, Any], key: str) -> str:
    return str(tags.get(key, "")).strip()


def pub_address(tags: dict[str, Any]) -> str:
    street_line = " ".join(part for part in (tag(tags, "addr:housenumber"), tag(tags, "addr:street")) if part)
    parts = [
        tag(tags, "addr:housename"),
        street_line,
        tag(tags, "addr:suburb"),
        tag(tags, "addr:city"),
        tag(tags, "addr:postcode"),
    ]
    return ", ".join(part for part in parts if part)


def build_feature(
    element: dict[str, Any], fetched_at_utc: str, endpoint: str, require_name: bool
) -> dict[str, Any] | None:
    tags = element.get("tags") or {}
    lat, lon = element_coordinates(element)
    if lat is None or lon is None:
        return None
    name = tag(tags, "name")
    if require_name and not name:
        return None
    properties: dict[str, Any] = {
        "name": name,
        "osm_type": element.get("type", ""),
        "osm_id": element.get("id"),
        "address": pub_address(tags),
        "house_name": tag(tags, "addr:housename"),
        "house_number": tag(tags, "addr:housenumber"),
        "street": tag(tags, "addr:street"),
        "suburb": tag(tags, "addr:suburb"),
        "city": tag(tags, "addr:city"),
        "postcode": tag(tags, "addr:postcode"),
        "country": tag(tags, "addr:country"),
    }
    for prop, key in TAG_FIELDS.items():
        properties[prop] = tag(tags, key)
    properties.update(
        {
            "fetched_at_utc": fetched_at_utc,
            "source_endpoint": endpoint,
            "tags": tags,
        }
    )
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": properties,
    }


def main() -> int:
    args = parse_args()
    fetched_at_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    payload, endpoint = fetch_overpass_payload(PUB_FRAGMENT, args.timeout, args.retry_rounds)

    features = []
    seen: set[tuple[str, Any]] = set()
    for element in payload.get("elements", []):
        key = (element.get("type", ""), element.get("id"))
        if key in seen:
            continue
        seen.add(key)
        feature = build_feature(element, fetched_at_utc, endpoint, args.require_name)
        if feature is not None:
            features.append(feature)

    if not features:
        raise RuntimeError("Overpass returned no pubs; refusing to overwrite the existing dataset.")

    features.sort(key=lambda item: item["properties"]["name"].casefold())
    args.geojson.parent.mkdir(parents=True, exist_ok=True)
    args.geojson.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"output": str(args.geojson), "pubs": len(features), "endpoint": endpoint}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
