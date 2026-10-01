#!/usr/bin/env python3
"""Answer the fetchers' Overpass fragments from a downloaded OSM extract.

Public Overpass servers are often overloaded. A city with an "osmExtract" URL in
v2/cities.json (e.g. a Geofabrik .osm.pbf) is read locally instead: the file is
downloaded once per run, the objects inside the city's bounding box are loaded,
and each fragment such as  nwr["amenity"="pub"](area.londonArea);  is evaluated
against them. The result has the same shape as an Overpass "out center tags"
response, so the rest of the pipeline doesn't change.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

CACHE_DIR = Path(__file__).resolve().parents[1] / ".cache"
# Only objects carrying one of these keys can match a fetcher fragment.
INTERESTING_KEYS = ("amenity", "tourism", "historic", "heritage", "leisure", "memorial", "plaque")

STATEMENT_RE = re.compile(r"nwr((?:\[[^\]]*\])+)\([^)]*\);")
FILTER_RE = re.compile(r'\["([^"]+)"(?:(=|~)"([^"]*)")?\]')

_loaded: dict[tuple[str, tuple[float, ...]], list[dict[str, Any]]] = {}


def parse_fragment(fragment: str) -> list[list[tuple[str, str, str]]]:
    """Each nwr statement becomes a list of (key, op, value) filters; op is =, ~ or has."""
    statements = []
    for match in STATEMENT_RE.finditer(fragment):
        filters = [(key, op or "has", value or "") for key, op, value in FILTER_RE.findall(match.group(1))]
        if filters:
            statements.append(filters)
    if not statements:
        raise ValueError(f"Could not parse Overpass fragment: {fragment!r}")
    return statements


def matches(tags: dict[str, str], filters: list[tuple[str, str, str]]) -> bool:
    for key, op, value in filters:
        if key not in tags:
            return False
        if op == "=" and tags[key] != value:
            return False
        if op == "~" and not re.search(value, tags[key]):
            return False
    return True


def download(url: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / url.rstrip("/").rsplit("/", 1)[-1]
    if not target.exists():
        tmp = target.with_suffix(target.suffix + ".part")
        request = Request(url, headers={"User-Agent": "pub-gen-data-refresh/1.0"})
        with urlopen(request, timeout=600) as response, tmp.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        tmp.rename(target)
    return target


def load_elements(path: Path, bbox: list[float]) -> list[dict[str, Any]]:
    """Tagged nodes, ways and multipolygon relations inside bbox (south, west, north, east)."""
    import osmium  # Imported lazily: only needed for extract-based cities.

    south, west, north, east = bbox

    def inside(lat: float, lon: float) -> bool:
        return south <= lat <= north and west <= lon <= east

    def wanted(tags: Any) -> bool:
        return any(key in tags for key in INTERESTING_KEYS)

    elements: list[dict[str, Any]] = []

    class Handler(osmium.SimpleHandler):
        def node(self, n: Any) -> None:
            if wanted(n.tags) and n.location.valid() and inside(n.location.lat, n.location.lon):
                elements.append(
                    {"type": "node", "id": n.id, "lat": n.location.lat, "lon": n.location.lon, "tags": dict(n.tags)}
                )

        def way(self, w: Any) -> None:
            if not wanted(w.tags):
                return
            points = [(nd.lat, nd.lon) for nd in w.nodes if nd.location.valid()]
            if not points:
                return
            lat = sum(p[0] for p in points) / len(points)
            lon = sum(p[1] for p in points) / len(points)
            if inside(lat, lon):
                elements.append({"type": "way", "id": w.id, "center": {"lat": lat, "lon": lon}, "tags": dict(w.tags)})

        def area(self, a: Any) -> None:
            # Ways are handled above; only multipolygon relations come through here.
            if a.from_way() or not wanted(a.tags):
                return
            points = [(node.lat, node.lon) for ring in a.outer_rings() for node in ring if node.location.valid()]
            if not points:
                return
            lat = sum(p[0] for p in points) / len(points)
            lon = sum(p[1] for p in points) / len(points)
            if inside(lat, lon):
                elements.append(
                    {"type": "relation", "id": a.orig_id(), "center": {"lat": lat, "lon": lon}, "tags": dict(a.tags)}
                )

    Handler().apply_file(str(path), locations=True)
    return elements


def extract_payload(url_or_path: str, bbox: list[float], fragment: str) -> dict[str, Any]:
    path = Path(url_or_path) if Path(url_or_path).exists() else download(url_or_path)
    key = (str(path), tuple(bbox))
    if key not in _loaded:
        _loaded[key] = load_elements(path, bbox)
    statements = parse_fragment(fragment)
    found = [el for el in _loaded[key] if any(matches(el["tags"], filters) for filters in statements)]
    return {"elements": found}
