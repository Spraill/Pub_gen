#!/usr/bin/env node
/*
 * Browser smoke test: serves v2/public, drives the app in Chromium on desktop
 * and mobile viewports, and checks planning, saving, sharing and reloading.
 *
 *   node v2/tests/e2e.cjs            (needs `playwright` installed)
 *   SCREENSHOTS=dir node v2/tests/e2e.cjs
 *
 * Map tiles and the walking router are stubbed so the test runs offline.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "public");
const SHOTS = process.env.SCREENSHOTS || "";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP89+3bfwAJcAPZm2D4ZwAAAABJRU5ErkJggg==",
  "base64"
);

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (error, body) => {
      if (error) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function stubNetwork(context, routerCalls) {
  const json = (route, body) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  await context.route(/wikidata\.org/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("action") === "wbgetclaims") {
      const property = params.get("property");
      const value = property === "P18" ? "Test photo.jpg" : "Test category";
      return json(route, { claims: { [property]: [{ mainsnak: { datavalue: { value } } }] } });
    }
    const id = params.get("ids");
    return json(route, { entities: { [id]: { sitelinks: { enwiki: { title: "Test Place" } } } } });
  });
  await context.route(/commons\.wikimedia\.org/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    const category = params.get("generator") === "categorymembers";
    const page = (title, index) => ({
      title,
      index,
      imageinfo: [
        {
          thumburl: `https://upload.wikimedia.org/test/${index}.jpg`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Test.jpg",
          extmetadata: { Artist: { value: "Test Photographer" }, LicenseShortName: { value: "CC BY-SA 4.0" } },
        },
      ],
    });
    return json(route, {
      query: { pages: category ? { 2: page("File:Saloon bar interior.jpg", 2), 3: page("File:Front.jpg", 3) } : { 1: page("File:Test photo.jpg", 1) } },
    });
  });
  await context.route(/upload\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG }));
  await context.route(/wikipedia\.org\/api/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        type: "standard",
        title: "Test Place",
        description: "Famous London landmark",
        extract: "This is the Wikipedia summary for the stop.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Test_Place" } },
      }),
    })
  );
  await context.route(/tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG })
  );
  await context.route(/routing\.openstreetmap\.de/, (route) => {
    routerCalls.push(route.request().url());
    const coords = new URL(route.request().url()).pathname.split("/").pop().split(";").map((pair) => pair.split(",").map(Number));
    const legs = coords.slice(1).map(() => ({ distance: 800, duration: 600 }));
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code: "Ok",
        routes: [{ geometry: { type: "LineString", coordinates: coords }, distance: 800 * legs.length, duration: 600 * legs.length, legs }],
      }),
    });
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function searchAndAdd(page, query) {
  await page.fill("#search-input", query);
  await page.waitForSelector("#search-results li[data-index]");
  await page.keyboard.press("Enter");
  await page.locator(".leaflet-popup .popup-title", { hasText: query }).waitFor();
  await page.locator('.leaflet-popup [data-action="toggle-stop"]', { hasText: "Add to crawl" }).click();
  await page.locator('.leaflet-popup [data-action="toggle-stop"]', { hasText: "Remove from crawl" }).waitFor();
}

async function run() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const errors = [];
  let failures = 0;

  async function scenario(name, contextOptions, fn) {
    const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
    const routerCalls = [];
    await stubNetwork(context, routerCalls);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(`${name}: ${message.text()}`);
    });
    const started = Date.now();
    try {
      await fn(page, routerCalls, context);
      console.log(`ok - ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failures += 1;
      console.log(`not ok - ${name}\n${error.stack}`);
      await shot(page, `failure-${name.replace(/\W+/g, "-")}`);
    } finally {
      await context.close();
    }
  }

  await scenario("desktop: plan, save, share, reload", { viewport: { width: 1400, height: 900 } }, async (page, routerCalls, context) => {
    const loadStart = Date.now();
    await page.goto(base);
    await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    console.log(`   data loaded and map ready in ${Date.now() - loadStart} ms`);
    assert.notEqual(await page.textContent("#count-pois"), "…");
    await shot(page, "desktop-start");

    // Crawl of the day card.
    await page.waitForSelector("#daily-card:not([hidden])");
    assert.ok((await page.textContent("#daily-title")).length > 3);
    await shot(page, "desktop-daily-card");

    await searchAndAdd(page, "British Museum");
    await page.waitForSelector(".leaflet-popup .popup-photo img");
    await searchAndAdd(page, "Tower of London");
    assert.equal(await page.locator("#selected-list .stop").count(), 2);
    await shot(page, "desktop-selected");

    await page.click("#generate-button");
    await page.waitForSelector("#route-list .stop");
    await page.waitForFunction(() => document.querySelector("#sum-distance").textContent !== "…");
    assert.ok(routerCalls.length >= 1, "router was called");
    const stops = await page.locator("#route-list .stop").count();
    assert.equal(stops, 5, "2 sights + 3 pubs");
    assert.equal(await page.locator("#route-list .stop-num").last().getAttribute("class"), "stop-num pub", "finishes at a pub");
    assert.equal(await page.locator(".leaflet-marker-pane .pin").count(), 5);
    await shot(page, "desktop-route");

    // Place info from Wikipedia.
    await page.locator('#route-list [data-action="info"]').first().click();
    await page.waitForSelector("#place-dialog[open]");
    await page.waitForFunction(() => document.querySelector("#place-content").textContent.includes("Wikipedia summary"));
    await page.waitForSelector("#place-gallery:not([hidden]) .slide");
    assert.equal(await page.locator("#place-gallery .slide").count(), 3);
    assert.match(await page.textContent("#place-gallery"), /Test Photographer/);
    assert.equal(await page.locator("#place-gallery .slide-tag").count(), 1, "interior labelled");
    assert.match(await page.textContent("#place-credit"), /Wikipedia/);
    await shot(page, "desktop-place-info");
    await page.click("#place-dialog [data-close]");
    await page.waitForFunction(() => !document.querySelector("#place-dialog").open);

    // Swap a pub and remove a stop.
    const before = await page.locator("#route-list .stop-title").allTextContents();
    await page.locator('[data-action="swap"]').first().click();
    await page.waitForFunction((old) => {
      const now = [...document.querySelectorAll("#route-list .stop-title")].map((el) => el.textContent);
      return now.join("|") !== old.join("|");
    }, before);
    await page.locator('[data-action="remove-stop"]').last().click();
    assert.equal(await page.locator("#route-list .stop").count(), 4);

    // Save and share.
    await page.fill("#route-name", "Test crawl");
    await page.click("#save-button");
    await page.waitForSelector("#route-saved-flag:not([hidden])");
    assert.equal(await page.textContent("#saved-badge"), "1");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click("#share-button");
    const shared = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(shared, /#r=/);
    assert.match(shared, /n=Test\+crawl/);

    // GPX download.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#gpx-button")]);
    assert.equal(download.suggestedFilename(), "test-crawl.gpx");

    // Reload restores the session route and saved list.
    await page.reload();
    await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    assert.equal(await page.locator("#route-list .stop").count(), 4);
    await page.click("#tab-saved");
    assert.equal(await page.locator("#saved-list .saved-item").count(), 1);
    await shot(page, "desktop-saved");

    // Open the share link in a fresh context (another device).
    const other = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: "block" });
    await stubNetwork(other, []);
    const friend = await other.newPage();
    friend.on("pageerror", (error) => errors.push(`shared: ${error.message}`));
    await friend.goto(shared.replace(/^https?:\/\/[^/]+\//, base));
    await friend.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    await friend.waitForSelector("#banner:not([hidden])");
    assert.equal(await friend.locator("#route-list .stop").count(), 4);
    assert.equal(await friend.inputValue("#route-name"), "Test crawl");
    await friend.click("#banner-action");
    await friend.waitForSelector("#saved-badge:not([hidden])");
    await shot(friend, "desktop-shared-link");
    await other.close();
  });

  await scenario("desktop: crawl of the day and another version", { viewport: { width: 1280, height: 800 } }, async (page) => {
    await page.goto(base);
    await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    await page.click("#daily-button");
    await page.waitForSelector("#route-list .stop");
    const pubs = await page.locator("#route-list .stop-num.pub").count();
    assert.ok(pubs >= 4 && pubs <= 6, `daily crawl has ${pubs} pubs`);
    assert.match(await page.inputValue("#route-name"), /crawl/);
    await page.waitForFunction(() => document.querySelector("#sum-distance").textContent !== "…");
    await shot(page, "desktop-daily-route");
    assert.equal(await page.locator(".reshuffle-row").isHidden(), true, "daily crawl can't be re-rolled");

    // Another version on a normal Surprise me crawl.
    await page.click("#tab-plan");
    await page.click('[data-mode="random"]');
    await page.click("#generate-button");
    await page.waitForSelector(".reshuffle-row:not([hidden])");
    const before = await page.locator("#route-list .stop-title").allTextContents();
    await page.click("#reshuffle-button");
    await page.waitForFunction((old) => {
      const now = [...document.querySelectorAll("#route-list .stop-title")].map((el) => el.textContent);
      return now.length && now.join("|") !== old.join("|");
    }, before);
  });

  await scenario("mobile: themed crawl", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, async (page) => {
    await page.goto(base);
    await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    await page.tap("#tab-themes");
    await page.waitForSelector('#theme-grid [data-theme="dickens"]');
    assert.ok((await page.locator("#theme-grid .theme-card").count()) >= 10);
    await page.tap('#theme-grid [data-theme="dickens"]');
    assert.match(await page.textContent("#theme-generate"), /Dickens/);
    await shot(page, "mobile-themes");
    await page.tap("#theme-generate");
    await page.waitForSelector("#route-list .stop");
    assert.match(await page.inputValue("#route-name"), /Dickens/);
    assert.ok((await page.locator("#route-list .tag.theme").count()) >= 3, "stops tagged on-theme");
    assert.match(await page.textContent("#route-theme-note"), /Why this fits/);
    assert.ok((await page.locator("#route-theme-note .highlights span").count()) >= 1, "note lists highlights");
    await page.waitForSelector(".reshuffle-row:not([hidden])");
    const before = await page.locator("#route-list .stop-title").allTextContents();
    await page.tap("#reshuffle-button");
    await page.waitForFunction((old) => {
      const now = [...document.querySelectorAll("#route-list .stop-title")].map((el) => el.textContent);
      return now.length && now.join("|") !== old.join("|");
    }, before);
    assert.match(await page.inputValue("#route-name"), /Dickens/);
    await shot(page, "mobile-theme-route");
  });

  if (fs.existsSync(path.join(ROOT, "data", "places-york.json"))) {
    await scenario("desktop: switch to York and share a York crawl", { viewport: { width: 1280, height: 800 } }, async (page, routerCalls, context) => {
      await page.goto(base);
      await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
      assert.match(await page.textContent(".brand h1"), /London/);
      await Promise.all([page.waitForNavigation(), page.selectOption("#city-select", "york")]);
      await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
      assert.match(await page.textContent(".brand h1"), /York Crawl Planner/);
      assert.ok(Number((await page.textContent("#count-pubs")).replace(/\D/g, "")) > 20, "York has pubs");
      await shot(page, "desktop-york");
      await page.click('[data-mode="random"]');
      await page.click("#generate-button");
      await page.waitForSelector("#route-list .stop");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.click("#share-button");
      const link = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(link, /c=york/);
      // The city is remembered, and a London share link switches back.
      await page.goto(base);
      await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
      assert.match(await page.textContent(".brand h1"), /York/);
      await page.goto(`${base}?city=london`);
      await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
      assert.match(await page.textContent(".brand h1"), /London/);
    });
  } else {
    console.log("skip - York data not built yet");
  }

  await scenario("desktop: surprise me (sights and pub-only)", { viewport: { width: 1280, height: 800 } }, async (page) => {
    await page.goto(base);
    await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    await page.click('[data-mode="random"]');
    await page.click("#generate-button");
    await page.waitForSelector("#route-list .stop");
    const sights = await page.locator("#route-list .stop-num.poi").count();
    assert.equal(sights, 3);
    await page.click("#tab-plan");
    await page.fill("#random-poi-count", "0");
    await page.locator("#random-poi-count").dispatchEvent("change");
    await page.fill("#pub-count", "4");
    await page.locator("#pub-count").dispatchEvent("change");
    await page.click("#generate-button");
    await page.waitForFunction(() => document.querySelectorAll("#route-list .stop-num.pub").length === 4);
    assert.equal(await page.locator("#route-list .stop-num.poi").count(), 0);
    await shot(page, "desktop-pub-only");
  });

  await scenario(
    "mobile: bottom sheet, planning and crawl mode",
    {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      geolocation: { latitude: 51.5, longitude: -0.2 },
      permissions: ["geolocation"],
    },
    async (page, routerCalls, context) => {
    await page.goto(base);
    await page.waitForSelector("#loading", { state: "detached", timeout: 20000 });
    assert.equal(await page.getAttribute("#sheet", "data-state"), "peek");
    const sheetBox = await page.locator("#sheet").boundingBox();
    assert.ok(sheetBox.height < 200, "sheet starts collapsed");
    await shot(page, "mobile-start");

    await searchAndAdd(page, "Tate Modern");
    await searchAndAdd(page, "Borough Market");
    await shot(page, "mobile-popup");
    await page.tap("#tab-plan");
    await page.waitForFunction(() => document.querySelector("#sheet").dataset.state === "half");
    await shot(page, "mobile-plan");
    await page.tap("#generate-button");
    await page.waitForSelector("#route-list .stop");
    await page.waitForFunction(() => document.querySelector("#sum-distance").textContent !== "…");
    await shot(page, "mobile-route");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `no horizontal overflow (${width})`);

    await page.tap("#sheet-handle");
    await page.waitForFunction(() => document.querySelector("#sheet").dataset.state === "peek");

    // Crawl mode: walking up to the first stop shows its story.
    await page.waitForFunction(() => {
      const session = JSON.parse(localStorage.getItem("pubgen.session.v1") || "null");
      return session && session.route && session.route.geometry;
    });
    await page.tap("#tab-route");
    await page.tap("#start-crawl-button");
    await page.waitForSelector("#crawl-bar:not([hidden])");
    await shot(page, "mobile-crawl");
    const target = await page.evaluate(() => JSON.parse(localStorage.getItem("pubgen.session.v1")).route.geometry[0]);
    await context.setGeolocation({ latitude: target[0], longitude: target[1], accuracy: 10 });
    await page.waitForSelector("#place-dialog[open]", { timeout: 10000 });
    assert.match(await page.textContent("#place-arrival"), /stop 1/);
    await shot(page, "mobile-arrival");
    await page.click("#place-dialog [data-close]");
    await page.waitForFunction(() => !document.querySelector("#place-dialog").open);
    assert.match(await page.textContent("#crawl-step"), /Stop 2/);
    await page.click("#crawl-here");
    await page.waitForSelector("#place-dialog[open]");
    await page.click("#place-dialog [data-close]");
    await page.waitForFunction(() => !document.querySelector("#place-dialog").open);
    assert.match(await page.textContent("#crawl-step"), /Stop 3/);
    await page.click("#crawl-stop");
    await page.waitForSelector("#crawl-bar", { state: "hidden" });
    }
  );

  await browser.close();
  server.close();

  if (errors.length) {
    failures += 1;
    console.log(`not ok - page errors:\n  ${errors.join("\n  ")}`);
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nall browser checks passed");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
