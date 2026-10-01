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

import hashlib
import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GEOFABRIK_INDEX = "https://download.geofabrik.de/index-v1.json"
CACHE_DIR = Path(__file__).resolve().parents[1] / ".cache"
# Only objects carrying one of these keys can match a fetcher fragment.
INTERESTING_KEYS = ("amenity", "tourism", "historic", "heritage", "leisure", "memorial", "plaque")

STATEMENT_RE = re.compile(r"nwr((?:\[[^\]]*\])+)\([^)]*\);")
FILTER_RE = re.compile(r'\["([^"]+)"(?:(=|~)"([^"]*)")?\]')

_failed: list[bool] = []
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


def _ring_contains(ring: list[list[float]], lon: float, lat: float) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def covering_geofabrik_regions(index: dict[str, Any], bbox: list[float]) -> list[str]:
    """Geofabrik extracts whose outline contains every corner of bbox, smallest first."""
    south, west, north, east = bbox
    corners = [(west, south), (west, north), (east, south), (east, north)]
    found: list[tuple[float, str]] = []
    for feature in index.get("features", []):
        geometry = feature.get("geometry") or {}
        pbf = ((feature.get("properties") or {}).get("urls") or {}).get("pbf")
        if not pbf or geometry.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        if not all(any(_ring_contains(poly[0], lon, lat) for poly in polygons) for lon, lat in corners):
            continue
        points = [pt for poly in polygons for pt in poly[0]]
        lons = [pt[0] for pt in points]
        lats = [pt[1] for pt in points]
        found.append(((max(lons) - min(lons)) * (max(lats) - min(lats)), pbf))
    return [pbf for _, pbf in sorted(found)]


def pick_geofabrik_region(index: dict[str, Any], bbox: list[float]) -> str:
    regions = covering_geofabrik_regions(index, bbox)
    if not regions:
        raise RuntimeError("No Geofabrik region covers this city.")
    return regions[0]


def candidate_sources(source: str, bbox: list[float]) -> list[str]:
    """"geofabrik" means: the Geofabrik extracts covering the city, smallest first."""
    if source != "geofabrik":
        return [source]
    request = Request(GEOFABRIK_INDEX, headers={"User-Agent": "pub-gen-data-refresh/1.0"})
    with urlopen(request, timeout=120) as response:
        index = json.load(response)
    # Up to country level (county, region, country); a continent is too big to download.
    return covering_geofabrik_regions(index, bbox)[:3]


def obtain(source: str | list[str], bbox: list[float]) -> Path:
    """A local .osm.pbf for the city: the first source that downloads, cut to bbox.

    source is a local path, a URL, "geofabrik" (every covering Geofabrik region,
    smallest first) or a list of these tried in order.
    """
    sources = source if isinstance(source, list) else [source]
    for item in sources:
        if Path(item).exists():
            return clip(Path(item), bbox)
    # Pubs and sights are fetched by separate processes: a recent failure is remembered on disk.
    digest = hashlib.sha1(json.dumps([sources, bbox]).encode()).hexdigest()[:10]
    failed_marker = CACHE_DIR / f"failed-{digest}"
    recently_failed = failed_marker.exists() and time.time() - failed_marker.stat().st_mtime < 3600
    if _failed or recently_failed:
        raise RuntimeError("OSM extract download already failed in this run.")
    last_error: Exception | None = None
    for item in sources:
        try:
            urls = candidate_sources(item, bbox)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            last_error = exc
            print(json.dumps({"osm_extract_index_failed": item, "error": str(exc)[:160]}), flush=True)
            continue
        for url in urls:
            try:
                path = download(url)
            except (HTTPError, URLError, TimeoutError, OSError) as exc:
                last_error = exc
                final = getattr(exc, "url", "") or ""
                print(json.dumps({"osm_extract_failed": url, "redirected_to": final, "error": str(exc)[:160]}), flush=True)
                continue
            print(json.dumps({"osm_extract": url}), flush=True)
            return clip(path, bbox)
    _failed.append(True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    failed_marker.write_text(str(last_error), encoding="utf-8")
    raise RuntimeError(f"Could not download an OSM extract: {last_error}") from last_error


def clip(path: Path, bbox: list[float]) -> Path:
    """Cut a regional extract down to the city with osmium-tool, if installed (much faster to read)."""
    if not shutil.which("osmium"):
        return path
    south, west, north, east = bbox
    target = path.with_name(f"{path.name.split('.')[0]}-{south}_{west}_{north}_{east}.osm.pbf")
    if not target.exists():
        subprocess.run(
            ["osmium", "extract", "-b", f"{west},{south},{east},{north}", "--overwrite", "-o", str(target), str(path)],
            check=True,
        )
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


def extract_payload(url_or_path: str | list[str], bbox: list[float], fragment: str) -> dict[str, Any]:
    path = obtain(url_or_path, bbox)
    key = (str(path), tuple(bbox))
    if key not in _loaded:
        _loaded[key] = load_elements(path, bbox)
    statements = parse_fragment(fragment)
    found = [el for el in _loaded[key] if any(matches(el["tags"], filters) for filters in statements)]
    return {"elements": found}
