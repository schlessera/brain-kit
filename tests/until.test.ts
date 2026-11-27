/**
 * The shared Bun-test wait (tests/helpers/until.ts, #4835) bounds its loop
 * with a watchdog the load gate scales. Every case injects the environment:
 * the `determinism` job sets BRAIN_TEST_DEADLINE_FACTOR=8 for the files it
 * repeats, so a case that read the ambient factor would change meaning there.
 */
import { describe, expect, test } from "bun:test";
import { until, UNTIL_DEFAULT_MS, type UntilClock } from "./helpers/until";

/** A clock that only moves when the helper sleeps, so the deadline is exact. */
function steppedClock(): UntilClock & { readonly elapsed: number; readonly sleeps: number } {
  let now = 1_000, sleeps = 0;
  return {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; sleeps++; },
    get elapsed() { return now - 1_000; },
    get sleeps() { return sleeps; },
  };
}

const NO_FACTOR = {} as const;
const LOADED = { BRAIN_TEST_DEADLINE_FACTOR: "8" } as const;

describe("until", () => {
  test("a never-true predicate fails after the written bound when no factor is set", async () => {
    const clock = steppedClock();
    const error = await until(() => false, "the harbour lights", 200, { clock, env: NO_FACTOR }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(clock.elapsed).toBe(200);
  });

  test("a never-true predicate fails after eight times the bound under a factor of eight", async () => {
    const clock = steppedClock();
    const error = await until(() => false, "the harbour lights", 200, { clock, env: LOADED }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(clock.elapsed).toBe(1_600);
  });

  test("the bound defaults to five seconds", async () => {
    const clock = steppedClock();
    await until(() => false, undefined, undefined, { clock, env: NO_FACTOR }).catch(() => undefined);
    expect(UNTIL_DEFAULT_MS).toBe(5_000);
    expect(clock.elapsed).toBe(5_000);
  });

  test("the error names what was awaited and the unscaled bound", async () => {
    const clock = steppedClock();
    await expect(until(() => false, "the harbour lights", 200, { clock, env: LOADED }))
      .rejects.toThrow("until: timed out after 200 ms waiting for the harbour lights");
  });

  test("a diagnostic function is printed, and is called only when the wait fails", async () => {
    let calls = 0;
    const seen = () => { calls++; return { frames: ["status", "text_delta"] }; };
    let ready = false, checks = 0;
    await until(() => { checks++; if (checks === 3) ready = true; return ready; }, seen, 200, { clock: steppedClock(), env: NO_FACTOR });
    expect(calls).toBe(0);
    await expect(until(() => false, seen, 200, { clock: steppedClock(), env: NO_FACTOR }))
      .rejects.toThrow('until: timed out after 200 ms waiting for {"frames":["status","text_delta"]}');
    expect(calls).toBe(1);
    await expect(until(() => false, () => "Penelope's loom", 200, { clock: steppedClock(), env: NO_FACTOR }))
      .rejects.toThrow("waiting for Penelope's loom");
  });

  test("returns as soon as the predicate holds, sleeping only between checks", async () => {
    const clock = steppedClock();
    let checks = 0;
    await until(() => ++checks === 4, "the fourth check", 200, { clock, env: NO_FACTOR });
    expect(checks).toBe(4);
    expect(clock.sleeps).toBe(3);
    const immediate = steppedClock();
    await until(() => true, "an immediate state", 200, { clock: immediate, env: NO_FACTOR });
    expect(immediate.sleeps).toBe(0);
  });

  test("waits on the real clock by default", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 10);
    await until(() => ready, "a real timer", 5_000, { env: NO_FACTOR });
    expect(ready).toBe(true);
  });
});
