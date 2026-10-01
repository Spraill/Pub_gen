/* London Crawl Planner: UI, map and persistence. Planning logic lives in planner.js. */
(function () {
  "use strict";

  const P = window.PubGenPlanner;
  const scriptEl = document.getElementById("app-script");
  const VERSION = (scriptEl && scriptEl.dataset.version) || "dev";
  const ROUTER_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/";
  const ROUTER_TIMEOUT_MS = 12000;
  const LONDON_BOUNDS = [
    [51.286, -0.51],
    [51.692, 0.334],
  ];
  const STORAGE = { session: "pubgen.session.v1", saved: "pubgen.saved.v1" };
  const MAX_SAVED = 100;
  const COLORS = { poi: "#d85b04", pub: "#1d5fd1", selected: "#0e8a62", route: "#253050", area: "#cf2f45" };

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
    sumTotal: $("sum-total"),
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
    ["round-trip", "roundTrip", "bool"],
    ["require-food", "requireFood", "bool"],
    ["require-step-free", "requireStepFree", "bool"],
    ["prefer-real-ale", "preferRealAle", "bool"],
    ["prefer-outdoor", "preferOutdoor", "bool"],
    ["prefer-dog", "preferDog", "bool"],
    ["minutes-per-pub", "minutesPerPub", "int"],
    ["minutes-per-sight", "minutesPerSight", "int"],
    ["show-pois", "showPois", "bool"],
    ["show-pubs", "showPubs", "bool"],
    ["min-score", "minScore", "int"],
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
    pubSignature: "",
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

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const MARKER_STYLES = {
    poi: { radius: 6.5, color: "#ffffff", weight: 1.5, fillColor: COLORS.poi, fillOpacity: 0.95 },
    pub: { radius: 6.5, color: "#ffffff", weight: 1.5, fillColor: COLORS.pub, fillOpacity: 0.95 },
    active: { radius: 8.5, color: "#ffffff", weight: 2, fillColor: COLORS.selected, fillOpacity: 1 },
  };

  function clusterGroup(kind) {
    return L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: false,
      disableClusteringAtZoom: 17,
      maxClusterRadius: (zoom) => (zoom < 13 ? 60 : 45),
      chunkedLoading: true,
      removeOutsideVisibleBounds: true,
      iconCreateFunction(cluster) {
        const count = cluster.getChildCount();
        const size = count < 10 ? 30 : count < 100 ? 36 : count < 1000 ? 42 : 48;
        const label = count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : count;
        return L.divIcon({
          html: `<div class="cluster ${kind}" style="width:${size}px;height:${size}px">${label}</div>`,
          className: "",
          iconSize: [size, size],
        });
      },
    });
  }

  const poiLayer = clusterGroup("poi");
  const pubLayer = clusterGroup("pub");
  map.addLayer(poiLayer);
  map.addLayer(pubLayer);

  const routeOutline = L.polyline([], { color: "#ffffff", weight: 9, opacity: 0.85, lineJoin: "round", interactive: false }).addTo(map);
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

  function pinIcon(kind, label, pending) {
    return L.divIcon({
      html: `<div class="pin ${kind}${pending ? " pending" : ""}"><span>${escapeHtml(label)}</span></div>`,
      className: "",
      iconSize: [30, 30],
      iconAnchor: [15, 36],
      popupAnchor: [0, -34],
    });
  }

  // ================================================================== data

  async function loadDataset() {
    try {
      const response = await fetch(`./data/places.json?v=${encodeURIComponent(VERSION)}`);
      if (!response.ok) throw new Error(`Data request failed (${response.status})`);
      return await response.json();
    } catch (error) {
      // file:// pages cannot fetch(); fall back to the script bundle.
      if (window.__PUBGEN_DATA__) return window.__PUBGEN_DATA__;
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./data/places.js";
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
    data.categories.forEach((category) => state.categories.add(category));
  }

  function createMarkers() {
    const add = (place) => {
      const marker = L.circleMarker([place.lat, place.lon], MARKER_STYLES[place.kind]);
      marker.placeId = place.id;
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
    return poi.categories.some((category) => state.categories.has(category));
  }

  function refreshMarkers() {
    const settings = readSettings();
    state.filteredPois = state.data.pois.filter((poi) => poiPassesFilters(poi, settings));
    poiLayer.clearLayers();
    if (settings.showPois) poiLayer.addLayers(state.filteredPois.map((poi) => state.markers.get(poi.id)));

    const pubSignature = [settings.showPubs, settings.requireFood, settings.requireStepFree].join("|");
    if (pubSignature !== state.pubSignature) {
      state.pubSignature = pubSignature;
      state.visiblePubs = state.data.pubs.filter((pub) => P.pubMatchesRequirements(pub, settings));
      pubLayer.clearLayers();
      if (settings.showPubs) pubLayer.addLayers(state.visiblePubs.map((pub) => state.markers.get(pub.id)));
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
    const addPin = (place, label, pending) => {
      const pin = L.marker([place.lat, place.lon], {
        icon: pinIcon(place.kind, label, pending),
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
      (loop ? stops.slice(0, -1) : stops).forEach((stop, index) => addPin(stop.place, index + 1, false));
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

    return `
      <div class="popup-kicker">${kicker}</div>
      <h3 class="popup-title">${escapeHtml(place.title)}</h3>
      ${body}
      <div class="popup-links">${links.join("")}</div>
      <div class="popup-actions">
        <button type="button" class="btn ${selected ? "" : "primary"} grow" data-action="toggle-stop" data-id="${escapeHtml(place.id)}">
          ${selected ? "Remove from crawl" : "Add to crawl"}
        </button>
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
    if (!first) return "London crawl";
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
      const rng = P.createRng(`${Date.now()}:${Math.random()}`);
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
        options = { ...settings, pubCount: 0, mealStop: "none", orderMode: "optimize" };
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
      map.fitBounds(bounds, { paddingTopLeft: [40, 40], paddingBottomRight: [els.sheet.offsetWidth + 48, 40], maxZoom: 17 });
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
    renderRoute();
    renderPins();
    updateHighlights();
    updateRouteGeometry(false);
  }

  function clearRoute() {
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

    const settings = readSettings();
    els.sumStops.textContent = `${uniqueStops.length - pubCount} + ${pubCount} 🍺`;
    els.sumDistance.textContent = route.distance != null ? P.formatDistance(route.distance) : "…";
    els.sumWalk.textContent = route.duration != null ? P.formatDuration(route.duration) : "…";
    els.sumTotal.textContent =
      route.duration != null
        ? P.formatDuration(P.totalTimeSeconds(stops, route.duration, settings.minutesPerPub, settings.minutesPerSight))
        : "…";

    if (route.routerMode === "fallback") {
      setStatus(els.routeStatus, "Walking directions are unavailable right now, so lines are straight and times are estimates.", "error");
    } else if (route.routerMode === "router") {
      setStatus(els.routeStatus, "");
    }

    const legs = route.legs || [];
    const canRemove = uniqueStops.length > 2;
    const items = [];
    stops.forEach((stop, index) => {
      const place = stop.place;
      const isReturn = loop && index === stops.length - 1;
      const number = isReturn ? 1 : index + 1;
      const tags = [];
      if (stop.mealStop) tags.push('<span class="tag meal">Meal stop</span>');
      if (place.kind === "pub") P.pubFeatures(place).slice(0, 3).forEach((f) => tags.push(`<span class="tag">${escapeHtml(f)}</span>`));
      const actions = [
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
      items.push(`
        <li class="stop">
          <span class="stop-num ${place.kind}">${number}</span>
          <div class="stop-main" data-action="focus" data-id="${escapeHtml(place.id)}">
            <div class="stop-title">${isReturn ? "Back to " : ""}${escapeHtml(place.title)}</div>
            <div class="stop-meta">${escapeHtml(placeMeta(place))}</div>
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
    const base = window.location.href.split("#")[0];
    return `${base}#${P.encodeShare(name, tokensOrStops)}`;
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
    const title = name || "London crawl";
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
    ["plan", "route", "saved"].forEach((name) => {
      $(`panel-${name}`).hidden = name !== tab;
    });
    els.sheetBody.scrollTop = 0;
    updateFooter();
    persistSession();
  }

  function updateFooter() {
    els.footerPlan.hidden = state.tab !== "plan";
    els.footerRoute.hidden = !(state.tab === "route" && state.route);
    els.sheetFooter.hidden = els.footerPlan.hidden && els.footerRoute.hidden;
    if (state.route) {
      const saved = state.route.savedId && !state.route.dirty;
      els.saveButton.textContent = saved ? "Saved ✓" : state.route.savedId ? "Save changes" : "Save";
      els.saveButton.disabled = Boolean(saved);
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
        if ((key === "minutesPerPub" || key === "minutesPerSight") && state.route) renderRoute();
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

    poiLayer.on("click", onMarkerClick);
    pubLayer.on("click", onMarkerClick);
    poiLayer.on("mouseover", onMarkerHover);
    pubLayer.on("mouseover", onMarkerHover);
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
    if (["plan", "route", "saved"].includes(session.tab)) state.tab = session.tab;
    if (session.view && Number.isFinite(session.view.lat)) {
      map.setView([session.view.lat, session.view.lon], session.view.zoom || 12, { animate: false });
    }
    if (session.route && Array.isArray(session.route.stops)) {
      const { route } = deserializeRoute(session.route);
      if (route.stops.length >= 2) state.route = route;
    }
  }

  function renderDataNote() {
    const fetched = state.data.dataFetchedAt ? formatDate(state.data.dataFetchedAt) : "";
    els.dataNote.innerHTML =
      `Data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ` +
      `and <a href="https://openplaques.org" target="_blank" rel="noopener">Open Plaques</a>` +
      (fetched ? `, updated ${escapeHtml(fetched)}` : "") +
      `. Walking routes by <a href="https://routing.openstreetmap.de" target="_blank" rel="noopener">FOSSGIS OSRM</a>.`;
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
    createMarkers();
    renderCategories();
    syncOutputs();
    refreshMarkers();
    renderSelected();
    renderSaved();
    renderDataNote();
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
