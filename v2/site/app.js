/* London Crawl Planner: UI, map and persistence. Planning logic lives in planner.js. */
(function () {
  "use strict";

  const P = window.PubGenPlanner;
  const scriptEl = document.getElementById("app-script");
  const VERSION = (scriptEl && scriptEl.dataset.version) || "dev";
  const CONFIG = window.PubGenConfig || {};
  const ROUTER_URL = CONFIG.routerUrl || "https://routing.openstreetmap.de/routed-foot/route/v1/driving/";
  const TILE_URL = CONFIG.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ROUTER_TIMEOUT_MS = 12000;
  const LONDON_BOUNDS = [
    [51.286, -0.51],
    [51.692, 0.334],
  ];

  // Which city: a shared link's "c=" wins, then ?city=, then the last city used.
  const CITY_ID = (() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("c");
    const fromQuery = new URLSearchParams(window.location.search).get("city");
    let remembered = null;
    try {
      remembered = localStorage.getItem("pubgen.city");
    } catch (error) {
      remembered = null;
    }
    const id = (fromHash || fromQuery || remembered || "london").toLowerCase();
    return /^[a-z-]{2,30}$/.test(id) ? id : "london";
  })();
  // London keeps the original keys so existing saved crawls survive.
  const citySuffix = CITY_ID === "london" ? "" : `.${CITY_ID}`;
  const STORAGE = {
    session: `pubgen.session.v1${citySuffix}`,
    saved: `pubgen.saved.v1${citySuffix}`,
    info: "pubgen.info.v1",
    media: "pubgen.media.v1",
    howDismissed: "pubgen.how.v1",
  };
  const MAX_SAVED = 100;
  // Off until switched on in Map filters (there are ~3,800 plaques; they swamp the map).
  const DEFAULT_HIDDEN_CATEGORIES = ["blue_plaque"];
  const CATEGORY_SETTINGS_VERSION = 2;
  const COLORS = { poi: "#2a66b8", pub: "#c97c10", selected: "#1f4a37", route: "#7a2430", area: "#b8322f" };

  const $ = (id) => document.getElementById(id);
  const els = {
    loading: $("loading"),
    loadingText: $("loading-text"),
    countPois: $("count-pois"),
    countPubs: $("count-pubs"),
    searchInput: $("search-input"),
    searchResults: $("search-results"),
    locateButton: $("locate-button"),
    layersButton: $("layers-button"),
    sheet: $("sheet"),
    sheetGrip: $("sheet-grip"),
    sheetHandle: $("sheet-handle"),
    sheetBody: $("sheet-body"),
    sheetFooter: $("sheet-footer"),
    footerPlan: $("footer-plan"),
    footerRoute: $("footer-route"),
    routeBadge: $("route-badge"),
    savedBadge: $("saved-badge"),
    modePick: $("mode-pick"),
    modeRandom: $("mode-random"),
    selectedList: $("selected-list"),
    selectedEmpty: $("selected-empty"),
    areaEnabled: $("area-enabled"),
    areaControls: $("area-controls"),
    areaRadius: $("area-radius"),
    areaRadiusOutput: $("area-radius-output"),
    areaFromMap: $("area-from-map"),
    areaFromMe: $("area-from-me"),
    areaStatus: $("area-status"),
    planStatus: $("plan-status"),
    detour: $("detour"),
    detourOutput: $("detour-output"),
    minScore: $("min-score"),
    minScoreOutput: $("min-score-output"),
    filtersDetails: $("filters-details"),
    filterSummary: $("filter-summary"),
    categoryList: $("category-list"),
    categoriesAll: $("categories-all"),
    categoriesNone: $("categories-none"),
    generateButton: $("generate-button"),
    clearSelectionButton: $("clear-selection-button"),
    routeEmpty: $("route-empty"),
    routeContent: $("route-content"),
    routeName: $("route-name"),
    routeSavedFlag: $("route-saved-flag"),
    sumStops: $("sum-stops"),
    sumDistance: $("sum-distance"),
    sumWalk: $("sum-walk"),
    routeStatus: $("route-status"),
    routeList: $("route-list"),
    gpxButton: $("gpx-button"),
    gmapsButton: $("gmaps-button"),
    clearRouteButton: $("clear-route-button"),
    saveButton: $("save-button"),
    shareButton: $("share-button"),
    savedEmpty: $("saved-empty"),
    savedList: $("saved-list"),
    dataNote: $("data-note"),
    banner: $("banner"),
    bannerText: $("banner-text"),
    bannerAction: $("banner-action"),
    bannerClose: $("banner-close"),
    toast: $("toast"),
  };

  // Settings read from form controls: [element id, option key, type].
  const SETTINGS = [
    ["pub-count", "pubCount", "int"],
    ["random-poi-count", "randomPoiCount", "int"],
    ["order-mode", "orderMode", "value"],
    ["walk-style", "walkStyle", "value"],
    ["meal-stop", "mealStop", "value"],
    ["max-per-leg", "maxPubsPerGap", "int"],
    ["detour", "maxDetourMeters", "int"],
    ["finish", "finish", "value"],
    ["require-food", "requireFood", "bool"],
    ["require-step-free", "requireStepFree", "bool"],
    ["prefer-real-ale", "preferRealAle", "bool"],
    ["prefer-outdoor", "preferOutdoor", "bool"],
    ["prefer-dog", "preferDog", "bool"],
    ["prefer-historic", "preferHistoric", "bool"],
    ["avoid-chains", "avoidChains", "bool"],
    ["show-pois", "showPois", "bool"],
    ["show-pubs", "showPubs", "bool"],
    ["min-score", "minScore", "int"],
    ["theme-sights", "themeSights", "int"],
    ["theme-pubs", "themePubs", "int"],
  ];

  const state = {
    data: null,
    byId: new Map(),
    markers: new Map(),
    searchIndex: null,
    tab: "plan",
    mode: "pick",
    selected: [],
    categories: new Set(),
    area: { enabled: false, lat: 51.509865, lon: -0.118092, radius: 1200 },
    filteredPois: [],
    visiblePubs: [],
    markerSignature: "",
    crawl: null,
    city: null,
    cities: [],
    theme: "victorian",
    highlighted: new Set(),
    route: null,
    routeRequest: 0,
    saved: [],
    popupPlaceId: null,
    userLocation: null,
    searchQuery: "",
    searchResults: [],
    searchActive: -1,
  };

  // ================================================================== utilities

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, wait) {
    let timer = 0;
    let pending = null;
    function debounced(...args) {
      pending = args;
      clearTimeout(timer);
      timer = setTimeout(debounced.flush, wait);
    }
    debounced.flush = () => {
      clearTimeout(timer);
      if (!pending) return;
      const args = pending;
      pending = null;
      fn(...args);
    };
    return debounced;
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        return false;
      }
    },
  };

  const mobileQuery = window.matchMedia("(max-width: 760px)");
  const hoverQuery = window.matchMedia("(hover: hover)");
  const isMobile = () => mobileQuery.matches;

  function formatCount(value) {
    return Number(value || 0).toLocaleString("en-GB");
  }

  function formatMeters(value) {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value} m`;
  }

  function formatDate(timestamp) {
    try {
      return new Date(timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    } catch (error) {
      return "";
    }
  }

  let toastTimer = 0;
  function toast(message, duration) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), duration || 2800);
  }

  function setStatus(el, message, tone) {
    el.textContent = message || "";
    el.className = `status${tone ? ` ${tone}` : ""}`;
  }

  function placeMeta(place) {
    if (place.kind === "pub") {
      const features = P.pubFeatures(place).slice(0, 3);
      return ["Pub", place.address].concat(features.length ? [features.join(", ")] : []).filter(Boolean).join(" · ");
    }
    return [P.categorySingular(place.primary), place.address].filter(Boolean).join(" · ");
  }

  const ICONS = {
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm1 8h-2v7h2v-7Zm0-4h-2v2h2V6Z"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 7 7 7-1.4 1.4L12 9.8l-5.6 5.6L5 14z"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17-7-7 1.4-1.4 5.6 5.6 5.6-5.6L19 10z"/></svg>',
    remove:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>',
    swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3 1.4-1.4L21.8 8l-5.4 5.4L15 12l3-3H7zm10 10H6l3 3-1.4 1.4L2.2 16l5.4-5.4L9 12l-3 3h11z"/></svg>',
    directions:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.7 11.3-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4ZM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5z"/></svg>',
  };

  // ================================================================== map setup

  const map = L.map("map", {
    zoomControl: false,
    minZoom: 9,
    maxZoom: 19,
    renderer: L.canvas({ padding: 0.3, tolerance: 6 }),
    worldCopyJump: false,
  });
  map.fitBounds(LONDON_BOUNDS);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  map.attributionControl.setPosition("bottomleft");
  map.attributionControl.setPrefix(false);

  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const MARKER_STYLES = {
    poi: { radius: 6.5, color: "#fffaf0", weight: 1.5, fillColor: COLORS.poi, fillOpacity: 0.95 },
    pub: { radius: 7, color: "#fffaf0", weight: 1.5, fillColor: COLORS.pub, fillOpacity: 0.95 },
    active: { radius: 8.5, color: "#fffaf0", weight: 2, fillColor: COLORS.selected, fillOpacity: 1 },
  };

  // One cluster layer for both kinds; each bubble's ring shows the pub/sight mix.
  const placeLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: false,
    disableClusteringAtZoom: 17,
    maxClusterRadius: (zoom) => (zoom < 13 ? 70 : zoom < 15 ? 55 : 45),
    chunkedLoading: true,
    removeOutsideVisibleBounds: true,
    iconCreateFunction(cluster) {
      const children = cluster.getAllChildMarkers();
      const count = children.length;
      let pubs = 0;
      for (let index = 0; index < count; index += 1) if (children[index].placeKind === "pub") pubs += 1;
      const size = count < 10 ? 32 : count < 100 ? 38 : count < 1000 ? 44 : 50;
      const label = count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : count;
      const pubDeg = Math.round((pubs / count) * 360);
      const ring = `conic-gradient(${COLORS.pub} 0 ${pubDeg}deg, ${COLORS.poi} ${pubDeg}deg 360deg)`;
      const title = `${pubs} pub${pubs === 1 ? "" : "s"}, ${count - pubs} sight${count - pubs === 1 ? "" : "s"}`;
      return L.divIcon({
        html: `<div class="cluster" title="${title}" style="width:${size}px;height:${size}px;background:${ring}"><span>${label}</span></div>`,
        className: "",
        iconSize: [size, size],
      });
    },
  });
  map.addLayer(placeLayer);

  const routeOutline = L.polyline([], { color: "#fffaf0", weight: 9, opacity: 0.9, lineJoin: "round", interactive: false }).addTo(map);
  const routeLine = L.polyline([], { color: COLORS.route, weight: 5, opacity: 0.95, lineJoin: "round", interactive: false }).addTo(map);
  const pinLayer = L.layerGroup().addTo(map);

  const areaCircle = L.circle([state.area.lat, state.area.lon], {
    radius: state.area.radius,
    color: COLORS.area,
    weight: 2,
    fillColor: COLORS.area,
    fillOpacity: 0.07,
    interactive: false,
  });
  const areaPin = L.marker([state.area.lat, state.area.lon], {
    draggable: true,
    autoPan: true,
    keyboard: false,
    title: "Drag to move the crawl area",
    icon: L.divIcon({ html: '<div class="pin area"><span>A</span></div>', className: "", iconSize: [30, 30], iconAnchor: [15, 36] }),
    zIndexOffset: 1000,
  });

  let userMarker = null;
  const popup = L.popup({ maxWidth: 320, closeButton: true, autoPanPaddingTopLeft: [16, 110] });

  function pinIcon(kind, label, pending, extra) {
    return L.divIcon({
      html: `<div class="pin ${kind}${pending ? " pending" : ""}${extra ? ` ${extra}` : ""}"><span>${escapeHtml(label)}</span></div>`,
      className: "",
      iconSize: [30, 30],
      iconAnchor: [15, 36],
      popupAnchor: [0, -34],
    });
  }

  // ================================================================== data

  async function loadCities() {
    try {
      const response = await fetch(`./data/cities.json?v=${encodeURIComponent(VERSION)}`);
      if (!response.ok) throw new Error(`Cities request failed (${response.status})`);
      return await response.json();
    } catch (error) {
      if (window.__PUBGEN_CITIES__) return window.__PUBGEN_CITIES__;
      return new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "./data/cities.js";
        script.onload = () => resolve(window.__PUBGEN_CITIES__ || []);
        script.onerror = () => resolve([]);
        document.head.appendChild(script);
      });
    }
  }

  function applyCity(cities) {
    const city = cities.find((item) => item.id === CITY_ID) || cities.find((item) => item.id === "london") || {
      id: "london",
      name: "London",
      center: [51.509865, -0.118092],
      bounds: LONDON_BOUNDS,
      minZoom: 9,
      dailyAreas: [],
      data: "data/places-london.json",
    };
    state.city = city;
    state.cities = cities;
    try {
      localStorage.setItem("pubgen.city", city.id);
    } catch (error) {
      // private mode: the city just isn't remembered
    }
    P.setReferenceLatitude(city.center[0]);
    P.setCity(city.id);
    // Jump straight to the city with no animation. map.setMinZoom() would start an animated
    // zoom that swallows the move (York opened on London) or, on phones where the city fits
    // below its minZoom, leaves the marker clusters empty when it ends. fitBounds clamps to
    // options.minZoom by itself.
    map.options.minZoom = city.minZoom || 9;
    map.fitBounds(city.bounds, { animate: false });
    const title = `${city.name} Crawl Planner`;
    document.title = title;
    document.querySelector(".brand h1").textContent = title;
    $("loading-text").textContent = `Pulling a map of ${city.name}…`;
    $("map").setAttribute("aria-label", `Map of ${city.name} pubs and sights`);
    const select = $("city-select");
    select.innerHTML = cities
      .map((item) => `<option value="${escapeHtml(item.id)}"${item.id === city.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`)
      .join("");
    select.hidden = cities.length < 2;
    return city;
  }

  function switchCity(id) {
    if (!id || id === state.city.id) return;
    persistSession.flush();
    try {
      localStorage.setItem("pubgen.city", id);
    } catch (error) {
      // fall through to the URL
    }
    window.location.href = `${window.location.pathname}?city=${encodeURIComponent(id)}`;
  }

  async function loadDataset() {
    const dataPath = state.city.data;
    try {
      const response = await fetch(`./${dataPath}?v=${encodeURIComponent(VERSION)}`);
      if (!response.ok) throw new Error(`Data request failed (${response.status})`);
      return await response.json();
    } catch (error) {
      // file:// pages cannot fetch(); fall back to the script bundle.
      if (window.__PUBGEN_DATA__) return window.__PUBGEN_DATA__;
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `./${dataPath.replace(/\.json$/, ".js")}`;
        script.onload = () => (window.__PUBGEN_DATA__ ? resolve(window.__PUBGEN_DATA__) : reject(error));
        script.onerror = () => reject(error);
        document.head.appendChild(script);
      });
    }
  }

  function indexData(data) {
    state.data = data;
    data.pubs.forEach((pub) => state.byId.set(pub.id, pub));
    data.pois.forEach((poi) => state.byId.set(poi.id, poi));
    data.categories.forEach((category) => {
      if (!DEFAULT_HIDDEN_CATEGORIES.includes(category)) state.categories.add(category);
    });
  }

  function createMarkers() {
    const add = (place) => {
      const marker = L.circleMarker([place.lat, place.lon], MARKER_STYLES[place.kind]);
      marker.placeId = place.id;
      marker.placeKind = place.kind;
      state.markers.set(place.id, marker);
    };
    state.data.pois.forEach(add);
    state.data.pubs.forEach(add);
  }

  function onMarkerClick(event) {
    const place = state.byId.get(event.layer.placeId);
    if (place) openPlacePopup(place);
  }

  function onMarkerHover(event) {
    const layer = event.layer;
    if (!hoverQuery.matches || !layer.placeId) return;
    if (!layer.getTooltip()) {
      const place = state.byId.get(layer.placeId);
      layer.bindTooltip(escapeHtml(place.title), { direction: "top", offset: [0, -6], opacity: 0.95 });
    }
    layer.openTooltip();
  }

  // ================================================================== settings

  function readSettings() {
    const settings = {};
    SETTINGS.forEach(([id, key, type]) => {
      const input = $(id);
      if (type === "bool") settings[key] = input.checked;
      else if (type === "int") {
        const min = Number(input.min || 0);
        const max = Number(input.max || 100000);
        const value = Number.parseInt(input.value, 10);
        settings[key] = Math.min(max, Math.max(min, Number.isFinite(value) ? value : Number(input.defaultValue) || min));
      } else settings[key] = input.value;
    });
    settings.roundTrip = settings.finish === "start";
    return settings;
  }

  function applySettings(settings) {
    if (!settings) return;
    SETTINGS.forEach(([id, key, type]) => {
      if (!(key in settings)) return;
      const input = $(id);
      if (type === "bool") input.checked = Boolean(settings[key]);
      else if (type === "value") {
        if ([...input.options].some((option) => option.value === settings[key])) input.value = settings[key];
      } else input.value = settings[key];
    });
  }

  function syncOutputs() {
    const settings = readSettings();
    els.detourOutput.textContent = formatMeters(settings.maxDetourMeters);
    els.minScoreOutput.textContent = String(settings.minScore);
    els.areaRadiusOutput.textContent = formatMeters(state.area.radius);
  }

  // ================================================================== persistence

  function serializeRoute(route) {
    return {
      name: route.name,
      stops: route.stops.map(P.stopToken),
      options: route.options,
      geometry: route.geometry
        ? route.geometry.map(([lat, lon]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5])
        : null,
      legs: route.legs,
      distance: route.distance,
      duration: route.duration,
      routerMode: route.routerMode,
      savedId: route.savedId || null,
      dirty: Boolean(route.dirty),
      visited: route.visited || [],
      source: route.source || "",
      theme: route.theme || "",
    };
  }

  function deserializeRoute(record) {
    const missing = [];
    const stops = [];
    (record.stops || []).forEach((raw) => {
      const token = P.parseToken(raw);
      const place = state.byId.get(token.id);
      if (!place) {
        missing.push(token.id);
        return;
      }
      stops.push({ place, auto: token.auto, mealStop: token.mealStop, segmentIndex: null, progress: null });
    });
    const intact = !missing.length && stops.length === (record.stops || []).length;
    return {
      route: {
        name: record.name || "",
        stops,
        options: record.options || readSettings(),
        geometry: intact ? record.geometry : null,
        legs: intact ? record.legs : null,
        distance: intact ? record.distance : null,
        duration: intact ? record.duration : null,
        routerMode: intact ? record.routerMode : null,
        savedId: record.savedId || null,
        dirty: Boolean(record.dirty),
        source: record.source || "",
        theme: record.theme || "",
        visited: Array.isArray(record.visited) && intact ? record.visited.filter(Number.isInteger) : [],
        analyzed: null,
        rejected: new Set(),
      },
      missing,
    };
  }

  const persistSession = debounce(() => {
    const center = map.getCenter();
    store.set(STORAGE.session, {
      version: 1,
      tab: state.tab,
      mode: state.mode,
      selected: state.selected,
      settings: readSettings(),
      categories: [...state.categories],
      categoryVersion: CATEGORY_SETTINGS_VERSION,
      theme: state.theme,
      area: state.area,
      view: { lat: center.lat, lon: center.lng, zoom: map.getZoom() },
      route: state.route ? serializeRoute(state.route) : null,
    });
  }, 300);

  function loadSaved() {
    const saved = store.get(STORAGE.saved, []);
    state.saved = Array.isArray(saved) ? saved.filter((item) => item && item.id && Array.isArray(item.stops)) : [];
  }

  function writeSaved() {
    if (store.set(STORAGE.saved, state.saved)) return true;
    // Out of space: drop stored geometry (it can be re-fetched) and try again.
    state.saved.forEach((item) => {
      item.geometry = null;
    });
    return store.set(STORAGE.saved, state.saved);
  }

  // ================================================================== filtering & markers

  function poiPassesFilters(poi, settings) {
    if (poi.score < settings.minScore) return false;
    // Plaques are usually also "historical"; hide them whenever their own chip is off.
    if (poi.primary === "blue_plaque" && !state.categories.has("blue_plaque")) return false;
    return poi.categories.some((category) => state.categories.has(category));
  }

  function refreshMarkers() {
    const settings = readSettings();
    state.filteredPois = state.data.pois.filter((poi) => poiPassesFilters(poi, settings));
    state.visiblePubs = state.data.pubs.filter((pub) => P.pubMatchesRequirements(pub, settings));
    const visible = [];
    if (settings.showPois) state.filteredPois.forEach((poi) => visible.push(state.markers.get(poi.id)));
    if (settings.showPubs) state.visiblePubs.forEach((pub) => visible.push(state.markers.get(pub.id)));
    const signature = `${visible.length}|${settings.showPois}|${settings.showPubs}|${settings.minScore}|${[...state.categories].join(",")}|${settings.requireFood}|${settings.requireStepFree}`;
    if (signature !== state.markerSignature) {
      state.markerSignature = signature;
      placeLayer.clearLayers();
      placeLayer.addLayers(visible);
    }

    els.countPois.textContent = formatCount(settings.showPois ? state.filteredPois.length : 0);
    els.countPubs.textContent = formatCount(settings.showPubs ? state.visiblePubs.length : 0);
    const categoryCount = state.data.categories.length;
    els.filterSummary.textContent =
      state.categories.size === categoryCount && settings.minScore === 0
        ? ""
        : `${formatCount(state.filteredPois.length)} sights`;
    updateAreaStatus();
  }

  const refreshMarkersSoon = debounce(refreshMarkers, 120);

  function updateHighlights() {
    const wanted = new Set(state.selected);
    if (state.route) state.route.stops.forEach((stop) => wanted.add(stop.place.id));
    state.highlighted.forEach((id) => {
      if (wanted.has(id)) return;
      const marker = state.markers.get(id);
      const place = state.byId.get(id);
      if (marker && place) marker.setStyle(MARKER_STYLES[place.kind]);
    });
    wanted.forEach((id) => {
      if (state.highlighted.has(id)) return;
      const marker = state.markers.get(id);
      if (marker) marker.setStyle(MARKER_STYLES.active);
    });
    state.highlighted = wanted;
  }

  function renderPins() {
    pinLayer.clearLayers();
    const addPin = (place, label, pending, extra) => {
      const pin = L.marker([place.lat, place.lon], {
        icon: pinIcon(place.kind, label, pending, extra),
        title: place.title,
        zIndexOffset: 500,
        keyboard: true,
      });
      pin.on("click", () => openPlacePopup(place));
      pinLayer.addLayer(pin);
    };
    if (state.route) {
      const stops = state.route.stops;
      const loop = stops.length > 2 && stops[0].place.id === stops[stops.length - 1].place.id;
      const crawl = state.crawl;
      const visited = new Set(state.route.visited || []);
      (loop ? stops.slice(0, -1) : stops).forEach((stop, index) => {
        let extra = "";
        if (visited.has(index)) extra = "done";
        else if (crawl && crawl.next === index) extra = "next";
        addPin(stop.place, visited.has(index) ? "✓" : index + 1, false, extra);
      });
    } else {
      state.selected.forEach((id, index) => {
        const place = state.byId.get(id);
        if (place) addPin(place, index + 1, true);
      });
    }
  }

  // ================================================================== popups & focus

  function popupHtml(place) {
    const selected = state.selected.includes(place.id);
    const inRoute = Boolean(state.route && state.route.stops.some((stop) => stop.place.id === place.id));
    const links = [];
    const website = P.safeUrl(place.website);
    if (website) links.push(`<a href="${escapeHtml(website)}" target="_blank" rel="noopener">Website</a>`);
    if (place.wikipedia) {
      const wiki = P.wikipediaUrl(place.wikipedia);
      if (wiki) links.push(`<a href="${escapeHtml(wiki)}" target="_blank" rel="noopener">Wikipedia</a>`);
    }
    links.push(`<a href="${escapeHtml(P.directionsUrl(place))}" target="_blank" rel="noopener">Directions</a>`);
    const source = P.sourceUrl(place);
    if (source) {
      links.push(
        `<a href="${escapeHtml(source)}" target="_blank" rel="noopener">${place.id.startsWith("q") ? "Open Plaques" : "OpenStreetMap"}</a>`
      );
    }

    let kicker;
    let body = "";
    if (place.kind === "pub") {
      kicker = `<span class="dot pub"></span>Pub${inRoute ? " · on your route" : ""}`;
      const features = P.pubFeatures(place);
      if (features.length) {
        body += `<div class="stop-tags">${features.map((f) => `<span class="tag">${escapeHtml(f)}</span>`).join("")}</div>`;
      }
      if (place.address) body += `<p class="popup-line">${escapeHtml(place.address)}</p>`;
      if (place.hours) body += `<p class="popup-line">Hours: ${escapeHtml(place.hours)}</p>`;
      if (place.brand) body += `<p class="popup-line">Part of ${escapeHtml(place.brand)}</p>`;
      if (place.brewery) body += `<p class="popup-line">Brewery: ${escapeHtml(place.brewery)}</p>`;
      if (place.cuisine) body += `<p class="popup-line">Food: ${escapeHtml(place.cuisine)}</p>`;
      if (place.phone) {
        const tel = place.phone.split(";")[0].replace(/[^\d+]/g, "");
        body += `<p class="popup-line">Phone: <a href="tel:${escapeHtml(tel)}">${escapeHtml(place.phone.split(";")[0])}</a></p>`;
      }
    } else {
      kicker = `<span class="dot poi"></span>${escapeHtml(P.categorySingular(place.primary))} · interest ${place.score}`;
      if (place.description) body += `<p class="popup-desc">${escapeHtml(place.description)}</p>`;
      if (place.address) body += `<p class="popup-line">${escapeHtml(place.address)}</p>`;
      const others = place.categories.filter((category) => category !== place.primary);
      if (others.length) {
        body += `<div class="stop-tags">${others.map((c) => `<span class="tag">${escapeHtml(P.categoryLabel(c))}</span>`).join("")}</div>`;
      }
    }

    const media = cachedMedia(place);
    const photo = media && media.images && media.images[0];
    const photoHtml = photo
      ? `<button type="button" class="popup-photo" data-action="info" data-id="${escapeHtml(place.id)}" aria-label="Photos and more about ${escapeHtml(place.title)}"><img src="${escapeHtml(photo.thumb)}" alt="" loading="lazy"></button>`
      : "";
    const story = P.placeStories(place)[0];
    if (story) body = `<p class="popup-story">${escapeHtml(story.icon)} ${escapeHtml(story.reason)}</p>` + body;
    return `
      ${photoHtml}
      <div class="popup-kicker">${kicker}</div>
      <h3 class="popup-title">${escapeHtml(place.title)}</h3>
      ${body}
      <div class="popup-links">${links.join("")}</div>
      <div class="popup-actions">
        <button type="button" class="btn ${selected ? "" : "primary"} grow" data-action="toggle-stop" data-id="${escapeHtml(place.id)}">
          ${selected ? "Remove from crawl" : "Add to crawl"}
        </button>
        <button type="button" class="btn" data-action="info" data-id="${escapeHtml(place.id)}">More info</button>
      </div>`;
  }

  function popupPadding() {
    if (isMobile()) {
      return { topLeft: [16, 90], bottomRight: [16, els.sheet.getBoundingClientRect().height + 16] };
    }
    return { topLeft: [els.searchInput.closest(".topbar").getBoundingClientRect().right + 16, 24], bottomRight: [els.sheet.offsetWidth + 40, 24] };
  }

  function openPlacePopup(place) {
    const padding = popupPadding();
    popup.options.autoPanPaddingTopLeft = padding.topLeft;
    popup.options.autoPanPaddingBottomRight = padding.bottomRight;
    state.popupPlaceId = place.id;
    popup.setLatLng([place.lat, place.lon]).setContent(popupHtml(place)).openOn(map);
    if (!cachedMedia(place) && hasMediaSource(place)) {
      loadPlaceMedia(place).then((media) => {
        if (state.popupPlaceId === place.id && map.hasLayer(popup) && media.images && media.images.length) {
          popup.setContent(popupHtml(place));
        }
      });
    }
  }

  function refreshOpenPopup() {
    if (!state.popupPlaceId || !map.hasLayer(popup)) return;
    const place = state.byId.get(state.popupPlaceId);
    if (place) popup.setContent(popupHtml(place));
  }

  function focusPlace(place, options) {
    if (isMobile() && els.sheet.dataset.state !== "peek") setSheet(options && options.keepSheet ? "half" : "peek");
    const zoom = Math.max(map.getZoom(), 16);
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      openPlacePopup(place);
    };
    map.once("moveend", open);
    setTimeout(open, 900);
    map.flyTo([place.lat, place.lon], zoom, { duration: 0.6 });
  }

  // ================================================================== selection

  function toggleStop(id) {
    const place = state.byId.get(id);
    if (!place) return;
    const index = state.selected.indexOf(id);
    if (index >= 0) {
      state.selected.splice(index, 1);
      toast(`Removed ${place.title}`);
    } else {
      state.selected.push(id);
      if (state.mode !== "pick") setMode("pick");
      toast(`Added ${place.title} · ${state.selected.length} stop${state.selected.length === 1 ? "" : "s"} chosen`);
    }
    renderSelected();
    if (!state.route) renderPins();
    updateHighlights();
    refreshOpenPopup();
    persistSession();
  }

  function moveSelected(id, delta) {
    const index = state.selected.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= state.selected.length) return;
    const [item] = state.selected.splice(index, 1);
    state.selected.splice(target, 0, item);
    renderSelected();
    if (!state.route) renderPins();
    persistSession();
  }

  function renderSelected() {
    const places = state.selected.map((id) => state.byId.get(id)).filter(Boolean);
    els.selectedEmpty.hidden = places.length > 0;
    els.selectedList.innerHTML = places
      .map(
        (place, index) => `
        <li class="stop">
          <span class="stop-num ${place.kind}">${index + 1}</span>
          <div class="stop-main" data-action="focus" data-id="${escapeHtml(place.id)}">
            <div class="stop-title">${escapeHtml(place.title)}</div>
            <div class="stop-meta">${escapeHtml(placeMeta(place))}</div>
          </div>
          <div class="stop-actions">
            <button type="button" class="icon-btn" data-action="move-up" data-id="${escapeHtml(place.id)}" aria-label="Move ${escapeHtml(place.title)} up" ${index === 0 ? "disabled" : ""}>${ICONS.up}</button>
            <button type="button" class="icon-btn" data-action="move-down" data-id="${escapeHtml(place.id)}" aria-label="Move ${escapeHtml(place.title)} down" ${index === places.length - 1 ? "disabled" : ""}>${ICONS.down}</button>
            <button type="button" class="icon-btn" data-action="unselect" data-id="${escapeHtml(place.id)}" aria-label="Remove ${escapeHtml(place.title)}">${ICONS.remove}</button>
          </div>
        </li>`
      )
      .join("");
    updateGenerateLabel();
  }

  function updateGenerateLabel() {
    if (state.mode === "random") {
      els.generateButton.textContent = state.route ? "Surprise me again" : "Surprise me";
    } else {
      const count = state.selected.length;
      els.generateButton.textContent = count ? `Plan crawl · ${count} stop${count === 1 ? "" : "s"}` : "Plan my crawl";
    }
    els.clearSelectionButton.hidden = state.mode !== "pick" || !state.selected.length;
  }

  // ================================================================== random area

  function poisInArea() {
    const center = { lat: state.area.lat, lon: state.area.lon };
    return state.filteredPois.filter((poi) => P.distance(center, poi) <= state.area.radius);
  }

  function pubsInArea(pubs) {
    const center = { lat: state.area.lat, lon: state.area.lon };
    return pubs.filter((pub) => P.distance(center, pub) <= state.area.radius);
  }

  function updateAreaLayers() {
    const visible = state.mode === "random" && state.area.enabled;
    areaCircle.setLatLng([state.area.lat, state.area.lon]).setRadius(state.area.radius);
    areaPin.setLatLng([state.area.lat, state.area.lon]);
    if (visible) {
      if (!map.hasLayer(areaCircle)) areaCircle.addTo(map);
      if (!map.hasLayer(areaPin)) areaPin.addTo(map);
    } else {
      if (map.hasLayer(areaCircle)) map.removeLayer(areaCircle);
      if (map.hasLayer(areaPin)) map.removeLayer(areaPin);
    }
    els.areaControls.hidden = !state.area.enabled;
    els.areaEnabled.checked = state.area.enabled;
    els.areaRadiusOutput.textContent = formatMeters(state.area.radius);
    updateAreaStatus();
  }

  function updateAreaStatus() {
    if (!state.data) return;
    const settings = readSettings();
    if (settings.randomPoiCount === 0) {
      const pool = state.data.pubs.filter((pub) => P.pubMatchesRequirements(pub, settings));
      const count = state.area.enabled ? pubsInArea(pool).length : pool.length;
      els.areaStatus.textContent = `Pub-only crawl: ${formatCount(count)} pubs ${state.area.enabled ? "inside the area" : "available"}.`;
      return;
    }
    const count = state.area.enabled ? poisInArea().length : state.filteredPois.length;
    els.areaStatus.textContent = state.area.enabled
      ? `${formatCount(count)} sights match your filters inside the area.`
      : `${formatCount(count)} sights match your map filters.`;
  }

  function moveArea(lat, lon, recenter) {
    state.area.lat = lat;
    state.area.lon = lon;
    updateAreaLayers();
    if (recenter) map.panTo([lat, lon]);
    persistSession();
  }

  // ================================================================== planning

  function defaultRouteName(stops) {
    const first = stops[0] && stops[0].place;
    if (!first) return `${state.city.name} crawl`;
    const title = first.title.length > 40 ? `${first.title.slice(0, 38)}…` : first.title;
    return `${title} crawl`;
  }

  async function generate() {
    const settings = readSettings();
    setStatus(els.planStatus, "");
    let anchors;
    let options = { ...settings };

    if (state.mode === "pick") {
      anchors = state.selected.map((id) => state.byId.get(id)).filter(Boolean);
      if (!anchors.length) {
        setStatus(els.planStatus, "Tap a sight or pub on the map and choose “Add to crawl”, or switch to Surprise me.", "error");
        setSheet("half");
        return;
      }
    } else {
      const seed = newSeed();
      options.seed = seed;
      const rng = P.createRng(seed);
      const constrained = state.area.enabled;
      if (settings.randomPoiCount > 0) {
        const pool = constrained ? poisInArea() : state.filteredPois;
        anchors = P.pickRandomSights(pool, settings.randomPoiCount, rng, constrained);
        if (!anchors) {
          setStatus(
            els.planStatus,
            `Only ${pool.length} sights match${constrained ? " inside the area" : ""}. Widen the area, relax the map filters or ask for fewer sights.`,
            "error"
          );
          return;
        }
      } else {
        if (settings.pubCount < 2) {
          setStatus(els.planStatus, "For a pub-only crawl, ask for at least 2 pubs.", "error");
          return;
        }
        let pool = state.data.pubs.filter((pub) => P.pubMatchesRequirements(pub, settings));
        if (constrained) pool = pubsInArea(pool);
        anchors = P.pickRandomPubs(pool, settings.pubCount, rng, constrained);
        if (!anchors) {
          setStatus(els.planStatus, `Only ${pool.length} matching pubs${constrained ? " in the area" : ""}. Widen the area or ask for fewer pubs.`, "error");
          return;
        }
        options = { ...settings, seed, pubCount: 0, mealStop: "none", orderMode: "optimize" };
      }
      state.selected = anchors.map((place) => place.id);
      renderSelected();
    }

    const result = P.planRoute(anchors, state.data.pubs, options);
    if (!result.ok) {
      setStatus(els.planStatus, result.error, "error");
      if (isMobile()) setSheet("half");
      return;
    }

    setRoute({
      name: defaultRouteName(result.stops),
      source: state.mode,
      stops: result.stops,
      options,
      analyzed: result.analyzed,
      rejected: new Set(),
      geometry: null,
      legs: null,
      distance: null,
      duration: null,
      routerMode: null,
      savedId: null,
      dirty: true,
    });
    switchTab("route");
    if (isMobile()) setSheet("half");
    await updateRouteGeometry(true);
  }

  function newSeed() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Same settings and stops, different luck: new random sights (Surprise me) or different pubs. */
  async function reshuffleRoute() {
    const route = state.route;
    if (!route || route.source === "daily") return;
    if (route.source === "theme") {
      await generateThemed(route.theme);
      return;
    }
    if (route.source === "random") {
      const previousMode = state.mode;
      state.mode = "random";
      await generate();
      state.mode = previousMode;
      return;
    }
    const anchors = routeAnchors(route);
    if (!anchors.length) return;
    const previousPubs = route.stops.filter((stop) => stop.auto).map((stop) => stop.place.id);
    const base = route.options && Object.keys(route.options).length ? route.options : readSettings();
    const options = { ...base, orderMode: "selected", seed: newSeed(), avoidIds: previousPubs };
    const result = P.planRoute(anchors, state.data.pubs, options);
    if (!result.ok) {
      toast(result.error, 4000);
      return;
    }
    const fresh = result.stops.filter((stop) => stop.auto && !previousPubs.includes(stop.place.id)).length;
    setRoute({
      ...route,
      stops: result.stops,
      options: { ...base },
      analyzed: result.analyzed,
      rejected: new Set(),
      geometry: null,
      legs: null,
      distance: null,
      duration: null,
      visited: [],
      dirty: true,
    });
    toast(fresh ? `${fresh} new pub${fresh === 1 ? "" : "s"} this time` : "No other pubs nearby fit. Try a bigger detour.");
    await updateRouteGeometry(true);
  }

  function setRoute(route) {
    state.route = route;
    hideBanner();
    renderRoute();
    renderPins();
    updateHighlights();
    refreshOpenPopup();
    updateGenerateLabel();
    persistSession();
  }

  async function fetchWalkingRoute(stops) {
    const places = stops.map((stop) => stop.place);
    const coordinates = places.map((place) => `${place.lon},${place.lat}`).join(";");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS) : 0;
    try {
      const response = await fetch(`${ROUTER_URL}${coordinates}?overview=full&geometries=geojson&steps=false`, {
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error(`Router returned ${response.status}`);
      const data = await response.json();
      const route = data.routes && data.routes[0];
      if (!route || !route.geometry) throw new Error("No walking route returned");
      return {
        geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        legs: (route.legs || []).map((leg) => ({ distance: leg.distance, duration: leg.duration })),
        distance: route.distance,
        duration: route.duration,
        routerMode: "router",
      };
    } catch (error) {
      const estimate = P.straightLineEstimate(places);
      return {
        geometry: places.map((place) => [place.lat, place.lon]),
        legs: estimate.legs,
        distance: estimate.distance,
        duration: estimate.duration,
        routerMode: "fallback",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function updateRouteGeometry(fit) {
    const route = state.route;
    if (!route) return;
    if (route.stops.length < 2) {
      route.geometry = null;
      route.legs = [];
      route.distance = 0;
      route.duration = 0;
      drawRouteLine(fit);
      renderRoute();
      return;
    }
    const request = ++state.routeRequest;
    els.routeStatus.textContent = "Finding walking paths…";
    els.routeStatus.className = "status";
    drawRouteLine(fit, route.stops.map((stop) => [stop.place.lat, stop.place.lon]), true);
    const result = await fetchWalkingRoute(route.stops);
    if (request !== state.routeRequest || state.route !== route) return;
    Object.assign(route, result);
    drawRouteLine(fit);
    renderRoute();
    persistSession();
  }

  function drawRouteLine(fit, preview, dashed) {
    const points = preview || (state.route && state.route.geometry) || [];
    routeOutline.setLatLngs(points);
    routeLine.setLatLngs(points);
    routeLine.setStyle({ dashArray: dashed ? "6 10" : null, opacity: dashed ? 0.6 : 0.95 });
    if (fit && points.length > 1) fitRoute(points);
  }

  function fitRoute(points) {
    const bounds = L.latLngBounds(points);
    if (isMobile()) {
      map.fitBounds(bounds, {
        paddingTopLeft: [24, 90],
        paddingBottomRight: [24, Math.min(window.innerHeight * 0.6, els.sheet.getBoundingClientRect().height + 24)],
        maxZoom: 17,
      });
    } else {
      const topbar = document.querySelector(".topbar").getBoundingClientRect();
      map.fitBounds(bounds, {
        paddingTopLeft: [40, topbar.bottom + 24],
        paddingBottomRight: [els.sheet.offsetWidth + 48, 40],
        maxZoom: 17,
      });
    }
  }

  function routeAnchors(route) {
    const anchors = route.stops.filter((stop) => !stop.auto).map((stop) => stop.place);
    if (anchors.length > 1 && anchors[0].id === anchors[anchors.length - 1].id) anchors.pop();
    return anchors;
  }

  function swapStop(index) {
    const route = state.route;
    const stop = route && route.stops[index];
    if (!stop || stop.place.kind !== "pub") return;
    const options = { ...readSettings(), ...route.options };
    if (!route.analyzed) {
      const anchors = routeAnchors(route);
      const pool = state.data.pubs.filter((pub) => P.pubMatchesRequirements(pub, options));
      route.analyzed = P.analyzePubsAlongPath(anchors.length ? anchors : [stop.place], pool, {
        ...options,
        maxDetourMeters: Math.max(options.maxDetourMeters || 0, 800),
      });
    }
    const excluded = new Set(route.rejected);
    route.stops.forEach((item) => excluded.add(item.place.id));
    const candidate = P.findSwapCandidate(route.analyzed, stop, excluded, options);
    if (!candidate) {
      toast("No other suitable pubs nearby. Try a bigger detour in Route options.");
      return;
    }
    route.rejected.add(stop.place.id);
    route.stops[index] = {
      ...stop,
      place: candidate.feature,
      segmentIndex: candidate.segmentIndex,
      progress: candidate.progress,
    };
    route.dirty = true;
    toast(`Swapped in ${candidate.feature.title}`);
    renderRoute();
    renderPins();
    updateHighlights();
    updateRouteGeometry(false);
  }

  function removeRouteStop(index) {
    const route = state.route;
    if (!route) return;
    const id = route.stops[index].place.id;
    const remaining = route.stops.filter((stop, position) => position !== index && stop.place.id !== id);
    if (remaining.length < 2) {
      toast("A crawl needs at least two stops.");
      return;
    }
    route.stops = remaining;
    route.dirty = true;
    if (route.visited) {
      route.visited = route.visited.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
      if (state.crawl) state.crawl.next = firstUnvisited(route);
      renderCrawl();
    }
    renderRoute();
    renderPins();
    updateHighlights();
    updateRouteGeometry(false);
  }

  function clearRoute() {
    stopCrawl(true);
    state.route = null;
    state.routeRequest += 1;
    drawRouteLine(false, []);
    renderRoute();
    renderPins();
    updateHighlights();
    updateGenerateLabel();
    persistSession();
  }

  function renderRoute() {
    const route = state.route;
    els.routeEmpty.hidden = Boolean(route);
    els.routeContent.hidden = !route;
    els.routeBadge.hidden = !route;
    updateFooter();
    if (!route) return;

    const stops = route.stops;
    const loop = stops.length > 2 && stops[0].place.id === stops[stops.length - 1].place.id;
    const uniqueStops = loop ? stops.slice(0, -1) : stops;
    const pubCount = uniqueStops.filter((stop) => stop.place.kind === "pub").length;
    els.routeBadge.textContent = String(uniqueStops.length);
    if (document.activeElement !== els.routeName) els.routeName.value = route.name || "";
    els.routeSavedFlag.hidden = !(route.savedId && !route.dirty);
    renderThemeNote(route);
    // The crawl of the day is fixed for everyone, so it can't be re-rolled.
    document.querySelector(".reshuffle-row").hidden = route.source === "daily";

    els.sumStops.textContent = `${uniqueStops.length - pubCount} + ${pubCount} 🍺`;
    els.sumDistance.textContent = route.distance != null ? P.formatDistance(route.distance) : "…";
    els.sumWalk.textContent = route.duration != null ? P.formatDuration(route.duration) : "…";

    if (route.routerMode === "fallback") {
      setStatus(els.routeStatus, "Walking directions are unavailable right now, so lines are straight and times are estimates.", "error");
    } else if (route.routerMode === "router") {
      setStatus(els.routeStatus, "");
    }

    const legs = route.legs || [];
    const canRemove = uniqueStops.length > 2;
    const visited = new Set(route.visited || []);
    const items = [];
    stops.forEach((stop, index) => {
      const place = stop.place;
      const isReturn = loop && index === stops.length - 1;
      const number = isReturn ? 1 : index + 1;
      const tags = [];
      if (stop.mealStop) tags.push('<span class="tag meal">Meal stop</span>');
      const theme = route.theme && P.themeById(route.theme);
      const reason = theme ? P.themeReason(place, theme) : "";
      if (reason) tags.push(`<span class="tag theme">${escapeHtml(theme.icon)} ${escapeHtml(reason)}</span>`);
      if (place.kind === "pub") P.pubFeatures(place).slice(0, 3).forEach((f) => tags.push(`<span class="tag">${escapeHtml(f)}</span>`));
      const actions = [
        `<button type="button" class="icon-btn" data-action="info" data-id="${escapeHtml(place.id)}" aria-label="About ${escapeHtml(place.title)}" title="About this place">${ICONS.info}</button>`,
        `<a class="icon-btn" href="${escapeHtml(P.directionsUrl(place))}" target="_blank" rel="noopener" aria-label="Walking directions to ${escapeHtml(place.title)}" title="Directions">${ICONS.directions}</a>`,
      ];
      if (place.kind === "pub" && stop.auto && !isReturn) {
        actions.push(
          `<button type="button" class="icon-btn" data-action="swap" data-index="${index}" aria-label="Swap ${escapeHtml(place.title)} for another pub" title="Swap pub">${ICONS.swap}</button>`
        );
      }
      if (canRemove && !isReturn) {
        actions.push(
          `<button type="button" class="icon-btn" data-action="remove-stop" data-index="${index}" aria-label="Remove ${escapeHtml(place.title)} from route" title="Remove">${ICONS.remove}</button>`
        );
      }
      const done = visited.has(index);
      const isNext = Boolean(state.crawl && state.crawl.next === index);
      items.push(`
        <li class="stop${done ? " visited" : ""}${isNext ? " next" : ""}">
          <span class="stop-num ${done ? "done" : place.kind}">${done ? "✓" : number}</span>
          <div class="stop-main" data-action="focus" data-id="${escapeHtml(place.id)}">
            <div class="stop-title">${isReturn ? "Back to " : ""}${escapeHtml(place.title)}</div>
            <div class="stop-meta">${escapeHtml(placeMeta(place))}</div>
            ${stopBlurb(place, route)}
            ${tags.length ? `<div class="stop-tags">${tags.join("")}</div>` : ""}
          </div>
          <div class="stop-actions">${actions.join("")}</div>
        </li>`);
      if (index < stops.length - 1) {
        const leg = legs[index];
        items.push(
          `<li class="leg" aria-hidden="true">${leg ? `${P.formatDistance(leg.distance)} · ${P.formatDuration(leg.duration)} walk` : "…"}</li>`
        );
      }
    });
    els.routeList.innerHTML = items.join("");
    prefetchStopInfo(route);
    renderAdSlot();
  }

  function renderAdSlot() {
    const slot = $("ad-slot");
    const premium = Boolean(window.PubGenPremium && window.PubGenPremium.active);
    const ads = window.PubGenAds;
    const show = Boolean(CONFIG.ads && CONFIG.ads.enabled && !premium && ads && typeof ads.render === "function");
    slot.hidden = !show;
    if (show && !slot.dataset.rendered) {
      slot.dataset.rendered = "1";
      try {
        ads.render(slot);
      } catch (error) {
        slot.hidden = true;
      }
    }
  }

  // ================================================================== saving & sharing

  function saveCurrentRoute() {
    const route = state.route;
    if (!route) return;
    route.name = (els.routeName.value || "").trim() || route.name || defaultRouteName(route.stops);
    const now = Date.now();
    const record = { ...serializeRoute(route), savedId: undefined, dirty: undefined };
    delete record.savedId;
    delete record.dirty;
    delete record.visited;
    const existing = route.savedId ? state.saved.find((item) => item.id === route.savedId) : null;
    if (existing) {
      Object.assign(existing, record, { updatedAt: now });
      state.saved = [existing].concat(state.saved.filter((item) => item !== existing));
    } else {
      const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      state.saved.unshift({ id, createdAt: now, updatedAt: now, ...record });
      route.savedId = id;
      if (state.saved.length > MAX_SAVED) state.saved.length = MAX_SAVED;
    }
    if (!writeSaved()) {
      toast("Couldn't save: this browser's storage is full or disabled.");
      return;
    }
    route.dirty = false;
    renderRoute();
    renderSaved();
    hideBanner();
    persistSession();
    toast(existing ? "Saved changes" : "Saved to this device. Find it under Saved.");
  }

  function openSavedRoute(id) {
    const record = state.saved.find((item) => item.id === id);
    if (!record) return;
    const { route, missing } = deserializeRoute({ ...record, savedId: id, dirty: false });
    if (route.stops.length < 2) {
      toast("This saved crawl's stops are no longer in the map data.");
      return;
    }
    if (missing.length) {
      route.dirty = true;
      toast(`${missing.length} stop${missing.length === 1 ? " is" : "s are"} no longer in the map data and was skipped.`);
    }
    showRoute(route);
  }

  function showRoute(route) {
    setRoute(route);
    switchTab("route");
    if (isMobile()) setSheet("half");
    if (route.geometry && route.geometry.length > 1) {
      drawRouteLine(true);
      renderRoute();
    } else {
      updateRouteGeometry(true);
    }
  }

  function renameSaved(id) {
    const record = state.saved.find((item) => item.id === id);
    if (!record) return;
    const name = window.prompt("Rename crawl", record.name || "");
    if (name == null) return;
    record.name = name.trim().slice(0, 80) || record.name;
    record.updatedAt = Date.now();
    writeSaved();
    if (state.route && state.route.savedId === id) {
      state.route.name = record.name;
      renderRoute();
    }
    renderSaved();
  }

  function deleteSaved(id) {
    const record = state.saved.find((item) => item.id === id);
    if (!record || !window.confirm(`Delete “${record.name || "Untitled crawl"}”?`)) return;
    state.saved = state.saved.filter((item) => item.id !== id);
    writeSaved();
    if (state.route && state.route.savedId === id) {
      state.route.savedId = null;
      state.route.dirty = true;
      renderRoute();
    }
    renderSaved();
    persistSession();
    toast("Deleted");
  }

  function renderSaved() {
    els.savedEmpty.hidden = state.saved.length > 0;
    els.savedBadge.hidden = !state.saved.length;
    els.savedBadge.textContent = String(state.saved.length);
    const currentId = state.route && state.route.savedId;
    els.savedList.innerHTML = state.saved
      .map((item) => {
        const stops = item.stops.length;
        const meta = [`${stops} stops`];
        if (item.distance) meta.push(P.formatDistance(item.distance));
        if (item.duration) meta.push(`${P.formatDuration(item.duration)} walking`);
        meta.push(formatDate(item.updatedAt || item.createdAt));
        return `
          <li class="saved-item${item.id === currentId ? " current" : ""}">
            <div class="saved-name">${escapeHtml(item.name || "Untitled crawl")}</div>
            <div class="saved-meta">${escapeHtml(meta.join(" · "))}</div>
            <div class="button-row">
              <button type="button" class="btn small primary" data-action="open-saved" data-id="${escapeHtml(item.id)}">Open</button>
              <button type="button" class="btn small" data-action="share-saved" data-id="${escapeHtml(item.id)}">Share</button>
              <button type="button" class="btn small ghost" data-action="rename-saved" data-id="${escapeHtml(item.id)}">Rename</button>
              <button type="button" class="btn small ghost" data-action="delete-saved" data-id="${escapeHtml(item.id)}">Delete</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function shareUrlFor(name, tokensOrStops) {
    const base = window.location.href.split("#")[0].split("?")[0];
    return `${base}#${P.encodeShare(name, tokensOrStops)}&c=${encodeURIComponent(state.city.id)}`;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // fall through to the legacy path
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  async function shareLink(name, stops, summary) {
    const url = shareUrlFor(name, stops);
    const title = name || `${state.city.name} crawl`;
    if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title, text: `${title}${summary ? ` (${summary})` : ""}`, url });
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    if (await copyText(url)) toast("Link copied. Anyone with it can open this crawl.");
    else window.prompt("Copy this link to share your crawl:", url);
  }

  function routeSummary(route) {
    const parts = [`${route.stops.length} stops`];
    if (route.distance) parts.push(P.formatDistance(route.distance));
    return parts.join(", ");
  }

  function shareCurrentRoute() {
    const route = state.route;
    if (!route) return;
    route.name = (els.routeName.value || "").trim() || route.name;
    shareLink(route.name, route.stops, routeSummary(route));
  }

  function shareSaved(id) {
    const record = state.saved.find((item) => item.id === id);
    if (!record) return;
    const { route } = deserializeRoute(record);
    shareLink(record.name, route.stops, routeSummary(route));
  }

  function importSharedFromHash() {
    const shared = P.decodeShare(window.location.hash);
    if (!shared) return false;
    const tokens = shared.tokens.map((token) => token.id + (token.mealStop ? "*" : token.auto ? "-" : ""));
    const { route, missing } = deserializeRoute({ name: shared.name, stops: tokens });
    try {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (error) {
      // ignore (e.g. file://)
    }
    if (route.stops.length < 2) {
      toast("That shared crawl couldn't be opened: its stops aren't in the current map data.");
      return false;
    }
    route.name = route.name || defaultRouteName(route.stops);
    route.dirty = true;
    showRoute(route);
    showBanner(`Shared crawl: ${route.name}`, "Save", saveCurrentRoute);
    if (missing.length) toast(`${missing.length} stop${missing.length === 1 ? "" : "s"} from the link no longer exist and were skipped.`);
    return true;
  }

  function downloadGpx() {
    const route = state.route;
    if (!route) return;
    const geometry = route.geometry ? { coordinates: route.geometry.map(([lat, lon]) => [lon, lat]) } : null;
    const gpx = P.toGpx(route.name, route.stops, geometry);
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(route.name || "london-crawl").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "london-crawl"}.gpx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function openGoogleMaps() {
    const route = state.route;
    if (!route) return;
    const { url, truncated } = P.googleMapsUrl(route.stops);
    if (truncated) toast("Google Maps only takes 10 stops in one link, so the route was shortened there.", 4000);
    window.open(url, "_blank", "noopener");
  }


  // ================================================================== place info (Wikipedia, Open Plaques, OSM)

  const INFO_TTL = 30 * 24 * 3600 * 1000;
  const INFO_MAX = 150;
  const infoCache = new Map();
  (function loadInfoCache() {
    const stored = store.get(STORAGE.info, {});
    if (stored && typeof stored === "object") Object.keys(stored).forEach((key) => infoCache.set(key, stored[key]));
  })();

  function rememberInfo(id, info) {
    const entry = { ...info, at: Date.now() };
    infoCache.delete(id);
    infoCache.set(id, entry);
    while (infoCache.size > INFO_MAX) infoCache.delete(infoCache.keys().next().value);
    store.set(STORAGE.info, Object.fromEntries(infoCache));
    return entry;
  }

  async function fetchJson(url, timeout) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout || 8000) : 0;
    try {
      const response = await fetch(url, { signal: controller ? controller.signal : undefined });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Encyclopedia summary for a place, from Wikipedia (via Wikidata when needed). Cached for 30 days. */
  async function loadPlaceInfo(place) {
    const cached = infoCache.get(place.id);
    if (cached && Date.now() - cached.at < INFO_TTL) return cached;
    let wiki = P.parseWikipedia(place.wikipedia);
    try {
      if (!wiki && place.wikidata) {
        const data = await fetchJson(P.wikidataSitelinkUrl(place.wikidata, "en"));
        const entity = data && data.entities && data.entities[place.wikidata];
        const link = entity && entity.sitelinks && entity.sitelinks.enwiki;
        if (link && link.title) wiki = { lang: "en", title: link.title };
      }
      if (!wiki) return rememberInfo(place.id, { none: true });
      const summary = P.summarizeWikipedia(await fetchJson(P.wikipediaSummaryUrl(wiki)));
      return rememberInfo(place.id, summary ? { wiki: summary } : { none: true });
    } catch (error) {
      if (error && error.status === 404) return rememberInfo(place.id, { none: true });
      return { offline: true }; // not cached, so it is retried next time
    }
  }

  const dialog = $("place-dialog");
  let dialogPlaceId = null;

  function placeFacts(place) {
    const facts = [];
    if (place.kind === "pub") {
      const features = P.pubFeatures(place);
      if (features.length) facts.push(features.join(" · "));
      if (place.brand) facts.push(`Part of ${place.brand}`);
      if (place.brewery) facts.push(`Brewery: ${place.brewery}`);
      if (place.cuisine) facts.push(`Food: ${place.cuisine}`);
      if (place.hours) facts.push(`Hours: ${place.hours}`);
    } else {
      facts.push(place.categories.map(P.categoryLabel).join(" · "));
    }
    if (place.address) facts.push(place.address);
    return facts;
  }

  function renderPlaceContent(place, info) {
    const content = [];
    const credits = [];
    const isPlaque = place.kind === "poi" && place.id.startsWith("q");
    const wiki = info && info.wiki;

    $("place-tagline").textContent = wiki && wiki.description ? wiki.description : "";

    if (isPlaque && place.description) {
      content.push(`<p class="inscription">${escapeHtml(place.description)}</p>`);
      credits.push(`Plaque text: <a href="${escapeHtml(P.sourceUrl(place))}" target="_blank" rel="noopener">Open Plaques</a>`);
    }
    if (wiki) {
      wiki.extract
        .split(/\n+/)
        .filter(Boolean)
        .forEach((paragraph) => content.push(`<p>${escapeHtml(paragraph)}</p>`));
      credits.push(
        `From <a href="${escapeHtml(wiki.url || P.wikipediaUrl(place.wikipedia))}" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA 4.0)`
      );
    } else if (!info) {
      content.push('<p class="loading-line">Looking this up on Wikipedia…</p>');
    } else if (!isPlaque && place.description) {
      content.push(`<p>${escapeHtml(place.description)}</p>`);
    }
    if (info && info.offline && !wiki) content.push('<p class="loading-line">Couldn\'t reach Wikipedia just now. Try again with a signal.</p>');
    if (info && info.none && !place.description && !isPlaque) {
      content.push(
        `<p class="loading-line">No encyclopedia entry for this one. ${place.kind === "pub" ? "Ask the bar staff for the story." : "Have a look around!"}</p>`
      );
    }

    const stories = P.placeStories(place);
    if (stories.length) {
      content.push(
        `<div class="stories"><h3>Stories &amp; links</h3><ul>${stories
          .map((story) => `<li><span aria-hidden="true">${escapeHtml(story.icon)}</span> <strong>${escapeHtml(story.name)}:</strong> ${escapeHtml(story.reason)}</li>`)
          .join("")}</ul></div>`
      );
    }
    const facts = placeFacts(place).filter(Boolean);
    if (facts.length) content.push(`<ul class="facts">${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>`);

    const links = [];
    const website = P.safeUrl(place.website);
    if (website) links.push(`<a href="${escapeHtml(website)}" target="_blank" rel="noopener">Website</a>`);
    const source = P.sourceUrl(place);
    if (source && !isPlaque) links.push(`<a href="${escapeHtml(source)}" target="_blank" rel="noopener">OpenStreetMap</a>`);
    if (links.length) content.push(`<p class="popup-links">${links.join("")}</p>`);

    $("place-content").innerHTML = content.join("");
    if (!credits.length) credits.push('Details: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>');
    $("place-credit").innerHTML = credits.join(" · ");
  }

  function renderPlaceActions(place, context) {
    const actions = [];
    const next = context && context.nextStop;
    if (context && context.arrival) {
      actions.push(
        `<button type="button" class="btn primary grow" data-close>${next ? "On to the next one" : "Finish"}</button>`
      );
      if (next) {
        actions.push(
          `<a class="btn" href="${escapeHtml(P.directionsUrl(next.place))}" target="_blank" rel="noopener">Directions</a>`
        );
      }
    } else {
      const selected = state.selected.includes(place.id);
      actions.push(
        `<button type="button" class="btn ${selected ? "" : "primary"} grow" data-action="toggle-stop" data-id="${escapeHtml(place.id)}" data-refresh-dialog>${selected ? "Remove from crawl" : "Add to crawl"}</button>`
      );
      actions.push(`<a class="btn" href="${escapeHtml(P.directionsUrl(place))}" target="_blank" rel="noopener">Directions</a>`);
    }
    $("place-actions").innerHTML = actions.join("");
  }

  function openPlaceDialog(place, context) {
    dialogPlaceId = place.id;
    dialog.dataset.context = context && context.arrival ? "arrival" : "";
    const arrival = $("place-arrival");
    arrival.hidden = !(context && context.arrival);
    if (context && context.arrival) {
      arrival.innerHTML = `${escapeHtml(context.arrival.title)}<small>${escapeHtml(context.arrival.sub)}</small>`;
    }
    const kind = place.kind === "pub" ? "Pub" : P.categorySingular(place.primary);
    $("place-kicker").innerHTML = `<span class="dot ${place.kind}"></span>${escapeHtml(kind)}`;
    $("place-title").textContent = place.title;
    const cached = infoCache.get(place.id);
    renderPlaceContent(place, cached && Date.now() - cached.at < INFO_TTL ? cached : null);
    renderGallery(place, cachedMedia(place));
    renderPlaceActions(place, context);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    $("place-dialog").querySelector(".place-body").scrollTop = 0;
    map.closePopup();
    loadPlaceInfo(place).then((info) => {
      if (dialogPlaceId === place.id && dialog.open) renderPlaceContent(place, info);
    });
    if (hasMediaSource(place)) {
      loadPlaceMedia(place).then((media) => {
        if (dialogPlaceId === place.id && dialog.open) renderGallery(place, media);
      });
    }
  }

  function closePlaceDialog() {
    dialogPlaceId = null;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }


  // ================================================================== photos (Wikimedia Commons, optional Mapillary)

  const MEDIA_MAX = 200;
  const mediaCache = new Map();
  (function loadMediaCache() {
    const stored = store.get(STORAGE.media, {});
    if (stored && typeof stored === "object") Object.keys(stored).forEach((key) => mediaCache.set(key, stored[key]));
  })();

  function cachedMedia(place) {
    const entry = mediaCache.get(place.id);
    return entry && Date.now() - entry.at < INFO_TTL ? entry : null;
  }

  function rememberMedia(id, media) {
    const entry = { ...media, at: Date.now() };
    mediaCache.delete(id);
    mediaCache.set(id, entry);
    while (mediaCache.size > MEDIA_MAX) mediaCache.delete(mediaCache.keys().next().value);
    store.set(STORAGE.media, Object.fromEntries(mediaCache));
    return entry;
  }

  function hasMediaSource(place) {
    return Boolean(place.commons || place.wikidata || place.wikipedia || (CONFIG.mapillaryToken && place.kind === "pub"));
  }

  const mediaRequests = new Map();

  /** Up to six credited photos: the Wikidata lead image, then the place's Commons category (often interiors for pubs). */
  function loadPlaceMedia(place) {
    const cached = cachedMedia(place);
    if (cached) return Promise.resolve(cached);
    if (mediaRequests.has(place.id)) return mediaRequests.get(place.id);
    const request = (async () => {
      const files = [];
      let category = "";
      if (place.commons.startsWith("File:")) files.push(place.commons);
      else if (place.commons.startsWith("Category:")) category = place.commons;
      try {
        let qid = place.wikidata;
        let info = null;
        if (!qid && place.wikipedia) {
          info = await loadPlaceInfo(place);
          qid = (info && info.wiki && info.wiki.qid) || "";
        }
        if (qid) {
          const [lead, cat] = await Promise.all([
            fetchJson(P.wikidataClaimUrl(qid, "P18")).catch(() => null),
            fetchJson(P.wikidataClaimUrl(qid, "P373")).catch(() => null),
          ]);
          const file = P.readWikidataClaim(lead, "P18");
          if (file) files.unshift(`File:${file}`);
          const commonsCategory = P.readWikidataClaim(cat, "P373");
          if (!category && commonsCategory) category = `Category:${commonsCategory}`;
        }
        if (!files.length && place.wikipedia) {
          info = info || (await loadPlaceInfo(place));
          const fromSummary = P.commonsFileFromUrl(info && info.wiki && info.wiki.image);
          if (fromSummary) files.push(fromSummary);
        }
        let images = [];
        if (files.length) {
          const found = P.parseCommonsImages(await fetchJson(P.commonsFilesUrl(files)));
          const order = files.map((title) => title.toLowerCase());
          found.sort((a, b) => order.indexOf(a.title.toLowerCase()) - order.indexOf(b.title.toLowerCase()));
          images = images.concat(found);
        }
        if (category) images = images.concat(P.parseCommonsImages(await fetchJson(P.commonsCategoryUrl(category))));
        if (!images.length && CONFIG.mapillaryToken && place.kind === "pub") images = await loadStreetPhotos(place);
        return rememberMedia(place.id, { images: P.arrangePhotos(images, 6) });
      } catch (error) {
        return { images: [], offline: true };
      } finally {
        mediaRequests.delete(place.id);
      }
    })();
    mediaRequests.set(place.id, request);
    return request;
  }

  async function loadStreetPhotos(place) {
    const dLat = 0.00045;
    const dLon = 0.0007;
    const params = new URLSearchParams({
      access_token: CONFIG.mapillaryToken,
      fields: "id,thumb_1024_url,computed_compass_angle,computed_geometry,creator",
      bbox: [place.lon - dLon, place.lat - dLat, place.lon + dLon, place.lat + dLat].map((n) => n.toFixed(6)).join(","),
      limit: "30",
    });
    try {
      return P.pickFacingPhotos(await fetchJson(`https://graph.mapillary.com/images?${params.toString()}`), place, 2);
    } catch (error) {
      return [];
    }
  }

  function renderGallery(place, media) {
    const gallery = $("place-gallery");
    const images = (media && media.images) || [];
    gallery.hidden = !images.length;
    if (!images.length) {
      gallery.innerHTML = "";
      return;
    }
    gallery.innerHTML = images
      .map((image, index) => {
        const source = image.source || "Wikimedia Commons";
        const credit = image.credit ? `${escapeHtml(image.credit)} · ` : "";
        const link = image.page ? `<a href="${escapeHtml(image.page)}" target="_blank" rel="noopener">${escapeHtml(source)}</a>` : escapeHtml(source);
        return `
          <figure class="slide">
            <img src="${escapeHtml(image.thumb)}" alt="${escapeHtml(place.title)}${image.interior ? " (inside)" : ""}" ${index ? 'loading="lazy"' : ""}>
            ${image.interior ? '<span class="slide-tag">Inside</span>' : ""}
            ${images.length > 1 ? `<span class="slide-count">${index + 1}/${images.length}</span>` : ""}
            <figcaption>Photo: ${credit}${link}</figcaption>
          </figure>`;
      })
      .join("");
    gallery.scrollLeft = 0;
  }

  // ================================================================== crawl of the day

  let daily = null;

  function renderDaily() {
    const card = $("daily-card");
    const dateKey = P.londonDateKey();
    if (!daily || daily.dateKey !== dateKey) {
      daily = P.pickDailyCrawl(state.data.pois, state.data.pubs, dateKey, state.city.dailyAreas);
      if (daily) daily.plan = P.planRoute(daily.anchors, state.data.pubs, daily.options);
    }
    card.hidden = !(daily && daily.plan && daily.plan.ok);
    if (card.hidden) return;
    const stops = daily.plan.stops;
    const pubs = stops.filter((stop) => stop.place.kind === "pub").length;
    const day = new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    $("daily-kicker").textContent = `Crawl of the day · ${day}`;
    $("daily-title").textContent = daily.title;
    const walk = P.formatDistance(P.pathLength(stops.map((stop) => stop.place)) * 1.25);
    $("daily-meta").textContent = `${daily.area.name.replace(/^the /, "The ")} · ${stops.length - pubs} sights, ${pubs} pubs · about ${walk} · ends at a pub`;
    const photo = $("daily-photo");
    const showPhoto = (media) => {
      const image = media && media.images && media.images[0];
      if (!image) return;
      photo.innerHTML = `<img src="${escapeHtml(image.thumb)}" alt="${escapeHtml(daily.hero.title)}">`;
      photo.hidden = false;
    };
    showPhoto(cachedMedia(daily.hero));
    if (!cachedMedia(daily.hero) && hasMediaSource(daily.hero)) loadPlaceMedia(daily.hero).then(showPhoto);
  }

  async function openDaily() {
    if (!daily || !daily.plan || !daily.plan.ok) return;
    const weekday = new Date(`${daily.dateKey}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long" });
    setRoute({
      name: `${weekday}'s crawl: ${daily.area.name.replace(/^the /, "")}`,
      source: "daily",
      stops: daily.plan.stops.map((stop) => ({ ...stop })),
      options: daily.options,
      analyzed: daily.plan.analyzed,
      rejected: new Set(),
      geometry: null,
      legs: null,
      distance: null,
      duration: null,
      routerMode: null,
      savedId: null,
      dirty: true,
      visited: [],
    });
    switchTab("route");
    if (isMobile()) setSheet("half");
    await updateRouteGeometry(true);
  }


  // ================================================================== themed crawls

  let themeCounts = null;

  function themeName(theme) {
    return theme.name.replace(/\bLondon\b/, state.city ? state.city.name : "London");
  }

  function renderThemes() {
    if (!themeCounts) {
      themeCounts = {};
      P.THEMES.forEach((theme) => {
        themeCounts[theme.id] = {
          sights: state.data.pois.filter((poi) => poi.score >= 30 && P.themeMatchesSight(poi, theme)).length,
          pubs: state.data.pubs.filter((pub) => P.themeMatchesPub(pub, theme)).length,
        };
      });
    }
    $("theme-grid").innerHTML = P.THEMES.filter((theme) => themeCounts[theme.id].sights >= 3).map((theme) => {
      const counts = themeCounts[theme.id];
      return `
        <button type="button" class="theme-card" role="radio" aria-checked="${theme.id === state.theme}" data-theme="${escapeHtml(theme.id)}">
          <span class="theme-icon" aria-hidden="true">${escapeHtml(theme.icon)}</span>
          <span><span class="theme-name">${escapeHtml(themeName(theme))}</span>
          <span class="theme-count">${formatCount(counts.sights)} sights · ${formatCount(counts.pubs)} pubs</span></span>
        </button>`;
    }).join("");
    const theme = P.themeById(state.theme);
    $("theme-blurb").textContent = theme ? theme.blurb : "";
    $("theme-generate").textContent = theme ? `Generate ${themeName(theme)} crawl` : "Generate themed crawl";
  }

  /** One line about a stop: its Wikipedia description, or its best story from another theme. */
  function stopBlurb(place, route) {
    const info = infoCache.get(place.id);
    const description = info && info.wiki && info.wiki.description;
    const other = P.placeStories(place).find((story) => story.theme !== route.theme);
    const parts = [];
    if (description) parts.push(`📖 ${description.charAt(0).toUpperCase()}${description.slice(1)}`);
    if (other && other.curated) parts.push(`${other.icon} ${other.reason}`);
    return parts.length ? `<div class="stop-blurb">${parts.map(escapeHtml).join(" · ")}</div>` : "";
  }

  let prefetching = false;
  /** Quietly fetch Wikipedia descriptions for the route's stops, then redraw once. */
  async function prefetchStopInfo(route) {
    if (prefetching) return;
    const missing = route.stops
      .map((stop) => stop.place)
      .filter((place, index, list) => list.indexOf(place) === index)
      .filter((place) => (place.wikipedia || place.wikidata) && !infoCache.has(place.id))
      .slice(0, 12);
    if (!missing.length) return;
    prefetching = true;
    try {
      for (const place of missing) await loadPlaceInfo(place);
    } finally {
      prefetching = false;
    }
    if (state.route === route) renderRoute();
  }

  /** "Why this fits": the theme's story plus how many stops are on theme. */
  function renderThemeNote(route) {
    const note = $("route-theme-note");
    const theme = route && route.theme && P.themeById(route.theme);
    note.hidden = !theme;
    if (!theme) return;
    const unique = route.stops.filter((stop, index) => route.stops.findIndex((other) => other.place.id === stop.place.id) === index);
    const sights = unique.filter((stop) => stop.place.kind === "poi");
    const pubs = unique.filter((stop) => stop.place.kind === "pub");
    const onTheme = (list) => list.filter((stop) => P.themeReason(stop.place, theme)).length;
    const pubLine = pubs.length
      ? onTheme(pubs) === pubs.length
        ? "every pub has a link to it too"
        : `${onTheme(pubs)} of ${pubs.length} pubs have a link (the rest are good historic pubs on the way)`
      : "";
    note.innerHTML =
      `<strong>${escapeHtml(theme.icon)} Why this fits:</strong> ${escapeHtml(theme.blurb)} ` +
      escapeHtml(
        `${sights.length ? `${onTheme(sights)} of ${sights.length} sights are on theme` : "An all-pub crawl"}` +
          (pubLine ? `, and ${pubLine}. ` : ". ") +
          "Each stop's gold tag says how."
      );
    const highlights = unique
      .map((stop) => ({ place: stop.place, reason: P.themeReason(stop.place, theme) }))
      .filter((item) => item.reason && /[a-z]{4,}.*[a-z]{4,}/i.test(item.reason) && !/^(Linked to|Plaque):/.test(item.reason))
      .slice(0, 3);
    if (highlights.length) {
      note.innerHTML += `<span class="highlights">${highlights
        .map((item) => `<span>• <strong>${escapeHtml(item.place.title)}</strong>: ${escapeHtml(item.reason)}</span>`)
        .join("")}</span>`;
    }
  }

  async function generateThemed(themeId) {
    const theme = P.themeById(themeId || state.theme);
    if (!theme) return;
    const settings = readSettings();
    if (settings.themeSights + settings.themePubs < 2) {
      setStatus($("theme-status"), "A crawl needs at least two stops.", "error");
      return;
    }
    setStatus($("theme-status"), "");
    const base = { ...settings, finish: settings.finish, mealStop: "none" };
    const result = P.generateThemedCrawl(
      theme,
      state.data.pois,
      state.data.pubs,
      settings.themeSights,
      settings.themePubs,
      newSeed(),
      base
    );
    if (!result.ok) {
      setStatus($("theme-status"), result.error, "error");
      if (state.tab !== "themes") toast(result.error, 4000);
      return;
    }
    setRoute({
      name: `${themeName(theme)} crawl`,
      source: "theme",
      theme: theme.id,
      stops: result.plan.stops,
      options: result.options,
      analyzed: result.plan.analyzed,
      rejected: new Set(),
      geometry: null,
      legs: null,
      distance: null,
      duration: null,
      routerMode: null,
      savedId: null,
      dirty: true,
      visited: [],
    });
    switchTab("route");
    if (isMobile()) setSheet("half");
    await updateRouteGeometry(true);
  }

  // ================================================================== crawl mode

  function firstUnvisited(route) {
    const visited = new Set(route.visited || []);
    for (let index = 0; index < route.stops.length; index += 1) if (!visited.has(index)) return index;
    return -1;
  }

  function startCrawl() {
    const route = state.route;
    if (!route) return;
    if (firstUnvisited(route) < 0) route.visited = [];
    state.crawl = { next: firstUnvisited(route), watchId: null, distance: null, accuracy: null };
    document.body.classList.add("crawling");
    hideBanner();
    if (navigator.geolocation && window.isSecureContext !== false) {
      state.crawl.watchId = navigator.geolocation.watchPosition(onCrawlPosition, onCrawlError, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 30000,
      });
    } else {
      toast("Location isn't available here, so tap “I'm here” at each stop.", 4000);
    }
    renderCrawl();
    renderRoute();
    renderPins();
    if (isMobile()) setSheet("peek");
    const next = route.stops[state.crawl.next];
    if (next) map.flyTo([next.place.lat, next.place.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
    persistSession();
  }

  function stopCrawl(silent) {
    if (!state.crawl) return;
    if (state.crawl.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(state.crawl.watchId);
    state.crawl = null;
    document.body.classList.remove("crawling");
    renderCrawl();
    if (state.route) {
      renderRoute();
      renderPins();
    }
    if (!silent) toast("Crawl paused. Your progress is kept. Tap Resume crawl to carry on.");
  }

  function onCrawlPosition(position) {
    const crawl = state.crawl;
    const route = state.route;
    if (!crawl || !route) return;
    const here = { lat: position.coords.latitude, lon: position.coords.longitude };
    state.userLocation = here;
    showUserMarker([here.lat, here.lon]);
    const stop = route.stops[crawl.next];
    if (!stop) return;
    crawl.distance = P.distance(here, stop.place);
    crawl.accuracy = position.coords.accuracy;
    const threshold = Math.max(40, Math.min(position.coords.accuracy || 0, 90));
    if (crawl.distance <= threshold && !dialog.open) arriveAt(crawl.next);
    else renderCrawl();
  }

  function onCrawlError(error) {
    if (!state.crawl) return;
    if (error.code === 1) {
      toast("Location is off, so tap “I'm here” when you reach each stop.", 4500);
      if (state.crawl.watchId != null) navigator.geolocation.clearWatch(state.crawl.watchId);
      state.crawl.watchId = null;
    }
    renderCrawl();
  }

  function arriveAt(index) {
    const route = state.route;
    if (!route || index < 0) return;
    const visited = new Set(route.visited || []);
    visited.add(index);
    route.visited = [...visited].sort((a, b) => a - b);
    const next = firstUnvisited(route);
    if (state.crawl) {
      state.crawl.next = next;
      state.crawl.distance = null;
    }
    const stop = route.stops[index];
    const nextStop = next >= 0 ? route.stops[next] : null;
    const leg = route.legs && route.legs[index];
    const isReturn = index === route.stops.length - 1 && index > 0 && stop.place.id === route.stops[0].place.id;
    openPlaceDialog(stop.place, {
      arrival: {
        title: nextStop ? (isReturn ? "Back where you started" : `You've made it to stop ${index + 1}`) : "That's the crawl done. Cheers!",
        sub: nextStop
          ? `Next: ${nextStop.place.title}${leg ? ` · ${P.formatDistance(leg.distance)}, about ${P.formatDuration(leg.duration)}` : ""}`
          : `${route.stops.length} stops${route.distance ? `, ${P.formatDistance(route.distance)} walked` : ""}. Get home safe.`,
      },
      nextStop,
    });
    if (!nextStop) stopCrawl(true);
    renderCrawl();
    renderRoute();
    renderPins();
    persistSession();
  }

  function skipStop() {
    const route = state.route;
    if (!route || !state.crawl || state.crawl.next < 0) return;
    const visited = new Set(route.visited || []);
    visited.add(state.crawl.next);
    route.visited = [...visited].sort((a, b) => a - b);
    state.crawl.next = firstUnvisited(route);
    state.crawl.distance = null;
    if (state.crawl.next < 0) {
      stopCrawl(true);
      toast("That was the last stop.");
    }
    renderCrawl();
    renderRoute();
    renderPins();
    persistSession();
  }

  function renderCrawl() {
    const bar = $("crawl-bar");
    const crawl = state.crawl;
    const route = state.route;
    bar.hidden = !(crawl && route && crawl.next >= 0);
    updateFooter();
    if (bar.hidden) return;
    const stop = route.stops[crawl.next];
    $("crawl-step").textContent = `Stop ${crawl.next + 1} of ${route.stops.length}`;
    $("crawl-next").textContent = stop.place.title;
    let distance = "Finding you…";
    if (crawl.watchId == null) distance = "Location off";
    else if (crawl.distance != null) distance = `${P.formatDistance(crawl.distance)} away`;
    $("crawl-distance").textContent = distance;
    $("crawl-directions").href = P.directionsUrl(stop.place);
  }

  // ================================================================== banner

  let bannerHandler = null;
  function showBanner(text, actionLabel, handler) {
    els.bannerText.textContent = text;
    els.bannerAction.textContent = actionLabel;
    els.bannerAction.hidden = !actionLabel;
    bannerHandler = handler;
    els.banner.hidden = false;
  }

  function hideBanner() {
    els.banner.hidden = true;
    bannerHandler = null;
  }

  // ================================================================== tabs, modes, sheet

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    ["plan", "themes", "route", "saved"].forEach((name) => {
      $(`panel-${name}`).hidden = name !== tab;
    });
    els.sheetBody.scrollTop = 0;
    updateFooter();
    persistSession();
  }

  function updateFooter() {
    els.footerPlan.hidden = state.tab !== "plan";
    $("footer-themes").hidden = state.tab !== "themes";
    els.footerRoute.hidden = !(state.tab === "route" && state.route);
    els.sheetFooter.hidden = els.footerPlan.hidden && els.footerRoute.hidden && $("footer-themes").hidden;
    if (state.route) {
      const saved = state.route.savedId && !state.route.dirty;
      els.saveButton.textContent = saved ? "Saved ✓" : state.route.savedId ? "Save changes" : "Save";
      els.saveButton.disabled = Boolean(saved);
      const startButton = $("start-crawl-button");
      startButton.textContent = state.crawl ? "End crawl" : state.route.visited && state.route.visited.length ? "Resume crawl" : "Start crawl";
      startButton.classList.toggle("primary", !state.crawl);
    }
    updatePeek();
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".segmented [data-mode]").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.mode === mode));
    });
    els.modePick.hidden = mode !== "pick";
    els.modeRandom.hidden = mode !== "random";
    setStatus(els.planStatus, "");
    updateAreaLayers();
    updateGenerateLabel();
    persistSession();
  }

  const SHEET_STATES = ["peek", "half", "full"];

  function updatePeek() {
    const footer = els.sheetFooter.hidden ? 0 : els.sheetFooter.offsetHeight;
    const peek = els.sheetGrip.offsetHeight + footer;
    if (peek > 0) document.documentElement.style.setProperty("--peek", `${peek}px`);
  }

  function setSheet(name) {
    if (!isMobile()) return;
    els.sheet.dataset.state = name;
    els.sheet.style.height = "";
    els.sheetHandle.setAttribute("aria-expanded", String(name !== "peek"));
    els.sheetHandle.setAttribute("aria-label", name === "peek" ? "Expand planner" : "Collapse planner");
    setTimeout(() => map.invalidateSize(), 250);
  }

  function initSheetDrag() {
    let drag = null;
    els.sheetGrip.addEventListener("pointerdown", (event) => {
      if (!isMobile() || event.button > 0) return;
      drag = {
        startY: event.clientY,
        startHeight: els.sheet.getBoundingClientRect().height,
        lastY: event.clientY,
        lastTime: performance.now(),
        velocity: 0,
        moved: false,
        pointerId: event.pointerId,
      };
    });
    els.sheetGrip.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        els.sheet.classList.add("dragging");
        els.sheetGrip.setPointerCapture(event.pointerId);
      }
      const now = performance.now();
      drag.velocity = (event.clientY - drag.lastY) / Math.max(1, now - drag.lastTime);
      drag.lastY = event.clientY;
      drag.lastTime = now;
      const max = window.innerHeight - 72;
      const height = Math.min(max, Math.max(80, drag.startHeight - dy));
      els.sheet.style.height = `${height}px`;
      els.sheet.dataset.state = height > 140 ? "half" : els.sheet.dataset.state;
    });
    const end = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const wasDrag = drag.moved;
      const velocity = drag.velocity;
      els.sheet.classList.remove("dragging");
      drag = null;
      if (!wasDrag) return;
      const height = els.sheet.getBoundingClientRect().height;
      const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) || 132;
      const targets = { peek, half: window.innerHeight * 0.55, full: window.innerHeight - 72 };
      let best = "half";
      if (velocity > 0.6) best = height < targets.half ? "peek" : "half";
      else if (velocity < -0.6) best = height > targets.half ? "full" : "half";
      else {
        best = SHEET_STATES.reduce((winner, name) =>
          Math.abs(targets[name] - height) < Math.abs(targets[winner] - height) ? name : winner
        );
      }
      setSheet(best);
    };
    els.sheetGrip.addEventListener("pointerup", end);
    els.sheetGrip.addEventListener("pointercancel", end);
    // A drag shouldn't also count as a tap on a tab.
    els.sheetGrip.addEventListener(
      "click",
      (event) => {
        if (els.sheet.classList.contains("dragging")) event.stopPropagation();
      },
      true
    );
    els.sheetHandle.addEventListener("click", () => {
      setSheet(els.sheet.dataset.state === "peek" ? "half" : "peek");
    });
  }

  // ================================================================== search

  function renderSearchResults() {
    const results = state.searchResults;
    const query = els.searchInput.value.trim();
    if (!query) {
      els.searchResults.hidden = true;
      els.searchInput.setAttribute("aria-expanded", "false");
      return;
    }
    els.searchResults.innerHTML = results.length
      ? results
          .map(
            (place, index) => `
          <li role="option" id="search-option-${index}" data-index="${index}" aria-selected="${index === state.searchActive}">
            <span class="dot ${place.kind}"></span>
            <span class="result-text">
              <span class="result-title">${escapeHtml(place.title)}</span>
              <span class="result-meta">${escapeHtml(placeMeta(place))}</span>
            </span>
          </li>`
          )
          .join("")
      : '<li class="no-results" role="option" aria-disabled="true">No matches. Try another name or street.</li>';
    els.searchResults.hidden = false;
    els.searchInput.setAttribute("aria-expanded", "true");
    if (state.searchActive >= 0) els.searchInput.setAttribute("aria-activedescendant", `search-option-${state.searchActive}`);
    else els.searchInput.removeAttribute("aria-activedescendant");
  }

  function buildSearchIndex() {
    if (!state.searchIndex && state.data) {
      state.searchIndex = P.createSearchIndex(state.data.pois.concat(state.data.pubs));
    }
    return state.searchIndex;
  }

  function searchNow() {
    const query = els.searchInput.value;
    if (query === state.searchQuery) return;
    state.searchQuery = query;
    state.searchResults = P.search(buildSearchIndex(), query, 8);
    state.searchActive = state.searchResults.length ? 0 : -1;
    renderSearchResults();
  }

  const runSearch = debounce(searchNow, 90);

  function chooseSearchResult(index) {
    const place = state.searchResults[index];
    if (!place) return;
    els.searchResults.hidden = true;
    els.searchInput.setAttribute("aria-expanded", "false");
    els.searchInput.blur();
    focusPlace(place);
  }

  // ================================================================== categories

  function renderCategories() {
    const counts = state.data.categoryCounts;
    els.categoryList.innerHTML = state.data.categories
      .map(
        (category) => `
        <label class="chip">
          <input type="checkbox" data-category="${escapeHtml(category)}" ${state.categories.has(category) ? "checked" : ""}>
          <span>${escapeHtml(P.categoryLabel(category))}</span>
          <span class="count">${formatCount(counts[category])}</span>
        </label>`
      )
      .join("");
  }

  // ================================================================== geolocation

  function showUserMarker(latlng) {
    if (!userMarker) {
      userMarker = L.marker(latlng, {
        icon: L.divIcon({ html: '<div class="user-dot"></div>', className: "", iconSize: [18, 18] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 2000,
      }).addTo(map);
    } else {
      userMarker.setLatLng(latlng);
    }
  }

  function locateUser(callback) {
    if (!navigator.geolocation) {
      toast("Location isn't available in this browser.");
      return;
    }
    els.locateButton.classList.add("active");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latlng = [position.coords.latitude, position.coords.longitude];
        state.userLocation = { lat: latlng[0], lon: latlng[1] };
        showUserMarker(latlng);
        if (callback) callback(state.userLocation);
        else map.flyTo(latlng, Math.max(map.getZoom(), 15), { duration: 0.6 });
      },
      (error) => {
        els.locateButton.classList.remove("active");
        toast(error.code === 1 ? "Location permission was denied." : "Couldn't find your location.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  // ================================================================== events

  function attachEvents() {
    // Settings: every control persists; some also refresh the map or route.
    SETTINGS.forEach(([id, key]) => {
      const input = $(id);
      const handler = () => {
        syncOutputs();
        if (["showPois", "showPubs", "minScore", "requireFood", "requireStepFree"].includes(key)) refreshMarkersSoon();
        if (key === "randomPoiCount") updateAreaStatus();
        persistSession();
      };
      input.addEventListener("input", handler);
      input.addEventListener("change", handler);
    });

    document.querySelectorAll("[data-stepper]").forEach((stepper) => {
      const input = stepper.querySelector("input");
      stepper.addEventListener("click", (event) => {
        const button = event.target.closest("[data-step]");
        if (!button) return;
        const next = (Number.parseInt(input.value, 10) || 0) + Number(button.dataset.step);
        input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
        input.dispatchEvent(new Event("change"));
      });
    });

    els.categoryList.addEventListener("change", (event) => {
      const input = event.target.closest("input[data-category]");
      if (!input) return;
      if (input.checked) state.categories.add(input.dataset.category);
      else state.categories.delete(input.dataset.category);
      refreshMarkersSoon();
      persistSession();
    });
    els.categoriesAll.addEventListener("click", () => {
      state.data.categories.forEach((category) => state.categories.add(category));
      renderCategories();
      refreshMarkers();
      persistSession();
    });
    els.categoriesNone.addEventListener("click", () => {
      state.categories.clear();
      renderCategories();
      refreshMarkers();
      persistSession();
    });

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        switchTab(button.dataset.tab);
        if (isMobile() && els.sheet.dataset.state === "peek") setSheet("half");
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const tabs = [...document.querySelectorAll(".tab")];
        const next = tabs[(tabs.indexOf(button) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        next.click();
      });
    });

    document.querySelectorAll(".segmented [data-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });

    els.areaEnabled.addEventListener("change", () => {
      state.area.enabled = els.areaEnabled.checked;
      if (state.area.enabled && !map.getBounds().contains([state.area.lat, state.area.lon])) {
        const center = map.getCenter();
        state.area.lat = center.lat;
        state.area.lon = center.lng;
      }
      updateAreaLayers();
      persistSession();
    });
    els.areaRadius.addEventListener("input", () => {
      state.area.radius = Number.parseInt(els.areaRadius.value, 10) || 1200;
      updateAreaLayers();
      persistSession();
    });
    els.areaFromMap.addEventListener("click", () => {
      const center = map.getCenter();
      moveArea(center.lat, center.lng, false);
    });
    els.areaFromMe.addEventListener("click", () => locateUser((location) => moveArea(location.lat, location.lon, true)));
    areaPin.on("drag", () => {
      const latlng = areaPin.getLatLng();
      state.area.lat = latlng.lat;
      state.area.lon = latlng.lng;
      areaCircle.setLatLng(latlng);
    });
    areaPin.on("dragend", () => {
      updateAreaStatus();
      persistSession();
    });
    map.on("click", (event) => {
      if (state.mode === "random" && state.area.enabled) moveArea(event.latlng.lat, event.latlng.lng, false);
    });

    els.generateButton.addEventListener("click", async () => {
      els.generateButton.classList.add("busy");
      try {
        await generate();
      } finally {
        els.generateButton.classList.remove("busy");
      }
    });
    els.clearSelectionButton.addEventListener("click", () => {
      state.selected = [];
      renderSelected();
      renderPins();
      updateHighlights();
      refreshOpenPopup();
      persistSession();
    });

    els.routeName.addEventListener("input", () => {
      if (!state.route) return;
      state.route.name = els.routeName.value.trim();
      state.route.dirty = true;
      els.routeSavedFlag.hidden = true;
      updateFooter();
      persistSession();
    });
    els.saveButton.addEventListener("click", saveCurrentRoute);
    $("reshuffle-button").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("busy");
      try {
        await reshuffleRoute();
      } finally {
        button.classList.remove("busy");
      }
    });
    $("daily-button").addEventListener("click", openDaily);
    $("city-select").addEventListener("change", (event) => switchCity(event.target.value));
    $("theme-grid").addEventListener("click", (event) => {
      const card = event.target.closest("[data-theme]");
      if (!card) return;
      state.theme = card.dataset.theme;
      renderThemes();
      persistSession();
    });
    $("theme-generate").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.classList.add("busy");
      try {
        await generateThemed(state.theme);
      } finally {
        button.classList.remove("busy");
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.data) renderDaily();
    });
    $("start-crawl-button").addEventListener("click", () => (state.crawl ? stopCrawl(false) : startCrawl()));
    $("crawl-here").addEventListener("click", () => state.crawl && arriveAt(state.crawl.next));
    $("crawl-skip").addEventListener("click", skipStop);
    $("crawl-stop").addEventListener("click", () => stopCrawl(false));
    dialog.addEventListener("click", (event) => {
      // Close on the backdrop or any [data-close] control.
      if (event.target === dialog || event.target.closest("[data-close]")) closePlaceDialog();
    });
    dialog.addEventListener("close", () => {
      dialogPlaceId = null;
    });
    $("how-dismiss").addEventListener("click", () => {
      $("how-it-works").hidden = true;
      store.set(STORAGE.howDismissed, true);
    });
    els.shareButton.addEventListener("click", shareCurrentRoute);
    els.gpxButton.addEventListener("click", downloadGpx);
    els.gmapsButton.addEventListener("click", openGoogleMaps);
    els.clearRouteButton.addEventListener("click", () => {
      clearRoute();
      switchTab("plan");
    });

    els.bannerAction.addEventListener("click", () => {
      if (bannerHandler) bannerHandler();
      hideBanner();
    });
    els.bannerClose.addEventListener("click", hideBanner);

    // Delegated actions for lists and popups. Capture phase, because Leaflet
    // stops click propagation out of popups.
    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const { action, id } = target.dataset;
      const index = Number(target.dataset.index);
      switch (action) {
        case "toggle-stop":
          toggleStop(id);
          if (target.hasAttribute("data-refresh-dialog") && state.byId.get(id)) renderPlaceActions(state.byId.get(id), null);
          break;
        case "info": {
          const place = state.byId.get(id);
          if (place) openPlaceDialog(place, null);
          break;
        }
        case "show-help":
          $("how-it-works").hidden = false;
          switchTab("plan");
          if (isMobile()) setSheet("full");
          break;
        case "focus": {
          const place = state.byId.get(id);
          if (place) focusPlace(place, { keepSheet: true });
          break;
        }
        case "move-up":
          moveSelected(id, -1);
          break;
        case "move-down":
          moveSelected(id, 1);
          break;
        case "unselect":
          toggleStop(id);
          break;
        case "swap":
          swapStop(index);
          break;
        case "remove-stop":
          removeRouteStop(index);
          break;
        case "open-saved":
          openSavedRoute(id);
          break;
        case "share-saved":
          shareSaved(id);
          break;
        case "rename-saved":
          renameSaved(id);
          break;
        case "delete-saved":
          deleteSaved(id);
          break;
        default:
          break;
      }
    }, true);

    // Search
    els.searchInput.addEventListener("input", runSearch);
    els.searchInput.addEventListener("focus", () => {
      if (els.searchInput.value.trim()) renderSearchResults();
    });
    els.searchInput.addEventListener("keydown", (event) => {
      const count = state.searchResults.length;
      if (event.key === "ArrowDown" && count) {
        event.preventDefault();
        state.searchActive = (state.searchActive + 1) % count;
        renderSearchResults();
      } else if (event.key === "ArrowUp" && count) {
        event.preventDefault();
        state.searchActive = (state.searchActive - 1 + count) % count;
        renderSearchResults();
      } else if (event.key === "Enter") {
        event.preventDefault();
        searchNow();
        if (state.searchActive >= 0) chooseSearchResult(state.searchActive);
      } else if (event.key === "Escape") {
        els.searchResults.hidden = true;
        els.searchInput.setAttribute("aria-expanded", "false");
      }
    });
    els.searchResults.addEventListener("pointerdown", (event) => event.preventDefault());
    els.searchResults.addEventListener("click", (event) => {
      const item = event.target.closest("[data-index]");
      if (item) chooseSearchResult(Number(item.dataset.index));
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#search")) {
        els.searchResults.hidden = true;
        els.searchInput.setAttribute("aria-expanded", "false");
      }
    });

    els.locateButton.addEventListener("click", () => locateUser());
    els.layersButton.addEventListener("click", () => {
      switchTab("plan");
      els.filtersDetails.open = true;
      if (isMobile()) setSheet("full");
      setTimeout(() => els.filtersDetails.scrollIntoView({ behavior: "smooth", block: "start" }), 260);
    });

    placeLayer.on("click", onMarkerClick);
    placeLayer.on("mouseover", onMarkerHover);
    map.on("popupclose", () => {
      state.popupPlaceId = null;
    });
    map.on("moveend", persistSession);

    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && document.activeElement === document.body) {
        event.preventDefault();
        els.searchInput.focus();
      }
    });

    window.addEventListener("hashchange", importSharedFromHash);
    // Never lose the last change when the tab is closed or backgrounded.
    window.addEventListener("pagehide", () => persistSession.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistSession.flush();
    });
    const onLayoutChange = () => {
      if (!isMobile()) {
        els.sheet.style.height = "";
        els.sheet.dataset.state = "peek";
      }
      updatePeek();
      map.invalidateSize();
    };
    if (mobileQuery.addEventListener) mobileQuery.addEventListener("change", onLayoutChange);
    window.addEventListener("resize", debounce(onLayoutChange, 150));
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE.saved) {
        loadSaved();
        renderSaved();
      }
    });
  }

  // ================================================================== startup

  function restoreSession() {
    const session = store.get(STORAGE.session, null);
    if (!session || session.version !== 1) return;
    applySettings(session.settings);
    if (Array.isArray(session.categories)) {
      state.categories = new Set(session.categories.filter((category) => state.data.categories.includes(category)));
      if (session.categoryVersion !== CATEGORY_SETTINGS_VERSION) {
        DEFAULT_HIDDEN_CATEGORIES.forEach((category) => state.categories.delete(category));
      }
    }
    if (session.area && Number.isFinite(session.area.lat) && Number.isFinite(session.area.lon)) {
      state.area = {
        enabled: Boolean(session.area.enabled),
        lat: session.area.lat,
        lon: session.area.lon,
        radius: Math.min(5000, Math.max(300, Number(session.area.radius) || 1200)),
      };
      els.areaRadius.value = String(state.area.radius);
    }
    if (Array.isArray(session.selected)) state.selected = session.selected.filter((id) => state.byId.has(id));
    if (session.mode === "random" || session.mode === "pick") state.mode = session.mode;
    if (["plan", "themes", "route", "saved"].includes(session.tab)) state.tab = session.tab;
    if (session.theme && P.themeById(session.theme)) state.theme = session.theme;
    // Ignore a remembered view that isn't over this city.
    const inCity = (view) => L.latLngBounds(state.city.bounds).pad(0.5).contains([view.lat, view.lon]);
    if (session.view && Number.isFinite(session.view.lat) && inCity(session.view)) {
      map.setView([session.view.lat, session.view.lon], session.view.zoom || 12, { animate: false });
    }
    if (session.route && Array.isArray(session.route.stops)) {
      const { route } = deserializeRoute(session.route);
      if (route.stops.length >= 2) state.route = route;
    }
  }

  function renderDataNote() {
    const fetched = state.data.dataFetchedAt ? formatDate(state.data.dataFetchedAt) : "";
    // Credit the sources this city's data actually came from (ids: n/w/r OSM, d Wikidata, q Open Plaques).
    const places = state.data.pois.concat(state.data.pubs);
    const uses = (pattern) => places.some((place) => pattern.test(place.id));
    const sources = [
      uses(/^p?[nwr]\d/) && `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>`,
      uses(/^p?d\d/) && `<a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a>`,
      uses(/^q\d/) && `<a href="https://openplaques.org" target="_blank" rel="noopener">Open Plaques</a>`,
    ].filter(Boolean);
    els.dataNote.innerHTML =
      `Data: ${sources.join(" and ")}` +
      (fetched ? `, updated ${escapeHtml(fetched)}` : "") +
      `. Walking routes by <a href="https://routing.openstreetmap.de" target="_blank" rel="noopener">FOSSGIS OSRM</a>. ` +
      `Stories from Wikipedia. <button type="button" data-action="show-help">How it works</button>`;
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const secure = location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname);
    if (!secure) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  async function start() {
    registerServiceWorker();
    initSheetDrag();
    applyCity(await loadCities());
    try {
      const raw = await loadDataset();
      els.loadingText.textContent = "Drawing the map…";
      indexData(P.decodeDataset(raw));
    } catch (error) {
      console.error(error);
      els.loading.classList.add("error");
      els.loadingText.textContent = "Couldn't load the map data. Check your connection and refresh.";
      return;
    }

    restoreSession();
    loadSaved();
    $("how-it-works").hidden = Boolean(store.get(STORAGE.howDismissed, false));
    createMarkers();
    renderCategories();
    syncOutputs();
    refreshMarkers();
    renderSelected();
    renderSaved();
    renderDataNote();
    renderDaily();
    renderThemes();
    setMode(state.mode);
    switchTab(state.route || state.tab !== "route" ? state.tab : "plan");
    renderRoute();
    renderPins();
    updateHighlights();
    if (state.route) {
      if (state.route.geometry) drawRouteLine(false);
      else updateRouteGeometry(false);
    }
    attachEvents();

    // The search index is only needed once someone types, so build it when idle.
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(buildSearchIndex);

    importSharedFromHash();
    updatePeek();
    map.invalidateSize();
    els.loading.classList.add("done");
    setTimeout(() => els.loading.remove(), 400);
  }

  start();
})();
