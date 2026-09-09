/**
 * The default service-worker route and cache policy for a brain UI shell.
 *
 * Workbox stays an implementation detail of the shell: every registrar,
 * strategy and plugin constructor is injected. The structural declarations in
 * this file intentionally use the DOM types already available to the package;
 * importing the webworker lib here would leak conflicting globals into node
 * consumers of the SDK's declarations.
 */

const ASSET_CACHE = "static-assets";
const ASSET_MAX_ENTRIES = 60;
const ASSET_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface PrecacheEntry {
  url: string;
  revision?: string | null;
  integrity?: string;
}

export interface RouteMatchOptions {
  request: Request;
  url: URL;
}

export interface RouteHandlerOptions {
  request: Request;
  url: URL;
  /** Structural equivalent of the Workbox-supplied ExtendableEvent. */
  event: Event & ExtendableEventLike;
  params?: string[] | Record<string, string>;
}

export type RouteMatchCallback = (options: RouteMatchOptions) => boolean;
export type RouteHandlerCallback = (
  options: RouteHandlerOptions
) => Promise<Response>;

export interface CacheLike {
  add(request: RequestInfo | URL): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
  match(request: RequestInfo | URL): Promise<Response | undefined>;
}

export interface CacheStorageLike {
  delete(cacheName: string): Promise<boolean>;
  has(cacheName: string): Promise<boolean>;
  open(cacheName: string): Promise<CacheLike>;
}

export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Structural slice of ServiceWorkerGlobalScope used by this policy. */
export interface ServiceWorkerPolicyScope {
  caches: CacheStorageLike;
  clients: { claim(): Promise<unknown> };
  fetch(request: Request): Promise<Response>;
  skipWaiting(): Promise<unknown>;
  addEventListener(type: "install", listener: () => void): void;
  addEventListener(
    type: "activate",
    listener: (event: ExtendableEventLike) => void
  ): void;
}

export interface ExpirationOptions {
  maxEntries?: number;
  maxAgeSeconds?: number;
}

export interface CacheExpirationLike {
  delete(): Promise<unknown>;
}

export interface CacheExpirationConstructor {
  new (cacheName: string, options: ExpirationOptions): CacheExpirationLike;
}

export interface RegisterDefaultRoutesDeps<
  NetworkOnlyInstance extends object = object,
  CacheFirstInstance extends object = object,
  ExpirationPluginInstance extends object = object,
> {
  registerRoute(
    capture: RouteMatchCallback,
    handler:
      | NetworkOnlyInstance
      | CacheFirstInstance
      | RouteHandlerCallback
  ): unknown;
  NetworkOnly: new () => NetworkOnlyInstance;
  CacheFirst: new (options: {
    cacheName: string;
    plugins: ExpirationPluginInstance[];
  }) => CacheFirstInstance;
  ExpirationPlugin: new (
    options: ExpirationOptions
  ) => ExpirationPluginInstance;
  CacheExpiration: CacheExpirationConstructor;
  precacheAndRoute(
    entries: Array<string | PrecacheEntry>,
    options: { ignoreURLParametersMatching: RegExp[] }
  ): unknown;
  cleanupOutdatedCaches(): unknown;
  createHandlerBoundToURL(url: string): RouteHandlerCallback;
  manifest: Array<string | PrecacheEntry>;
  scope: ServiceWorkerPolicyScope;
}

export interface PurgeLegacyApiCachesDeps {
  caches: CacheStorageLike;
  CacheExpiration: CacheExpirationConstructor;
}

/**
 * Remove every /api entry a PREVIOUS service-worker version persisted.
 *
 * Deleting Cache Storage bodies is not enough: workbox-expiration keeps its
 * own IndexedDB index whose rows store the FULL request URL — including the
 * `?path=…` of a file read. Those rows are the personal data, so both the
 * bodies and the metadata have to go.
 */
export async function purgeLegacyApiCaches({
  caches,
  CacheExpiration,
}: PurgeLegacyApiCachesDeps): Promise<void> {
  // 1. The old NetworkFirst /api cache: bodies AND its expiration index.
  await caches.delete("api-cache");
  await new CacheExpiration("api-cache", { maxEntries: 1 })
    .delete()
    .catch(() => {});

  // 2. /api responses that landed in the asset cache back when the CacheFirst
  //    route was registered first (file bytes fetched through <img>).
  if (!(await caches.has(ASSET_CACHE))) return;
  const cache = await caches.open(ASSET_CACHE);
  const expiration = new CacheExpiration(ASSET_CACHE, {
    maxEntries: ASSET_MAX_ENTRIES,
    maxAgeSeconds: ASSET_MAX_AGE_SECONDS,
  });
  let purged = false;
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.startsWith("/api")) {
      await cache.delete(request);
      purged = true;
    }
  }
  // cache.delete() bypasses the plugin, so the IndexedDB rows — which hold the
  // full URLs — would survive. There is no per-entry metadata API, so drop the
  // whole store: assets simply lose their timestamps and get re-tracked on the
  // next fetch (they are build-revisioned, and cleanupOutdatedCaches handles
  // the precache), which is a cheap price for not leaving file paths on disk.
  if (purged) {
    await expiration.delete().catch(() => {});
  }
}

/** Register the default lifecycle, precache, API, asset and navigation policy. */
export function registerDefaultRoutes<
  NetworkOnlyInstance extends object,
  CacheFirstInstance extends object,
  ExpirationPluginInstance extends object,
>(
  deps: RegisterDefaultRoutesDeps<
    NetworkOnlyInstance,
    CacheFirstInstance,
    ExpirationPluginInstance
  >
): void {
  const {
    registerRoute,
    NetworkOnly,
    CacheFirst,
    ExpirationPlugin,
    CacheExpiration,
    precacheAndRoute,
    cleanupOutdatedCaches,
    createHandlerBoundToURL,
    manifest,
    scope,
  } = deps;

  const assetExpiration = new ExpirationPlugin({
    maxEntries: ASSET_MAX_ENTRIES,
    maxAgeSeconds: ASSET_MAX_AGE_SECONDS,
  });

  // Activate new service worker immediately on deploy
  scope.addEventListener("install", () => {
    void scope.skipWaiting();
  });
  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      Promise.all([
        scope.clients.claim(),
        purgeLegacyApiCaches({ caches: scope.caches, CacheExpiration }),
      ])
    );
  });

  // Precache the app shell (revisioned by the build) and DELETE precaches from
  // previous builds — without this, orphaned old bundles linger in the cache and
  // a stale client can keep running after a deploy.
  cleanupOutdatedCaches();
  // `share` and `share_error` must be stripped before a precache lookup. Workbox
  // only ignores `utm_*` and `fbclid` by default, so `/?share=abc` would match no
  // precache entry at all — an offline share would land on the offline page, the
  // app would never boot, and the stashed record would be stranded with nobody
  // holding its id.
  precacheAndRoute(manifest, {
    ignoreURLParametersMatching: [
      /^utm_/,
      /^fbclid$/,
      /^share$/,
      /^share_error$/,
    ],
  });

  // API - network only, NEVER cached. API responses carry personal data (search
  // results, session transcripts, file contents, passkey metadata) and liveness
  // signals; persisting any of it in Cache Storage would leave plaintext copies
  // on disk and replay stale "reachable" liveness while actually offline.
  //
  // MUST be registered BEFORE the static-asset route: workbox matches routes in
  // registration order, and /api/files/content?raw=1 is loaded through <img>
  // (destination "image"), so a leading CacheFirst route would swallow personal
  // file bytes into the asset cache.
  registerRoute(
    ({ url }) => url.pathname.startsWith("/api"),
    new NetworkOnly()
  );

  // Cache static assets (JS, CSS, images) - cache first. The ExpirationPlugin
  // bounds the cache so orphaned assets can't accumulate unbounded across deploys.
  registerRoute(
    ({ request }) =>
      request.destination === "script" ||
      request.destination === "style" ||
      request.destination === "image" ||
      request.destination === "font",
    new CacheFirst({
      cacheName: ASSET_CACHE,
      plugins: [assetExpiration],
    })
  );

  // Navigation requests - network first, then the precached app shell, and only
  // then the offline page.
  //
  // The shell is on disk, so an offline navigation should still boot the app:
  // it can show its own connection state, and — the reason this matters here —
  // it can read `?share=` and hold the share until the network returns. The
  // offline page is a dead end that cannot do either, so it is the last resort
  // rather than the first.
  const shellHandler = createHandlerBoundToURL("/index.html");
  registerRoute(
    ({ request }) => request.mode === "navigate",
    async (options) => {
      try {
        return await scope.fetch(options.request);
      } catch {
        try {
          return await shellHandler(options);
        } catch {
          const cache = await scope.caches.open("offline-fallback");
          const cached = await cache.match("/offline.html");
          return (
            cached ||
            new Response("Offline - Connect to VPN", {
              status: 503,
              headers: { "Content-Type": "text/html" },
            })
          );
        }
      }
    }
  );

  // Cache the offline page on activate
  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      scope.caches
        .open("offline-fallback")
        .then((cache) => cache.add("/offline.html").catch(() => {}))
    );
  });
}
