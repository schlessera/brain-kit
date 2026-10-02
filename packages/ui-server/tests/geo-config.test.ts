import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerConfig } from "../src/config/env.js";
import { createGeoRoutes } from "../src/routes/geo.js";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("server canonical geo adapter", () => {
  test("unset canonical configuration retains legacy settings; explicit JSON overrides service settings and resolves only its response-cache path", () => {
    const legacy = resolveServerConfig({ BRAIN_PATH: "/brain-fixture", OVERPASS_URL: "https://legacy.example.invalid", OVERPASS_USER_AGENT: "legacy/1" });
    expect(legacy.coastline).toMatchObject({ enabled: true, url: "https://legacy.example.invalid", userAgent: "legacy/1" });
    expect(legacy.coastline.geo).toBeUndefined();
    const canonical = resolveServerConfig({ BRAIN_PATH: "/brain-fixture", BRAIN_UI_COASTLINE: "false",
      BRAIN_GEO_CONFIG_JSON: JSON.stringify({ userAgent: "canonical/1", cacheDir: ".brain/geo",
        overpass: { enabled: true, endpoints: ["https://canonical.example.invalid"] } }) });
    expect(canonical.coastline.enabled).toBe(false);
    expect(canonical.coastline.geo).toMatchObject({ userAgent: "canonical/1", cacheDir: "/brain-fixture/.brain/geo",
      overpass: { enabled: true, endpoints: ["https://canonical.example.invalid"] }, geocoding: { enabled: false } });
    expect(canonical.coastline.cacheDir).toBe("/brain-fixture/.brain-ui/geo");
  });

  test("invalid canonical input refuses startup instead of silently using a public legacy endpoint", () => {
    for (const value of ["", "{", "null", "[]", '{"provider":"generic"}', '{"overpass":{"enabled":"true"}}']) {
      expect(() => resolveServerConfig({ BRAIN_GEO_CONFIG_JSON: value })).toThrow("must contain valid canonical geo JSON");
    }
  });

  test("the mounted route really uses canonical requests/shared cache and still honors the legacy privacy switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-server-geo-")); roots.push(root);
    const requests: { path: string; ua: string | undefined; body: string }[] = [];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk.toString();
      requests.push({ path: request.url!, ua: request.headers["user-agent"], body });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ elements: [{ type: "way", geometry: [{ lat: 38.21, lon: 15.62 }, { lat: 38.24, lon: 15.65 }] }] }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const base = `http://127.0.0.1:${address.port}`;
    const env = { BRAIN_PATH: root, COASTLINE_CACHE_DIR: join(root, "geometry"), OVERPASS_URL: `${base}/legacy`,
      BRAIN_GEO_CONFIG_JSON: JSON.stringify({ userAgent: "brain-server-fixture/1.0", cacheDir: "responses",
        minimumIntervalMs: 0, overpass: { enabled: true, endpoints: [`${base}/canonical`] } }) };
    const config = resolveServerConfig(env).coastline;
    const path = "/geo/coastline?bbox=15.6,38.2,15.8,38.32&width=330&detail=coast";
    const first = await createGeoRoutes({ config }).request(path);
    expect(first.status).toBe(200);
    expect((await first.json()).coastline).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe("/canonical");
    expect(requests[0]!.ua).toBe("brain-server-fixture/1.0");
    expect(new URLSearchParams(requests[0]!.body).get("data")).toContain('"natural"="coastline"');
    // Remove only the route-level geometry cache: a new concrete client must use the shared response cache.
    await rm(config.cacheDir, { recursive: true, force: true });
    const cached = await createGeoRoutes({ config }).request(path);
    expect((await cached.json()).coastline).toHaveLength(1);
    expect(requests).toHaveLength(1);
    await rm(config.cacheDir, { recursive: true, force: true });
    const disabled = await createGeoRoutes({ config: resolveServerConfig({ ...env, BRAIN_UI_COASTLINE: "false" }).coastline }).request(path);
    expect((await disabled.json()).coastline).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});
