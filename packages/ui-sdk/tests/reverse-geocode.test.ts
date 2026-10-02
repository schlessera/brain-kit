import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoClient } from "@schlessera/brain-geo/server";
import { reverseGeocode, type ReverseGeocodeConfig } from "../src/server/reverse-geocode.js";
import { handleGetCurrentLocation } from "../src/server/bridge-tools/location.js";
import type { BackendBridge } from "../src/server/backend.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const coords = { latitude: 38.3, longitude: 15.7, accuracy: 20 };
const endpoint = "https://reverse.example.invalid";
const reply = {
  lat: "38.3", lon: "15.7", display_name: "Ithaca, Greece",
  address: { suburb: "Harbour", town: "Ithaca", country: "Greece" },
};
async function setup(fetchImpl: NonNullable<ReverseGeocodeConfig["fetchImpl"]>) {
  const root = await mkdtemp(join(tmpdir(), "brain-sdk-reverse-"));
  roots.push(root);
  const config: ReverseGeocodeConfig = {
    enabled: true, url: "https://unused.example.invalid", userAgent: "unused",
    geo: { userAgent: "brain-sdk-fixture/1.0", cacheDir: root, minimumIntervalMs: 0,
      geocoding: { enabled: true, url: endpoint } },
    fetchImpl, admissionDir: join(root, "admission"),
  };
  return config;
}

describe("SDK shared reverse geocoding", () => {
  test("the real location bridge keeps its raw-coordinate payload when the public service is ineligible", async () => {
    let requests = 0;
    const config = await setup(async () => { requests++; return Response.json(reply); });
    config.geo!.geocoding = { enabled: true, url: "https://nominatim.openstreetmap.org" };
    const bridge = { getLocation: async () => ({ coords, timestamp: 0 }) } as BackendBridge;
    const payload = await handleGetCurrentLocation({}, bridge, { reverseGeocodeConfig: config });
    expect(requests).toBe(0);
    expect(payload).toEqual({ latitude: 38.3, longitude: 15.7, accuracyMeters: 20,
      note: "Reverse geocoding was unavailable; only raw coordinates are known.", retrievedAt: "1970-01-01T00:00:00.000Z" });
  });

  test("retains the exact nullable result shape and shares nonempty evidence with the concrete client cache", async () => {
    const urls: string[] = [];
    const config = await setup(async (url, init) => {
      urls.push(url);
      expect(new Headers(init.headers).get("User-Agent")).toBe("brain-sdk-fixture/1.0");
      return Response.json(reply);
    });
    const first = await reverseGeocode(coords, config);
    expect(first).toEqual({ displayName: reply.display_name, summary: "Harbour, Ithaca, Greece", address: reply.address });
    expect(Object.keys(first!).sort()).toEqual(["address", "displayName", "summary"]);
    first!.address.town = "caller mutation";
    const shared = await new GeoClient(config.geo, { fetchImpl: config.fetchImpl, admissionDir: config.admissionDir })
      .reverse(coords.latitude, coords.longitude);
    expect(shared.value).toHaveLength(1);
    expect(shared.source!.fromCache).toBe(true);
    expect(shared.value![0]!.address.town).toBe("Ithaca");
    expect(await reverseGeocode(coords, config)).toMatchObject({ address: { town: "Ithaca" } });
    expect(urls).toHaveLength(1);
    const query = new URL(urls[0]!);
    expect(query.origin).toBe(endpoint);
    expect(query.pathname).toBe("/reverse");
    expect(query.searchParams.get("lat")).toBe("38.3");
    expect(query.searchParams.get("zoom")).toBe("16");
  });

  test("legacy enabled never implies public eligibility; disabling overrides eligible canonical settings", async () => {
    let requests = 0;
    const config = await setup(async () => { requests++; return Response.json(reply); });
    expect(await reverseGeocode(coords, { ...config, geo: undefined, url: "https://nominatim.openstreetmap.org" })).toBeNull();
    expect(await reverseGeocode(coords, { ...config, enabled: false, publicServiceEligible: true })).toBeNull();
    expect(requests).toBe(0);
  });

  test("canonical public eligibility is explicit and the legacy flag cannot override canonical refusal", async () => {
    let requests = 0;
    const config = await setup(async () => { requests++; return Response.json(reply); });
    config.geo!.geocoding = { enabled: true, url: "https://nominatim.openstreetmap.org", publicServiceEligible: false };
    expect(await reverseGeocode(coords, { ...config, publicServiceEligible: true })).toBeNull();
    expect(requests).toBe(0);
    config.geo!.geocoding.publicServiceEligible = true;
    expect(await reverseGeocode(coords, config)).toMatchObject({ displayName: reply.display_name });
    expect(requests).toBe(1);
  });

  test("legacy configured endpoint and explicit public eligibility actually reach the shared transport", async () => {
    const urls: string[] = [];
    const config = await setup(async (url, init) => {
      urls.push(url);
      expect(new Headers(init.headers).get("User-Agent")).toBe("legacy-sdk-fixture/1.0");
      return new Response("unavailable", { status: 503 });
    });
    const legacy = { ...config, geo: undefined, url: endpoint, userAgent: "legacy-sdk-fixture/1.0" };
    expect(await reverseGeocode(coords, legacy)).toBeNull();
    expect(await reverseGeocode(coords, { ...legacy, url: "https://nominatim.openstreetmap.org", publicServiceEligible: true })).toBeNull();
    expect(urls.map(url => new URL(url).origin)).toEqual([endpoint, "https://nominatim.openstreetmap.org"]);
  });

  test("provider and exact coordinates participate in the cache key", async () => {
    const urls: string[] = [];
    const config = await setup(async url => { urls.push(url); return Response.json(reply); });
    expect(await reverseGeocode(coords, config)).not.toBeNull();
    expect(await reverseGeocode({ ...coords, longitude: 15.70001 }, config)).not.toBeNull();
    config.geo!.geocoding!.url = "https://other-reverse.example.invalid";
    expect(await reverseGeocode(coords, config)).not.toBeNull();
    expect(urls).toHaveLength(3);
    expect(new URL(urls[2]!).origin).toBe("https://other-reverse.example.invalid");
  });

  test("network failure stays nullable and is never cached as a successful empty location", async () => {
    let requests = 0;
    const config = await setup(async () => { if (++requests === 1) throw new Error("offline"); return Response.json(reply); });
    expect(await reverseGeocode(coords, config)).toBeNull();
    expect(await reverseGeocode(coords, config)).toMatchObject({ displayName: reply.display_name });
    expect(requests).toBe(2);
  });

  test("invalid input/configuration never dispatches; malformed/no-match/HTTP responses stay null", async () => {
    let requests = 0;
    const config = await setup(async () => { requests++; return Response.json(reply); });
    expect(await reverseGeocode({ ...coords, latitude: 91 }, config)).toBeNull();
    expect(await reverseGeocode(coords, { ...config, geo: { timeoutMs: 1 } })).toBeNull();
    expect(requests).toBe(0);
    for (const response of [Response.json({ display_name: "no coordinates" }),
      Response.json({ error: "Unable to geocode" }, { status: 404 }), new Response("down", { status: 503 })]) {
      const failure = await setup(async () => { requests++; return response; });
      expect(await reverseGeocode(coords, failure)).toBeNull();
    }
    expect(requests).toBe(3);
  });
});
