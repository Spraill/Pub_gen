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

  const REF_LAT = 51.509865;
  const METERS_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180);
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
      () => true,
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

  const TOKEN_PATTERN = /^(p?[nwr]|q)\d{1,15}$/;

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

  // Ordered so consecutive days hop between different parts of London.
  const DAILY_AREAS = [
    { name: "the City", region: "City", lat: 51.5136, lon: -0.0925, radius: 900 },
    { name: "the West End", region: "West End", lat: 51.5125, lon: -0.133, radius: 900 },
    { name: "Shoreditch & Spitalfields", region: "East", lat: 51.5235, lon: -0.076, radius: 1000 },
    { name: "Camden & Primrose Hill", region: "North", lat: 51.5395, lon: -0.146, radius: 1100 },
    { name: "the South Bank & Borough", region: "South", lat: 51.505, lon: -0.096, radius: 1000 },
    { name: "Kensington & Chelsea", region: "West", lat: 51.4965, lon: -0.172, radius: 1200 },
    { name: "Fleet Street & Temple", region: "City", lat: 51.5135, lon: -0.109, radius: 800 },
    { name: "Greenwich", region: "South East", lat: 51.481, lon: -0.005, radius: 1100 },
    { name: "Hampstead", region: "North", lat: 51.5565, lon: -0.177, radius: 1200 },
    { name: "Westminster", region: "Central", lat: 51.5005, lon: -0.13, radius: 1000 },
    { name: "Wapping & Limehouse", region: "East", lat: 51.507, lon: -0.054, radius: 1300 },
    { name: "Bloomsbury & Holborn", region: "Central", lat: 51.5195, lon: -0.123, radius: 900 },
    { name: "Notting Hill & Bayswater", region: "West", lat: 51.512, lon: -0.196, radius: 1100 },
    { name: "Islington & Clerkenwell", region: "North", lat: 51.528, lon: -0.103, radius: 1100 },
    { name: "Bermondsey & Rotherhithe", region: "South", lat: 51.4995, lon: -0.066, radius: 1200 },
    { name: "Marylebone", region: "West End", lat: 51.52, lon: -0.153, radius: 1000 },
    { name: "Hackney & Victoria Park", region: "East", lat: 51.538, lon: -0.048, radius: 1400 },
    { name: "Richmond", region: "South West", lat: 51.4605, lon: -0.304, radius: 1300 },
    { name: "Covent Garden & the Strand", region: "West End", lat: 51.5115, lon: -0.122, radius: 800 },
    { name: "Hammersmith & Chiswick", region: "West", lat: 51.4895, lon: -0.24, radius: 1500 },
  ];

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
    /\b(embassy|high commission|club|offices?|headquarters|hotel|school|college|university|hospital|station|studios?|centre|center|library|shop|market hall|bank|tower block|house of fraser|apartments?|flats|estate|sainsbury'?s?|tesco|waitrose|lidl|aldi|primark|pret)\b/i;
  // Weighting cap: famous places still feature, but the crawl isn't always Buckingham Palace.
  const FAME_CAP = 45;

  /** Historic, beautiful or culturally significant, and well documented. */
  function isQualitySight(poi, minScore) {
    if (poi.primary === "blue_plaque" || poi.score < minScore || DAILY_EXCLUDE.test(poi.title)) return false;
    if (!poi.categories.some((category) => DAILY_CATEGORIES.has(category))) return false;
    return Boolean(poi.wikipedia || poi.wikidata || poi.fame >= 10);
  }

  /**
   * Today's crawl: the same for everyone on a given London date. It hinges on a
   * notable sight (plus a historic pub on alternate days) in an area of London
   * that changes daily, with two more quality sights nearby; planRoute adds the
   * pubs (4–5 in total, finishing at a pub).
   */
  function pickDailyCrawl(pois, pubs, dateKey) {
    const day = dayNumber(dateKey);
    const area = DAILY_AREAS[((day % DAILY_AREAS.length) + DAILY_AREAS.length) % DAILY_AREAS.length];
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
          isQualitySight(poi, 65) && (poi.wikipedia || poi.fame >= 15) && poi !== hero && distance(hero, poi) <= radius
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
    const match = /^p?([nwrq])(\d+)$/.exec(place.id || "");
    if (!match) return "";
    if (match[1] === "q") return `https://openplaques.org/plaques/${match[2]}`;
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
    DAILY_AREAS,
    londonDateKey,
    dayNumber,
    pickDailyCrawl,
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
