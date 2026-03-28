(async function () {
  const DEFAULT_CENTER = [51.509865, -0.118092];
  const DEFAULT_ZOOM = 11;
  const ROUTER_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/";

  const state = {
    pubs: [],
    pois: [],
    meta: null,
    selectedPoiIds: [],
    routePubIds: new Set(),
    routeStops: [],
    activeTab: "guided",
    poiMarkers: new Map(),
    pubMarkers: new Map(),
    filteredPois: [],
    filteredPoiIds: new Set(),
    randomCenter: { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1] },
    randomRadiusMeters: 1200,
    randomAreaEnabled: false,
    randomAreaDrag: null,
    ignoreNextRandomMapClick: false,
  };

  const els = {
    introPoiCount: document.getElementById("intro-poi-count"),
    introPubCount: document.getElementById("intro-pub-count"),
    poiSearchInput: document.getElementById("poi-search-input"),
    scoreThresholdInput: document.getElementById("score-threshold-input"),
    scoreThresholdOutput: document.getElementById("score-threshold-output"),
    showPoisInput: document.getElementById("show-pois-input"),
    showPubsInput: document.getElementById("show-pubs-input"),
    categoryFilterList: document.getElementById("category-filter-list"),
    selectAllCategoriesButton: document.getElementById("select-all-categories-button"),
    clearAllCategoriesButton: document.getElementById("clear-all-categories-button"),
    tabGuided: document.getElementById("tab-guided"),
    tabRandom: document.getElementById("tab-random"),
    panelGuided: document.getElementById("panel-guided"),
    panelRandom: document.getElementById("panel-random"),
    selectedPoisEmpty: document.getElementById("selected-pois-empty"),
    selectedPoisList: document.getElementById("selected-pois-list"),
    generateGuidedButton: document.getElementById("generate-guided-button"),
    clearSelectionButton: document.getElementById("clear-selection-button"),
    enableRandomAreaInput: document.getElementById("enable-random-area-input"),
    randomAreaControls: document.getElementById("random-area-controls"),
    randomRadiusInput: document.getElementById("random-radius-input"),
    randomRadiusOutput: document.getElementById("random-radius-output"),
    randomPoiCountInput: document.getElementById("random-poi-count-input"),
    randomSeedInput: document.getElementById("random-seed-input"),
    setAreaFromCenterButton: document.getElementById("set-area-from-center-button"),
    generateRandomButton: document.getElementById("generate-random-button"),
    randomAreaStatus: document.getElementById("random-area-status"),
    pubCountInput: document.getElementById("pub-count-input"),
    maxPubsPerGapInput: document.getElementById("max-pubs-per-gap-input"),
    poiOrderInput: document.getElementById("poi-order-input"),
    walkingStyleInput: document.getElementById("walking-style-input"),
    mealStopInput: document.getElementById("meal-stop-input"),
    pubDetourInput: document.getElementById("pub-detour-input"),
    pubDetourOutput: document.getElementById("pub-detour-output"),
    roundTripInput: document.getElementById("round-trip-input"),
    requireFoodInput: document.getElementById("require-food-input"),
    preferRealAleInput: document.getElementById("prefer-real-ale-input"),
    preferOutdoorInput: document.getElementById("prefer-outdoor-input"),
    clearRouteButton: document.getElementById("clear-route-button"),
    summaryPois: document.getElementById("summary-pois"),
    summaryPubs: document.getElementById("summary-pubs"),
    summaryDistance: document.getElementById("summary-distance"),
    summaryDuration: document.getElementById("summary-duration"),
    plannerStatus: document.getElementById("planner-status"),
    routeEmpty: document.getElementById("route-empty"),
    routeStopList: document.getElementById("route-stop-list"),
    plannerShell: document.querySelector(".planner-shell"),
    mobileOpenButton: document.getElementById("mobile-open-button"),
    mobileCollapseButton: document.getElementById("mobile-collapse-button"),
  };

  const map = L.map("map", {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    minZoom: 10,
    preferCanvas: true,
  });

  const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  function createPointLayer(options) {
    if (typeof L.markerClusterGroup === "function") {
      return L.markerClusterGroup(options);
    }
    console.warn("Leaflet.markercluster was unavailable. Falling back to plain map layers.");
    return L.layerGroup();
  }

  const poiClusterLayer = createPointLayer({
    showCoverageOnHover: false,
    maxClusterRadius: 40,
    chunkedLoading: true,
    chunkInterval: 120,
    chunkDelay: 16,
  });
  const pubClusterLayer = createPointLayer({
    showCoverageOnHover: false,
    maxClusterRadius: 40,
    chunkedLoading: true,
    chunkInterval: 120,
    chunkDelay: 16,
  });

  const routeOutlineLayer = L.geoJSON(null, {
    style: { color: "#ffffff", weight: 9, opacity: 0.82, lineJoin: "round" },
  }).addTo(map);
  const routeLineLayer = L.geoJSON(null, {
    style: { color: "#253050", weight: 5, opacity: 0.94, lineJoin: "round" },
  }).addTo(map);

  const randomCircleLayer = L.circle(DEFAULT_CENTER, {
    radius: state.randomRadiusMeters,
    color: "#cf2f45",
    weight: 2,
    fillColor: "#cf2f45",
    fillOpacity: 0.08,
  }).addTo(map);

  const randomCenterMarker = L.marker(DEFAULT_CENTER, {
    draggable: true,
    icon: makeMarkerIcon("#cf2f45", "#81202b", "R", true),
    title: "Random crawl area centre",
  }).addTo(map);

  map.addLayer(poiClusterLayer);
  map.addLayer(pubClusterLayer);

  function makeMarkerIcon(fill, stroke, label, square) {
    const outer = square
      ? `<rect x="5" y="3" width="20" height="20" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="2"></rect><path d="M15 39L9 23H21L15 39Z" fill="${fill}" stroke="${stroke}" stroke-width="2"></path>`
      : `<path d="M15 40 C15 40 3 26 3 15 C3 7.2 9.2 1 15 1 C20.8 1 27 7.2 27 15 C27 26 15 40 15 40 Z" fill="${fill}" stroke="${stroke}" stroke-width="2"></path>`;
    const badge = square
      ? '<circle cx="15" cy="13" r="6.6" fill="white"></circle>'
      : '<circle cx="15" cy="15" r="7.6" fill="white"></circle>';
    const textY = square ? 15.6 : 18.2;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
        ${outer}
        ${badge}
        <text x="15" y="${textY}" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" font-weight="700" fill="${stroke}">${label}</text>
      </svg>`;
    return L.icon({
      iconUrl: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      iconSize: [30, 42],
      iconAnchor: [15, 40],
      popupAnchor: [0, -34],
    });
  }

  const icons = {
    pub: makeMarkerIcon("#1858c9", "#0f387d", "P", false),
    pubActive: makeMarkerIcon("#0c7b57", "#0a503a", "P", false),
    poi: makeMarkerIcon("#d85b04", "#922f00", "I", true),
    poiActive: makeMarkerIcon("#12815f", "#0d573f", "I", true),
  };

  const CATEGORY_LABELS = {
    blue_plaque: "Blue Plaques",
    museum: "Museums",
    historical: "Historical",
    cultural: "Cultural",
    architecture: "Architecture",
    natural: "Natural",
    garden: "Gardens",
    park: "Parks",
    scenic: "Scenic",
    landmark: "Landmarks",
    art: "Art",
    literary: "Literary",
  };

  const categorySelection = new Set();

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function toXY(lat, lon) {
    const scaleX = 111320 * Math.cos(DEFAULT_CENTER[0] * Math.PI / 180);
    const scaleY = 110540;
    return { x: lon * scaleX, y: lat * scaleY };
  }

  function pointDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function featureDistance(a, b) {
    return pointDistance(toXY(a.lat, a.lon), toXY(b.lat, b.lon));
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function formatDistance(meters) {
    if (meters == null || Number.isNaN(meters)) return "-";
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  }

  function formatDuration(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return "-";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${minutes % 60} min`;
  }

  function truthy(value) {
    const normalized = normalizeText(value);
    return ["yes", "true", "1", "designated", "limited", "permissive"].includes(normalized);
  }

  function hashSeed(value) {
    let hash = 2166136261;
    const text = String(value || "42");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let result = Math.imul(t ^ (t >>> 15), t | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(array, seedValue) {
    const random = mulberry32(hashSeed(seedValue));
    const copy = array.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  }

  function setStatus(message, tone = "") {
    els.plannerStatus.textContent = message;
    els.plannerStatus.className = "status-box" + (tone ? ` ${tone}` : "");
  }

  function currentFilters() {
    return {
      search: normalizeText(els.poiSearchInput.value),
      scoreThreshold: Number.parseInt(els.scoreThresholdInput.value || "25", 10) || 0,
      showPois: els.showPoisInput.checked,
      showPubs: els.showPubsInput.checked,
      categories: new Set(categorySelection),
    };
  }

  function currentRouteOptions() {
    return {
      pubCount: Math.max(0, Number.parseInt(els.pubCountInput.value || "0", 10) || 0),
      maxPubsPerGap: Math.max(0, Number.parseInt(els.maxPubsPerGapInput.value || "0", 10) || 0),
      orderMode: els.poiOrderInput.value,
      walkStyle: els.walkingStyleInput.value,
      mealStop: els.mealStopInput.value,
      maxDetourMeters: Number.parseInt(els.pubDetourInput.value || "1200", 10) || 1200,
      roundTrip: els.roundTripInput.checked,
      requireFood: els.requireFoodInput.checked,
      preferRealAle: els.preferRealAleInput.checked,
      preferOutdoor: els.preferOutdoorInput.checked,
    };
  }

  function visibleRandomArea() {
    return state.activeTab === "random" && state.randomAreaEnabled;
  }

  function renderCategoryFilters() {
    const counts = state.meta.category_counts || {};
    els.categoryFilterList.innerHTML = state.meta.categories.map((category) => `
      <label class="category-chip">
        <input type="checkbox" data-category="${escapeHtml(category)}" checked>
        <span>${escapeHtml(CATEGORY_LABELS[category] || category)}</span>
        <span class="count">${counts[category] || 0}</span>
      </label>
    `).join("");
    state.meta.categories.forEach((category) => categorySelection.add(category));
  }

  function syncCategoryCheckboxes() {
    els.categoryFilterList.querySelectorAll("input[data-category]").forEach((input) => {
      const category = input.getAttribute("data-category");
      input.checked = categorySelection.has(category);
    });
  }

  function buildPoiPopup(poi) {
    const selected = state.selectedPoiIds.includes(poi.id);
    const buttonLabel = selected ? "Remove from crawl" : "Add to crawl";
    const categoryText = poi.categories.map((category) => CATEGORY_LABELS[category] || category).join(", ");
    return `
      <div class="popup-toolbar">
        <button class="poi-action" data-action="toggle-poi" data-id="${escapeHtml(poi.id)}">${buttonLabel}</button>
      </div>
      <h3>${escapeHtml(poi.title)}</h3>
      <div class="poi-score">Interest score ${poi.interest_score}</div>
      <div class="popup-line"><strong>Type:</strong>${escapeHtml(categoryText)}</div>
      ${poi.address ? `<div class="popup-line"><strong>Address:</strong>${escapeHtml(poi.address)}</div>` : ""}
      ${poi.description ? `<div class="popup-line">${escapeHtml(poi.description)}</div>` : ""}
      ${poi.website ? `<div class="popup-line"><strong>Website:</strong> <a href="${escapeHtml(poi.website)}" target="_blank" rel="noopener">${escapeHtml(poi.website)}</a></div>` : ""}
      ${poi.source_url ? `<div class="popup-line"><strong>Source:</strong> <a href="${escapeHtml(poi.source_url)}" target="_blank" rel="noopener">Open source</a></div>` : ""}
    `;
  }

  function buildPubPopup(pub) {
    return `
      <div class="popup-toolbar">
        <button class="pub-action" data-action="focus-pub" data-id="${escapeHtml(pub.id)}">Focus pub</button>
      </div>
      <h3>${escapeHtml(pub.title)}</h3>
      <div class="popup-line"><strong>Pub</strong></div>
      ${pub.address ? `<div class="popup-line"><strong>Address:</strong>${escapeHtml(pub.address)}</div>` : ""}
      ${pub.opening_hours ? `<div class="popup-line"><strong>Opening hours:</strong>${escapeHtml(pub.opening_hours)}</div>` : ""}
      ${pub.cuisine ? `<div class="popup-line"><strong>Cuisine:</strong>${escapeHtml(pub.cuisine)}</div>` : ""}
      ${pub.website ? `<div class="popup-line"><strong>Website:</strong> <a href="${escapeHtml(pub.website)}" target="_blank" rel="noopener">${escapeHtml(pub.website)}</a></div>` : ""}
      ${pub.source_url ? `<div class="popup-line"><strong>Source:</strong> <a href="${escapeHtml(pub.source_url)}" target="_blank" rel="noopener">OpenStreetMap</a></div>` : ""}
    `;
  }

  function createMarkers() {
    state.pubs.forEach((pub) => {
      const marker = L.marker([pub.lat, pub.lon], {
        icon: icons.pub,
        title: pub.title,
      }).bindPopup(buildPubPopup(pub), { maxWidth: 340 });
      state.pubMarkers.set(pub.id, marker);
    });

    state.pois.forEach((poi) => {
      const marker = L.marker([poi.lat, poi.lon], {
        icon: icons.poi,
        title: poi.title,
      }).bindPopup(buildPoiPopup(poi), { maxWidth: 340 });
      state.poiMarkers.set(poi.id, marker);
    });
  }

  function applyMarkerStyles() {
    state.pubs.forEach((pub) => {
      const marker = state.pubMarkers.get(pub.id);
      if (marker) {
        marker.setIcon(state.routePubIds.has(pub.id) ? icons.pubActive : icons.pub);
      }
    });
    state.pois.forEach((poi) => {
      const marker = state.poiMarkers.get(poi.id);
      if (marker) {
        marker.setIcon(state.selectedPoiIds.includes(poi.id) ? icons.poiActive : icons.poi);
        marker.setPopupContent(buildPoiPopup(poi));
      }
    });
  }

  function poiMatchesFilters(poi, filters) {
    if (poi.interest_score < filters.scoreThreshold) return false;
    if (!filters.categories.size) return false;
    const categoryHit = poi.categories.some((category) => filters.categories.has(category));
    if (!categoryHit) return false;
    if (filters.search) {
      const haystack = [
        poi.title,
        poi.description,
        poi.address,
        ...(poi.categories || []),
      ].join(" ").toLowerCase();
      if (!haystack.includes(filters.search)) return false;
    }
    return true;
  }

  function refreshVisibleMarkers() {
    const filters = currentFilters();
    state.filteredPois = state.pois.filter((poi) => poiMatchesFilters(poi, filters));
    state.filteredPoiIds = new Set(state.filteredPois.map((poi) => poi.id));

    poiClusterLayer.clearLayers();
    pubClusterLayer.clearLayers();

    if (filters.showPois) {
      state.filteredPois.forEach((poi) => {
        const marker = state.poiMarkers.get(poi.id);
        if (marker) poiClusterLayer.addLayer(marker);
      });
    }

    if (filters.showPubs) {
      state.pubs.forEach((pub) => {
        const marker = state.pubMarkers.get(pub.id);
        if (marker) pubClusterLayer.addLayer(marker);
      });
    }

    updateRandomAreaStatus();
  }

  function refreshSelectedPoiList() {
    const selectedPois = state.selectedPoiIds
      .map((id) => state.pois.find((poi) => poi.id === id))
      .filter(Boolean);

    els.summaryPois.textContent = String(selectedPois.length);
    els.selectedPoisEmpty.style.display = selectedPois.length ? "none" : "block";
    els.selectedPoisList.innerHTML = selectedPois.map((poi, index) => `
      <li class="list-item">
        <div class="list-item-main">
          <div>
            <div class="list-title">${index + 1}. ${escapeHtml(poi.title)}</div>
            <div class="list-meta">${escapeHtml(poi.address || (poi.categories || []).join(", "))}</div>
          </div>
          <span class="pill poi">${escapeHtml(CATEGORY_LABELS[poi.primary_category] || poi.primary_category)}</span>
        </div>
        <div class="list-actions">
          <button class="mini-button" data-action="focus-poi" data-id="${escapeHtml(poi.id)}">Focus</button>
          <button class="mini-button" data-action="move-poi-up" data-id="${escapeHtml(poi.id)}">Up</button>
          <button class="mini-button" data-action="move-poi-down" data-id="${escapeHtml(poi.id)}">Down</button>
          <button class="mini-button" data-action="remove-poi" data-id="${escapeHtml(poi.id)}">Remove</button>
        </div>
      </li>
    `).join("");
  }

  function refreshRouteStops() {
    els.routeEmpty.style.display = state.routeStops.length ? "none" : "block";
    els.routeStopList.innerHTML = state.routeStops.map((stop, index) => `
      <li class="list-item">
        <div class="list-item-main">
          <div>
            <div class="list-title">${index + 1}. ${escapeHtml(stop.title)}</div>
            <div class="list-meta">${escapeHtml(stop.address || "")}</div>
          </div>
          <span class="pill ${stop.kind === "pub" ? "pub" : "poi"}">${stop.mealStop ? "Meal stop" : (stop.kind === "pub" ? "Pub" : "POI")}</span>
        </div>
        <div class="list-actions">
          <button class="mini-button" data-action="focus-stop" data-id="${escapeHtml(stop.id)}" data-kind="${escapeHtml(stop.kind)}">Focus</button>
        </div>
      </li>
    `).join("");
  }

  function setActiveTab(tabName) {
    state.activeTab = tabName;
    els.tabGuided.classList.toggle("active", tabName === "guided");
    els.tabRandom.classList.toggle("active", tabName === "random");
    els.panelGuided.classList.toggle("active", tabName === "guided");
    els.panelRandom.classList.toggle("active", tabName === "random");
    updateRandomAreaUi();
  }

  function nearestPointOnSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) {
      return { t: 0, projected: start, distance: pointDistance(point, start) };
    }
    const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
    const t = Math.max(0, Math.min(1, rawT));
    const projected = { x: start.x + dx * t, y: start.y + dy * t };
    return { t, projected, distance: pointDistance(point, projected) };
  }

  function permutations(values) {
    if (values.length <= 1) return [values.slice()];
    const result = [];
    values.forEach((value, index) => {
      const rest = values.slice(0, index).concat(values.slice(index + 1));
      permutations(rest).forEach((tail) => result.push([value].concat(tail)));
    });
    return result;
  }

  function pathLength(stops, roundTrip) {
    if (stops.length <= 1) return 0;
    let total = 0;
    for (let index = 0; index < stops.length - 1; index += 1) {
      total += featureDistance(stops[index], stops[index + 1]);
    }
    if (roundTrip) total += featureDistance(stops[stops.length - 1], stops[0]);
    return total;
  }

  function optimizePoiOrder(pois, mode, roundTrip) {
    if (mode === "selected" || pois.length <= 2) return pois.slice();
    const start = pois[0];
    const rest = pois.slice(1);
    if (pois.length <= 8) {
      let best = pois.slice();
      let bestLength = Infinity;
      permutations(rest).forEach((candidateRest) => {
        const candidate = [start].concat(candidateRest);
        const length = pathLength(candidate, roundTrip);
        if (length < bestLength) {
          bestLength = length;
          best = candidate;
        }
      });
      return best;
    }
    const ordered = [start];
    const remaining = rest.slice();
    while (remaining.length) {
      const current = ordered[ordered.length - 1];
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((candidate, index) => {
        const distance = featureDistance(current, candidate);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      ordered.push(remaining.splice(bestIndex, 1)[0]);
    }
    return ordered;
  }

  function segmentCountForPlan(pois, options) {
    if (!pois.length) return 0;
    if (pois.length === 1) return 1;
    return (pois.length - 1) + (options.roundTrip ? 1 : 0);
  }

  function featureText(feature) {
    return [
      feature.title,
      feature.address,
      feature.operator,
      feature.brewery,
      feature.cuisine,
    ].join(" ").toLowerCase();
  }

  function metadataRichnessScore(pub) {
    const keys = ["address", "opening_hours", "website", "phone", "operator", "brewery", "cuisine"];
    return keys.reduce((score, key) => score + (String(pub[key] || "").trim() ? 1 : 0), 0) * 22;
  }

  function scenicCueScore(pub) {
    const text = featureText(pub);
    const cues = ["park", "garden", "green", "common", "heath", "river", "canal", "square", "wharf", "quay"];
    return cues.reduce((score, cue) => score + (text.includes(cue) ? 60 : 0), 0);
  }

  function majorRoadPenalty(pub) {
    const text = featureText(pub);
    const strongSignals = [
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
    let penalty = strongSignals.reduce((score, cue) => score + (text.includes(cue) ? 120 : 0), 0);
    if (/\ba\d{1,3}\b/.test(text)) penalty += 140;
    return penalty;
  }

  function scorePubPreferences(pub, options) {
    let bonus = 0;
    if (options.preferRealAle && truthy(pub.real_ale)) bonus += 180;
    if (options.preferOutdoor && truthy(pub.outdoor_seating)) bonus += 120;
    if (options.walkStyle === "quiet") {
      bonus += scenicCueScore(pub);
      bonus += metadataRichnessScore(pub) * 0.35;
      if (truthy(pub.outdoor_seating)) bonus += 80;
      bonus -= majorRoadPenalty(pub);
    }
    return bonus;
  }

  function mealCandidateScore(candidate, options, targetProgress) {
    let score =
      candidate.distanceToPath +
      Math.abs(candidate.progress - targetProgress) * 0.7 -
      metadataRichnessScore(candidate.feature) -
      scenicCueScore(candidate.feature);
    if (truthy(candidate.feature.outdoor_seating)) score -= 90;
    if (truthy(candidate.feature.real_ale)) score -= 35;
    if (options.walkStyle === "quiet") score += majorRoadPenalty(candidate.feature);
    return score;
  }

  function filterPubCandidates(options) {
    return state.pubs.filter((pub) => {
      if (options.requireFood && !truthy(pub.food)) return false;
      return true;
    });
  }

  function analyzePubsAlongPath(orderedPois, options) {
    const pubs = filterPubCandidates(options);
    if (!pubs.length) return [];

    if (orderedPois.length === 1) {
      const anchor = toXY(orderedPois[0].lat, orderedPois[0].lon);
      return pubs.map((pub) => {
        const point = toXY(pub.lat, pub.lon);
        const distance = pointDistance(anchor, point);
        return { feature: pub, segmentIndex: 0, progress: distance, distanceToPath: distance };
      }).filter((candidate) => candidate.distanceToPath <= options.maxDetourMeters);
    }

    const pathPois = orderedPois.slice();
    if (options.roundTrip) pathPois.push(orderedPois[0]);
    const points = pathPois.map((poi) => toXY(poi.lat, poi.lon));
    const segmentLengths = [];
    const cumulative = [0];
    for (let index = 0; index < points.length - 1; index += 1) {
      const length = pointDistance(points[index], points[index + 1]);
      segmentLengths.push(length);
      cumulative.push(cumulative[cumulative.length - 1] + length);
    }

    return pubs.map((pub) => {
      const point = toXY(pub.lat, pub.lon);
      let best = { segmentIndex: 0, progress: 0, distanceToPath: Infinity };
      for (let index = 0; index < points.length - 1; index += 1) {
        const segment = nearestPointOnSegment(point, points[index], points[index + 1]);
        if (segment.distance < best.distanceToPath) {
          best = {
            segmentIndex: index,
            progress: cumulative[index] + segmentLengths[index] * segment.t,
            distanceToPath: segment.distance,
          };
        }
      }
      return { feature: pub, ...best };
    }).filter((candidate) => candidate.distanceToPath <= options.maxDetourMeters);
  }

  function choosePubsForSinglePoi(orderedPois, options) {
    const analyzed = analyzePubsAlongPath(orderedPois, options);
    const chosen = [];
    const used = new Set();
    const limit = Math.min(options.pubCount, options.maxPubsPerGap);
    const targetProgress = analyzed.length ? analyzed.reduce((sum, item) => sum + item.progress, 0) / analyzed.length : 0;

    if (options.mealStop === "middle") {
      const mealCandidates = analyzed.filter((candidate) => truthy(candidate.feature.food));
      mealCandidates.sort((a, b) => mealCandidateScore(a, options, targetProgress) - mealCandidateScore(b, options, targetProgress));
      if (!mealCandidates.length) return [];
      chosen.push({ ...mealCandidates[0], isMealStop: true });
      used.add(mealCandidates[0].feature.id);
    }

    analyzed.sort((a, b) => (a.distanceToPath - scorePubPreferences(a.feature, options)) - (b.distanceToPath - scorePubPreferences(b.feature, options)));
    analyzed.forEach((candidate) => {
      if (chosen.length >= limit) return;
      if (used.has(candidate.feature.id)) return;
      chosen.push(candidate);
      used.add(candidate.feature.id);
    });
    return chosen;
  }

  function choosePubsAlongOrderedPath(orderedPois, options) {
    if (options.pubCount <= 0) return [];
    if (orderedPois.length === 1) return choosePubsForSinglePoi(orderedPois, options);

    const analyzed = analyzePubsAlongPath(orderedPois, options);
    if (!analyzed.length) return [];
    const totalLength = pathLength(orderedPois, options.roundTrip);
    const chosen = [];
    const usedIds = new Set();
    const perSegmentCounts = new Map();

    function reserveCandidate(candidate, extra = {}) {
      usedIds.add(candidate.feature.id);
      perSegmentCounts.set(candidate.segmentIndex, (perSegmentCounts.get(candidate.segmentIndex) || 0) + 1);
      chosen.push({ ...candidate, ...extra });
    }

    if (options.mealStop === "middle") {
      const mealCandidates = analyzed
        .filter((candidate) => truthy(candidate.feature.food))
        .sort((a, b) => mealCandidateScore(a, options, totalLength / 2) - mealCandidateScore(b, options, totalLength / 2));
      if (!mealCandidates.length) return [];
      reserveCandidate(mealCandidates[0], { isMealStop: true });
    }

    for (let slot = 1; slot <= options.pubCount; slot += 1) {
      if (chosen.length >= options.pubCount) break;
      const targetProgress = totalLength > 0 ? totalLength * (slot / (options.pubCount + 1)) : 0;
      let bestCandidate = null;
      let bestScore = Infinity;
      analyzed.forEach((candidate) => {
        if (usedIds.has(candidate.feature.id)) return;
        if ((perSegmentCounts.get(candidate.segmentIndex) || 0) >= options.maxPubsPerGap) return;
        const spacingPenalty = chosen.reduce((penalty, existing) => penalty + (Math.abs(existing.progress - candidate.progress) < 250 ? 220 : 0), 0);
        const score =
          candidate.distanceToPath +
          Math.abs(candidate.progress - targetProgress) * 0.6 +
          spacingPenalty -
          scorePubPreferences(candidate.feature, options);
        if (score < bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      });
      if (!bestCandidate) break;
      reserveCandidate(bestCandidate);
    }

    return chosen.sort((a, b) => a.progress - b.progress);
  }

  function buildStopOrder(orderedPois, chosenPubCandidates, options) {
    if (!orderedPois.length) return [];
    if (orderedPois.length === 1) {
      const remaining = chosenPubCandidates.map((candidate) => ({ ...candidate.feature, kind: "pub", mealStop: Boolean(candidate.isMealStop) }));
      const ordered = [{ ...orderedPois[0], kind: "poi" }];
      let current = orderedPois[0];
      while (remaining.length) {
        let bestIndex = 0;
        let bestDistance = Infinity;
        remaining.forEach((pub, index) => {
          const distance = featureDistance(current, pub);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        });
        current = remaining.splice(bestIndex, 1)[0];
        ordered.push(current);
      }
      if (options.roundTrip) ordered.push({ ...orderedPois[0], kind: "poi" });
      return ordered;
    }

    const grouped = new Map();
    chosenPubCandidates.forEach((candidate) => {
      const bucket = grouped.get(candidate.segmentIndex) || [];
      bucket.push(candidate);
      grouped.set(candidate.segmentIndex, bucket);
    });
    grouped.forEach((bucket) => bucket.sort((a, b) => a.progress - b.progress));

    const stops = [{ ...orderedPois[0], kind: "poi" }];
    const lastSegmentIndex = options.roundTrip ? orderedPois.length - 1 : orderedPois.length - 2;
    for (let segmentIndex = 0; segmentIndex <= lastSegmentIndex; segmentIndex += 1) {
      const pubsOnSegment = grouped.get(segmentIndex) || [];
      pubsOnSegment.forEach((candidate) => {
        stops.push({ ...candidate.feature, kind: "pub", mealStop: Boolean(candidate.isMealStop) });
      });
      if (segmentIndex < orderedPois.length - 1) {
        stops.push({ ...orderedPois[segmentIndex + 1], kind: "poi" });
      } else if (options.roundTrip) {
        stops.push({ ...orderedPois[0], kind: "poi" });
      }
    }
    return stops;
  }

  async function fetchWalkingRoute(stops) {
    if (stops.length < 2) {
      return { geometry: null, distance: 0, duration: 0, mode: "none" };
    }
    const coordinates = stops.map((stop) => `${stop.lon},${stop.lat}`).join(";");
    const url = `${ROUTER_URL}${coordinates}?overview=full&geometries=geojson&steps=false`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Routing service returned ${response.status}`);
      const data = await response.json();
      const route = data.routes && data.routes[0];
      if (!route || !route.geometry) throw new Error("No walking route returned");
      return { geometry: route.geometry, distance: route.distance, duration: route.duration, mode: "router" };
    } catch (error) {
      let distance = 0;
      for (let index = 0; index < stops.length - 1; index += 1) {
        distance += featureDistance(stops[index], stops[index + 1]);
      }
      return {
        geometry: { type: "LineString", coordinates: stops.map((stop) => [stop.lon, stop.lat]) },
        distance,
        duration: distance / 1.35,
        mode: "fallback",
        error: error.message,
      };
    }
  }

  function clearRoute() {
    state.routePubIds = new Set();
    state.routeStops = [];
    routeOutlineLayer.clearLayers();
    routeLineLayer.clearLayers();
    els.summaryPubs.textContent = "0";
    els.summaryDistance.textContent = "-";
    els.summaryDuration.textContent = "-";
    refreshRouteStops();
    applyMarkerStyles();
  }

  function refreshRandomArea() {
    randomCircleLayer.setLatLng([state.randomCenter.lat, state.randomCenter.lon]);
    randomCircleLayer.setRadius(state.randomRadiusMeters);
    randomCenterMarker.setLatLng([state.randomCenter.lat, state.randomCenter.lon]);
    els.randomRadiusOutput.textContent = `${state.randomRadiusMeters} m`;
    updateRandomAreaStatus();
  }

  function updateRandomAreaUi() {
    const enabled = state.randomAreaEnabled;
    const visible = visibleRandomArea();
    els.enableRandomAreaInput.checked = enabled;
    els.randomAreaControls.classList.toggle("disabled", !enabled);
    els.randomRadiusInput.disabled = !enabled;
    els.setAreaFromCenterButton.disabled = !enabled;
    randomCircleLayer.setStyle({ opacity: visible ? 1 : 0, fillOpacity: visible ? 0.08 : 0 });
    if (visible) {
      if (!map.hasLayer(randomCenterMarker)) randomCenterMarker.addTo(map);
    } else if (map.hasLayer(randomCenterMarker)) {
      map.removeLayer(randomCenterMarker);
    }
    updateRandomAreaStatus();
  }

  function updateRandomAreaStatus() {
    if (!els.randomAreaStatus) return;
    if (!state.filteredPois.length) {
      els.randomAreaStatus.textContent = "No POIs match the current filters yet. Relax the filters first, then generate a crawl.";
      return;
    }
    if (!state.randomAreaEnabled) {
      els.randomAreaStatus.textContent = `${state.filteredPois.length} matching POIs are available across the current filtered map. Turn on the movable area to constrain the crawl to one region.`;
      return;
    }
    const candidates = poisWithinRandomArea();
    const noun = candidates.length === 1 ? "POI" : "POIs";
    els.randomAreaStatus.textContent = `${candidates.length} matching ${noun} inside the ${state.randomRadiusMeters} m region. Drag the marker or the circle to move it.`;
  }

  function startRandomAreaDrag(event) {
    if (!visibleRandomArea()) return;
    if (event.originalEvent) {
      L.DomEvent.stopPropagation(event.originalEvent);
      L.DomEvent.preventDefault(event.originalEvent);
    }
    state.randomAreaDrag = {
      startPointer: event.latlng,
      startCenter: { ...state.randomCenter },
      moved: false,
    };
    if (map.dragging.enabled()) map.dragging.disable();
  }

  function continueRandomAreaDrag(event) {
    if (!state.randomAreaDrag) return;
    const deltaLat = event.latlng.lat - state.randomAreaDrag.startPointer.lat;
    const deltaLon = event.latlng.lng - state.randomAreaDrag.startPointer.lng;
    state.randomAreaDrag.moved = true;
    state.randomCenter = {
      lat: state.randomAreaDrag.startCenter.lat + deltaLat,
      lon: state.randomAreaDrag.startCenter.lon + deltaLon,
    };
    refreshRandomArea();
  }

  function endRandomAreaDrag() {
    if (!state.randomAreaDrag) return;
    const moved = state.randomAreaDrag.moved;
    state.randomAreaDrag = null;
    if (!map.dragging.enabled()) map.dragging.enable();
    if (moved) state.ignoreNextRandomMapClick = true;
  }

  function pickPoisByIds(ids) {
    return ids.map((id) => state.pois.find((poi) => poi.id === id)).filter(Boolean);
  }

  async function generateRouteFromPois(inputPois, sourceLabel) {
    const options = currentRouteOptions();
    if (!inputPois.length) {
      setStatus("Choose at least one POI first.", "error");
      clearRoute();
      return;
    }
    if (inputPois.length === 1 && options.pubCount === 0) {
      setStatus("With one POI selected, add at least one pub stop or choose more POIs.", "error");
      clearRoute();
      return;
    }
    if (options.mealStop === "middle" && options.pubCount < 1) {
      setStatus("A middle meal stop needs at least one pub stop.", "error");
      clearRoute();
      return;
    }

    const orderedPois = optimizePoiOrder(inputPois, options.orderMode, options.roundTrip);
    const segmentCount = segmentCountForPlan(orderedPois, options);
    if (options.pubCount > segmentCount * options.maxPubsPerGap) {
      setStatus(
        `You asked for ${options.pubCount} pub stops, but with a cap of ${options.maxPubsPerGap} per leg across ${segmentCount} legs only ${segmentCount * options.maxPubsPerGap} can fit.`,
        "error"
      );
      clearRoute();
      return;
    }

    const chosenPubCandidates = choosePubsAlongOrderedPath(orderedPois, options);
    if (chosenPubCandidates.length < options.pubCount) {
      setStatus(
        `Only ${chosenPubCandidates.length} of the requested ${options.pubCount} pubs could be placed under the current constraints. Raise the detour, loosen food constraints, or increase the pub cap per leg.`,
        "error"
      );
      clearRoute();
      return;
    }

    const stops = buildStopOrder(orderedPois, chosenPubCandidates, options);
    state.routePubIds = new Set(chosenPubCandidates.map((candidate) => candidate.feature.id));
    state.routeStops = stops;
    els.summaryPubs.textContent = String(state.routePubIds.size);
    refreshRouteStops();
    applyMarkerStyles();

    const route = await fetchWalkingRoute(stops);
    routeOutlineLayer.clearLayers();
    routeLineLayer.clearLayers();
    if (route.geometry) {
      routeOutlineLayer.addData({ type: "Feature", geometry: route.geometry });
      routeLineLayer.addData({ type: "Feature", geometry: route.geometry });
    }

    els.summaryDistance.textContent = formatDistance(route.distance);
    els.summaryDuration.textContent = formatDuration(route.duration);

    let message = `${sourceLabel}: ${orderedPois.length} POIs and ${state.routePubIds.size} pubs planned.`;
    if (options.walkStyle === "quiet") {
      message += " Pub choice was biased away from major-road locations where the open data provided useful signals.";
    }
    if (options.mealStop === "middle") {
      message += " Includes a mid-route meal pub.";
    }
    if (route.mode === "fallback") {
      message += " Walking router unavailable, so the route line is a straight-line fallback.";
      setStatus(message, "error");
    } else {
      setStatus(message, "success");
    }

    const bounds = routeLineLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  function focusPoi(id) {
    const marker = state.poiMarkers.get(id);
    if (!marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.6 });
    marker.openPopup();
  }

  function focusPub(id) {
    const marker = state.pubMarkers.get(id);
    if (!marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.6 });
    marker.openPopup();
  }

  function focusStop(id, kind) {
    const markerMap = kind === "pub" ? state.pubMarkers : state.poiMarkers;
    const marker = markerMap.get(id);
    if (!marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.6 });
    marker.openPopup();
  }

  function toggleSelectedPoi(id) {
    const index = state.selectedPoiIds.indexOf(id);
    if (index >= 0) {
      state.selectedPoiIds.splice(index, 1);
    } else {
      state.selectedPoiIds.push(id);
    }
    openPlanner();
    refreshSelectedPoiList();
    applyMarkerStyles();
  }

  function moveSelectedPoi(id, delta) {
    const index = state.selectedPoiIds.indexOf(id);
    if (index < 0) return;
    const target = index + delta;
    if (target < 0 || target >= state.selectedPoiIds.length) return;
    const copy = state.selectedPoiIds.slice();
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    state.selectedPoiIds = copy;
    refreshSelectedPoiList();
    applyMarkerStyles();
  }

  function poisWithinRandomArea() {
    if (!state.randomAreaEnabled) return state.filteredPois.slice();
    const center = toXY(state.randomCenter.lat, state.randomCenter.lon);
    return state.filteredPois.filter((poi) => {
      const point = toXY(poi.lat, poi.lon);
      return pointDistance(center, point) <= state.randomRadiusMeters;
    });
  }

  function sampleRandomPois(candidates, count, seed) {
    const shuffled = shuffle(candidates, seed);
    const grouped = new Map();
    shuffled.forEach((poi) => {
      const key = poi.primary_category;
      const bucket = grouped.get(key) || [];
      bucket.push(poi);
      grouped.set(key, bucket);
    });

    const diversified = [];
    while (diversified.length < count && grouped.size) {
      for (const [key, bucket] of Array.from(grouped.entries())) {
        if (!bucket.length) {
          grouped.delete(key);
          continue;
        }
        diversified.push(bucket.shift());
        if (diversified.length >= count) break;
        if (!bucket.length) grouped.delete(key);
      }
    }

    if (diversified.length < count) {
      return shuffled.slice(0, count);
    }
    return diversified;
  }

  function updateIntroCounts() {
    els.introPoiCount.textContent = String(state.filteredPois.length);
    els.introPubCount.textContent = String(state.pubs.length);
  }

  function openPlanner() {
    if (window.matchMedia("(max-width: 760px)").matches) {
      els.plannerShell.classList.add("open");
    }
  }

  async function loadData() {
    const embeddedPayload = window.__V2_DATA__;
    if (
      embeddedPayload &&
      Array.isArray(embeddedPayload.pubs) &&
      Array.isArray(embeddedPayload.pois) &&
      embeddedPayload.meta
    ) {
      state.pubs = embeddedPayload.pubs;
      state.pois = embeddedPayload.pois;
      state.meta = embeddedPayload.meta;
      return;
    }

    async function loadJson(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json();
    }

    const [pubs, pois, meta] = await Promise.all([
      loadJson("./data/pubs.json"),
      loadJson("./data/pois.json"),
      loadJson("./data/meta.json"),
    ]);
    state.pubs = pubs;
    state.pois = pois;
    state.meta = meta;
  }

  function fitInitialBounds() {
    const bounds = L.latLngBounds([]);
    state.pubs.forEach((pub) => bounds.extend([pub.lat, pub.lon]));
    state.pois.forEach((poi) => bounds.extend([poi.lat, poi.lon]));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
    map.invalidateSize();
  }

  function attachEvents() {
    els.scoreThresholdInput.addEventListener("input", () => {
      els.scoreThresholdOutput.textContent = els.scoreThresholdInput.value;
      refreshVisibleMarkers();
      updateIntroCounts();
    });
    els.poiSearchInput.addEventListener("input", () => {
      refreshVisibleMarkers();
      updateIntroCounts();
    });
    els.showPoisInput.addEventListener("change", refreshVisibleMarkers);
    els.showPubsInput.addEventListener("change", refreshVisibleMarkers);
    els.categoryFilterList.addEventListener("change", (event) => {
      const target = event.target.closest("input[data-category]");
      if (!target) return;
      const category = target.getAttribute("data-category");
      if (target.checked) {
        categorySelection.add(category);
      } else {
        categorySelection.delete(category);
      }
      refreshVisibleMarkers();
      updateIntroCounts();
    });
    els.selectAllCategoriesButton.addEventListener("click", () => {
      state.meta.categories.forEach((category) => categorySelection.add(category));
      syncCategoryCheckboxes();
      refreshVisibleMarkers();
      updateIntroCounts();
    });
    els.clearAllCategoriesButton.addEventListener("click", () => {
      categorySelection.clear();
      syncCategoryCheckboxes();
      refreshVisibleMarkers();
      updateIntroCounts();
    });

    els.tabGuided.addEventListener("click", () => setActiveTab("guided"));
    els.tabRandom.addEventListener("click", () => setActiveTab("random"));
    els.enableRandomAreaInput.addEventListener("change", () => {
      state.randomAreaEnabled = els.enableRandomAreaInput.checked;
      updateRandomAreaUi();
    });
    els.pubDetourInput.addEventListener("input", () => {
      els.pubDetourOutput.textContent = `${els.pubDetourInput.value} m`;
    });
    els.randomRadiusInput.addEventListener("input", () => {
      state.randomRadiusMeters = Number.parseInt(els.randomRadiusInput.value || "1200", 10) || 1200;
      refreshRandomArea();
    });
    els.setAreaFromCenterButton.addEventListener("click", () => {
      const center = map.getCenter();
      state.randomCenter = { lat: center.lat, lon: center.lng };
      refreshRandomArea();
    });
    els.generateGuidedButton.addEventListener("click", async () => {
      openPlanner();
      await generateRouteFromPois(pickPoisByIds(state.selectedPoiIds), "Targeted crawl");
    });
    els.generateRandomButton.addEventListener("click", async () => {
      openPlanner();
      const constrainedToArea = state.randomAreaEnabled;
      const candidates = constrainedToArea ? poisWithinRandomArea() : state.filteredPois.slice();
      const poiCount = Math.max(1, Number.parseInt(els.randomPoiCountInput.value || "3", 10) || 3);
      if (candidates.length < poiCount) {
        setStatus(
          constrainedToArea
            ? `Only ${candidates.length} matching POIs are available inside the current random area. Reduce the requested POI count, widen the radius, or relax the filters.`
            : `Only ${candidates.length} matching POIs are available under the current filters. Reduce the requested POI count or relax the filters.`,
          "error"
        );
        clearRoute();
        return;
      }
      const sampled = sampleRandomPois(candidates, poiCount, els.randomSeedInput.value || "42");
      state.selectedPoiIds = sampled.map((poi) => poi.id);
      refreshSelectedPoiList();
      applyMarkerStyles();
      await generateRouteFromPois(sampled, constrainedToArea ? "Random area crawl" : "Random crawl");
    });
    els.clearSelectionButton.addEventListener("click", () => {
      state.selectedPoiIds = [];
      refreshSelectedPoiList();
      applyMarkerStyles();
      clearRoute();
      setStatus("POI selection cleared.", "");
    });
    els.clearRouteButton.addEventListener("click", () => {
      clearRoute();
      setStatus("Route cleared. Current POI selection is unchanged.", "");
    });

    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.getAttribute("data-action");
      const id = target.getAttribute("data-id") || "";
      if (action === "toggle-poi") {
        toggleSelectedPoi(id);
        return;
      }
      if (action === "focus-poi") {
        focusPoi(id);
        return;
      }
      if (action === "focus-pub") {
        focusPub(id);
        return;
      }
      if (action === "move-poi-up") {
        moveSelectedPoi(id, -1);
        return;
      }
      if (action === "move-poi-down") {
        moveSelectedPoi(id, 1);
        return;
      }
      if (action === "remove-poi") {
        state.selectedPoiIds = state.selectedPoiIds.filter((poiId) => poiId !== id);
        refreshSelectedPoiList();
        applyMarkerStyles();
        return;
      }
      if (action === "focus-stop") {
        focusStop(id, target.getAttribute("data-kind") || "poi");
      }
    });

    map.on("click", (event) => {
      if (!visibleRandomArea()) return;
      if (state.ignoreNextRandomMapClick) {
        state.ignoreNextRandomMapClick = false;
        return;
      }
      state.randomCenter = { lat: event.latlng.lat, lon: event.latlng.lng };
      refreshRandomArea();
    });

    map.on("mousemove", continueRandomAreaDrag);
    map.on("mouseup", endRandomAreaDrag);
    randomCircleLayer.on("mousedown", startRandomAreaDrag);

    randomCenterMarker.on("drag", (event) => {
      if (!state.randomAreaEnabled) return;
      const latlng = event.target.getLatLng();
      state.randomCenter = { lat: latlng.lat, lon: latlng.lng };
      refreshRandomArea();
    });

    els.mobileOpenButton.addEventListener("click", () => {
      els.plannerShell.classList.add("open");
      map.invalidateSize();
    });
    els.mobileCollapseButton.addEventListener("click", () => {
      els.plannerShell.classList.remove("open");
      map.invalidateSize();
    });
    document.addEventListener("mouseup", endRandomAreaDrag);
    window.addEventListener("resize", () => map.invalidateSize());
  }

  try {
    await loadData();
    renderCategoryFilters();
    createMarkers();
    refreshVisibleMarkers();
    applyMarkerStyles();
    refreshSelectedPoiList();
    refreshRouteStops();
    updateIntroCounts();
    fitInitialBounds();
    refreshRandomArea();
    els.pubDetourOutput.textContent = `${els.pubDetourInput.value} m`;
    setActiveTab("guided");
    updateRandomAreaUi();
    attachEvents();
    window.setTimeout(() => map.invalidateSize(), 0);
    setStatus("Datasets loaded. Filter the map, pick POIs, or switch to Random Area mode.", "");
  } catch (error) {
    setStatus(`Failed to load V2 data: ${error.message}`, "error");
    console.error(error);
  }

  map.attributionControl.addAttribution(
    'POIs from OpenStreetMap and Open Plaques. Static app built locally for London crawl planning.'
  );
})();
