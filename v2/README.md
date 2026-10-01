# London Crawl Planner

A static web app for planning walking pub crawls through London's sights:
museums, blue plaques, parks, historic buildings and historic pubs.

- **Plan**: pick sights or pubs on the map (or search), or press *Surprise me*
  for a walkable random crawl (set sights to 0 for a pub-only crawl). Pubs are
  added along the walk, with options for food, step-free access, historic pubs,
  real ale, beer gardens, dog-friendly pubs and avoiding chains.
- **Route**: real walking directions with per-leg times, finishing at a pub by
  default, swap or remove any pub, *Another version* (same settings, new luck),
  GPX download and Google Maps hand-off.
- **Crawl of the day**: the same for everyone on a given London date. It hinges
  on a notable historic, beautiful or culturally significant sight (and a
  historic pub on alternate days) in an area that rotates daily (City, West
  End, East, North, South, West…), with 3 sights and 4–5 pubs.
- **Photos**: tapping a place shows its photo; *More info* opens a gallery
  (Wikidata lead image plus the place's Wikimedia Commons category, which often
  has pub interiors), each credited to its photographer and licence. Set
  `mapillaryToken` in `config.js` to add street-level exterior photos for pubs
  without a Commons photo.
- **Crawl mode**: *Start crawl* follows your location. When you reach a stop
  you get its story (Wikipedia summary, plaque inscription, pub details), then
  the walk to the next one. *I'm here* works without GPS.
- **Save and share**: routes are saved on the device; *Share* produces a link
  that rebuilds the exact route on any phone or computer.
- Works on phones (bottom sheet) and desktops (side panel), light and dark
  mode, installable as a PWA and usable offline once loaded (apart from map
  tiles, routing and Wikipedia).

## Layout

```
v2/
  site/                  source for the web app (edit these)
    index.html           markup, CSP
    styles.css           theme and layout
    planner.js           pure planning logic (no DOM); shared with the Node tests
    app.js               UI, map, persistence, crawl mode
    config.js            public deployment config (ads/premium hooks, service URLs)
    sw.js                service worker (offline cache), version-stamped at build
    vendor/              Leaflet 1.9.4 + markercluster 1.5.3 (vendored, no CDN)
    fonts/               Fraunces (SIL OFL)
  scripts/
    fetch_london_pubs.py     OpenStreetMap pubs via Overpass
    fetch_london_pois_v2.py  OSM sights + Open Plaques + Wikidata popularity
  data/                  raw GeoJSON snapshots (committed)
  build_v2.py            curates data and writes the site to public/
  public/                build output (deploy this)
  tests/                 unit tests (JS + Python) and Playwright browser test
docs/                    copy of public/ for GitHub Pages
```

## Commands

```bash
npm run build      # build v2/public from the committed data
npm run publish    # build and mirror to docs/ (GitHub Pages)
npm run refresh    # re-fetch OSM / Open Plaques / Wikidata, rebuild, publish
npm test           # planner unit tests (Node) + build tests (Python)
npm run test:e2e   # browser test, desktop + mobile (needs `npm i playwright`)
npm run serve      # http://localhost:8000
```

Python 3.10+ and Node 18+; no other dependencies.

## Data

| What | Source | Licence |
| --- | --- | --- |
| Pubs | OpenStreetMap (`amenity=pub`) | ODbL, attribute "© OpenStreetMap contributors" |
| Sights | OpenStreetMap (museums, heritage, parks, art, markets…) | ODbL |
| Plaques | Open Plaques London export | CC BY-SA |
| Popularity | Wikidata sitelink counts (number of Wikipedia languages) | CC0 |
| Stop stories | Wikipedia page summaries, fetched in the browser on demand | CC BY-SA 4.0, credited in the app |
| Photos | Wikimedia Commons (via Wikidata P18/P373 and OSM tags); optional Mapillary | per-photo licence, credited in the app |
| Walking routes | FOSSGIS OSRM (`routing.openstreetmap.de`) | free demo service, fair use |

**Freshness.** `.github/workflows/refresh-data.yml` re-fetches everything weekly
and commits only if the data changed. A refresh that shrinks either dataset by
more than 30% is rejected, so a flaky upstream API cannot empty the map.

**Curation** (`build_v2.py`) runs on every build:

- blue plaques are off by default on the map (switch them on in Map filters);
- drops zoo exhibits and rides, shops, toilets, allotments, playing fields and
  plain local libraries (unless notable: listed, on Wikipedia or Wikidata);
- removes pubs marked closed or disused;
- boosts listed buildings (Grade I/II*/II), Royal Parks, National Trust, English
  Heritage and other notable operators, places with many name translations and
  (after a refresh) places covered by many Wikipedia languages;
- turns pubs that appear in the sights data (listed pub buildings) into
  "Historic pub" badges, and flags brewpubs, real fires and chain pubs.

**What isn't included, and why.** Google and TripAdvisor ratings can't be
stored or shown on a non-Google map under their terms. CAMRA data (WhatPub,
Good Beer Guide, National Inventory) isn't openly licensed. Ask CAMRA about a
data partnership if you want "CAMRA listed" badges. The open-data substitutes
used here are OSM `real_ale`, listed-building status and `microbrewery`.

## Security and privacy

- Static site with no backend, no accounts, no cookies and no analytics.
  Saved routes, settings and cached stop stories stay in the browser's local
  storage on the device.
- Sharing puts only stop IDs and the route name in the URL fragment (`#r=…`).
  Fragments are not sent to the web server.
- Third-party requests: map tiles (OSM), walking routes (FOSSGIS OSRM; stop
  coordinates only), Wikipedia/Wikidata/Commons (the place being viewed).
  Location never leaves the device.
- A Content-Security-Policy restricts scripts to the site itself and network
  access to those services. All data is HTML-escaped before rendering, links
  are restricted to `http(s)`, and shared links are validated against a strict
  ID pattern.

## Shipping to app stores

The app is already a PWA (manifest + service worker). For the App Store and
Play Store, wrap `v2/public` with [Capacitor](https://capacitorjs.com):

1. `npm i @capacitor/core @capacitor/cli && npx cap init` with `webDir: "v2/public"`.
2. Add `@capacitor/geolocation` for background-friendly location if needed,
   and add the platforms (`npx cap add ios android`).
3. Map tiles: OSM's public tile servers are not meant for heavy app traffic.
   Before launch, switch `tileUrl` in `site/config.js` to a commercial or
   self-hosted provider (e.g. MapTiler, Stadia, Thunderforest).
4. Routing: the FOSSGIS OSRM server is a fair-use demo. For a store release,
   host OSRM or use a paid routing API and set `routerUrl` in `config.js`.

### Ads and the paid upgrade

Both are hooks, off by default, so the web version stays clean:

- `config.js` → `ads.enabled: true`, and the native wrapper defines
  `window.PubGenAds = { render(slotElement) { … } }` (e.g. AdMob banner via
  `@capacitor-community/admob`). The app shows one unobtrusive slot under the
  route list and never inside crawl mode.
- `window.PubGenPremium = { active: true }` once a store purchase is verified
  (e.g. RevenueCat or the store billing plugin). Premium hides ads; the free
  app stays fully functional.

Update the CSP `connect-src`/`img-src` in `index.html` for any ad or billing
domains you add.
