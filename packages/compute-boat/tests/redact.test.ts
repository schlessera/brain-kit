/**
 * Redaction removes the instance key verbatim and anything shaped like a Boat
 * key, new (`boat_`) or legacy (`box_`), without eating Boat's own error
 * codes, which share the `boat_` prefix and are what an operator reads.
 */

import { describe, expect, test } from "bun:test";

import { createRedactor } from "../src/redact";
import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

describe("redaction", () => {
  test("Boat's error codes survive", () => {
    const red = createRedactor(KEY);
    for (const code of ["boat_direct_failed", "boat_starting", "sandbox_direct_failed", "idempotency_key_reused", "boat_live"]) {
      expect(red.text(`HTTP 502 ${code}`)).toBe(`HTTP 502 ${code}`);
    }
  });

  test("key-shaped values are removed, new and legacy", () => {
    const red = createRedactor(undefined);
    expect(red.text("echoed boat_live_7Hq2mZ9xkP4rT8wq back")).toBe("echoed [redacted] back");
    expect(red.text("echoed box_9f8e7d6c5b4a3e2d1c0b back")).toBe("echoed [redacted] back");
    expect(red.text("echoed box_Qm4kZ7pX2vN8rT5w back")).toBe("echoed [redacted] back");
  });

  test("the configured key is removed verbatim whatever its shape", () => {
    expect(createRedactor("boat_scoped_ci").text("key boat_scoped_ci refused")).toBe("key [redacted] refused");
  });

  test("an outcome reason keeps the vendor code", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    const allocated = await provider.allocate({ key: "job-aeaea", leaseSeconds: 300, retain: false }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    fake.failNext("exec", { status: 502, code: "boat_direct_failed" });
    const outcome = await provider.exec(allocated.sandbox, { argv: ["exit", "0"], env: {} }, contextFor(fake, { now }));
    expect(outcome.kind === "uncertain" && outcome.reason).toContain("boat_direct_failed");
  });
});
