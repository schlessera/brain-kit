/**
 * Cost is Boat's own usage report at list price, taken from the answer.
 * Unknown is `null`, never zero, and no rate is written into the adapter.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

async function run(secondsPerDollar: number) {
  let t = Date.parse("2026-07-12T09:00:00Z");
  const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0, secondsPerDollar, now: () => t });
  const { provider, now } = instantProvider(t);
  const allocated = await provider.allocate({ key: "job-circe", leaseSeconds: 3600, retain: true }, contextFor(fake, { now }));
  if (allocated.kind !== "ok") throw new Error(allocated.kind);
  t += 1000 * 1000;
  return { fake, provider, now, sandbox: allocated.sandbox, advance: (ms: number) => (t += ms) };
}

describe("cost", () => {
  test("usd is the dollars Boat reports, partial while it runs and complete once stopped", async () => {
    const { fake, provider, now, sandbox } = await run(100_000);
    expect(await provider.usage!(sandbox, contextFor(fake, { now }))).toEqual({ usd: 0.01, seconds: 1000, coverage: "partial" });
    await provider.release(sandbox, "retain", contextFor(fake, { now }));
    expect(await provider.usage!(sandbox, contextFor(fake, { now }))).toEqual({ usd: 0.01, seconds: 1000, coverage: "complete" });
  });

  test("a different list price changes the figure: nothing is computed from a built-in rate", async () => {
    const { fake, provider, now, sandbox } = await run(50_000);
    expect((await provider.usage!(sandbox, contextFor(fake, { now }))).usd).toBe(0.02);
  });

  test("a deleted sandbox reports the reading taken before deletion as partial", async () => {
    const { fake, provider, now, sandbox } = await run(100_000);
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("released");
    expect(await provider.usage!(sandbox, contextFor(fake, { now }))).toEqual({ usd: 0.01, seconds: 1000, coverage: "partial" });
  });

  test("no report is null with unknown coverage, never zero", async () => {
    const { fake, provider, now, sandbox } = await run(100_000);
    fake.failNext("usage", { status: 500, code: "http_500" }, 3);
    expect(await provider.usage!(sandbox, contextFor(fake, { now }))).toEqual({ usd: null, seconds: null, coverage: "unknown" });
    fake.failNext("usage", { status: 404, code: "not_found" });
    expect(await provider.usage!({ id: "bx_unknown2" }, contextFor(fake, { now }))).toEqual({ usd: null, seconds: null, coverage: "unknown" });
  });

  test("the adapter source carries no price or rate", () => {
    const src = resolve(import.meta.dir, "..", "src");
    const text = readdirSync(src).map((f) => readFileSync(join(src, f), "utf8")).join("\n");
    expect(text.match(/secondsPerDollar|vmHourDollars|overagePrices|\$\s?\d+(\.\d+)?\s*\/\s*(h|hour|month)/g)).toBeNull();
  });
});
