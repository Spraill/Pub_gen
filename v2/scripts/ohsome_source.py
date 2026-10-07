#!/usr/bin/env python3
"""OpenStreetMap data for a city from the ohsome API, shaped like an Overpass response.

The public Overpass servers are often overloaded. ohsome (HeiGIT, Heidelberg
University) serves the same OpenStreetMap data from its own history database:
one request per fetcher fragment returns every matching element's centroid and
tags inside the city's bounding box. Unlike Wikidata it has every pub, not just
the notable ones. Data lags OpenStreetMap by a few days, which is fine here.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any

from osm_extract import parse_fragment

ENDPOINT = "https://api.ohsome.org/v1/elements/centroid"


def ohsome_value(value: str) -> str:
    return value if value.replace("_", "").isalnum() else json.dumps(value)


def build_filter(fragment: str) -> str:
    """Overpass fragment -> ohsome filter, e.g. (tourism in (attraction, viewpoint) and name=*) or (amenity=pub)."""
    clauses = []
    for filters in parse_fragment(fragment):
        parts = []
        for key, op, value in filters:
            key = ohsome_value(key)
            if op == "has":
                parts.append(f"{key}=*")
            elif op == "=":
                parts.append(f"{key}={ohsome_value(value)}")
            else:  # "~": the fetchers only use plain alternations ("a|b|c")
                options = [option for option in value.split("|") if option]
                parts.append(f"{key} in ({', '.join(ohsome_value(option) for option in options)})")
        clauses.append("(" + " and ".join(parts) + ")")
    return " or ".join(clauses)


def run(bbox: list[float], ohsome_filter: str) -> dict[str, Any]:
    """POST one query. Sent with curl: ohsome answers Python's urllib with 403 but curl with 200."""
    south, west, north, east = bbox
    command = [
        "curl", "-sS", "--fail", "--max-time", "180", "--retry", "2", "--retry-delay", "10",
        "--data-urlencode", f"bboxes={west},{south},{east},{north}",
        "--data-urlencode", f"filter={ohsome_filter}",
        "--data-urlencode", "properties=tags",
        ENDPOINT,
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({"ohsome_error": result.stderr.strip()[:160]}), flush=True)
        raise RuntimeError(f"ohsome request failed: {result.stderr.strip()[:160]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ohsome sent something that isn't JSON: {result.stdout[:120]!r}") from exc


def elements_from_geojson(collection: dict[str, Any]) -> list[dict[str, Any]]:
    elements = []
    for feature in collection.get("features", []):
        props = dict(feature.get("properties") or {})
        osm_id = str(props.pop("@osmId", ""))
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if "/" not in osm_id or geometry.get("type") != "Point" or len(coords) != 2:
            continue
        osm_type, number = osm_id.split("/", 1)
        if osm_type not in ("node", "way", "relation") or not number.isdigit():
            continue
        tags = {key: str(value) for key, value in props.items() if not key.startswith("@")}
        lon, lat = float(coords[0]), float(coords[1])
        element: dict[str, Any] = {"type": osm_type, "id": int(number), "tags": tags}
        if osm_type == "node":
            element.update({"lat": lat, "lon": lon})
        else:
            element["center"] = {"lat": lat, "lon": lon}
        elements.append(element)
    return elements


def ohsome_payload(bbox: list[float], fragment: str) -> dict[str, Any]:
    return {"elements": elements_from_geojson(run(bbox, build_filter(fragment)))}
