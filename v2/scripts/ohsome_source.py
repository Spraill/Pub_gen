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
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from osm_extract import CACHE_DIR, parse_fragment

ENDPOINT = "https://api.ohsome.org/v1/elements/centroid"
USER_AGENT = "pub-gen-data-refresh/1.0 (https://github.com/Spraill/Pub_gen)"


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


# Pubs and sights are fetched by separate processes: an outage is remembered on disk for an
# hour so every later query goes straight to the next source instead of retrying again.
FAILED_MARKER = CACHE_DIR / "ohsome-failed"


def recently_failed() -> bool:
    return FAILED_MARKER.exists() and time.time() - FAILED_MARKER.stat().st_mtime < 3600


def run(bbox: list[float], ohsome_filter: str) -> dict[str, Any]:
    if recently_failed():
        raise RuntimeError("ohsome failed earlier in this run")
    south, west, north, east = bbox
    body = urlencode({"bboxes": f"{west},{south},{east},{north}", "filter": ohsome_filter, "properties": "tags"}).encode()
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            request = Request(ENDPOINT, data=body, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urlopen(request, timeout=120) as response:
                return json.load(response)
        except Exception as exc:  # noqa: BLE001 - every network error gets a retry
            last_error = exc
            print(json.dumps({"ohsome_retry": attempt + 1, "error": str(exc)[:160]}), flush=True)
            time.sleep(10)
    Path(CACHE_DIR).mkdir(parents=True, exist_ok=True)
    FAILED_MARKER.write_text(str(last_error), encoding="utf-8")
    raise RuntimeError(f"ohsome request failed: {last_error}") from last_error


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
