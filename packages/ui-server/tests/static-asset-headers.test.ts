/**
 * Static SPA assets carry a cache policy (#4815): every static response is
 * `no-cache` unless an embedder names the one URL prefix its build hashes, and
 * a precompressed sibling is served to a client that accepts it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";

import { createApp } from "../src/app";
import { createTestApp, type TestApp } from "./helpers/test-app";

const IMMUTABLE = "public, max-age=31536000, immutable";
const BUNDLE = "export const crew = 'Odysseus';\n".repeat(64);

let staticRoot: string;
let plain: TestApp;
let hashed: TestApp;

beforeAll(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "brain-ui-static-headers-"));
  mkdirSync(join(staticRoot, "assets"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Ithaca</title>");
  writeFileSync(join(staticRoot, "sw.js"), "self.addEventListener('fetch', () => {});\n");
  writeFileSync(join(staticRoot, "assets", "x.js"), BUNDLE);
  writeFileSync(join(staticRoot, "assets", "x.js.br"), brotliCompressSync(BUNDLE));
  plain = await createTestApp({ appOptions: { staticRoot } });
  hashed = await createTestApp({ appOptions: { staticRoot, staticImmutablePrefix: "/assets/" } });
});

afterAll(async () => {
  await plain?.teardown();
  await hashed?.teardown();
  rmSync(staticRoot, { recursive: true, force: true });
});

async function policy(app: TestApp, path: string): Promise<[number, string | null]> {
  const response = await app.fetch(path);
  await response.arrayBuffer();
  return [response.status, response.headers.get("cache-control")];
}

describe("static cache policy", () => {
  test("with no immutable prefix every static response is no-cache", async () => {
    expect(await policy(plain, "/"), "ROOT_NO_CACHE").toEqual([200, "no-cache"]);
    expect(await policy(plain, "/voyage/ithaca"), "DEEP_LINK_NO_CACHE").toEqual([200, "no-cache"]);
    expect(await policy(plain, "/sw.js"), "ROOT_FILE_NO_CACHE").toEqual([200, "no-cache"]);
    expect(await policy(plain, "/assets/x.js"), "ASSET_NO_CACHE_WITHOUT_PREFIX").toEqual([200, "no-cache"]);
  });

  test("only an existing file under the named prefix is immutable", async () => {
    expect(await policy(hashed, "/assets/x.js"), "HASHED_ASSET_IMMUTABLE").toEqual([200, IMMUTABLE]);
    expect(await policy(hashed, "/"), "ROOT_STILL_NO_CACHE").toEqual([200, "no-cache"]);
    expect(await policy(hashed, "/index.html"), "INDEX_STILL_NO_CACHE").toEqual([200, "no-cache"]);
    expect(await policy(hashed, "/sw.js"), "OUTSIDE_PREFIX_NO_CACHE").toEqual([200, "no-cache"]);
    // A missing hashed file is answered by the index fallback, which must be revalidated.
    expect(await policy(hashed, "/assets/missing.js"), "MISSING_UNDER_PREFIX_IS_FALLBACK_NO_CACHE").toEqual([200, "no-cache"]);
  });

  test("a precompressed sibling is served to a client that accepts it, under its path's policy", async () => {
    for (const [app, cache] of [[plain, "no-cache"], [hashed, IMMUTABLE]] as const) {
      const compressed = await app.fetch("/assets/x.js", { headers: { "Accept-Encoding": "br" } });
      expect(compressed.headers.get("content-encoding"), "BROTLI_SERVED").toBe("br");
      expect(compressed.headers.get("vary"), "VARY_ACCEPT_ENCODING").toBe("Accept-Encoding");
      expect(compressed.headers.get("cache-control"), "COMPRESSED_KEEPS_POLICY").toBe(cache);
      await compressed.arrayBuffer();
      const identity = await app.fetch("/assets/x.js", { headers: { "Accept-Encoding": "identity" } });
      expect(identity.headers.get("content-encoding"), "IDENTITY_UNCOMPRESSED").toBeNull();
      expect(await identity.text(), "IDENTITY_BODY").toBe(BUNDLE);
      expect(identity.headers.get("cache-control"), "IDENTITY_KEEPS_POLICY").toBe(cache);
    }
  });
});

describe("staticImmutablePrefix validation", () => {
  test.each(["/", "assets/", "/assets"])("refuses %p before creating anything", async (prefix) => {
    // No config is passed: a check that ran later would fail on the missing
    // managed storage instead of naming the prefix.
    await expect(createApp({ staticImmutablePrefix: prefix }), `PREFIX_REFUSED ${prefix}`).rejects.toThrow("staticImmutablePrefix must start and end with \"/\"");
  });

  test("is accepted without staticRoot and has no effect", async () => {
    const app = await createTestApp({ appOptions: { staticImmutablePrefix: "/assets/" } });
    try {
      const response = await app.fetch("/assets/x.js");
      await response.arrayBuffer();
      expect(response.status, "NO_STATIC_ROUTE").toBe(404);
      expect(response.headers.get("cache-control"), "NO_STATIC_POLICY").toBeNull();
    } finally { await app.teardown(); }
  });
});
