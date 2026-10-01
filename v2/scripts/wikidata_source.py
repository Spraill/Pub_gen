#!/usr/bin/env python3
"""Pubs and sights for a city from Wikidata, shaped like an Overpass response.

A simple, dependable fallback for small cities when the OpenStreetMap servers
are overloaded: one SPARQL query fetches every item with coordinates inside the
city's bounding box, Wikidata classes become OSM-style tags, and the fetchers'
Overpass fragments are evaluated against those tags (see osm_extract.matches).
Coverage is thinner than OpenStreetMap (listed and notable pubs, not every
pub) but it is all well-sourced, and it always has a Wikipedia/Wikidata link.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any
from urllib.parse import unquote, urlencode
from urllib.request import Request, urlopen

from osm_extract import CACHE_DIR, matches, parse_fragment

SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "pub-gen-data-refresh/1.0 (https://github.com/Spraill/Pub_gen)"

# Wikidata class -> OSM-style tags understood by the fetchers.
CLASS_TAGS: dict[str, dict[str, str]] = {
    "Q212198": {"amenity": "pub"},  # pub
    "Q256020": {"amenity": "pub"},  # inn
    "Q33506": {"tourism": "museum"},  # museum
    "Q207694": {"tourism": "museum"},  # art museum
    "Q1007870": {"tourism": "gallery"},  # art gallery
    "Q24354": {"amenity": "theatre"},  # theatre building
    "Q7075": {"amenity": "library"},  # library
    "Q1060829": {"amenity": "music_venue"},  # concert hall
    "Q16970": {"amenity": "place_of_worship", "historic": "building"},  # church building
    "Q2977": {"amenity": "place_of_worship", "historic": "building"},  # cathedral
    "Q160742": {"amenity": "place_of_worship", "historic": "building"},  # abbey
    "Q44613": {"historic": "building"},  # monastery
    "Q108325": {"amenity": "place_of_worship", "historic": "building"},  # chapel
    "Q34627": {"amenity": "place_of_worship"},  # synagogue
    "Q32815": {"amenity": "place_of_worship"},  # mosque
    "Q23413": {"historic": "castle"},  # castle
    "Q57821": {"historic": "fort"},  # fortification
    "Q16748868": {"historic": "city_gate"},  # city walls
    "Q82117": {"historic": "city_gate"},  # city gate
    "Q12518": {"historic": "tower"},  # tower
    "Q4989906": {"historic": "monument"},  # monument
    "Q5003624": {"historic": "memorial"},  # memorial
    "Q575759": {"historic": "memorial"},  # war memorial
    "Q839954": {"historic": "archaeological_site"},  # archaeological site
    "Q109607": {"historic": "ruins"},  # ruins
    "Q16560": {"historic": "building"},  # palace
    "Q879050": {"historic": "manor"},  # manor house
    "Q1802963": {"historic": "building"},  # mansion
    "Q3947": {"historic": "building"},  # house
    "Q1081138": {"historic": "building"},  # historic site
    "Q570116": {"tourism": "attraction"},  # tourist attraction
    "Q22698": {"leisure": "park"},  # park
    "Q1107656": {"leisure": "garden"},  # garden
    "Q167346": {"leisure": "garden"},  # botanical garden
    "Q12280": {"historic": "building"},  # bridge
    "Q132510": {"amenity": "marketplace"},  # market
    "Q1595639": {"tourism": "attraction"},  # street (only notable ones have coordinates and a sitelink)
}

# Listed-building names that are (or contain) a pub.
PUB_NAME = re.compile(r"\b(public house|inn|inne|tavern)\b", re.I)
NOT_A_PUB = re.compile(r"\b(former|formerly|old|site of)\b", re.I)
# Heritage-listing records that describe a fixture or a stretch of street, not a place to visit.
LISTING_JUNK = re.compile(
    r"approximately|\bmetres\b|adjacent to|to (the )?rear|\battached\b|boundary wall|railings|gate ?piers"
    r"|\blamp|telephone kiosk|bollard|mounting block|\bwalls? to\b|steps to|forecourt|outbuilding|gazebo"
    r"|\bstable\b|ice house|pinfold|\bnos?\.? \d",
    re.I,
)
STARTS_WITH_NUMBER = re.compile(r"^(numbers? )?\d", re.I)
# Listing-style suffixes on pub names.
PUB_SUFFIX = re.compile(r",? (public house|and attached buildings.*|\(number \d+\))$", re.I)
# Historic England grades (P1435 values) worth a fame boost.
GRADES = {"Q15700818": "grade i", "Q15700831": "grade ii*", "Q15700834": "grade ii"}

_cache: dict[str, list[dict[str, Any]]] = {}


def build_query(bbox: list[float]) -> str:
    south, west, north, east = bbox
    return f"""
SELECT ?item ?itemLabel ?coord ?class ?article ?sitelinks ?inception ?heritage ?ended ?address WHERE {{
  SERVICE wikibase:box {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point({west} {south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point({east} {north})"^^geo:wktLiteral .
  }}
  OPTIONAL {{ ?item wdt:P31 ?class . }}
  OPTIONAL {{ ?item wikibase:sitelinks ?sitelinks . }}
  OPTIONAL {{ ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }}
  OPTIONAL {{ ?item wdt:P571 ?inception . }}
  OPTIONAL {{ ?item wdt:P1435 ?heritage . }}
  OPTIONAL {{ ?item wdt:P576|wdt:P3999 ?ended . }}
  OPTIONAL {{ ?item wdt:P6375 ?address . FILTER(LANG(?address) = "en") }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}"""


def run_query(query: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            request = Request(
                SPARQL_ENDPOINT,
                data=urlencode({"query": query, "format": "json"}).encode(),
                headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
            )
            with urlopen(request, timeout=120) as response:
                return json.load(response)
        except Exception as exc:  # noqa: BLE001 - network errors of every kind get a retry
            last_error = exc
            print(json.dumps({"wikidata_retry": attempt + 1, "error": str(exc)[:160]}), flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Wikidata query failed: {last_error}") from last_error


def parse_point(wkt: str) -> tuple[float, float] | None:
    match = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", wkt or "")
    if not match:
        return None
    return float(match.group(2)), float(match.group(1))


def elements_from_results(results: dict[str, Any]) -> list[dict[str, Any]]:
    items: dict[str, dict[str, Any]] = {}
    for row in results.get("results", {}).get("bindings", []):
        value = lambda key: (row.get(key) or {}).get("value", "")  # noqa: E731
        qid = value("item").rsplit("/", 1)[-1]
        point = parse_point(value("coord"))
        if not qid.startswith("Q") or point is None:
            continue
        item = items.setdefault(
            qid,
            {"label": value("itemLabel"), "point": point, "classes": set(), "heritage": False, "ended": False},
        )
        if value("class"):
            item["classes"].add(value("class").rsplit("/", 1)[-1])
        if value("heritage"):
            item["heritage"] = True
            grade = GRADES.get(value("heritage").rsplit("/", 1)[-1])
            if grade and (item.get("grade") is None or grade < item["grade"]):
                item["grade"] = grade
        if value("ended"):
            item["ended"] = True
        if value("article") and "wikipedia" not in item:
            item["wikipedia"] = "en:" + unquote(value("article").rsplit("/wiki/", 1)[-1]).replace("_", " ")
        if value("sitelinks"):
            item["sitelinks"] = int(value("sitelinks"))
        if value("inception") and "start_date" not in item:
            year = re.match(r"\+?(\d{3,4})-", value("inception"))
            if year:
                item["start_date"] = year.group(1)
        if value("address") and "address" not in item:
            item["address"] = value("address")

    elements = []
    for qid, item in items.items():
        label = item["label"]
        if item["ended"] or not label or re.fullmatch(r"Q\d+", label):
            continue
        tags: dict[str, str] = {"name": label, "wikidata": qid}
        for wd_class in sorted(item["classes"]):
            for key, val in CLASS_TAGS.get(wd_class, {}).items():
                tags.setdefault(key, val)
        has_class = len(tags) > 2
        if tags.get("amenity") != "pub" and item["heritage"] and PUB_NAME.search(label) and not NOT_A_PUB.search(label):
            tags["amenity"] = "pub"
        # Listing-style labels ("Guildhall and Chamber Range, Atkinson block, ...", "44, Shambles")
        # read better as their Wikipedia article title ("Guildhall, York", "44 Shambles").
        article = item.get("wikipedia", "")[3:]
        if article and (len(label) > 45 or STARTS_WITH_NUMBER.search(label) or LISTING_JUNK.search(label)):
            label = re.sub(r" \([^)]*\)$", "", article)
            tags["name"] = label
        is_pub = tags.get("amenity") == "pub"
        if is_pub:
            previous = None
            while previous != label:  # "X Public House (Number 19)" -> "X"
                previous, label = label, PUB_SUFFIX.sub("", label).strip()
            tags["name"] = label
        # Listing records for fixtures ("Gazebo 50 Metres North Of ...") or bare addresses ("19, Market Street")
        # are not pubs, and only make sights when Wikipedia has an article on them.
        junk = LISTING_JUNK.search(label) or STARTS_WITH_NUMBER.search(label) or len(label) > 70
        if junk and (is_pub or not item.get("wikipedia")):
            continue
        # A plain listed house with no article and no class is a poor crawl stop.
        if not is_pub and not has_class and not item.get("wikipedia"):
            continue
        if item["heritage"]:
            tags["heritage"] = "2"
            tags.setdefault("historic", "building")
            if item.get("grade"):
                tags["listed_status"] = item["grade"]

        for key in ("wikipedia", "start_date"):
            if item.get(key):
                tags[key] = item[key]
        if item.get("address"):
            tags["addr:street"] = item["address"]
        if len(tags) <= 2:  # nothing but a name: not a pub or a sight
            continue
        lat, lon = item["point"]
        elements.append({"type": "wikidata", "id": int(qid[1:]), "lat": lat, "lon": lon, "tags": tags})
    return elements


def load(bbox: list[float]) -> list[dict[str, Any]]:
    """All useful Wikidata items in bbox, cached in memory and (for an hour) on disk."""
    digest = hashlib.sha1(json.dumps(bbox).encode()).hexdigest()[:10]
    if digest in _cache:
        return _cache[digest]
    cache_file = CACHE_DIR / f"wikidata-{digest}.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 3600:
        elements = json.loads(cache_file.read_text(encoding="utf-8"))
    else:
        elements = elements_from_results(run_query(build_query(bbox)))
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(elements), encoding="utf-8")
        print(json.dumps({"wikidata_items": len(elements)}), flush=True)
    _cache[digest] = elements
    return elements


def wikidata_payload(bbox: list[float], fragment: str, city_name: str = "") -> dict[str, Any]:
    statements = parse_fragment(fragment)
    found = [el for el in load(bbox) if any(matches(el["tags"], filters) for filters in statements)]
    if city_name:
        # "Golden Fleece, York" -> "Golden Fleece": Wikipedia-style disambiguation isn't part of the name.
        suffix = re.compile(rf"(, | \(){re.escape(city_name)}\)?$", re.I)
        found = [
            {
                **el,
                "tags": {
                    **el["tags"],
                    "name": suffix.sub("", el["tags"]["name"]).strip() or el["tags"]["name"],
                    "addr:city": el["tags"].get("addr:city") or city_name,
                },
            }
            for el in found
        ]
    return {"elements": found}

