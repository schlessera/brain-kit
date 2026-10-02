import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoClient } from "@schlessera/brain-geo/server";
import { brainConfigSchema, defineConfig, loadUserConfig, type BrainConfig } from "../src/lib/config.js";
import { resolveGeoConfig } from "../src/lib/geo-config.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "brain-core-geo-")); roots.push(root); return root;
}

describe("canonical core geo configuration", () => {
  test("an untouched empty brain remains empty and every new service remains disabled", async () => {
    const root = await directory();
    expect(brainConfigSchema.parse({})).toEqual({});
    const geo = resolveGeoConfig(root, null);
    expect(geo.geocoding.enabled).toBe(false);
    expect(geo.routing.demo.enabled).toBe(false);
    expect(geo.routing.endpoints).toEqual({});
    expect(geo.overpass.enabled).toBe(false);
    expect(existsSync(join(root, "brain.db"))).toBe(false);
  });

  test("typed partial authoring loads into the actual shared client, resolves its cache and preserves the config file", async () => {
    const root = await directory();
    const authored: BrainConfig = defineConfig({ geo: { userAgent: "brain-core-fixture/1.0", cacheDir: ".brain/geo",
      minimumIntervalMs: 0, geocoding: { enabled: true, url: "https://geo-config.example.invalid" } } });
    const file = join(root, "brain.config.json"), original = JSON.stringify(authored);
    await writeFile(file, original);
    const loaded = await loadUserConfig(root);
    expect(loaded.config!.geo!.geocoding!.url).toBe("https://geo-config.example.invalid");
    const config = resolveGeoConfig(root, loaded.config);
    expect(config.cacheDir).toBe(join(root, ".brain", "geo"));
    let requests = 0;
    const runtime = { admissionDir: join(root, "admission"), fetchImpl: async (url: string, init: RequestInit) => {
      requests++;
      expect(new URL(url).origin).toBe("https://geo-config.example.invalid");
      expect(new Headers(init.headers).get("User-Agent")).toBe("brain-core-fixture/1.0");
      return Response.json([{ lat: "38.3", lon: "15.7", display_name: "Ithaca" }]);
    } };
    expect((await new GeoClient(config, runtime).geocode("Ithaca")).value).toHaveLength(1);
    const repeated = await new GeoClient(resolveGeoConfig(root, loaded.config), runtime).geocode("Ithaca");
    expect(repeated.value).toHaveLength(1); expect(repeated.source!.fromCache).toBe(true);
    expect(requests).toBe(1);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(existsSync(join(root, "brain.db"))).toBe(false);
  });

  test("response-cache authoring rejects lexical escapes and canonical validation rejects provider registries/implicit flags", () => {
    for (const cacheDir of ["../geo", "/tmp/geo", "~/geo", "a\\geo", "geo\ncache"]) {
      expect(brainConfigSchema.safeParse({ geo: { cacheDir } }).success).toBe(false);
    }
    for (const geo of [{ geocoding: { enabled: "true" } }, { provider: "generic" },
      { routing: { demo: { enabled: 1 } } }, { geocoding: { url: "https://geo.example.invalid?secret=value" } }]) {
      expect(brainConfigSchema.safeParse({ geo }).success).toBe(false);
    }
  });

  test("existing and dangling symlinks cannot send the configured cache outside the brain", async () => {
    const root = await directory(), outside = await directory();
    await symlink(outside, join(root, "cache"));
    expect(() => resolveGeoConfig(root, { geo: { cacheDir: "cache/new" } })).toThrow("including through symlinks");
    await symlink(join(outside, "missing"), join(root, "dangling"));
    expect(() => resolveGeoConfig(root, { geo: { cacheDir: "dangling/new" } })).toThrow("including through symlinks");
    expect(existsSync(join(outside, "missing"))).toBe(false);
  });
});
