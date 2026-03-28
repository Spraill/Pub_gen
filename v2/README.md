# London Crawl Planner V2

V2 is a separate static app with:

- a broader London POI dataset built from OpenStreetMap and Open Plaques
- the same London pub dataset source as V1
- mobile-first UI
- category filters
- targeted crawl planning
- random area crawl planning

Build outputs are written to `public/`, which is the folder to host.

## Build

Refresh everything:

```bash
python3 v2/build_v2.py --refresh-all
```

Refresh only the richer POI dataset:

```bash
python3 v2/build_v2.py --refresh-pois
```

Build and mirror the deployable site into the repo-root `docs/` folder for GitHub Pages:

```bash
python3 v2/build_v2.py --publish-docs
```

Use the generated static site locally:

```bash
python3 -m http.server 8000 -d v2/public
```

The build also writes `public/data/payload.js`, so opening `public/index.html` directly now still loads the POI and pub data bundle.

## Hosting

Host the whole `v2/public/` folder on any static host:

- Netlify
- GitHub Pages
- Cloudflare Pages

For GitHub Pages specifically, publish the repo-root `docs/` folder rather than `v2/public/`. The helper above copies the built site there.

The build also writes `public/.nojekyll`, so GitHub Pages will serve the folder cleanly.
