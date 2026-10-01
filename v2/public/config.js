/*
 * Deployment configuration. Everything here is public: never put secrets in it.
 *
 * ads:      leave disabled on the web. When the app ships in a store wrapper
 *           (e.g. Capacitor + AdMob), set enabled: true and implement
 *           window.PubGenAds.render(slotElement) in the wrapper.
 * premium:  the one-off upgrade. The wrapper sets window.PubGenPremium.active
 *           after a verified store purchase; the free app must stay fully usable.
 */
window.PubGenConfig = Object.freeze({
  ads: { enabled: false },
  premium: { enabled: false, productId: "crawl_pass" },
  routerUrl: "https://routing.openstreetmap.de/routed-foot/route/v1/driving/",
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
});
