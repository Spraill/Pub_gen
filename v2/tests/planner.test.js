"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../site/planner.js");

const DATA_PATH = path.join(__dirname, "..", "public", "data", "places.json");
const data = fs.existsSync(DATA_PATH) ? P.decodeDataset(JSON.parse(fs.readFileSync(DATA_PATH, "utf8"))) : null;

const BASE_OPTIONS = {
  pubCount: 3,
  maxPubsPerGap: 2,
  orderMode: "optimize",
  walkStyle: "balanced",
  mealStop: "none",
  maxDetourMeters: 1200,
  roundTrip: false,
  requireFood: false,
  requireStepFree: false,
  preferRealAle: false,
  preferOutdoor: false,
  preferDog: false,
};

function poi(id, lat, lon, extra) {
  return { kind: "poi", id, title: id, lat, lon, score: 50, categories: ["museum"], primary: "museum", ...extra };
}

function pub(id, lat, lon, flags) {
  return { kind: "pub", id, title: `Pub ${id}`, lat, lon, flags: flags || 0, address: "", hours: "", website: "", phone: "", brewery: "", cuisine: "" };
}

// A straight east-west line of sights with pubs scattered alongside.
const sights = [poi("n1", 51.51, -0.14), poi("n2", 51.51, -0.12), poi("n3", 51.51, -0.1)];
const pubs = [];
for (let index = 0; index < 20; index += 1) {
  pubs.push(pub(`pn${100 + index}`, 51.5105 + (index % 3) * 0.001, -0.145 + index * 0.0025, index % 4 === 0 ? P.FLAGS.food : 0));
}

test("distance is close to the haversine distance across London", () => {
  // Trafalgar Square -> St Paul's is about 2.1 km.
  const d = P.distance({ lat: 51.508, lon: -0.1281 }, { lat: 51.5138, lon: -0.0984 });
  assert.ok(d > 2000 && d < 2250, `got ${d}`);
});

test("orderAnchors keeps the first stop and finds the shortest order", () => {
  const scrambled = [sights[0], sights[2], sights[1]];
  const ordered = P.orderAnchors(scrambled, "optimize", false);
  assert.deepEqual(ordered.map((p) => p.id), ["n1", "n2", "n3"]);
  assert.deepEqual(P.orderAnchors(scrambled, "selected", false).map((p) => p.id), ["n1", "n3", "n2"]);
});

test("2-opt untangles a long route", () => {
  const points = [];
  for (let index = 0; index < 12; index += 1) points.push(poi(`n${index}`, 51.5, -0.2 + index * 0.01));
  const shuffled = [points[0]].concat(points.slice(1).reverse().filter((_, i) => i % 2), points.slice(1).filter((_, i) => i % 2));
  const ordered = P.orderAnchors(shuffled, "optimize", false);
  assert.equal(ordered[0].id, "n0");
  assert.ok(P.pathLength(ordered, false) <= P.pathLength(points, false) + 1);
});

test("planRoute places the requested pubs in walking order", () => {
  const result = P.planRoute(sights, pubs, BASE_OPTIONS);
  assert.equal(result.ok, true, result.error);
  const pubStops = result.stops.filter((stop) => stop.place.kind === "pub");
  assert.equal(pubStops.length, 3);
  assert.ok(pubStops.every((stop) => stop.auto));
  assert.equal(result.stops[0].place.id, "n1");
  assert.equal(result.stops[result.stops.length - 1].place.id, "n3");
  // Stops should progress west -> east.
  const lons = result.stops.map((stop) => stop.place.lon);
  const sorted = lons.slice().sort((a, b) => a - b);
  assert.ok(P.pathLength(result.stops.map((s) => s.place)) < P.pathLength(sorted.map((lon) => ({ lat: 51.51, lon }))) * 1.5);
});

test("planRoute respects the max pubs per leg capacity", () => {
  const result = P.planRoute(sights, pubs, { ...BASE_OPTIONS, pubCount: 5, maxPubsPerGap: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error, /won't fit/);
});

test("planRoute with a meal stop picks a food pub", () => {
  const result = P.planRoute(sights, pubs, { ...BASE_OPTIONS, mealStop: "middle" });
  assert.equal(result.ok, true, result.error);
  const meal = result.stops.filter((stop) => stop.mealStop);
  assert.equal(meal.length, 1);
  assert.ok(P.hasFlag(meal[0].place, P.FLAGS.food));
});

test("planRoute requires food pubs when asked", () => {
  const result = P.planRoute(sights, pubs, { ...BASE_OPTIONS, requireFood: true, pubCount: 2 });
  assert.equal(result.ok, true, result.error);
  result.stops.filter((s) => s.place.kind === "pub").forEach((s) => assert.ok(P.hasFlag(s.place, P.FLAGS.food)));
});

test("round trips end where they start", () => {
  const result = P.planRoute(sights, pubs, { ...BASE_OPTIONS, roundTrip: true });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stops[0].place.id, result.stops[result.stops.length - 1].place.id);
});

test("a single stop gets pubs around it", () => {
  const result = P.planRoute([sights[1]], pubs, { ...BASE_OPTIONS, pubCount: 3 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stops.length, 4);
  assert.equal(P.planRoute([sights[1]], pubs, { ...BASE_OPTIONS, pubCount: 0 }).ok, false);
});

test("must-visit pubs are not picked again as extra pubs", () => {
  const anchors = [sights[0], pubs[5], sights[2]];
  const result = P.planRoute(anchors, pubs, { ...BASE_OPTIONS, orderMode: "selected" });
  assert.equal(result.ok, true, result.error);
  const ids = result.stops.map((stop) => stop.place.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.stops.find((stop) => stop.place.id === pubs[5].id).auto, false);
});

test("findSwapCandidate offers a different nearby pub", () => {
  const result = P.planRoute(sights, pubs, BASE_OPTIONS);
  const index = result.stops.findIndex((stop) => stop.auto);
  const used = new Set(result.stops.map((stop) => stop.place.id));
  const swap = P.findSwapCandidate(result.analyzed, result.stops[index], used, BASE_OPTIONS);
  assert.ok(swap);
  assert.ok(!used.has(swap.feature.id));
});

test("share links round-trip stops, flags and names", () => {
  const stops = [
    { place: { id: "n1" }, auto: false, mealStop: false },
    { place: { id: "pn22" }, auto: true, mealStop: false },
    { place: { id: "pw33" }, auto: true, mealStop: true },
    { place: { id: "q44" }, auto: false, mealStop: false },
  ];
  const encoded = P.encodeShare("Soho & Bloomsbury", stops);
  const decoded = P.decodeShare(`#${encoded}`);
  assert.equal(decoded.name, "Soho & Bloomsbury");
  assert.deepEqual(decoded.tokens, [
    { id: "n1", auto: false, mealStop: false },
    { id: "pn22", auto: true, mealStop: false },
    { id: "pw33", auto: true, mealStop: true },
    { id: "q44", auto: false, mealStop: false },
  ]);
});

test("decodeShare rejects junk", () => {
  assert.equal(P.decodeShare(""), null);
  assert.equal(P.decodeShare("#foo=bar"), null);
  assert.equal(P.decodeShare("#r=<script>.javascript:alert(1)"), null);
  assert.deepEqual(P.decodeShare("#r=n1.bad.q2").tokens.map((t) => t.id), ["n1", "q2"]);
});

test("safeUrl only allows http(s) links", () => {
  assert.equal(P.safeUrl("javascript:alert(1)"), "");
  assert.equal(P.safeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(P.safeUrl("www.example.com"), "https://www.example.com");
  assert.equal(P.safeUrl("https://a.com; https://b.com"), "https://a.com");
});

test("source and wikipedia links", () => {
  assert.equal(P.sourceUrl({ id: "pn123" }), "https://www.openstreetmap.org/node/123");
  assert.equal(P.sourceUrl({ id: "w9" }), "https://www.openstreetmap.org/way/9");
  assert.equal(P.sourceUrl({ id: "q7" }), "https://openplaques.org/plaques/7");
  assert.equal(P.wikipediaUrl("en:Tower of London"), "https://en.wikipedia.org/wiki/Tower_of_London");
});

test("GPX export is well formed and escaped", () => {
  const gpx = P.toGpx("A & B", [{ place: { lat: 51.5, lon: -0.1, title: "<Pub>", kind: "pub" } }, { place: { lat: 51.51, lon: -0.11, title: "Museum", kind: "poi" } }], null);
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /A &amp; B/);
  assert.match(gpx, /&lt;Pub&gt;/);
  assert.equal((gpx.match(/<trkpt/g) || []).length, 2);
});

test("Google Maps links cap waypoints", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ place: { lat: 51.5, lon: -0.1 + i * 0.001 } }));
  const { url, truncated } = P.googleMapsUrl(many);
  assert.equal(truncated, true);
  assert.equal(new URL(url).searchParams.get("waypoints").split("|").length, 9);
  assert.equal(new URL(url).searchParams.get("travelmode"), "walking");
});

test("random sights are drawn close together", () => {
  const spread = [];
  for (let index = 0; index < 200; index += 1) {
    spread.push(poi(`n${index}`, 51.3 + (index % 20) * 0.02, -0.4 + Math.floor(index / 20) * 0.06, { score: 20 + (index % 80) }));
  }
  const rng = P.createRng("test");
  const picks = P.pickRandomSights(spread, 4, rng, false);
  assert.equal(picks.length, 4);
  assert.equal(new Set(picks.map((p) => p.id)).size, 4);
  const maxGap = Math.max(...picks.map((a) => Math.max(...picks.map((b) => P.distance(a, b)))));
  assert.ok(maxGap < 13000, `sights too far apart: ${maxGap}`);
  assert.equal(P.pickRandomSights(spread.slice(0, 2), 4, rng, false), null);
});

test("random pub crawls space pubs out", () => {
  const rng = P.createRng(7);
  const picks = P.pickRandomPubs(pubs, 4, rng, true);
  assert.equal(picks.length, 4);
  assert.equal(new Set(picks.map((p) => p.id)).size, 4);
});

test("search ranks title matches first", () => {
  const index = P.createSearchIndex([
    poi("n1", 51.5, -0.1, { title: "British Museum", score: 100 }),
    poi("n2", 51.5, -0.1, { title: "Plaque", description: "Lived near the British Museum", score: 90 }),
    pub("pn3", 51.5, -0.1),
  ]);
  const results = P.search(index, "british museum");
  assert.deepEqual(results.map((p) => p.id), ["n1", "n2"]);
  assert.deepEqual(P.search(index, "Pub pn3").map((p) => p.id), ["pn3"]);
  assert.deepEqual(P.search(index, "  "), []);
});

test("total time counts each stop once", () => {
  const stops = [{ place: { id: "a", kind: "poi" } }, { place: { id: "b", kind: "pub" } }, { place: { id: "a", kind: "poi" } }];
  assert.equal(P.totalTimeSeconds(stops, 600, 40, 15), 600 + 55 * 60);
});

test("formatting", () => {
  assert.equal(P.formatDistance(840), "840 m");
  assert.equal(P.formatDistance(2345), "2.3 km");
  assert.equal(P.formatDuration(59 * 60), "59 min");
  assert.equal(P.formatDuration(125 * 60), "2 h 5 min");
  assert.equal(P.formatDuration(120 * 60), "2 h");
});

test("built dataset decodes and plans a real crawl", { skip: !data && "run build_v2.py first" }, () => {
  assert.ok(data.pubs.length > 1000);
  assert.ok(data.pois.length > 1000);
  const ids = new Set();
  data.pubs.concat(data.pois).forEach((place) => {
    assert.ok(!ids.has(place.id), `duplicate id ${place.id}`);
    ids.add(place.id);
    assert.ok(Number.isFinite(place.lat) && Number.isFinite(place.lon));
  });
  const museum = data.pois.find((p) => /british museum/i.test(p.title));
  const tower = data.pois.find((p) => /^tower of london$/i.test(p.title));
  assert.ok(museum && tower);
  const result = P.planRoute([museum, tower], data.pubs, { ...BASE_OPTIONS, pubCount: 3, maxPubsPerGap: 3 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stops.length, 5);
});
