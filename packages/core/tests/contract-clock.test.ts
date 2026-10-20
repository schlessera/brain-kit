import { expect, test } from "bun:test";

import { settleWithin } from "../src/testing/primitives";
import { withContractClock } from "./helpers/contract-clock";

const descriptors = () => [
  Object.getOwnPropertyDescriptor(globalThis, "setTimeout"),
  Object.getOwnPropertyDescriptor(globalThis, "clearTimeout"),
  Object.getOwnPropertyDescriptor(performance, "now"),
];

test("contract clock delivers real callbacks at boundaries and drains promises before tied timers", async () => {
  const before = descriptors();
  await withContractClock(async () => {
    const events: unknown[] = [];
    setTimeout(() => events.push(["before", performance.now()]), 39);
    const result = new Promise<string>((resolve) => setTimeout(resolve, 40, "answer"));
    const tied = setTimeout(() => events.push("cancelled tie"), 40);
    result.then(() => clearTimeout(tied));
    expect(await settleWithin(result, 40)).toEqual({ state: "resolved", value: "answer" });
    events.push(["at", performance.now()]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(events).toEqual([["before", 39], ["at", 40]]);
    expect(performance.now()).toBe(41);
  });
  expect(descriptors()).toEqual(before);
});

test("contract clock retains pending, rejection, cancellation and elapsed outcomes", async () => {
  await withContractClock(async () => {
    const rejected = new Promise((_, reject) => setTimeout(() => reject(new Error("deadline")), 400));
    expect(await settleWithin(rejected, 399)).toEqual({ state: "pending" });
    expect(performance.now()).toBe(399);
    expect((await settleWithin(rejected, 1)).state).toBe("rejected");
    expect(performance.now()).toBe(400);
    let cancelled = false;
    const timer = setTimeout(() => { cancelled = true; }, 1);
    clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(cancelled).toBe(false);
    expect(performance.now()).toBe(402);
  });
});

test("contract clock restores descriptors and isolates leftovers after a genuine assertion failure", async () => {
  const before = descriptors();
  let contaminated = false;
  let failure: unknown;
  try {
    await withContractClock(async () => {
      setTimeout(() => { contaminated = true; }, 10);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect("actual contract outcome").toBe("deliberately wrong outcome");
    });
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("deliberately wrong outcome");
  expect(descriptors()).toEqual(before);
  await withContractClock(async () => {
    expect(performance.now()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(performance.now()).toBe(20);
    expect(contaminated).toBe(false);
    setTimeout(() => { contaminated = true; }, 1);
  });
  expect(descriptors()).toEqual(before);
  await withContractClock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(contaminated).toBe(false);
  });
  expect(descriptors()).toEqual(before);
});
