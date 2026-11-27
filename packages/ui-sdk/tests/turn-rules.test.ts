/** Turn rules both backends apply the same way (#4721). */
import { describe, expect, test } from "bun:test";
import { autonomousYieldLatch, isSessionUuid, usageTokenCount } from "../src/server/index";
import type { ServerMessage } from "../src/protocol";

describe("autonomousYieldLatch", () => {
  function latch(options: { aborted?: () => boolean; onYield?: (key: string) => void } = {}) {
    const yields: string[] = [], emitted: ServerMessage[] = [];
    let aborts = 0;
    const onYield = autonomousYieldLatch({ onYield: options.onYield ?? ((key) => { yields.push(key); }), aborted: options.aborted ?? (() => aborts > 0),
      emit: (message) => { emitted.push(message); }, abort: () => { aborts++; } });
    return { onYield, yields, emitted, aborts: () => aborts };
  }

  test("the first yield calls onYield once and aborts; a second yield is ignored", () => {
    const run = latch();
    run.onYield("ithaca-1");
    run.onYield("ithaca-2");
    expect(run.yields).toEqual(["ithaca-1"]);
    expect(run.aborts()).toBe(1);
    expect(run.emitted).toEqual([]);
  });

  test("a yield after the turn stopped is ignored", () => {
    const run = latch({ aborted: () => true });
    run.onYield("ithaca-1");
    expect(run.yields).toEqual([]);
    expect(run.aborts()).toBe(0);
  });

  test("a throwing onYield emits one AUTONOMOUS_YIELD_FAILED error and still aborts", () => {
    const run = latch({ aborted: () => false, onYield: () => { throw new Error("the checkpoint store is full"); } });
    run.onYield("ithaca-1");
    run.onYield("ithaca-2");
    expect(run.emitted).toEqual([{ type: "error", code: "AUTONOMOUS_YIELD_FAILED", message: "Autonomous yield checkpoint failed." }]);
    expect(run.aborts()).toBe(1);
  });
});

test("isSessionUuid accepts an anchored UUID in either case and nothing else", () => {
  expect(isSessionUuid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
  expect(isSessionUuid("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe(true);
  for (const id of ["-".repeat(36), "0f8fad5b-d9cb-469f-a165-70867728950e/", " 0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5bd9cb469fa16570867728950e", "", "../ithaca"]) expect(isSessionUuid(id)).toBe(false);
});

test("usageTokenCount keeps a non-negative safe integer and nulls anything else", () => {
  expect(usageTokenCount(0)).toBe(0);
  expect(usageTokenCount(1200)).toBe(1200);
  for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "12", null, undefined]) expect(usageTokenCount(value)).toBeNull();
});
