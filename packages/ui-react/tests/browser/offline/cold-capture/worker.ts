/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkOnly } from "workbox-strategies";
import { CacheExpiration, ExpirationPlugin } from "workbox-expiration";
import { registerDefaultRoutes } from "../../../../../ui-sdk/src/client/sw-policy.js";

declare const self: ServiceWorkerGlobalScope;
registerDefaultRoutes({
  registerRoute, NetworkOnly, CacheFirst, CacheExpiration, ExpirationPlugin,
  cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute,
  manifest: ["/index.html", "/app.js", "/styles.css"].map(url => ({ url, revision: "odysseus-cold-capture" })),
  scope: self,
});
