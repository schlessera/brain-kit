import { describe, expect, test } from "bun:test";
import {
  purgeLegacyApiCaches,
  registerDefaultRoutes,
  type CacheLike,
  type CacheStorageLike,
  type RouteHandlerCallback,
  type RouteMatchCallback,
  type ServiceWorkerPolicyScope,
} from "../src/client/sw-policy.js";

function emptyCache(overrides: Partial<CacheLike> = {}): CacheLike {
  return {
    add: async () => {},
    delete: async () => false,
    keys: async () => [],
    match: async () => undefined,
    ...overrides,
  };
}

describe("registerDefaultRoutes", () => {
  test("registers API before assets and configures precache query stripping", () => {
    class FakeNetworkOnly {
      readonly kind = "network-only";
    }
    class FakeExpirationPlugin {
      readonly options;
      constructor(options: { maxEntries?: number; maxAgeSeconds?: number }) {
        this.options = options;
      }
    }
    class FakeCacheFirst {
      readonly kind = "cache-first";
      constructor(
        readonly options: {
          cacheName: string;
          plugins: FakeExpirationPlugin[];
        }
      ) {}
    }
    class FakeCacheExpiration {
      async delete(): Promise<void> {}
    }

    const routes: Array<{
      capture: RouteMatchCallback;
      handler: object | RouteHandlerCallback;
    }> = [];
    let ignored: RegExp[] = [];
    const manifest = [{ url: "/index.html", revision: "build-1" }];
    const cache = emptyCache();
    const caches: CacheStorageLike = {
      delete: async () => false,
      has: async () => false,
      open: async () => cache,
    };
    const scope: ServiceWorkerPolicyScope = {
      caches,
      clients: { claim: async () => {} },
      fetch: async () => new Response("network"),
      skipWaiting: async () => {},
      addEventListener: () => {},
    };

    registerDefaultRoutes({
      registerRoute: (capture, handler) => routes.push({ capture, handler }),
      NetworkOnly: FakeNetworkOnly,
      CacheFirst: FakeCacheFirst,
      ExpirationPlugin: FakeExpirationPlugin,
      CacheExpiration: FakeCacheExpiration,
      precacheAndRoute: (entries, options) => {
        expect(entries).toBe(manifest);
        ignored = options.ignoreURLParametersMatching;
      },
      cleanupOutdatedCaches: () => {},
      createHandlerBoundToURL: () => async () => new Response("shell"),
      manifest,
      scope,
    });

    expect(routes).toHaveLength(3);
    expect((routes[0]!.handler as FakeNetworkOnly).kind).toBe("network-only");
    expect((routes[1]!.handler as FakeCacheFirst).kind).toBe("cache-first");
    expect(
      routes[0]!.capture({
        request: { destination: "image" } as Request,
        url: new URL("https://example.test/api/files/content?path=private.md"),
      })
    ).toBe(true);
    expect(
      routes[1]!.capture({
        request: { destination: "image" } as Request,
        url: new URL("https://example.test/api/files/content?path=private.md"),
      })
    ).toBe(true);
    expect(ignored.map((pattern) => pattern.source)).toEqual([
      "^utm_",
      "^fbclid$",
      "^share$",
      "^share_error$",
    ]);
  });

  test("a navigation to the interactive HTML preview goes to the network, never the shell", () => {
    class FakeNetworkOnly {
      readonly kind = "network-only";
    }
    class FakeExpirationPlugin {}
    class FakeCacheFirst {
      readonly kind = "cache-first";
    }
    class FakeCacheExpiration {
      async delete(): Promise<void> {}
    }
    const routes: Array<{ capture: RouteMatchCallback; handler: object | RouteHandlerCallback }> = [];
    registerDefaultRoutes({
      registerRoute: (capture, handler) => routes.push({ capture, handler }),
      NetworkOnly: FakeNetworkOnly,
      CacheFirst: FakeCacheFirst,
      ExpirationPlugin: FakeExpirationPlugin,
      CacheExpiration: FakeCacheExpiration,
      precacheAndRoute: () => {},
      cleanupOutdatedCaches: () => {},
      createHandlerBoundToURL: () => async () => new Response("shell"),
      manifest: [],
      scope: {
        caches: { delete: async () => false, has: async () => false, open: async () => emptyCache() },
        clients: { claim: async () => {} },
        fetch: async () => new Response("network"),
        skipWaiting: async () => {},
        addEventListener: () => {},
      },
    });
    const navigation = { mode: "navigate", destination: "document" } as Request;
    const framed = { mode: "navigate", destination: "iframe" } as Request;
    const url = new URL("https://example.test/api/files/html?path=voyage/beacon.html");
    // Workbox answers with the first registered route that captures.
    for (const request of [navigation, framed]) {
      const first = routes.find((route) => route.capture({ request, url }));
      expect((first?.handler as FakeNetworkOnly | undefined)?.kind).toBe("network-only");
    }
    // The shell route itself refuses /api, independent of registration order,
    // while an ordinary deep link still reaches it.
    const shell = routes[2]!;
    expect(shell.capture({ request: navigation, url })).toBe(false);
    expect(shell.capture({ request: framed, url })).toBe(false);
    expect(shell.capture({ request: navigation, url: new URL("https://example.test/notes") })).toBe(true);
  });

  test("navigation falls back from network to shell to offline page", async () => {
    class FakeNetworkOnly {}
    class FakeExpirationPlugin {}
    class FakeCacheFirst {}
    class FakeCacheExpiration {
      async delete(): Promise<void> {}
    }

    const calls: string[] = [];
    const offline = new Response("offline page");
    const cache = emptyCache({
      match: async (request) => {
        calls.push(`offline:${String(request)}`);
        return offline;
      },
    });
    const routes: Array<object | RouteHandlerCallback> = [];
    const scope: ServiceWorkerPolicyScope = {
      caches: {
        delete: async () => false,
        has: async () => false,
        open: async (name) => {
          calls.push(`open:${name}`);
          return cache;
        },
      },
      clients: { claim: async () => {} },
      fetch: async () => {
        calls.push("network");
        throw new Error("offline");
      },
      skipWaiting: async () => {},
      addEventListener: () => {},
    };

    registerDefaultRoutes({
      registerRoute: (_capture, handler) => routes.push(handler),
      NetworkOnly: FakeNetworkOnly,
      CacheFirst: FakeCacheFirst,
      ExpirationPlugin: FakeExpirationPlugin,
      CacheExpiration: FakeCacheExpiration,
      precacheAndRoute: () => {},
      cleanupOutdatedCaches: () => {},
      createHandlerBoundToURL: (url) => async () => {
        calls.push(`shell:${url}`);
        throw new Error("precache unavailable");
      },
      manifest: [],
      scope,
    });

    const navigate = routes[2] as RouteHandlerCallback;
    const response = await navigate({
      request: { mode: "navigate" } as Request,
      url: new URL("https://example.test/notes"),
      event: Object.assign(new Event("fetch"), { waitUntil: () => {} }),
    });

    expect(response).toBe(offline);
    expect(calls).toEqual([
      "network",
      "shell:/index.html",
      "open:offline-fallback",
      "offline:/offline.html",
    ]);
  });
  /**
   * Build the navigation route handler with pluggable network and shell
   * outcomes, so a SUCCESSFUL response can be asserted too. The fallback-chain
   * test above only ever fails both, which cannot tell "returns the network
   * response" from "discards it and falls through".
   */
  function navigateHandler(opts: {
    network: () => Promise<Response>;
    shell: () => Promise<Response>;
    offline?: Response | undefined;
    calls: string[];
  }): RouteHandlerCallback {
    class FakeNetworkOnly {}
    class FakeExpirationPlugin {}
    class FakeCacheFirst {}
    class FakeCacheExpiration {
      async delete(): Promise<void> {}
    }
    const cache = emptyCache({
      match: async () => {
        opts.calls.push("offline-page");
        return opts.offline;
      },
    });
    const routes: Array<object | RouteHandlerCallback> = [];
    const scope: ServiceWorkerPolicyScope = {
      caches: {
        delete: async () => false,
        has: async () => false,
        open: async () => cache,
      },
      clients: { claim: async () => {} },
      fetch: async () => {
        opts.calls.push("network");
        return opts.network();
      },
      skipWaiting: async () => {},
      addEventListener: () => {},
    };
    registerDefaultRoutes({
      registerRoute: (_capture, handler) => routes.push(handler),
      NetworkOnly: FakeNetworkOnly,
      CacheFirst: FakeCacheFirst,
      ExpirationPlugin: FakeExpirationPlugin,
      CacheExpiration: FakeCacheExpiration,
      precacheAndRoute: () => {},
      cleanupOutdatedCaches: () => {},
      createHandlerBoundToURL: () => async () => {
        opts.calls.push("shell");
        return opts.shell();
      },
      manifest: [],
      scope,
    });
    return routes[2] as RouteHandlerCallback;
  }

  const navigateRequest = () => ({
    request: { mode: "navigate" } as Request,
    url: new URL("https://example.test/notes"),
    event: Object.assign(new Event("fetch"), { waitUntil: () => {} }),
  });

  test("a successful network response is returned and nothing else is consulted", async () => {
    const calls: string[] = [];
    const fromNetwork = new Response("live");
    const navigate = navigateHandler({
      network: async () => fromNetwork,
      shell: async () => {
        throw new Error("shell must not be consulted");
      },
      calls,
    });

    expect(await navigate(navigateRequest())).toBe(fromNetwork);
    expect(calls).toEqual(["network"]);
  });

  test("offline, the precached shell wins over the offline page", async () => {
    // The shell can read `?share=` and hold the share until the network
    // returns; the offline page is a dead end. Preferring it is the whole
    // point of this handler, so a test that only proves ordering while both
    // fail would not notice the shell response being discarded.
    const calls: string[] = [];
    const fromShell = new Response("app shell");
    const navigate = navigateHandler({
      network: async () => {
        throw new Error("offline");
      },
      shell: async () => fromShell,
      calls,
    });

    expect(await navigate(navigateRequest())).toBe(fromShell);
    expect(calls).toEqual(["network", "shell"]);
  });

  test("with no cached offline page the last resort is a 503", async () => {
    const calls: string[] = [];
    const navigate = navigateHandler({
      network: async () => {
        throw new Error("offline");
      },
      shell: async () => {
        throw new Error("precache unavailable");
      },
      offline: undefined,
      calls,
    });

    const response = await navigate(navigateRequest());
    expect(await response.text()).toBe("Brain needs to load once while online before it can work offline on this device.");
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(calls).toEqual(["network", "shell", "offline-page"]);
  });
});

describe("purgeLegacyApiCaches", () => {
  test("deletes legacy bodies and both expiration indexes when assets were purged", async () => {
    const deletedCaches: string[] = [];
    const deletedBodies: string[] = [];
    const deletedIndexes: string[] = [];
    const apiRequest = {
      url: "https://example.test/api/files/content?path=notes/private.md",
    } as Request;
    const assetRequest = {
      url: "https://example.test/assets/app.js",
    } as Request;
    const assetCache = emptyCache({
      keys: async () => [apiRequest, assetRequest],
      delete: async (request) => {
        deletedBodies.push((request as Request).url);
        return true;
      },
    });
    const caches: CacheStorageLike = {
      delete: async (name) => {
        deletedCaches.push(name);
        return true;
      },
      has: async (name) => name === "static-assets",
      open: async () => assetCache,
    };
    class FakeCacheExpiration {
      constructor(readonly cacheName: string) {}
      async delete(): Promise<void> {
        deletedIndexes.push(this.cacheName);
      }
    }

    await purgeLegacyApiCaches({ caches, CacheExpiration: FakeCacheExpiration });

    expect(deletedCaches).toEqual(["api-cache"]);
    expect(deletedBodies).toEqual([apiRequest.url]);
    expect(deletedIndexes).toEqual(["api-cache", "static-assets"]);
  });

  test("keeps the asset expiration index when no API body was present", async () => {
    const deletedIndexes: string[] = [];
    const assetCache = emptyCache({
      keys: async () => [
        { url: "https://example.test/assets/app.js" } as Request,
      ],
    });
    class FakeCacheExpiration {
      constructor(readonly cacheName: string) {}
      async delete(): Promise<void> {
        deletedIndexes.push(this.cacheName);
      }
    }

    await purgeLegacyApiCaches({
      caches: {
        delete: async () => true,
        has: async () => true,
        open: async () => assetCache,
      },
      CacheExpiration: FakeCacheExpiration,
    });

    expect(deletedIndexes).toEqual(["api-cache"]);
  });
});
