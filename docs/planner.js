/*
 * London Crawl Planner: pure planning logic.
 *
 * No DOM or Leaflet access here, so the same file runs in the browser
 * (as window.PubGenPlanner) and under Node for the unit tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PubGenPlanner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Distances use a flat projection around the current city's latitude.
  let METERS_PER_DEG_LON = 111320 * Math.cos((51.509865 * Math.PI) / 180);

  function setReferenceLatitude(lat) {
    METERS_PER_DEG_LON = 111320 * Math.cos((lat * Math.PI) / 180);
  }

  // Curated pub stories are about London pubs unless a rule names its street or city
  // (it contains "|"), or the story is only about the name ("Seafaring name").
  let CURRENT_CITY = "london";
  function setCity(id) {
    CURRENT_CITY = String(id || "london");
  }
  const METERS_PER_DEG_LAT = 110540;
  // Straight-line distances underestimate real walking routes.
  const STRAIGHT_LINE_DETOUR = 1.25;
  const WALK_SPEED_MPS = 1.33;
  const MAX_SHARED_STOPS = 40;
  const MAX_EXACT_ORDER = 8;

  // Keep in sync with the FLAG_* constants in build_v2.py.
  const FLAGS = {
    food: 1,
    realAle: 2,
    outdoor: 4,
    stepFree: 8,
    dog: 16,
    liveMusic: 32,
    realCider: 64,
    partialAccess: 128,
    historic: 256,
    chain: 512,
    brewpub: 1024,
    realFire: 2048,
  };

  const PUB_FEATURE_LABELS = [
    [FLAGS.historic, "Historic pub"],
    [FLAGS.brewpub, "Brews its own"],
    [FLAGS.food, "Food"],
    [FLAGS.realAle, "Real ale"],
    [FLAGS.realCider, "Real cider"],
    [FLAGS.outdoor, "Outdoor seating"],
    [FLAGS.dog, "Dog friendly"],
    [FLAGS.liveMusic, "Live music"],
    [FLAGS.realFire, "Real fire"],
    [FLAGS.stepFree, "Step-free"],
    [FLAGS.partialAccess, "Partial access"],
  ];

  const CATEGORY_LABELS = {
    blue_plaque: "Plaques",
    museum: "Museums",
    historical: "Historical",
    cultural: "Cultural",
    architecture: "Architecture",
    natural: "Nature",
    garden: "Gardens",
    park: "Parks",
    scenic: "Viewpoints",
    art: "Art",
    literary: "Libraries",
    market: "Markets",
    science: "Zoos & aquariums",
    music: "Music venues",
    religious: "Religious",
    memorial: "Memorials",
    landmark: "Landmarks",
  };

  const CATEGORY_SINGULAR = {
    blue_plaque: "Plaque",
    museum: "Museum",
    historical: "Historic site",
    cultural: "Culture",
    architecture: "Architecture",
    natural: "Nature",
    garden: "Garden",
    park: "Park",
    scenic: "Viewpoint",
    art: "Art",
    literary: "Library",
    market: "Market",
    science: "Zoo / aquarium",
    music: "Music venue",
    religious: "Place of worship",
    memorial: "Memorial",
    landmark: "Landmark",
  };

  const SCENIC_CUES = ["park", "garden", "green", "common", "heath", "river", "canal", "square", "wharf", "quay"];
  const MAJOR_ROAD_CUES = [
    "high road",
    "high street",
    "commercial road",
    "old kent road",
    "new kent road",
    "city road",
    "euston road",
    "marylebone road",
    "edgware road",
    "holloway road",
    "camberwell road",
    "uxbridge road",
    "kingsland road",
    "piccadilly",
    "oxford street",
    "regent street",
    "strand",
    "bishopsgate",
    "embankment",
  ];

  // ------------------------------------------------------------------ data

  function fieldIndex(fields) {
    const index = {};
    fields.forEach((name, position) => {
      index[name] = position;
    });
    return index;
  }

  function decodeDataset(raw) {
    if (!raw || raw.schema !== 2 || !Array.isArray(raw.pubs) || !Array.isArray(raw.pois)) {
      throw new Error("Unsupported data format");
    }
    const categories = raw.categories || [];
    const pf = fieldIndex(raw.pub_fields);
    const qf = fieldIndex(raw.poi_fields);

    const pubs = raw.pubs.map((row) => ({
      kind: "pub",
      id: row[pf.id],
      title: row[pf.name],
      lat: row[pf.lat],
      lon: row[pf.lon],
      flags: row[pf.flags] || 0,
      address: row[pf.address] || "",
      hours: row[pf.hours] || "",
      website: row[pf.website] || "",
      phone: row[pf.phone] || "",
      brewery: row[pf.brewery] || "",
      cuisine: row[pf.cuisine] || "",
      brand: pf.brand == null ? "" : row[pf.brand] || "",
      wikipedia: pf.wikipedia == null ? "" : row[pf.wikipedia] || "",
      wikidata: pf.wikidata == null ? "" : row[pf.wikidata] || "",
      commons: pf.commons == null ? "" : row[pf.commons] || "",
      built: pf.built == null ? 0 : row[pf.built] || 0,
    }));

    const pois = raw.pois.map((row) => {
      const cats = (row[qf.cats] || []).map((index) => categories[index]).filter(Boolean);
      return {
        kind: "poi",
        id: row[qf.id],
        title: row[qf.name],
        lat: row[qf.lat],
        lon: row[qf.lon],
        score: row[qf.score] || 0,
        categories: cats.length ? cats : ["landmark"],
        primary: cats[0] || "landmark",
        address: row[qf.address] || "",
        description: row[qf.description] || "",
        website: row[qf.website] || "",
        wikipedia: row[qf.wikipedia] || "",
        wikidata: qf.wikidata == null ? "" : row[qf.wikidata] || "",
        fame: qf.fame == null ? 0 : row[qf.fame] || 0,
        commons: qf.commons == null ? "" : row[qf.commons] || "",
        built: qf.built == null ? 0 : row[qf.built] || 0,
      };
    });

    return {
      pubs,
      pois,
      categories,
      categoryCounts: raw.category_counts || {},
      dataFetchedAt: raw.data_fetched_at || "",
      builtAt: raw.built_at || "",
    };
  }

  // ------------------------------------------------------------------ geometry

  function toXY(place) {
    return { x: place.lon * METERS_PER_DEG_LON, y: place.lat * METERS_PER_DEG_LAT };
  }

  function pointDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Approximate distance in metres between two {lat, lon} points (accurate to <1% across London). */
  function distance(a, b) {
    const dx = (a.lon - b.lon) * METERS_PER_DEG_LON;
    const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function nearestPointOnSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return { t: 0, distance: pointDistance(point, start) };
    const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
    const t = Math.max(0, Math.min(1, rawT));
    return { t, distance: pointDistance(point, { x: start.x + dx * t, y: start.y + dy * t }) };
  }

  function pathLength(places, roundTrip) {
    let total = 0;
    for (let index = 0; index < places.length - 1; index += 1) {
      total += distance(places[index], places[index + 1]);
    }
    if (roundTrip && places.length > 1) total += distance(places[places.length - 1], places[0]);
    return total;
  }

  function straightLineEstimate(places) {
    const legs = [];
    for (let index = 0; index < places.length - 1; index += 1) {
      const meters = distance(places[index], places[index + 1]) * STRAIGHT_LINE_DETOUR;
      legs.push({ distance: meters, duration: meters / WALK_SPEED_MPS });
    }
    return {
      legs,
      distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
      duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
    };
  }

  // ------------------------------------------------------------------ randomness

  function hashSeed(value) {
    let hash = 2166136261;
    const text = String(value == null ? "42" : value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function random() {
      t += 0x6d2b79f5;
      let result = Math.imul(t ^ (t >>> 15), t | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createRng(seed) {
    return mulberry32(hashSeed(seed));
  }

  /** Weighted random order without replacement (Efraimidis–Spirakis). */
  function weightedOrder(items, rng, weightFn) {
    return items
      .map((item) => {
        const weight = Math.max(1e-6, weightFn(item));
        return { item, key: Math.pow(rng(), 1 / weight) };
      })
      .sort((a, b) => b.key - a.key)
      .map((entry) => entry.item);
  }

  // ------------------------------------------------------------------ pubs

  function hasFlag(pub, flag) {
    return Boolean(pub && pub.flags & flag);
  }

  function pubFeatures(pub) {
    return PUB_FEATURE_LABELS.filter(([flag]) => hasFlag(pub, flag)).map(([, label]) => label);
  }

  function pubMatchesRequirements(pub, options) {
    if (options.requireFood && !hasFlag(pub, FLAGS.food)) return false;
    if (options.requireStepFree && !hasFlag(pub, FLAGS.stepFree)) return false;
    return true;
  }

  function featureText(pub) {
    if (pub._text == null) {
      Object.defineProperty(pub, "_text", {
        value: [pub.title, pub.address, pub.brewery, pub.cuisine].join(" ").toLowerCase(),
        enumerable: false,
      });
    }
    return pub._text;
  }

  function metadataRichness(pub) {
    const keys = ["address", "hours", "website", "phone", "brewery", "cuisine"];
    let count = keys.reduce((sum, key) => sum + (pub[key] ? 1 : 0), 0);
    if (pub.flags) count += 1;
    return count;
  }

  function scenicCueScore(pub) {
    const text = featureText(pub);
    return SCENIC_CUES.reduce((score, cue) => score + (text.includes(cue) ? 60 : 0), 0);
  }

  function majorRoadPenalty(pub) {
    const text = featureText(pub);
    let penalty = MAJOR_ROAD_CUES.reduce((score, cue) => score + (text.includes(cue) ? 120 : 0), 0);
    if (/\ba\d{1,3}\b/.test(text)) penalty += 140;
    return penalty;
  }

  /** Bonus (in metres-equivalent) applied to a pub's placement score; higher is better. */
  function pubPreferenceBonus(pub, options) {
    let bonus = metadataRichness(pub) * 6;
    if (options.preferRealAle && hasFlag(pub, FLAGS.realAle)) bonus += 180;
    if (options.preferOutdoor && hasFlag(pub, FLAGS.outdoor)) bonus += 120;
    if (options.preferDog && hasFlag(pub, FLAGS.dog)) bonus += 160;
    if (options.preferHistoric && hasFlag(pub, FLAGS.historic)) bonus += 220;
    if (options.avoidChains && hasFlag(pub, FLAGS.chain)) bonus -= 260;
    if (options.favouredIds && options.favouredIds.length) {
      if (!options._favoured) Object.defineProperty(options, "_favoured", { value: new Set(options.favouredIds), enumerable: false });
      if (options._favoured.has(pub.id)) bonus += 450;
    }
    if (options.walkStyle === "quiet") {
      bonus += scenicCueScore(pub);
      bonus += metadataRichness(pub) * 8;
      if (hasFlag(pub, FLAGS.outdoor)) bonus += 80;
      bonus -= majorRoadPenalty(pub);
    }
    return bonus;
  }

  function mealCandidateScore(candidate, options, targetProgress) {
    const pub = candidate.feature;
    let score =
      candidate.distanceToPath +
      Math.abs(candidate.progress - targetProgress) * 0.7 -
      metadataRichness(pub) * 22 -
      scenicCueScore(pub);
    if (hasFlag(pub, FLAGS.outdoor)) score -= 90;
    if (hasFlag(pub, FLAGS.realAle)) score -= 35;
    if (options.walkStyle === "quiet") score += majorRoadPenalty(pub);
    return score;
  }

  // ------------------------------------------------------------------ ordering

  function permutations(values) {
    if (values.length <= 1) return [values.slice()];
    const result = [];
    values.forEach((value, index) => {
      const rest = values.slice(0, index).concat(values.slice(index + 1));
      permutations(rest).forEach((tail) => result.push([value].concat(tail)));
    });
    return result;
  }

  function nearestNeighbourOrder(places) {
    const ordered = [places[0]];
    const remaining = places.slice(1);
    while (remaining.length) {
      const current = ordered[ordered.length - 1];
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((candidate, index) => {
        const d = distance(current, candidate);
        if (d < bestDistance) {
          bestDistance = d;
          bestIndex = index;
        }
      });
      ordered.push(remaining.splice(bestIndex, 1)[0]);
    }
    return ordered;
  }

  /** 2-opt improvement keeping the first stop fixed. */
  function twoOpt(places, roundTrip) {
    let best = places.slice();
    let bestLength = pathLength(best, roundTrip);
    let improved = true;
    let guard = 0;
    while (improved && guard < 50) {
      improved = false;
      guard += 1;
      for (let i = 1; i < best.length - 1; i += 1) {
        for (let k = i + 1; k < best.length; k += 1) {
          const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          const length = pathLength(candidate, roundTrip);
          if (length + 0.01 < bestLength) {
            best = candidate;
            bestLength = length;
            improved = true;
          }
        }
      }
    }
    return best;
  }

  /** Order the must-visit stops. The first stop always stays first. */
  function orderAnchors(anchors, mode, roundTrip) {
    if (mode !== "optimize" || anchors.length <= 2) return anchors.slice();
    if (anchors.length <= MAX_EXACT_ORDER) {
      const start = anchors[0];
      let best = anchors.slice();
      let bestLength = Infinity;
      permutations(anchors.slice(1)).forEach((rest) => {
        const candidate = [start].concat(rest);
        const length = pathLength(candidate, roundTrip);
        if (length < bestLength) {
          bestLength = length;
          best = candidate;
        }
      });
      return best;
    }
    return twoOpt(nearestNeighbourOrder(anchors), roundTrip);
  }

  // ------------------------------------------------------------------ pub placement

  function analyzePubsAlongPath(anchors, pubs, options) {
    const maxDetour = options.maxDetourMeters;
    if (!anchors.length || !pubs.length) return [];

    if (anchors.length === 1) {
      const anchor = anchors[0];
      const result = [];
      pubs.forEach((pub) => {
        const d = distance(anchor, pub);
        if (d <= maxDetour) result.push({ feature: pub, segmentIndex: 0, progress: d, distanceToPath: d });
      });
      return result;
    }

    const pathPlaces = anchors.slice();
    if (options.roundTrip) pathPlaces.push(anchors[0]);
    const points = pathPlaces.map(toXY);
    const segmentLengths = [];
    const cumulative = [0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach((point) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });
    for (let index = 0; index < points.length - 1; index += 1) {
      const length = pointDistance(points[index], points[index + 1]);
      segmentLengths.push(length);
      cumulative.push(cumulative[cumulative.length - 1] + length);
    }

    const result = [];
    pubs.forEach((pub) => {
      const point = toXY(pub);
      if (
        point.x < minX - maxDetour ||
        point.x > maxX + maxDetour ||
        point.y < minY - maxDetour ||
        point.y > maxY + maxDetour
      ) {
        return;
      }
      let best = null;
      for (let index = 0; index < points.length - 1; index += 1) {
        const segment = nearestPointOnSegment(point, points[index], points[index + 1]);
        if (!best || segment.distance < best.distanceToPath) {
          best = {
            segmentIndex: index,
            progress: cumulative[index] + segmentLengths[index] * segment.t,
            distanceToPath: segment.distance,
          };
        }
      }
      if (best && best.distanceToPath <= maxDetour) result.push({ feature: pub, ...best });
    });
    return result;
  }

  function placementScore(candidate, options) {
    // jitter (seeded) and penalty (pubs from the previous version) make "another version" differ.
    return (
      candidate.distanceToPath -
      pubPreferenceBonus(candidate.feature, options) +
      (candidate.jitter || 0) +
      (candidate.penalty || 0)
    );
  }

  const RESHUFFLE_JITTER = 320;
  const RESHUFFLE_PENALTY = 450;

  function decorateCandidates(candidates, options) {
    const rng = options.seed != null ? createRng(`pubs:${options.seed}`) : null;
    const avoid = new Set(options.avoidIds || []);
    candidates.forEach((candidate) => {
      candidate.jitter = rng ? rng() * RESHUFFLE_JITTER : 0;
      candidate.penalty = avoid.has(candidate.feature.id) ? RESHUFFLE_PENALTY : 0;
    });
    return candidates;
  }

  /** Pick the pub to finish at: close to the last sight and not back the way you came. */
  function chooseFinalePub(ordered, pool, options, requireFood) {
    const last = ordered[ordered.length - 1];
    const prev = ordered.length > 1 ? ordered[ordered.length - 2] : null;
    const radius = Math.max(400, options.maxDetourMeters);
    const candidates = decorateCandidates(
      pool
        .filter((pub) => (!requireFood || hasFlag(pub, FLAGS.food)) && distance(last, pub) <= radius)
        .map((pub) => ({ feature: pub, segmentIndex: null, progress: null, distanceToPath: distance(last, pub) })),
      options
    );
    let best = null;
    let bestScore = Infinity;
    candidates.forEach((candidate) => {
      let score = placementScore(candidate, options) + candidate.distanceToPath * 0.3;
      if (prev && distance(prev, candidate.feature) < distance(prev, last)) score += 200;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    });
    return { finale: best, candidates };
  }

  function choosePubsAroundSingleStop(analyzed, options) {
    const chosen = [];
    const used = new Set();
    if (options.mealStop === "middle") {
      const target = analyzed.length ? analyzed.reduce((sum, item) => sum + item.progress, 0) / analyzed.length : 0;
      const meal = analyzed
        .filter((candidate) => hasFlag(candidate.feature, FLAGS.food))
        .sort((a, b) => mealCandidateScore(a, options, target) - mealCandidateScore(b, options, target))[0];
      if (!meal) return [];
      chosen.push({ ...meal, isMealStop: true });
      used.add(meal.feature.id);
    }
    analyzed
      .slice()
      .sort((a, b) => placementScore(a, options) - placementScore(b, options))
      .forEach((candidate) => {
        if (chosen.length >= options.pubCount || used.has(candidate.feature.id)) return;
        if (chosen.some((existing) => distance(existing.feature, candidate.feature) < 60)) return;
        chosen.push(candidate);
        used.add(candidate.feature.id);
      });
    return chosen;
  }

  function choosePubsAlongPath(anchors, analyzed, options) {
    if (options.pubCount <= 0 || !analyzed.length) return [];
    if (anchors.length === 1) return choosePubsAroundSingleStop(analyzed, options);

    const totalLength = pathLength(anchors, options.roundTrip);
    const chosen = [];
    const usedIds = new Set();
    const perSegment = new Map();

    function reserve(candidate, extra) {
      usedIds.add(candidate.feature.id);
      perSegment.set(candidate.segmentIndex, (perSegment.get(candidate.segmentIndex) || 0) + 1);
      chosen.push({ ...candidate, ...extra });
    }

    if (options.mealStop === "middle") {
      const target = totalLength / 2;
      const meal = analyzed
        .filter((candidate) => hasFlag(candidate.feature, FLAGS.food))
        .sort((a, b) => mealCandidateScore(a, options, target) - mealCandidateScore(b, options, target))[0];
      if (!meal) return [];
      reserve(meal, { isMealStop: true });
    }

    for (let slot = 1; slot <= options.pubCount && chosen.length < options.pubCount; slot += 1) {
      const targetProgress = totalLength * (slot / (options.pubCount + 1));
      let best = null;
      let bestScore = Infinity;
      analyzed.forEach((candidate) => {
        if (usedIds.has(candidate.feature.id)) return;
        if ((perSegment.get(candidate.segmentIndex) || 0) >= options.maxPubsPerGap) return;
        let spacingPenalty = 0;
        chosen.forEach((existing) => {
          if (Math.abs(existing.progress - candidate.progress) < 250) spacingPenalty += 220;
        });
        const score =
          placementScore(candidate, options) + Math.abs(candidate.progress - targetProgress) * 0.6 + spacingPenalty;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      });
      if (!best) break;
      reserve(best, {});
    }
    return chosen.sort((a, b) => a.progress - b.progress);
  }

  function makeStop(place, extra) {
    return {
      place,
      auto: Boolean(extra && extra.auto),
      mealStop: Boolean(extra && extra.mealStop),
      segmentIndex: extra && extra.segmentIndex != null ? extra.segmentIndex : null,
      progress: extra && extra.progress != null ? extra.progress : null,
    };
  }

  function candidateStop(candidate) {
    return makeStop(candidate.feature, {
      auto: true,
      mealStop: candidate.isMealStop,
      segmentIndex: candidate.segmentIndex,
      progress: candidate.progress,
    });
  }

  function buildStops(anchors, chosen, options) {
    if (!anchors.length) return [];
    if (anchors.length === 1) {
      const stops = [makeStop(anchors[0])];
      const remaining = chosen.slice();
      let current = anchors[0];
      while (remaining.length) {
        let bestIndex = 0;
        let bestDistance = Infinity;
        remaining.forEach((candidate, index) => {
          const d = distance(current, candidate.feature);
          if (d < bestDistance) {
            bestDistance = d;
            bestIndex = index;
          }
        });
        const next = remaining.splice(bestIndex, 1)[0];
        stops.push(candidateStop(next));
        current = next.feature;
      }
      if (options.roundTrip) stops.push(makeStop(anchors[0]));
      return stops;
    }

    const grouped = new Map();
    chosen.forEach((candidate) => {
      const bucket = grouped.get(candidate.segmentIndex) || [];
      bucket.push(candidate);
      grouped.set(candidate.segmentIndex, bucket);
    });
    grouped.forEach((bucket) => bucket.sort((a, b) => a.progress - b.progress));

    const stops = [makeStop(anchors[0])];
    const lastSegment = options.roundTrip ? anchors.length - 1 : anchors.length - 2;
    for (let segment = 0; segment <= lastSegment; segment += 1) {
      (grouped.get(segment) || []).forEach((candidate) => stops.push(candidateStop(candidate)));
      if (segment < anchors.length - 1) stops.push(makeStop(anchors[segment + 1]));
      else if (options.roundTrip) stops.push(makeStop(anchors[0]));
    }
    return stops;
  }

  function segmentCount(anchors, roundTrip) {
    if (anchors.length <= 1) return anchors.length;
    return anchors.length - 1 + (roundTrip ? 1 : 0);
  }

  /**
   * Plan a crawl through `anchors` (must-visit sights or pubs), inserting
   * `options.pubCount` extra pubs chosen from `pubPool` along the way.
   */
  function planRoute(anchors, pubPool, options) {
    if (!anchors.length) return { ok: false, error: "Choose at least one stop first." };
    if (anchors.length === 1 && options.pubCount === 0) {
      return { ok: false, error: "With only one stop chosen, add at least one pub stop or choose more stops." };
    }
    if (options.mealStop === "middle" && options.pubCount < 1) {
      return { ok: false, error: "A meal stop needs at least one pub stop." };
    }

    const ordered = orderAnchors(anchors, options.orderMode, options.roundTrip);
    const anchorIds = new Set(anchors.map((place) => place.id));
    let pool = pubPool.filter((pub) => !anchorIds.has(pub.id) && pubMatchesRequirements(pub, options));

    // Save one pub for the end, unless it's a loop or already finishes at a pub.
    let finale = null;
    let finaleCandidates = [];
    const wantsFinale =
      options.finish === "pub" &&
      !options.roundTrip &&
      options.pubCount > 0 &&
      ordered.length > 1 &&
      ordered[ordered.length - 1].kind !== "pub";
    if (wantsFinale) {
      const mealAtEnd = options.mealStop === "middle" && options.pubCount === 1;
      const result = chooseFinalePub(ordered, pool, options, mealAtEnd);
      finale = result.finale;
      finaleCandidates = result.candidates;
      if (finale) {
        finale.isMealStop = mealAtEnd;
        pool = pool.filter((pub) => pub.id !== finale.feature.id);
      }
    }
    const alongOptions = finale
      ? { ...options, pubCount: options.pubCount - 1, mealStop: finale.isMealStop ? "none" : options.mealStop }
      : options;

    if (ordered.length > 1) {
      const legs = segmentCount(ordered, options.roundTrip);
      const capacity = legs * options.maxPubsPerGap + (finale ? 1 : 0);
      if (options.pubCount > capacity) {
        return {
          ok: false,
          error: `${options.pubCount} pubs won't fit: ${legs} stretch${legs === 1 ? "" : "es"} between sights × ${options.maxPubsPerGap} pubs each allows ${capacity}. Raise "Max pubs between sights" or add more sights.`,
        };
      }
    }

    const analyzed =
      alongOptions.pubCount > 0 ? decorateCandidates(analyzePubsAlongPath(ordered, pool, alongOptions), options) : [];
    const chosen = choosePubsAlongPath(ordered, analyzed, alongOptions);
    if (chosen.length < alongOptions.pubCount) {
      const hint =
        alongOptions.mealStop === "middle" && !chosen.length
          ? "No food-serving pub was found near the route."
          : `Only ${chosen.length + (finale ? 1 : 0)} of ${options.pubCount} pubs could be placed.`;
      return {
        ok: false,
        error: `${hint} Try a larger pub detour, fewer requirements, or more pubs between sights.`,
      };
    }

    const stops = buildStops(ordered, chosen, options);
    if (finale) stops.push(makeStop(finale.feature, { auto: true, mealStop: finale.isMealStop }));
    const seen = new Set(analyzed.map((candidate) => candidate.feature.id));
    finaleCandidates.forEach((candidate) => {
      if (!seen.has(candidate.feature.id)) analyzed.push(candidate);
    });
    return { ok: true, stops, ordered, analyzed };
  }

  /** Best replacement for an auto-picked pub, or null. */
  function findSwapCandidate(analyzed, stop, excludedIds, options) {
    let best = null;
    let bestScore = Infinity;
    analyzed.forEach((candidate) => {
      if (excludedIds.has(candidate.feature.id)) return;
      if (stop.mealStop && !hasFlag(candidate.feature, FLAGS.food)) return;
      const sameSegment = stop.segmentIndex == null || candidate.segmentIndex === stop.segmentIndex;
      const progressGap =
        stop.progress == null ? distance(candidate.feature, stop.place) : Math.abs(candidate.progress - stop.progress);
      const score = placementScore(candidate, options) + progressGap * 0.6 + (sameSegment ? 0 : 600);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    });
    return best;
  }

  // ------------------------------------------------------------------ random crawls

  function sightWeight(poi) {
    const normalized = Math.max(0, Math.min(100, poi.score)) / 100;
    return 0.12 + normalized * normalized;
  }

  function pubWeight(pub) {
    return 1 + metadataRichness(pub);
  }

  function nearbyPool(pool, anchor, count, startRadius) {
    let radius = startRadius;
    let nearby = [];
    while (radius <= 6000) {
      nearby = pool.filter((place) => distance(anchor, place) <= radius);
      if (nearby.length >= count * 3) break;
      radius *= 1.5;
    }
    return nearby;
  }

  function spreadPick(ordered, picks, count, minSpacing, keyFn) {
    const seenKeys = new Set(picks.map(keyFn));
    const passes = [
      (place) => !seenKeys.has(keyFn(place)) && picks.every((pick) => distance(pick, place) >= minSpacing),
      (place) => picks.every((pick) => distance(pick, place) >= minSpacing),
      // Never the same building twice (some places are mapped under two names).
      (place) => picks.every((pick) => distance(pick, place) >= 25),
    ];
    passes.forEach((accept) => {
      ordered.forEach((place) => {
        if (picks.length >= count || picks.includes(place) || !accept(place)) return;
        picks.push(place);
        seenKeys.add(keyFn(place));
      });
    });
    return picks;
  }

  /**
   * Pick `count` interesting sights that are walkable together. When the pool is
   * already constrained to an area it is used as-is; otherwise sights are drawn
   * from around a randomly chosen (interest-weighted) starting sight.
   */
  function pickRandomSights(pool, count, rng, constrained) {
    if (count <= 0) return [];
    if (pool.length < count) return null;
    const anchor = weightedOrder(pool, rng, sightWeight)[0];
    const candidates = (constrained ? pool : nearbyPool(pool, anchor, count, 900)).filter((poi) => poi !== anchor);
    const ordered = weightedOrder(candidates, rng, sightWeight);
    const picks = spreadPick(ordered, [anchor], count, 60, (poi) => poi.primary);
    return picks.length >= count ? picks : null;
  }

  /** Pick `count` pubs for a pub-only crawl, spaced out so you actually walk between them. */
  function pickRandomPubs(pool, count, rng, constrained) {
    if (count <= 0) return [];
    if (pool.length < count) return null;
    const anchor = weightedOrder(pool, rng, pubWeight)[0];
    const candidates = (constrained ? pool : nearbyPool(pool, anchor, count, 700)).filter((pub) => pub !== anchor);
    const ordered = weightedOrder(candidates, rng, pubWeight);
    const picks = spreadPick(ordered, [anchor], count, 120, (pub) => pub.id);
    return picks.length >= count ? picks : null;
  }

  // ------------------------------------------------------------------ themed crawls

  // Each theme says *why* a place fits, so the app can show it.
  // Sights: keywords (word-bounded) in name/description/plaque, category, or period
  // (life spans, "built in" dates, OSM build date). Pubs: specific, curated rules
  // tested against "name | address" (never bare common names), or build date.
  const PERSON_PLAQUE = /\b(lived|born|died|worked|stayed|wrote|composed|founded)\b/;

  const THEMES = [
    {
      id: "victorian", name: "Victorian", icon: "🎩", years: [1837, 1901],
      blurb: "Gin palaces, railway engineers and the age of Dickens and Darwin.",
      keywords: /\b(victorian|gin palace|queen victoria|prince albert|great exhibition)\b/,
      pubs: [
        [/\bprincess louise\b/, "Famous Victorian gin palace (1872)"],
        [/\bmarble arch\b.*\|.*(\bm\d|\bmanchester$)/, "Victorian pub (1888) with a sloping mosaic floor and tiled ceiling"],
        [/\b(queen victoria|princess victoria)\b/, "Named after Queen Victoria"],
        [/\bprince albert\b/, "Named after Prince Albert"],
        [/\bprince alfred\b/, "Victorian pub with original snob screens"],
        [/\brailway (tavern|arms|inn|bell|hotel|telegraph)\b|\bgreat northern railway\b/, "A railway-age pub"],
        [/\bblackfriar\b.*\|.*queen victoria street/, "Arts & Crafts pub, remodelled 1905"],
      ],
      historicPubs: true,
    },
    {
      id: "georgian", name: "Georgian & Regency", icon: "🕯️", years: [1714, 1837],
      blurb: "Squares, coffee houses and the London of Hogarth and Jane Austen.",
      keywords: /\b(georgian|regency|hogarth|coffee house)\b/,
      pubs: [
        [/\bgeorge (ii|iii|iv)\b|\bprince regent\b/, "Named after a Georgian king"],
        [/\b(lord nelson|admiral nelson|duke of wellington|marquis of wellington|prince blucher)\b/, "Named after a hero of the Napoleonic wars"],
        [/\bgeorge and vulture\b/, "Georgian tavern Dickens wrote into Pickwick"],
        [/\bjamaica wine house\b/, "Site of London's first coffee house"],
      ],
      historicPubs: true,
    },
    {
      id: "stuart", name: "Great Fire & Wren", icon: "🔥", years: [1603, 1714],
      blurb: "Plague, the Great Fire of 1666 and the rebuilding of the City by Wren.",
      keywords: /\b(great fire|wren|stuart|plague|pepys|charles ii|james i)\b/,
      pubs: [
        [/\bye olde cheshire cheese\b/, "Rebuilt just after the Great Fire, 1667"],
        [/\bye olde starre\b/, "Licensed in 1644, during the Civil War siege of York"],
        [/\bye olde watling\b/, "Built by Wren in 1668 from ships' timbers"],
        [/\bking charles\b/, "Named after a Stuart king"],
        [/\b(samuel pepys|the pepys)\b/, "Named after diarist Samuel Pepys"],
        [/\bthe george inn\b|\bgeorge inn\b.*\|.*borough/, "London's last galleried coaching inn (1677)"],
        [/\bseven stars\b/, "Dates from 1602 and survived the Great Fire"],
      ],
      historicPubs: true,
    },
    {
      id: "tudor", name: "Tudor", icon: "👑", years: [1485, 1603],
      blurb: "Henry VIII, Anne Boleyn and half-timbered London.",
      keywords: /\b(tudor|henry viii|anne boleyn|wolsey|thomas more|thomas cromwell)\b/,
      pubs: [
        [/\bthe boleyn\b/, "Named after Anne Boleyn"],
        [/\bold wellington\b.*\|.*(\bm\d|\bmanchester$)/, "Timber-framed Tudor inn, moved 300 m in 1999 when the city centre was rebuilt"],
        [/\bguy fawkes\b.*\|.*(\byo\d|\byork$)/, "Birthplace of Guy Fawkes, born 1570"],
        [/\bking henry\b/, "Named after a Tudor king"],
        [/\bye olde mitre\b/, "Founded 1546 for the Bishop of Ely's servants"],
        [/\bprospect of whitby\b/, "Riverside tavern dating from around 1520"],
        [/\bmayflower\b.*\|.*rotherhithe/, "Rotherhithe inn with Tudor origins (c.1550)"],
        [/\bseven stars\b/, "Dates from 1602, the last year of Elizabeth I"],
      ],
      historicPubs: true,
    },
    {
      id: "elizabethan", name: "Elizabethan & Shakespeare", icon: "🎭", years: [1558, 1625],
      blurb: "Playhouses, Bankside and the world of Shakespeare and Marlowe.",
      keywords: /\b(elizabethan|elizabeth i|shakespeare|globe theatre|marlowe|jacobean|rose theatre|bankside)\b/,
      pubs: [
        [/\bshakespeare/, "Named after Shakespeare"],
        [/\bthe anchor\b.*\|.*bankside/, "Bankside tavern of Shakespeare's era"],
        [/\bswan at the globe\b/, "At Shakespeare's Globe"],
        [/\bseven stars\b/, "Dates from 1602, late Elizabethan"],
        [/\bmayflower\b.*\|.*rotherhithe/, "Elizabethan-era Rotherhithe inn"],
        [/\bprospect of whitby\b/, "Tudor riverside tavern (c.1520)"],
      ],
      historicPubs: true,
    },
    {
      id: "medieval", name: "Roman & Medieval", icon: "🏰", years: [43, 1484],
      blurb: "Londinium, the City wall, monks, knights and the oldest churches.",
      keywords: /\b(roman|londinium|medieval|norman (church|arch|conquest|chapel)|saxon|crusade[rs]?|templars?|city wall|priory|monastery|friary)\b/,
      pubs: [
        [/\bblack ?friar\b/, "Built on the site of a medieval Dominican friary"],
        [/\bcrutched friar\b/, "Named after the medieval Crutched Friars"],
        [/\bjerusalem tavern\b/, "Named after the Priory of St John (Knights Hospitaller)"],
        [/\bye olde mitre\b/, "In the grounds of the Bishops of Ely's medieval palace"],
        [/\bcittie of yorke\b/, "On the site of a pub dating from 1430"],
        [/\bblack swan\b.*\|.*(\byo\d|\byork$)/, "Timber-framed house dating from the 1400s"],
      ],
      historicPubs: true,
    },
    {
      id: "rock", name: "Rock, pop & punk", icon: "🎸",
      blurb: "Fifty years of British music, from 1950s Soho skiffle and the Beatles to punk, Camden and Britpop.",
      keywords: /\b(rock 'n' roll|rock and roll|rock star|rock band|punk|pop star|pop singer|pop group|beatles|bowie|ziggy|hendrix|rolling stones|sex pistols|the who|kinks|led zeppelin|pink floyd|marc bolan|freddie mercury|amy winehouse|the clash|britpop|abbey road (studios|crossing)|2i'?s|two i'?s|marquee|ufo club|skiffle|brian epstein|lennon|mccartney|hmv|recording studios?|guitarist|record shop|hammersmith palais|ray (&|and) dave davies)\b/,
      exclude: /rock garden|rockery|rock face/,
      pubs: [
        [/\bdublin castle\b/, "Camden gig pub where Madness made their name"],
        [/\bthe ship\b.*\|.*wardour street/, "Musicians' pub next to the old Marquee Club"],
        [/\bhope (&|and) anchor\b.*\|.*upper street/, "Punk venue: the Stranglers, Madness, Joy Division"],
        [/\bgood mixer\b/, "Camden Britpop haunt of Blur and Oasis"],
        [/\bhawley arms\b/, "Amy Winehouse's Camden local"],
        [/\bbull (&|and) gate\b/, "Kentish Town indie venue (early Blur, Coldplay)"],
        [/\bwater rats\b/, "Bob Dylan's first UK gig (1962) and Oasis's first London show"],
        [/\bold blue last\b/, "Shoreditch gig pub (Arctic Monkeys, Amy Winehouse)"],
        [/\bblack heart\b.*\|.*camden/, "Camden rock and metal bar"],
        [/\bhalf moon\b.*\|.*lower richmond/, "Putney venue where the Rolling Stones played"],
        [/\b(the lexington|shacklewell arms|nambucca|the macbeth|the boogaloo|george tavern)\b/, "Well-known live music pub"],
      ],
      pubFlags: [[32, "Has live music"]],
    },
    {
      id: "jazz", name: "Jazz, blues & folk", icon: "🎷",
      blurb: "Soho jazz cellars, the blues boom and London's folk clubs.",
      keywords: /\b(jazz|blues|folk (music|singer|song|club)|ronnie scott|100 club|reggae|calypso|gospel|bebop|bandleader|dance band|crooner|vera lynn)\b/,
      pubs: [
        [/\bspice of life\b/, "Soho pub with a jazz and folk basement since the 1960s"],
        [/\bbull'?s head\b.*\|.*lonsdale road/, "Barnes riverside pub, a jazz venue since 1959"],
        [/\bhalf moon\b.*\|.*lower richmond/, "Putney blues and folk venue"],
        [/\b(jazz|blues)\b/, "Jazz or blues in the name"],
      ],
      pubFlags: [[32, "Has live music"]],
    },
    {
      id: "classical", name: "Classical & opera", icon: "🎻", categories: [],
      blurb: "Concert halls, opera houses and the homes of Handel, Mozart and Holst.",
      keywords: /\b(composer|opera|orchestra|symphony|concert hall|conductor|pianist|violinist|cellist|organist|ballet|handel|mozart|haydn|elgar|holst|vaughan williams|mendelssohn|chopin|berlioz|wagner|purcell|britten|royal albert hall|wigmore hall|queen'?s hall|royal festival hall|sadler'?s wells)\b/,
      pubs: [
        [/\bnag'?s head\b.*\|.*james street/, "Opera-goers' pub beside the Royal Opera House"],
        [/\bthe chandos\b.*\|.*st\.? martin'?s lane/, "Next to English National Opera at the Coliseum"],
        [/\bcoal hole\b/, "Victorian song-and-supper club next to the Savoy"],
        [/\b(opera|organ|fiddle)\b/, "Music in the name"],
      ],
    },
    {
      id: "literary", name: "Literary London", icon: "📚", categories: ["literary"],
      blurb: "Poets, novelists and the pubs they drank in.",
      keywords: /\b(poet|novelist|writer|author|playwright|literary|essayist|keats|woolf|orwell|wilde|byron|dickens|bloomsbury group)\b/,
      pubs: [
        [/\bye olde cheshire cheese\b/, "Dr Johnson and Dickens drank here"],
        [/\bmuseum tavern\b/, "Karl Marx and Conan Doyle's local"],
        [/\bfitzroy tavern\b/, "Haunt of Dylan Thomas and George Orwell"],
        [/\bwheatsheaf\b.*\|.*rathbone/, "Dylan Thomas and Orwell's Fitzrovia pub"],
        [/\bthe lamb\b.*\|.*lamb'?s conduit/, "Dickens and Ted Hughes drank here"],
        [/\blamb (and|&) flag\b.*\|.*(rose street|covent garden)/, "Dickens's Covent Garden haunt"],
        [/\b(spaniards inn)\b/, "Keats, Dickens and Byron's Hampstead inn"],
        [/\bjack straw'?s castle\b|\bthe flask\b.*\|.*hampstead/, "Hampstead literary haunt"],
        [/\bdickens (inn|tavern)\b|\bkeats\b/, "Named after a great writer"],
        [/\beagle (and|&) child\b.*\|.*(\box\d|\boxford$)/, "The Inklings, Tolkien and C. S. Lewis, met here"],
        [/\bmilne'?s bar\b.*\|.*(\beh\d|\bedinburgh$)/, "The 'poets' pub' of Hugh MacDiarmid and Norman MacCaig"],
        [/\bthe oxford bar\b.*\|.*(\beh\d|\bedinburgh$)/, "Inspector Rebus's local in Ian Rankin's novels"],
        [/\bconan doyle\b.*\|.*(\beh\d|\bedinburgh$)/, "Named after Arthur Conan Doyle, born nearby"],
      ],
    },
    {
      id: "dickens", name: "Dickens's London", icon: "🖋️",
      blurb: "Follow Charles Dickens through the streets of his novels.",
      keywords: /\b(dickens|pickwick|oliver twist|marshalsea|copperfield|old curiosity|great expectations|fagin)\b/,
      pubs: [
        [/\bye olde cheshire cheese\b/, "One of Dickens's regular haunts"],
        [/\bgeorge inn\b/, "Mentioned in Little Dorrit"],
        [/\bthe grapes\b.*\|.*narrow street/, "Inspired the inn in Our Mutual Friend"],
        [/\bgeorge and vulture\b/, "Mr Pickwick's base in The Pickwick Papers"],
        [/\bspaniards inn\b/, "Appears in The Pickwick Papers"],
        [/\btrafalgar tavern\b/, "Scene of a wedding feast in Our Mutual Friend"],
        [/\bthe lamb\b.*\|.*lamb'?s conduit|\blamb (and|&) flag\b.*\|.*rose street/, "A Dickens local"],
        [/\bdickens (inn|tavern)\b/, "Named after Dickens"],
      ],
      historicPubs: true,
    },
    {
      id: "art", name: "Artists & galleries", icon: "🎨", categories: ["art"],
      blurb: "Galleries, studios and the homes of painters and sculptors.",
      keywords: /\b(painter|artist|sculptor|gallery|turner|hogarth|constable|pre-raphaelite|whistler)\b/,
      pubs: [
        [/\bhogarth\b/, "Named after William Hogarth"],
        [/\bturner'?s old star\b/, "Owned by J.M.W. Turner for his mistress"],
        [/\bfrench house\b/, "Soho haunt of Francis Bacon and Lucian Freud"],
        [/\bfitzroy tavern\b|\bwheatsheaf\b.*\|.*rathbone/, "Fitzrovia artists' pub (Augustus John)"],
        [/\bcolony room\b|\bchelsea arts\b/, "Artists' drinking den"],
      ],
    },
    {
      id: "science", name: "Science & invention", icon: "🔬", categories: ["science"],
      blurb: "Scientists, engineers and inventors who changed the world.",
      keywords: /\b(scientist|engineer|inventor|invented|physicist|chemist|astronomer|mathematician|naturalist|brunel|faraday|darwin|newton|telephone|television)\b/,
      pubs: [
        [/\b(railway telegraph|the engineer|the brunel|steam passage|the telegraph)\b/, "Named for the age of engineering"],
        [/\bthe sir isaac newton\b|\bnewton arms\b/, "Named after Isaac Newton"],
      ],
    },
    {
      id: "theatre", name: "Theatreland", icon: "🎟️",
      blurb: "Stages, music halls and the actors' pubs of the West End.",
      keywords: /\b(theatre|actor|actress|music hall|playhouse|pantomime|comedian)\b/,
      pubs: [
        [/\b(garrick|harlequin|nell gwynne?)\b/, "Named after a theatrical legend"],
        [/\bshakespeare/, "Named after Shakespeare"],
        [/\btheatre\b/, "Theatre pub with its own stage"],
        [/\bthe salisbury\b.*\|.*st\.? martin'?s lane/, "Ornate West End actors' pub"],
        [/\blamb (and|&) flag\b.*\|.*rose street/, "Covent Garden actors' pub"],
      ],
    },
    {
      id: "royal", name: "Royal London", icon: "👑",
      blurb: "Palaces, coronations and the pubs named after kings and queens.",
      keywords: /\b(royal|king|queen|palace|prince|princess|monarch|coronation|crown jewels)\b/,
      pubs: [[/\b(crown|kings?|queens?|prince|princess|royal|duke of (york|cambridge|edinburgh|kent|cornwall|clarence)|sceptre|throne)\b/, "Named after royalty"]],
    },
    {
      id: "maritime", name: "Maritime & Thames", icon: "⚓",
      blurb: "Docks, ships, explorers and riverside taverns.",
      keywords: /\b(maritime|ship|ships|naval|admiral|dock|docks|wharf|river|thames|sailor|navy|explorer|captain|lighthouse|cutty sark)\b/,
      pubs: [
        [/\b(prospect of whitby|mayflower|town of ramsgate|captain kidd)\b/, "Historic riverside pub"],
        [/\bthe grapes\b.*\|.*narrow street/, "Limehouse riverside tavern"],
        [/\b(trafalgar tavern|cutty sark)\b/, "Greenwich riverside pub"],
        [/\b(ship|anchor|mariner|sailor|admiral|captain|dock|wharf|ferry|waterman|barge|boat|compass)\b/, "Seafaring name"],
      ],
    },
    {
      id: "wartime", name: "World War II & the Blitz", icon: "✈️", years: [1939, 1945], eventsOnly: true,
      blurb: "The Blitz, the Battle of Britain, Churchill's bunker and Free French London.",
      keywords: /\b(blitz|second world war|world war ii|world war two|wwii|ww2|flying bomb|doodlebug|v-?1|v-?2 rockets?|air raids?|battle of britain|bomber command|spitfires?|churchill war rooms|cabinet war rooms|de gaulle|free french|home guard|kindertransport|evacuees?|bomb damage|air raid precautions|eagle squadron|international brigades?|dunkirk|d-day|special operations executive|soe agent|violette szabo)\b/,
      pubs: [
        [/\bfrench house\b/, "Free French HQ pub; de Gaulle is said to have written his 1940 appeal here"],
        [/\bchurchill arms\b/, "Named for Churchill and decked in wartime memorabilia"],
        [/\bchurchill/, "Named after Winston Churchill"],
      ],
    },
    {
      id: "crime", name: "Crime, ghosts & mystery", icon: "🔍",
      blurb: "Murders, gallows and gaols, highwaymen and pirates, unsolved cases and London's most haunted pubs.",
      keywords: /\b(murder|murdered|murders|ghost|ghosts|haunted|haunting|unsolved|mystery|executed|execution|executions|hanged|hanging|gallows|tyburn|ripper|kray|highwaym[ae]n|dick turpin|pirates?|smugglers?|smuggling|gunpowder plot|guy fawkes|body ?snatchers?|resurrection men|newgate|great train robbery|sweeney todd|plague pit|witch|witches|heist|robbery|assassinat\w*|poison\w*|prison|gaol|old bailey|the clink|beheaded|crime|sherlock|detective)\b/,
      exclude: /police (box|call ?box|station|museum)|callbox|ghost bike|ghost sign/,
      pubs: [
        [/\bten bells\b/, "Jack the Ripper's victims drank here in 1888"],
        [/\bgolden fleece\b.*\|.*(\byo\d|\byork$)/, "Said to be York's most haunted pub"],
        [/\bguy fawkes\b.*\|.*(\byo\d|\byork$)/, "Gunpowder plotter Guy Fawkes was born here in 1570"],
        [/\bblack swan\b.*\|.*(\byo\d|\byork$)/, "Medieval inn said to be haunted by several ghosts"],
        [/\bye olde starre\b/, "York's oldest licensed inn; its cellar was a Civil War hospital"],
        [/\bblind beggar\b/, "Ronnie Kray shot George Cornell at the bar in 1966"],
        [/\bcarpenters arms\b.*\|.*cheshire street/, "Bought by the Kray twins for their mother"],
        [/\bviaduct tavern\b/, "Its cellars are said to be old Newgate Prison cells, and it's reputedly haunted"],
        [/\bmagpie (&|and) stump\b/, "Crowds paid to watch Newgate hangings from its windows"],
        [/\bhung,? drawn (and|&) quartered\b/, "Named for the executions on nearby Tower Hill"],
        [/\bprospect of whitby\b/, "Smugglers' haunt by Execution Dock, with a noose hanging outside"],
        [/\btown of ramsgate\b/, "'Hanging Judge' Jeffreys was caught here in 1688"],
        [/\bcaptain kidd\b/, "Named after the pirate hanged at Execution Dock in 1701"],
        [/\bthe grenadier\b.*\|.*wilton row/, "Said to be London's most haunted pub: a ghostly officer killed for cheating at cards"],
        [/\bspaniards inn\b/, "Highwayman Dick Turpin is said to have hidden here"],
        [/\bthe flask\b.*\|.*highgate/, "Said to be haunted by a heartbroken Spanish barmaid"],
        [/\bold bank of england\b/, "Fleet Street legend puts Sweeney Todd's pie shop nearby"],
        [/\bmorpeth arms\b/, "Built for Millbank Prison guards; its cellars are said to be haunted cells"],
        [/\blamb (and|&) flag\b.*\|.*rose street/, "Nicknamed the 'Bucket of Blood' for its bare-knuckle fights"],
        [/\bship tavern\b.*\|.*gate street/, "Hid outlawed Catholic priests and secret masses"],
        [/\bold nun'?s head\b/, "Named after a legendary abbess executed under Henry VIII"],
        [/\bthe gun\b.*\|.*cold harbour/, "Riverside pub with a smugglers' spy-hole"],
        [/\bthe anchor\b.*\|.*bank end/, "Bankside tavern beside the old Clink prison"],
        [/\bsherlock holmes\b/, "Full of Sherlock Holmes memorabilia"],
        [/\bdeacon brodie'?s\b.*\|.*(\beh\d|\bedinburgh$)/, "Named after the councillor by day, burglar by night, hanged in 1788"],
        [/\bthe last drop\b.*\|.*(\beh\d|\bedinburgh$)/, "Named for the public hangings in the Grassmarket"],
      ],
    },
    {
      id: "politics", name: "Politics & protest", icon: "✊",
      blurb: "Prime ministers, suffragettes, radicals and reformers.",
      keywords: /\b(prime minister|politician|parliament|suffragette|suffragist|reformer|radical|activist|revolutionary|marx|chartist|campaigner|abolitionist)\b/,
      pubs: [
        [/\b(westminster arms|st\.? stephen'?s tavern)\b/, "Has a division bell for MPs"],
        [/\bred lion\b.*\|.*(whitehall|parliament street)/, "Whitehall pub of MPs and civil servants"],
        [/\bmuseum tavern\b/, "Karl Marx drank here"],
        [/\bbriton'?s protection\b.*\|.*(\bm\d|\bmanchester$)/, "Its murals tell the story of the 1819 Peterloo Massacre nearby"],
        [/\bturf tavern\b.*\|.*(\box\d|\boxford$)/, "Future Australian PM Bob Hawke downed a yard of ale here in 11 seconds"],
      ],
    },
    {
      id: "money", name: "Money, markets & merchants", icon: "💷",
      blurb: "The Bank of England, livery halls, old markets and the coffee houses where the City's fortunes began.",
      keywords: /\b(bank of england|royal exchange|stock exchange|lloyd'?s (of london|building|register)|coffee ?houses?|livery (hall|company)|worshipful company|guildhall|east india (company|house|dock)|royal mint|leadenhall market|smithfield|billingsgate (market|fish market)|spitalfields market|borough market|corn exchange|coal exchange|wool exchange|south sea|merchant adventurers|merchants?(?! navy| seam[ae]n| ships?\b)|bankers?|banking|economists?|financiers?|keynes|adam smith|ricardo|rothschild|goldsmiths'?|mercers'?|drapers'?|fishmongers'?|vintners'?|skinners'?|grocers'?|clothworkers'?|ironmongers'?|haberdashers'?|salters'?|custom ?house|stockbrokers?|hudson'?s bay)\b/,
      pubs: [
        [/\bjamaica wine house\b/, "On the site of London's first coffee house, opened in 1652"],
        [/\bold bank of england\b/, "Built in 1888 as the Bank of England's Law Courts branch"],
        [/\bsimpson'?s tavern\b/, "Chop house feeding City traders since 1757"],
        [/\bcounting house\b.*\|.*cornhill/, "In a grand Victorian banking hall"],
        [/\bcrosse keys\b.*\|.*gracechurch/, "In the former banking hall of the Hongkong and Shanghai Bank"],
        [/\bbarrowboy (&|and) banker\b/, "In an old bank building by London Bridge"],
        [/\bthe banker\b.*\|.*cousin lane/, "Named for the City bankers who drink there"],
        [/\blamb tavern\b.*\|.*leadenhall/, "Inside Leadenhall Market, trading since the 1300s"],
        [/\bmarket porter\b/, "Opens early for Borough Market's traders"],
        [/\bthe hope\b.*\|.*cowcross/, "Early licence for Smithfield meat market workers"],
        [/\bfox (&|and) anchor\b.*\|.*charterhouse/, "Smithfield market pub with an early licence"],
        [/\bhand (&|and) shears\b/, "Named for the cloth traders of Bartholomew Fair"],
        [/\beast india arms\b/, "Named for the East India Company, headquartered nearby"],
        [/\bleather exchange\b/, "In Bermondsey's old leather market"],
      ],
    },
    {
      id: "sacred", name: "Churches & cathedrals", icon: "⛪", categories: ["religious"], nameOnly: true,
      blurb: "Wren spires, cathedrals, synagogues and hidden chapels.",
      keywords: /\b(church|cathedral|abbey|chapel|synagogue|temple|mosque|priory)\b/,
      pubs: [
        [/\bblack ?friar\b/, "Built on a Dominican friary; monks in the decor"],
        [/\bye olde mitre\b/, "Built for the Bishop of Ely's household"],
        [/\b(bishops?|abbey|mitre|cross keys|friar|monk|vicar|parson)\b/, "Name with a church link"],
      ],
    },
    {
      id: "green", name: "Green London", icon: "🌳", categories: ["park", "garden", "natural", "scenic"], nameOnly: true,
      blurb: "Parks, gardens and views, with beer gardens in between.",
      keywords: /\b(park|garden|gardens|heath|common|viewpoint|nature reserve)\b/,
      pubs: [],
      pubFlags: [[4, "Has a beer garden or outdoor seating"]],
    },
  ];

  function themeById(id) {
    return THEMES.find((theme) => theme.id === id) || null;
  }

  function placeText(place) {
    if (place._themeText == null) {
      Object.defineProperty(place, "_themeText", {
        value: [place.title, place.description, place.wikipedia].join(" ").toLowerCase(),
        enumerable: false,
      });
    }
    return place._themeText;
  }

  // Dates that say when a place is "from", each with how we know.
  function placeDates(place) {
    if (place._dates == null) {
      const text = placeText(place);
      const dates = [];
      const spans = /\b(1[0-9]{3})\s*(?:-|–|—|to)\s*(1[0-9]{3}|20[0-2][0-9])\b/g;
      let match;
      while ((match = spans.exec(text))) {
        const from = Number(match[1]);
        const to = Number(match[2]);
        if (to >= from && to - from <= 110) {
          dates.push({ year: Math.round((from + to) / 2), label: PERSON_PLAQUE.test(text) ? `Life of someone who lived ${from}–${to}` : `Dates from ${from}–${to}` });
        }
      }
      const events = /\b(built|erected|founded|opened|rebuilt|completed|constructed|established|dates from|designed|consecrated)\b[^.\d]{0,25}(1[0-9]{3})\b/g;
      while ((match = events.exec(text))) dates.push({ year: Number(match[2]), label: `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}` });
      if (place.built) dates.push({ year: place.built, label: `Built ${place.built}` });
      Object.defineProperty(place, "_dates", { value: dates, enumerable: false });
    }
    return place._dates;
  }

  function eraReason(place, theme) {
    if (!theme.years) return "";
    if (theme.eventsOnly) {
      // Life spans say nothing about a war; look for "in 1941", "night of 10 May 1941"…
      const event = /\b(?:in|on|of|during|from|until|by|night of)\s+(?:\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\s+)?(19[0-9]{2})\b/g;
      let match;
      while ((match = event.exec(placeText(place)))) {
        const year = Number(match[1]);
        if (year >= theme.years[0] && year <= theme.years[1]) return `Wartime event, ${year}`;
      }
      return "";
    }
    const hit = placeDates(place).find((date) => date.year >= theme.years[0] && date.year <= theme.years[1]);
    return hit ? hit.label : "";
  }

  const THEME_EXCLUDE =
    /resource centre|community centre|leisure centre|housing|\bestate\b|school|library|church of christ,? scientist|christian science|car park|house of fraser|business centre/;

  function titleCase(word) {
    // "lloyd's of london" -> "Lloyd's of London" (no capital after an apostrophe; small words stay small)
    return word.replace(/(^|[\s-])(\w+)/g, (match, gap, part, offset) =>
      offset > 0 && /^(of|and|the|in|on|at|to|for)$/.test(part) ? match : gap + part[0].toUpperCase() + part.slice(1)
    );
  }

  /** Why a sight fits a theme ("" if it doesn't). */
  function themeSightReason(poi, theme) {
    if (!poi || poi.kind !== "poi" || THEME_EXCLUDE.test(poi.title.toLowerCase())) return "";
    if (theme.exclude && theme.exclude.test(placeText(poi))) return "";
    const categoryHit = (poi.categories || []).find((category) => (theme.categories || []).includes(category));
    if (theme.nameOnly) {
      if (poi.primary === "blue_plaque") return "";
      const nameHit = theme.keywords.exec(poi.title.toLowerCase());
      if (nameHit) return titleCase(nameHit[0]);
      return categoryHit ? CATEGORY_SINGULAR[categoryHit] || categoryLabel(categoryHit) : "";
    }
    const era = eraReason(poi, theme);
    if (era) return era;
    const keyword = theme.keywords.exec(placeText(poi));
    if (keyword) return `${poi.primary === "blue_plaque" ? "Plaque" : "Linked to"}: “${titleCase(keyword[0])}”`;
    return categoryHit ? CATEGORY_SINGULAR[categoryHit] || categoryLabel(categoryHit) : "";
  }

  // Stories that hold for any pub with the name, wherever it is.
  const NAME_ONLY_STORY =
    /^(Named after (Queen Victoria|Prince Albert|a Georgian king|a hero of the Napoleonic wars|a Stuart king|diarist Samuel Pepys|Anne Boleyn|a Tudor king|Shakespeare|a great writer|Dickens|William Hogarth|Isaac Newton|a theatrical legend|royalty|Winston Churchill|the pirate hanged)|Named for the age of engineering|Jazz or blues in the name|Music in the name|Seafaring name|Name with a church link)/;

  /** Why a pub fits a theme ("" if it doesn't). */
  function themePubReason(pub, theme) {
    if (!pub || pub.kind !== "pub") return "";
    const name = pub.title.toLowerCase();
    const withAddress = `${name} | ${(pub.address || "").toLowerCase()}`;
    // Only rules that name a specific street (they contain "|") look at the address.
    for (const [pattern, reason] of theme.pubs || []) {
      const guarded = pattern.source.includes("\\|");
      // Manchester's Seven Stars didn't survive London's Great Fire.
      if (!guarded && CURRENT_CITY !== "london" && !NAME_ONLY_STORY.test(reason)) continue;
      if (pattern.test(guarded ? withAddress : name)) return reason;
    }
    for (const [flag, reason] of theme.pubFlags || []) if (hasFlag(pub, flag)) return reason;
    if (theme.years && pub.built && pub.built >= theme.years[0] && pub.built <= theme.years[1]) return `Built ${pub.built}`;
    return "";
  }

  function themeMatchesSight(poi, theme) {
    return Boolean(themeSightReason(poi, theme));
  }

  function themeMatchesPub(pub, theme) {
    return Boolean(themePubReason(pub, theme));
  }

  function themeReason(place, theme) {
    return place.kind === "pub" ? themePubReason(place, theme) : themeSightReason(place, theme);
  }

  /**
   * Every theme link for a place, strongest first: curated pub stories and
   * sight links (keywords, dates). Plain category matches are left out.
   */
  function placeStories(place) {
    const stories = [];
    THEMES.forEach((theme) => {
      const reason = themeReason(place, theme);
      if (!reason) return;
      const curated = place.kind === "pub" && (theme.pubs || []).some(([, text]) => text === reason);
      const weak = place.kind === "poi" && !/[“:]|\d/.test(reason);
      if (weak) return;
      stories.push({ theme: theme.id, icon: theme.icon, name: theme.name, reason, curated });
    });
    return stories.sort((a, b) => Number(b.curated) - Number(a.curated));
  }

  /**
   * A walkable themed crawl anywhere in London: find a spot where enough on-theme
   * places sit within walking distance, then pick a varied set of them.
   * sightCount sights (or, with 0 sights, pubCount on-theme pubs as stops).
   */
  function pickThemedCrawl(theme, pois, pubs, sightCount, pubCount, rng, themedPubs) {
    const usePubs = sightCount <= 0;
    const want = usePubs ? Math.max(2, pubCount) : sightCount;
    const pool = usePubs
      ? pubs.filter((pub) => themeMatchesPub(pub, theme))
      : pois.filter((poi) => poi.score >= 30 && themeMatchesSight(poi, theme));
    if (pool.length < want) return null;
    const isPlaque = (place) => place.primary === "blue_plaque";
    // Plaques are rare in themed crawls: weighted right down, never the starting
    // point, and at most one per crawl.
    // Flat-ish weights so "Another version" really varies.
    // Themes with few non-plaque sights (rock, jazz…) lean on their plaques more.
    const nonPlaqueCount = pool.filter((place) => !isPlaque(place)).length;
    const plaqueWeight = nonPlaqueCount < 25 ? 0.6 : 0.08;
    const weight = usePubs
      ? (pub) => 1 + metadataRichness(pub) / 3
      : (poi) => (1 + poi.score / 100) * (isPlaque(poi) ? plaqueWeight : 1);
    const ordered = weightedOrder(pool, rng, weight);
    const nonPlaques = ordered.filter((place) => !isPlaque(place));
    // Plaque-heavy themes (e.g. jazz) may start from a plaque if they must.
    const starts = usePubs || nonPlaqueCount < 25 ? ordered : nonPlaques;
    const spacing = usePubs ? 120 : 90;
    // First try spots with an on-theme pub close by, then anywhere.
    const pubNear = (place) => (themedPubs || []).some((pub) => distance(place, pub) <= 800);
    const wantPub = !usePubs && pubCount > 0 && themedPubs && themedPubs.length > 0;
    // Gather a few good spots with an on-theme pub nearby and a few anywhere, then
    // usually (60%) go with a pub-rich one; this keeps "Another version" varied.
    const collect = (needPub) => {
      const found = [];
      const seen = new Set();
      for (const radius of [1200, 1800, 2600, 4000]) {
        for (let index = 0; index < Math.min(starts.length, 150) && found.length < 6; index += 1) {
          const anchor = starts[index];
          if (needPub && !pubNear(anchor)) continue;
          const near = ordered.filter((place) => place !== anchor && distance(anchor, place) <= radius);
          const main = usePubs ? near : near.filter((place) => !isPlaque(place));
          const picks = spreadPick(main, [anchor], want, spacing, (place) => (usePubs ? place.id : place.primary));
          if (!usePubs && picks.length < want) {
            // Top up with plaques: one normally, more only for plaque-heavy themes.
            const allowed = picks.length === want - 1 || nonPlaqueCount < 25;
            near
              .filter((place) => isPlaque(place) && !picks.includes(place))
              .forEach((place) => {
                if (picks.length < want && allowed && picks.every((pick) => distance(pick, place) >= spacing)) picks.push(place);
              });
          }
          if (picks.length < want) continue;
          const key = picks.map((place) => place.id).sort().join();
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(picks);
        }
        if (found.length) break;
      }
      return found;
    };
    const withPub = wantPub ? collect(true) : [];
    const anywhere = collect(false);
    const pool2 = withPub.length && (rng() < 0.6 || !anywhere.length) ? withPub : anywhere;
    return pool2.length ? pool2[Math.floor(rng() * pool2.length)] : null;
  }

  /** Pick and plan a themed crawl, trying a few spots in case one has no pubs nearby. */
  function generateThemedCrawl(theme, pois, pubs, sightCount, pubCount, seed, base) {
    const rng = createRng(`theme:${theme.id}:${seed}`);
    const options = themedOptions(theme, pubs, { ...base, pubCount: sightCount > 0 ? pubCount : 0, seed });
    const themedPubs = pubs.filter((pub) => themeMatchesPub(pub, theme) && pubMatchesRequirements(pub, options));
    let lastError = `Not enough ${theme.name.toLowerCase()} places to make that crawl. Try fewer stops.`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sights = pickThemedCrawl(theme, pois, pubs, sightCount, pubCount, rng, themedPubs);
      if (!sights) break;
      // On-theme pubs near the sights become must-visit stops (leaving one pub
      // slot so the crawl can still finish at a pub, which also favours theme pubs).
      let anchors = sights;
      let planOptions = options;
      if (sightCount > 0 && pubCount >= 2) {
        const nearby = themedPubs
          .map((pub) => ({ pub, gap: Math.min(...sights.map((sight) => distance(sight, pub))) }))
          .filter((entry) => entry.gap <= 700)
          .sort((a, b) => a.gap - b.gap)
          .map((entry) => entry.pub);
        const chosen = [];
        nearby.forEach((pub) => {
          if (chosen.length < pubCount - 1 && chosen.every((other) => distance(other, pub) >= 150)) chosen.push(pub);
        });
        anchors = sights.concat(chosen);
        planOptions = { ...options, pubCount: pubCount - chosen.length };
      }
      const plan = planRoute(anchors, pubs, planOptions);
      if (plan.ok) return { ok: true, anchors, plan, options };
      lastError = plan.error;
    }
    return { ok: false, error: lastError };
  }

  /** Planner options for a themed crawl: on-theme pubs are strongly favoured. */
  function themedOptions(theme, pubs, base) {
    return {
      ...base,
      favouredIds: pubs.filter((pub) => themeMatchesPub(pub, theme)).map((pub) => pub.id),
      preferHistoric: Boolean(theme.historicPubs) || base.preferHistoric,
      avoidChains: true,
      orderMode: "optimize",
      maxPubsPerGap: Math.max(base.maxPubsPerGap || 3, 4),
      maxDetourMeters: Math.max(base.maxDetourMeters || 0, 900),
    };
  }

  // ------------------------------------------------------------------ search

  function normalizeSearch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function createSearchIndex(places) {
    return places.map((place) => {
      const title = normalizeSearch(place.title);
      const extra =
        place.kind === "poi"
          ? [place.address, place.description, place.categories.map((c) => CATEGORY_LABELS[c] || c).join(" ")]
          : [place.address, place.brewery, place.brand, place.cuisine, "pub"];
      return { place, title, hay: `${title} ${normalizeSearch(extra.join(" "))}` };
    });
  }

  function search(index, query, limit) {
    const normalized = normalizeSearch(query);
    if (!normalized) return [];
    const tokens = normalized.split(" ");
    const matches = [];
    index.forEach((entry) => {
      if (!tokens.every((token) => entry.hay.includes(token))) return;
      let rank = 4;
      if (entry.title === normalized) rank = 0;
      else if (entry.title.startsWith(normalized)) rank = 1;
      else if (tokens.every((token) => entry.title.includes(token))) rank = 2;
      else if (tokens.some((token) => entry.title.includes(token))) rank = 3;
      const quality = entry.place.kind === "poi" ? entry.place.score : 55;
      matches.push({ entry, rank, quality });
    });
    matches.sort((a, b) => a.rank - b.rank || b.quality - a.quality || a.entry.title.length - b.entry.title.length);
    return matches.slice(0, limit || 8).map((match) => match.entry.place);
  }

  // ------------------------------------------------------------------ sharing & export

  const TOKEN_PATTERN = /^(p?[nwrd]|q)\d{1,15}$/;

  // Suffixes: "*" = auto-picked meal pub, "-" = auto-picked pub (can be swapped).
  function stopToken(stop) {
    if (stop.mealStop) return `${stop.place.id}*`;
    return stop.place.id + (stop.auto ? "-" : "");
  }

  function parseToken(token) {
    const suffix = /[*-]$/.exec(token);
    return {
      id: suffix ? token.slice(0, -1) : token,
      mealStop: Boolean(suffix && suffix[0] === "*"),
      auto: Boolean(suffix),
    };
  }

  function encodeShare(name, stops) {
    const params = new URLSearchParams();
    params.set("r", stops.map(stopToken).join("."));
    if (name) params.set("n", String(name).slice(0, 80));
    return params.toString();
  }

  /** Parse "r=pn1.n2*.q3&n=Name" (with or without a leading '#'). Returns null if invalid. */
  function decodeShare(fragment) {
    const text = String(fragment || "").replace(/^#/, "");
    if (!text) return null;
    const params = new URLSearchParams(text);
    const raw = params.get("r");
    if (!raw) return null;
    const tokens = raw
      .split(".")
      .slice(0, MAX_SHARED_STOPS)
      .map(parseToken)
      .filter((token) => TOKEN_PATTERN.test(token.id));
    if (!tokens.length) return null;
    return { name: (params.get("n") || "").slice(0, 80), tokens };
  }

  function xmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toGpx(name, stops, geometry) {
    const title = xmlEscape(name || "London crawl");
    const waypoints = stops
      .map(
        (stop, index) =>
          `  <wpt lat="${stop.place.lat}" lon="${stop.place.lon}"><name>${index + 1}. ${xmlEscape(stop.place.title)}</name>` +
          `<type>${stop.place.kind === "pub" ? "Pub" : "Sight"}</type></wpt>`
      )
      .join("\n");
    const coordinates =
      geometry && geometry.coordinates && geometry.coordinates.length
        ? geometry.coordinates
        : stops.map((stop) => [stop.place.lon, stop.place.lat]);
    const track = coordinates.map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"/>`).join("\n");
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="London Crawl Planner" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${title}</name></metadata>`,
      waypoints,
      `  <trk><name>${title}</name><trkseg>`,
      track,
      "  </trkseg></trk>",
      "</gpx>",
      "",
    ].join("\n");
  }

  const GOOGLE_MAX_WAYPOINTS = 9;

  function googleMapsUrl(stops) {
    const points = stops.map((stop) => `${stop.place.lat},${stop.place.lon}`);
    const params = new URLSearchParams({
      api: "1",
      travelmode: "walking",
      origin: points[0],
      destination: points[points.length - 1],
    });
    const middle = points.slice(1, -1);
    if (middle.length) params.set("waypoints", middle.slice(0, GOOGLE_MAX_WAYPOINTS).join("|"));
    return {
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
      truncated: middle.length > GOOGLE_MAX_WAYPOINTS,
    };
  }

  function directionsUrl(place) {
    const params = new URLSearchParams({ api: "1", travelmode: "walking", destination: `${place.lat},${place.lon}` });
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  // ------------------------------------------------------------------ photos (Wikimedia Commons)

  const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
  const SKIP_IMAGE = /\.(svg|pdf|tiff?|djvu|ogg|oga|webm|gif|mid)$|\b(map|plan|logo|diagram|coat of arms|signature|locator|floor)\b/i;
  const INTERIOR_IMAGE = /\b(interior|inside|saloon|snug|lounge|bar room|public bar|taproom|ceiling)\b/i;

  function commonsQuery(params) {
    const search = new URLSearchParams({
      action: "query",
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiurlwidth: "800",
      iiextmetadatafilter: "Artist|LicenseShortName",
      format: "json",
      origin: "*",
      ...params,
    });
    return `${COMMONS_API}?${search.toString()}`;
  }

  function commonsFilesUrl(titles) {
    return commonsQuery({ titles: titles.slice(0, 10).join("|") });
  }

  function commonsCategoryUrl(category) {
    return commonsQuery({ generator: "categorymembers", gcmtitle: category, gcmtype: "file", gcmlimit: "16" });
  }

  function wikidataClaimUrl(qid, property) {
    const params = new URLSearchParams({ action: "wbgetclaims", entity: qid, property, format: "json", origin: "*" });
    return `https://www.wikidata.org/w/api.php?${params.toString()}`;
  }

  function readWikidataClaim(json, property) {
    const claims = json && json.claims && json.claims[property];
    const snak = claims && claims[0] && claims[0].mainsnak;
    const value = snak && snak.datavalue && snak.datavalue.value;
    return typeof value === "string" ? value : "";
  }

  function plainText(html) {
    return String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Photos from a Commons API response, keeping only real photographs with credit details. */
  function parseCommonsImages(json) {
    const pages = json && json.query && json.query.pages;
    if (!pages) return [];
    return Object.keys(pages)
      .map((key) => pages[key])
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((page) => {
        const info = page.imageinfo && page.imageinfo[0];
        if (!info) return null;
        const title = String(page.title || "");
        const thumb = String(info.thumburl || "");
        if (SKIP_IMAGE.test(title) || !/^https:\/\/upload\.wikimedia\.org\//.test(thumb)) return null;
        const meta = info.extmetadata || {};
        const artist = plainText(meta.Artist && meta.Artist.value).slice(0, 80);
        const license = plainText(meta.LicenseShortName && meta.LicenseShortName.value);
        return {
          title,
          thumb,
          page: /^https:\/\/commons\.wikimedia\.org\//.test(info.descriptionurl || "") ? info.descriptionurl : "",
          credit: [artist, license].filter(Boolean).join(", "),
          interior: INTERIOR_IMAGE.test(title),
        };
      })
      .filter(Boolean);
  }

  /** "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo_bar.jpg/320px-Foo_bar.jpg" -> "File:Foo bar.jpg" */
  function commonsFileFromUrl(url) {
    const match = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/.exec(
      String(url || "")
    );
    if (!match) return "";
    try {
      return `File:${decodeURIComponent(match[1]).replace(/_/g, " ")}`;
    } catch (error) {
      return "";
    }
  }

  /** Compass bearing in degrees from a to b. */
  function bearing(a, b) {
    const dx = (b.lon - a.lon) * METERS_PER_DEG_LON;
    const dy = (b.lat - a.lat) * METERS_PER_DEG_LAT;
    return (Math.atan2(dx, dy) * 180) / Math.PI + (dx < 0 ? 360 : 0);
  }

  /**
   * Street-level photos (Mapillary API response) that look towards the place:
   * taken 5–45 m away with the camera pointing within 50° of it.
   */
  function pickFacingPhotos(json, place, limit) {
    const items = (json && Array.isArray(json.data) ? json.data : [])
      .map((item) => {
        const coords = item.computed_geometry && item.computed_geometry.coordinates;
        if (!coords || !/^https:\/\/[^/]+\.fbcdn\.net\//.test(item.thumb_1024_url || "")) return null;
        const from = { lat: coords[1], lon: coords[0] };
        const meters = distance(from, place);
        const offset = Math.abs((((bearing(from, place) - (item.computed_compass_angle || 0)) % 360) + 540) % 360 - 180);
        if (meters < 5 || meters > 45 || offset > 50) return null;
        return {
          thumb: item.thumb_1024_url,
          page: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(item.id)}`,
          credit: `${(item.creator && item.creator.username) || "Mapillary contributor"}, CC BY-SA 4.0`,
          source: "Mapillary",
          rank: offset + meters,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank);
    return items.slice(0, limit || 2);
  }

  /** Lead photo first, then up to two interior shots, then the rest. */
  function arrangePhotos(images, limit) {
    const seen = new Set();
    const unique = images.filter((image) => {
      if (seen.has(image.thumb)) return false;
      seen.add(image.thumb);
      return true;
    });
    if (!unique.length) return [];
    const [lead, ...rest] = unique;
    const interior = rest.filter((image) => image.interior);
    const others = rest.filter((image) => !image.interior);
    return [lead].concat(interior.slice(0, 2), others, interior.slice(2)).slice(0, limit || 6);
  }

  // ------------------------------------------------------------------ crawl of the day

  const DAILY_OPTIONS = {
    pubCount: 4,
    maxPubsPerGap: 4,
    orderMode: "optimize",
    walkStyle: "quiet",
    mealStop: "none",
    maxDetourMeters: 800,
    roundTrip: false,
    finish: "pub",
    requireFood: false,
    requireStepFree: false,
    preferHistoric: true,
    avoidChains: true,
    preferRealAle: true,
    preferOutdoor: false,
    preferDog: false,
  };

  function londonDateKey(date) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date || new Date());
    } catch (error) {
      return (date || new Date()).toISOString().slice(0, 10);
    }
  }

  function dayNumber(dateKey) {
    const [year, month, day] = String(dateKey).split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  const DAILY_CATEGORIES = new Set(["historical", "architecture", "religious", "museum", "cultural", "art", "garden", "scenic", "memorial"]);
  const DAILY_EXCLUDE =
    /\b(embassy|high commission|club|offices?|headquarters|hotel|school|college|university|hospital|station|studios?|centre|center|library|shop|market hall|bank|tower block|house of fraser|apartments?|flats|estate|sainsbury'?s?|tesco|waitrose|lidl|aldi|primark|pret|dungeon|madame tussauds|telephone (box|kiosk)|k6|arena|stadium)\b/i;
  // Weighting cap: famous places still feature, but the crawl isn't always Buckingham Palace.
  const FAME_CAP = 45;

  /** Historic, beautiful or culturally significant, and well documented. */
  function isQualitySight(poi, minScore) {
    // "23 and 25, Micklegate": an address-named listing isn't a headline sight.
    if (poi.primary === "blue_plaque" || poi.score < minScore || DAILY_EXCLUDE.test(poi.title) || /^\d/.test(poi.title)) return false;
    if (!poi.categories.some((category) => DAILY_CATEGORIES.has(category))) return false;
    return Boolean(poi.wikipedia || poi.wikidata || poi.fame >= 10);
  }

  /**
   * Today's crawl: the same for everyone on a given London date. It hinges on a
   * notable sight (plus a historic pub on alternate days) in an area of London
   * that changes daily, with two more quality sights nearby; planRoute adds the
   * pubs (4–5 in total, finishing at a pub).
   */
  function pickDailyCrawl(pois, pubs, dateKey, areas) {
    // Small cities have few headline sights: don't lean on yesterday's supporting sights again.
    const yesterday = dailyCrawlFor(pois, pubs, shiftDateKey(dateKey, -1), areas, new Set());
    return dailyCrawlFor(pois, pubs, dateKey, areas, new Set(yesterday ? yesterday.anchors.slice(1) : []));
  }

  function shiftDateKey(dateKey, days) {
    const date = new Date(`${dateKey}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function dailyCrawlFor(pois, pubs, dateKey, areas, avoid) {
    if (!areas || !areas.length) return null;
    const day = dayNumber(dateKey);
    const area = areas[((day % areas.length) + areas.length) % areas.length];
    const rng = createRng(`daily-v2:${dateKey}`);

    let heroes = [];
    for (const factor of [1, 1.5, 2.2, 3.5]) {
      heroes = pois.filter((poi) => isQualitySight(poi, 75) && poi.wikipedia && distance(area, poi) <= area.radius * factor);
      if (heroes.length >= 4) break;
    }
    if (!heroes.length) return null;
    heroes.sort((a, b) => b.fame - a.fame || b.score - a.score);
    const hero = weightedOrder(heroes.slice(0, 10), rng, (poi) => Math.min(poi.fame, FAME_CAP) + 5)[0];
    const anchors = [hero];

    const historicPubs = pubs
      .filter((pub) => hasFlag(pub, FLAGS.historic) && !hasFlag(pub, FLAGS.chain) && distance(hero, pub) <= 1400)
      .sort((a, b) => Number(Boolean(b.wikipedia || b.wikidata)) - Number(Boolean(a.wikipedia || a.wikidata)));
    const pubHero =
      day % 2 === 0 ? weightedOrder(historicPubs.slice(0, 6), rng, (pub) => (pub.wikipedia || pub.wikidata ? 3 : 1))[0] : null;
    if (pubHero) anchors.push(pubHero);

    let support = [];
    for (const radius of [1200, 1800, 2600]) {
      support = pois.filter(
        (poi) =>
          isQualitySight(poi, 65) &&
          (poi.wikipedia || poi.fame >= 15) &&
          poi !== hero &&
          !avoid.has(poi) &&
          distance(hero, poi) <= radius
      );
      if (support.length >= 4) break;
    }
    support = weightedOrder(support, rng, (poi) => Math.min(poi.fame, FAME_CAP) + poi.score / 4);
    const sightCount = () => anchors.filter((place) => place.kind === "poi").length;
    const categories = new Set([hero.primary]);
    const tooClose = (poi) => anchors.some((place) => distance(place, poi) < 180);
    const sightsWanted = rng() < 0.5 ? 3 : 4;
    support.forEach((poi) => {
      if (sightCount() >= sightsWanted || categories.has(poi.primary) || tooClose(poi)) return;
      anchors.push(poi);
      categories.add(poi.primary);
    });
    support.forEach((poi) => {
      if (sightCount() >= sightsWanted || anchors.includes(poi) || tooClose(poi)) return;
      anchors.push(poi);
    });

    const totalPubs = 4 + Math.floor(rng() * 3); // 4–6
    return {
      dateKey,
      area,
      hero,
      pubHero: pubHero || null,
      anchors,
      title: pubHero ? `${hero.title} & ${pubHero.title}` : hero.title,
      // A pub hero counts towards the total.
      options: { ...DAILY_OPTIONS, pubCount: totalPubs - (pubHero ? 1 : 0), seed: `daily-v2:${dateKey}` },
    };
  }

  // ------------------------------------------------------------------ formatting & links

  function formatDistance(meters) {
    if (meters == null || !Number.isFinite(meters)) return "–";
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 10) * 10} m`;
  }

  function formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "–";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }

  function safeUrl(value) {
    const text = String(value || "").trim().split(/[\s;]+/)[0];
    if (/^https?:\/\//i.test(text)) return text;
    if (/^www\.[^\s]+\.[a-z]{2,}/i.test(text)) return `https://${text}`;
    return "";
  }

  function sourceUrl(place) {
    const match = /^p?([nwrqd])(\d+)$/.exec(place.id || "");
    if (!match) return "";
    if (match[1] === "q") return `https://openplaques.org/plaques/${match[2]}`;
    if (match[1] === "d") return `https://www.wikidata.org/wiki/Q${match[2]}`;
    const type = { n: "node", w: "way", r: "relation" }[match[1]];
    return `https://www.openstreetmap.org/${type}/${match[2]}`;
  }

  /** "en:Tower of London" -> { lang: "en", title: "Tower of London" } */
  function parseWikipedia(value) {
    const match = /^([a-z][a-z-]{1,11}):(.+)$/i.exec(String(value || "").trim());
    if (!match) return null;
    return { lang: match[1].toLowerCase(), title: match[2].trim() };
  }

  function wikiPath(title) {
    return encodeURIComponent(title.replace(/ /g, "_"));
  }

  function wikipediaUrl(value) {
    const wiki = parseWikipedia(value);
    return wiki ? `https://${wiki.lang}.wikipedia.org/wiki/${wikiPath(wiki.title)}` : "";
  }

  function wikipediaSummaryUrl(wiki) {
    return `https://${wiki.lang}.wikipedia.org/api/rest_v1/page/summary/${wikiPath(wiki.title)}?redirect=true`;
  }

  function wikidataSitelinkUrl(qid, lang) {
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: qid,
      props: "sitelinks",
      sitefilter: `${lang || "en"}wiki`,
      format: "json",
      origin: "*",
    });
    return `https://www.wikidata.org/w/api.php?${params.toString()}`;
  }

  /** Reduce a Wikipedia REST summary to the fields we show, validating URLs. */
  function summarizeWikipedia(summary) {
    if (!summary || summary.type === "disambiguation" || !summary.extract) return null;
    const thumb = summary.thumbnail && summary.thumbnail.source;
    const page = summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page;
    return {
      title: String(summary.title || ""),
      description: String(summary.description || ""),
      extract: String(summary.extract || ""),
      image: /^https:\/\/upload\.wikimedia\.org\//.test(thumb || "") ? thumb : "",
      qid: /^Q\d+$/.test(summary.wikibase_item || "") ? summary.wikibase_item : "",
      url: /^https:\/\/[a-z-]+\.(m\.)?wikipedia\.org\//.test(page || "") ? page : "",
    };
  }

  function categoryLabel(category) {
    return CATEGORY_LABELS[category] || category.replace(/_/g, " ");
  }

  function categorySingular(category) {
    return CATEGORY_SINGULAR[category] || categoryLabel(category);
  }

  return {
    FLAGS,
    CATEGORY_LABELS,
    decodeDataset,
    setReferenceLatitude,
    setCity,
    distance,
    pathLength,
    straightLineEstimate,
    createRng,
    hashSeed,
    weightedOrder,
    hasFlag,
    pubFeatures,
    pubMatchesRequirements,
    pubPreferenceBonus,
    orderAnchors,
    twoOpt,
    analyzePubsAlongPath,
    planRoute,
    findSwapCandidate,
    pickRandomSights,
    pickRandomPubs,
    normalizeSearch,
    createSearchIndex,
    search,
    stopToken,
    parseToken,
    encodeShare,
    decodeShare,
    toGpx,
    googleMapsUrl,
    directionsUrl,
    formatDistance,
    formatDuration,
    commonsFilesUrl,
    commonsCategoryUrl,
    wikidataClaimUrl,
    readWikidataClaim,
    parseCommonsImages,
    arrangePhotos,
    commonsFileFromUrl,
    bearing,
    pickFacingPhotos,
    londonDateKey,
    dayNumber,
    pickDailyCrawl,
    THEMES,
    themeById,
    themeMatchesSight,
    themeMatchesPub,
    themeReason,
    placeStories,
    pickThemedCrawl,
    generateThemedCrawl,
    themedOptions,
    isQualitySight,
    safeUrl,
    sourceUrl,
    wikipediaUrl,
    parseWikipedia,
    wikipediaSummaryUrl,
    wikidataSitelinkUrl,
    summarizeWikipedia,
    categoryLabel,
    categorySingular,
  };
});
