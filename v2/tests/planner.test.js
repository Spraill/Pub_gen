"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../site/planner.js");

const DATA_PATH = path.join(__dirname, "..", "public", "data", "places-london.json");
const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cities.json"), "utf8"));
const LONDON_AREAS = CITIES.london.dailyAreas;
const data = fs.existsSync(DATA_PATH) ? P.decodeDataset(JSON.parse(fs.readFileSync(DATA_PATH, "utf8"))) : null;

const BASE_OPTIONS = {
  pubCount: 3,
  maxPubsPerGap: 2,
  orderMode: "optimize",
  walkStyle: "balanced",
  mealStop: "none",
  maxDetourMeters: 1200,
  roundTrip: false,
  finish: "any",
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

test("finish at a pub saves one pub for the end", () => {
  const result = P.planRoute(sights, pubs, { ...BASE_OPTIONS, finish: "pub", pubCount: 3 });
  assert.equal(result.ok, true, result.error);
  const last = result.stops[result.stops.length - 1];
  assert.equal(last.place.kind, "pub");
  assert.equal(last.auto, true);
  assert.equal(result.stops.filter((stop) => stop.place.kind === "pub").length, 3);
  // The finale is near the last sight, not back near the start.
  assert.ok(P.distance(last.place, sights[2]) < P.distance(last.place, sights[0]));
  // Loops ignore it.
  const loop = P.planRoute(sights, pubs, { ...BASE_OPTIONS, finish: "pub", roundTrip: true });
  assert.equal(loop.stops[loop.stops.length - 1].place.id, "n1");
});

test("finish at a pub with one pub and a meal stop makes the finale the meal", () => {
  const result = P.planRoute(sights, pubs, { ...BASE_OPTIONS, finish: "pub", pubCount: 1, mealStop: "middle" });
  assert.equal(result.ok, true, result.error);
  const last = result.stops[result.stops.length - 1];
  assert.equal(last.mealStop, true);
  assert.ok(P.hasFlag(last.place, P.FLAGS.food));
});

test("another version prefers different pubs", () => {
  const first = P.planRoute(sights, pubs, { ...BASE_OPTIONS, seed: "a" });
  const firstPubs = first.stops.filter((stop) => stop.auto).map((stop) => stop.place.id);
  const second = P.planRoute(sights, pubs, { ...BASE_OPTIONS, seed: "b", avoidIds: firstPubs });
  const secondPubs = second.stops.filter((stop) => stop.auto).map((stop) => stop.place.id);
  assert.equal(second.ok, true, second.error);
  assert.ok(secondPubs.some((id) => !firstPubs.includes(id)), "at least one new pub");
  // Same seed, same result.
  const again = P.planRoute(sights, pubs, { ...BASE_OPTIONS, seed: "a" });
  assert.deepEqual(again.stops.map((stop) => stop.place.id), first.stops.map((stop) => stop.place.id));
});

test("Commons responses become credited photos", () => {
  const json = {
    query: {
      pages: {
        1: { title: "File:Pub map.svg", index: 1, imageinfo: [{ thumburl: "https://upload.wikimedia.org/a.png" }] },
        2: {
          title: "File:The Lamb, interior.jpg",
          index: 3,
          imageinfo: [
            {
              thumburl: "https://upload.wikimedia.org/b.jpg",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:b.jpg",
              extmetadata: { Artist: { value: '<a href="x">Jane &amp; Co</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } },
            },
          ],
        },
        3: { title: "File:The Lamb.jpg", index: 2, imageinfo: [{ thumburl: "https://upload.wikimedia.org/c.jpg" }] },
        4: { title: "File:Evil.jpg", index: 4, imageinfo: [{ thumburl: "javascript:alert(1)" }] },
      },
    },
  };
  const images = P.parseCommonsImages(json);
  assert.deepEqual(images.map((image) => image.title), ["File:The Lamb.jpg", "File:The Lamb, interior.jpg"]);
  assert.equal(images[1].credit, "Jane & Co, CC BY-SA 4.0");
  assert.equal(images[1].interior, true);
  const arranged = P.arrangePhotos([images[0], { thumb: "x", interior: false }, images[1]]);
  assert.deepEqual(arranged.map((image) => image.thumb), ["https://upload.wikimedia.org/c.jpg", "https://upload.wikimedia.org/b.jpg", "x"]);
  assert.equal(P.readWikidataClaim({ claims: { P18: [{ mainsnak: { datavalue: { value: "A.jpg" } } }] } }, "P18"), "A.jpg");
  assert.equal(
    P.commonsFileFromUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tower_of_London.jpg/320px-Tower_of_London.jpg"),
    "File:Tower of London.jpg"
  );
});

test("street photos must face the pub", () => {
  const place = { lat: 51.5, lon: -0.1 };
  const south = { lat: 51.4998, lon: -0.1 }; // ~22 m south of the pub
  const photo = (angle) => ({
    id: String(angle),
    thumb_1024_url: "https://scontent.xx.fbcdn.net/a.jpg",
    computed_compass_angle: angle,
    computed_geometry: { coordinates: [south.lon, south.lat] },
  });
  const picked = P.pickFacingPhotos({ data: [photo(180), photo(5), photo(90)] }, place);
  assert.deepEqual(picked.map((item) => item.page.split("=")[1]), ["5"]);
});

test("formatting", () => {
  assert.equal(P.formatDistance(840), "840 m");
  assert.equal(P.formatDistance(2345), "2.3 km");
  assert.equal(P.formatDuration(59 * 60), "59 min");
  assert.equal(P.formatDuration(125 * 60), "2 h 5 min");
  assert.equal(P.formatDuration(120 * 60), "2 h");
});

test("crawl of the day is stable, high quality and ends at a pub", { skip: !data && "run build_v2.py first" }, () => {
  const areas = new Set();
  for (let offset = 0; offset < 30; offset += 1) {
    const key = new Date(Date.UTC(2026, 9, 1 + offset)).toISOString().slice(0, 10);
    const crawl = P.pickDailyCrawl(data.pois, data.pubs, key, LONDON_AREAS);
    assert.ok(crawl, key);
    assert.deepEqual(P.pickDailyCrawl(data.pois, data.pubs, key, LONDON_AREAS).anchors.map((p) => p.id), crawl.anchors.map((p) => p.id));
    areas.add(crawl.area.name);
    const sightsInCrawl = crawl.anchors.filter((place) => place.kind === "poi");
    assert.ok(sightsInCrawl.length >= 2 && sightsInCrawl.length <= 4, `${key} has ${sightsInCrawl.length} sights`);
    sightsInCrawl.forEach((poi) => assert.ok(P.isQualitySight(poi, 65), `${key}: ${poi.title}`));
    const plan = P.planRoute(crawl.anchors, data.pubs, crawl.options);
    assert.equal(plan.ok, true, `${key}: ${plan.error}`);
    const pubCount = plan.stops.filter((stop) => stop.place.kind === "pub").length;
    assert.ok(pubCount >= 4 && pubCount <= 6, `${key} has ${pubCount} pubs`);
    assert.equal(plan.stops[plan.stops.length - 1].place.kind, "pub");
  }
  assert.ok(areas.size >= 15, "rotates through London");
  const today = P.londonDateKey(new Date(Date.UTC(2026, 9, 1, 23, 30)));
  assert.equal(today, "2026-10-02", "uses the London date (BST)");
});

test("every theme makes walkable, on-theme crawls", { skip: !data && "run build_v2.py first" }, () => {
  const base = { ...BASE_OPTIONS, finish: "pub", walkStyle: "quiet" };
  assert.ok(P.THEMES.length >= 10 && P.THEMES.length <= 24);
  P.THEMES.forEach((theme) => {
    for (const seed of ["one", "two", "three"]) {
      const result = P.generateThemedCrawl(theme, data.pois, data.pubs, 3, 4, seed, base);
      assert.equal(result.ok, true, `${theme.id}/${seed}: ${result.error}`);
      const sightsInCrawl = result.plan.stops.filter((stop) => stop.place.kind === "poi");
      assert.equal(sightsInCrawl.length, 3, theme.id);
      sightsInCrawl.forEach((stop) => assert.ok(P.themeMatchesSight(stop.place, theme), `${theme.id}: ${stop.place.title}`));
      assert.equal(result.plan.stops.filter((stop) => stop.place.kind === "pub").length, 4, theme.id);
      assert.ok(P.pathLength(sightsInCrawl.map((stop) => stop.place)) < 9000, `${theme.id} is walkable`);
    }
  });
  const pubsOnly = P.generateThemedCrawl(P.themeById("maritime"), data.pois, data.pubs, 0, 4, "x", base);
  assert.equal(pubsOnly.ok, true, pubsOnly.error);
  pubsOnly.plan.stops.forEach((stop) => assert.ok(P.themeMatchesPub(stop.place, P.themeById("maritime")), stop.place.title));
});

test("theme pub rules are specific and explain themselves", () => {
  const tudor = P.themeById("tudor");
  const stuart = P.themeById("stuart");
  const royal = P.themeById("royal");
  const cheese = pub("pn1", 51.5, -0.1);
  cheese.title = "The Cheshire Cheese";
  const olde = pub("pn2", 51.5, -0.1);
  olde.title = "Ye Olde Cheshire Cheese";
  const golden = pub("pn3", 51.5, -0.1);
  golden.title = "The Golden Lion";
  const kingsRoad = pub("pn4", 51.5, -0.1);
  kingsRoad.title = "Chelsea Potter";
  kingsRoad.address = "119 King's Road";
  assert.equal(P.themeReason(cheese, tudor), "");
  assert.equal(P.themeReason(cheese, stuart), "");
  assert.equal(P.themeReason(olde, tudor), "");
  assert.match(P.themeReason(olde, stuart), /Great Fire/);
  assert.equal(P.themeReason(golden, tudor), "", "'olde' must not match 'Golden'");
  assert.equal(P.themeReason(kingsRoad, royal), "", "broad name rules ignore the address");
});

test("music is split by genre and wartime means World War II", () => {
  const rock = P.themeById("rock");
  const classical = P.themeById("classical");
  const ww2 = P.themeById("wartime");
  assert.equal(P.themeById("music"), null);
  const dublin = pub("pn10", 51.5, -0.1);
  dublin.title = "The Dublin Castle";
  assert.match(P.themeReason(dublin, rock), /Madness/);
  assert.equal(P.themeReason(dublin, classical), "");
  const opera = poi("n11", 51.5, -0.1, { title: "Royal Opera House" });
  assert.ok(P.themeReason(opera, classical));
  assert.equal(P.themeReason(opera, rock), "");
  const nelson = pub("pn12", 51.5, -0.1);
  nelson.title = "Lord Nelson";
  assert.equal(P.themeReason(nelson, ww2), "", "Napoleonic names aren't WWII");
  const waterloo = poi("n13", 51.5, -0.1, { title: "Waterloo memorial", description: "Battle of Waterloo 1815" });
  assert.equal(P.themeReason(waterloo, ww2), "");
  const lifeSpan = poi("n14", 51.5, -0.1, { title: "Jane Doe", description: "Jane Doe 1890-1941 novelist lived here" });
  assert.equal(P.themeReason(lifeSpan, ww2), "", "a life span ending in 1941 isn't a wartime link");
  const blitz = poi("n15", 51.5, -0.1, { title: "Stainer Street Arch", description: "On the night of 17 February 1941 a bomb fell here" });
  assert.match(P.themeReason(blitz, ww2), /1941/);
  const french = pub("pn16", 51.5, -0.1);
  french.title = "French House";
  assert.match(P.themeReason(french, ww2), /Free French/);
});

test("crime is about crime and ghosts, not police boxes", () => {
  const crime = P.themeById("crime");
  const box = poi("n20", 51.5, -0.1, { title: "Police Public Callbox", description: "A police box" });
  assert.equal(P.themeReason(box, crime), "");
  const bike = poi("n21", 51.5, -0.1, { title: "Ghost bike in memory of a cyclist" });
  assert.equal(P.themeReason(bike, crime), "");
  const tyburn = poi("n22", 51.5, -0.1, { title: "Site of Tyburn Tree", description: "Gallows where thousands were hanged" });
  assert.ok(P.themeReason(tyburn, crime));
  const grenadier = pub("pn23", 51.5, -0.1);
  grenadier.title = "The Grenadier";
  grenadier.address = "18 Wilton Row, London";
  assert.match(P.themeReason(grenadier, crime), /haunted/);
  const stories = P.placeStories(grenadier);
  assert.ok(stories.some((story) => story.theme === "crime" && story.curated));
});

test("money theme: banks, markets and coffee houses, not the merchant navy", () => {
  const money = P.themeById("money");
  const lloyds = poi("n30", 51.5, -0.1, { title: "Lloyd's of London" });
  assert.equal(P.themeReason(lloyds, money), "Linked to: “Lloyd's of London”");
  const navy = poi("n31", 51.5, -0.1, { title: "Memorial", description: "To the merchant navy seamen lost in 1982" });
  assert.equal(P.themeReason(navy, money), "");
  const jamaica = pub("pn32", 51.5, -0.1);
  jamaica.title = "Jamaica Wine House";
  assert.match(P.themeReason(jamaica, money), /first coffee house/);
  const exchange = pub("pn33", 51.5, -0.1);
  exchange.title = "Royal Exchange";
  exchange.address = "26 Sale Place, London, W2 1PU";
  assert.equal(P.themeReason(exchange, money), "");
});

test("London pub stories stay in London; name stories travel", () => {
  const sevenStars = pub("pn40", 53.48, -2.24);
  sevenStars.title = "Seven Stars";
  const crown = pub("pn41", 53.48, -2.24);
  crown.title = "The Crown";
  try {
    P.setCity("manchester");
    assert.ok(!P.placeStories(sevenStars).some((story) => /Great Fire/.test(story.reason)));
    assert.ok(P.placeStories(crown).some((story) => story.reason === "Named after royalty"));
  } finally {
    P.setCity("london");
  }
  assert.ok(P.placeStories(sevenStars).some((story) => /Great Fire/.test(story.reason)));
});

test("every curated pub rule matches a real pub", { skip: !data && "run build_v2.py first" }, () => {
  const misses = [];
  const cityMisses = [];
  // Rules guarded to another city only count once that city's data is built.
  const cityRules = { york: /yo\\d|starre/, edinburgh: /eh\\d|edinburgh/, oxford: /ox\\d|oxford\$/, manchester: /\\bm\\d|manchester/ };
  const cityPath = (id) => path.join(__dirname, "..", "public", "data", `places-${id}.json`);
  const built = Object.keys(cityRules).filter((id) => fs.existsSync(cityPath(id)));
  const allPubs = data.pubs.concat(...built.map((id) => P.decodeDataset(JSON.parse(fs.readFileSync(cityPath(id), "utf8"))).pubs));
  P.THEMES.forEach((theme) => {
    (theme.pubs || []).forEach(([pattern, reason]) => {
      const city = Object.keys(cityRules).find((id) => cityRules[id].test(pattern.source));
      if (city && !built.includes(city)) return;
      const hit = allPubs.some((place) => P.themeReason(place, theme) === reason);
      // Wikidata-sourced cities only list some pubs: report their misses, don't fail the data refresh.
      if (!hit && city) cityMisses.push(`${city}/${theme.id}: ${reason}`);
      else if (!hit) misses.push(`${theme.id}: ${reason}`);
    });
  });
  if (cityMisses.length) console.log(`city pub rules with no matching pub yet:\n${cityMisses.join("\n")}`);
  assert.ok(misses.length <= 12, `unused pub rules:\n${misses.join("\n")}`);
});

test("themed crawls rarely use plaques and allow up to 10 sights", { skip: !data && "run build_v2.py first" }, () => {
  const base = { ...BASE_OPTIONS, finish: "pub" };
  let plaques = 0;
  let total = 0;
  P.THEMES.forEach((theme) => {
    for (const seed of ["p1", "p2", "p3"]) {
      const result = P.generateThemedCrawl(theme, data.pois, data.pubs, 4, 3, seed, base);
      assert.equal(result.ok, true, `${theme.id}: ${result.error}`);
      const sightStops = result.plan.stops.filter((stop) => stop.place.kind === "poi");
      const count = sightStops.filter((stop) => stop.place.primary === "blue_plaque").length;
      const nonPlaques = data.pois.filter((p) => p.score >= 30 && p.primary !== "blue_plaque" && P.themeMatchesSight(p, theme)).length;
      // Plaque-heavy themes (few other sights) may use more; the rest at most one.
      if (nonPlaques >= 25) assert.ok(count <= 1, `${theme.id} has ${count} plaques`);
      plaques += count;
      total += sightStops.length;
    }
  });
  assert.ok(plaques / total < 0.25, `plaques are ${plaques}/${total}`);
  const big = P.generateThemedCrawl(P.themeById("sacred"), data.pois, data.pubs, 10, 6, "big", base);
  assert.equal(big.ok, true, big.error);
  assert.equal(big.plan.stops.filter((stop) => stop.place.kind === "poi").length, 10);
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
