/** The disk response cache deletes entries no process may still use (#4812). */
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geoConfigSchema } from "../src/config.js";
import { CACHE_PRUNE_AGE_MS, GeoTransport } from "../src/server/io.js";

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1_000;
const endpoint = "https://geo.example.invalid";
const userAgent = "brain-geo-fixture/1.0";
const decode = (raw: unknown): { places: string[] } => raw as { places: string[] };

async function setup(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-geo-prune-"));
  roots.push(root);
  const responses = join(root, "responses");
  await mkdir(responses, { recursive: true });
  const config = geoConfigSchema.parse({ userAgent, cacheDir: root, minimumIntervalMs: 0, ...options });
  let requests = 0;
  const io = new GeoTransport(config, {
    fetchImpl: async () => { requests++; return Response.json({ places: ["Ithaca"] }); },
    admissionDir: join(root, "admission"),
  });
  return { responses, io, requests: () => requests };
}

const ask = (io: GeoTransport, q: string) => io.request("nominatim", endpoint, `${endpoint}/search?q=${q}`, {}, decode);
const keyOf = (q: string) => createHash("sha256")
  .update(JSON.stringify(["nominatim", endpoint, `${endpoint}/search?q=${q}`, "GET", "", userAgent, ""])).digest("hex");
const name = (seed: string) => createHash("sha256").update(seed).digest("hex") + ".json";

async function seed(directory: string, file: string, ageMs: number, fetchedAt = Date.now() - ageMs): Promise<void> {
  const path = join(directory, file);
  await writeFile(path, JSON.stringify({ version: 1, fetchedAt, payload: { places: ["Aeaea"] } }));
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

function countListings(directory: string): () => number {
  let listings = 0;
  const original = fsPromises.readdir;
  const spy = spyOn(fsPromises, "readdir").mockImplementation(((path: string, ...rest: unknown[]) => {
    if (path === directory) listings++;
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fsPromises.readdir);
  spies.push(spy);
  return () => listings;
}

test("the prune age is the largest cacheTtlMs the configuration accepts", () => {
  expect(geoConfigSchema.safeParse({ cacheTtlMs: CACHE_PRUNE_AGE_MS }).success).toBe(true);
  expect(geoConfigSchema.safeParse({ cacheTtlMs: CACHE_PRUNE_AGE_MS + 1 }).success).toBe(false);
});

test("a cache write removes entries older than 30 days and keeps younger ones", async () => {
  const { responses, io } = await setup({ cacheTtlMs: DAY });
  const old = name("old"), middle = name("middle"), fresh = name("fresh");
  await seed(responses, old, 31 * DAY);
  await seed(responses, middle, 2 * DAY);
  await seed(responses, fresh, 0);
  const result = await ask(io, "new");
  expect(result).toMatchObject({ value: { places: ["Ithaca"] }, error: null, source: { fromCache: false } });
  expect((await readdir(responses)).sort()).toEqual([middle, fresh, keyOf("new") + ".json"].sort());
});

test("orphaned temporaries from a crashed write are removed once old, and kept while young", async () => {
  const { responses, io } = await setup();
  const orphan = `${name("orphan")}.4c7e2a1d-9b0f-4e3a-8d21-0f6b5a7c9e11.tmp`;
  const young = `${name("young")}.0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6.tmp`;
  await seed(responses, orphan, 31 * DAY);
  await seed(responses, young, 0);
  await ask(io, "new");
  const left = await readdir(responses);
  expect(left).not.toContain(orphan);
  expect(left).toContain(young);
});

test("two cache writes within the hour list the directory once", async () => {
  const { responses, io, requests } = await setup();
  const listings = countListings(responses);
  await ask(io, "first");
  await ask(io, "second");
  expect(requests()).toBe(2);
  expect(listings()).toBe(1);
});

test("a failing prune never changes the request's result", async () => {
  const { responses, io } = await setup();
  const original = fsPromises.readdir;
  spies.push(spyOn(fsPromises, "readdir").mockImplementation(((path: string, ...rest: unknown[]) => {
    if (path === responses) return Promise.reject(Object.assign(new Error("listing refused"), { code: "EACCES" }));
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fsPromises.readdir));
  const result = await ask(io, "new");
  expect(result.error).toBeNull();
  expect(result.value).toEqual({ places: ["Ithaca"] });
});

test("an answer from a fresh cache entry neither prunes nor deletes that entry", async () => {
  const { responses, io, requests } = await setup();
  // A fresh entry whose file time is past the prune age: a prune would delete it.
  const entry = keyOf("cached") + ".json";
  await seed(responses, entry, 31 * DAY, Date.now());
  const listings = countListings(responses);
  const result = await ask(io, "cached");
  expect(result.source.fromCache).toBe(true);
  expect(result.value).toEqual({ places: ["Aeaea"] });
  expect(requests()).toBe(0);
  expect(listings()).toBe(0);
  expect(await readdir(responses)).toContain(entry);
});
