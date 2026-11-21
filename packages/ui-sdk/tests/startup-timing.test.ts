import { expect, test } from "bun:test";
import { safeStartupTiming } from "../src/server/startup-timing.js";

test("startup observer failures never escape any diagnostic method or returned completion", () => {
  const events: string[] = [];
  const fail = (event: string) => { events.push(event); throw Error("Ithaca diagnostics unavailable"); };
  const timing = safeStartupTiming({ start: name => fail(`start:${name}`), worker: name => fail(`worker:${name}`),
    missing: name => fail(`missing:${name}`), received: () => fail("received") })!;
  timing.start("host_probe")(); timing.worker("resources", 31); timing.missing("first_enqueue"); timing.received();
  const ending = safeStartupTiming({ start: () => () => fail("end:worker_launch"), worker() {}, missing() {}, received() {} })!;
  ending.start("worker_launch")();
  expect(events).toEqual(["start:host_probe", "worker:resources", "missing:first_enqueue", "received", "end:worker_launch"]);
  expect(safeStartupTiming(undefined)).toBeUndefined();
});

test("startup observations preserve names, durations and method receivers", () => {
  const events: unknown[] = [];
  const observer = { label: "ithaca", start(name: string) { events.push([this.label, name]); return () => events.push("ended"); },
    worker(name: string, ms: number) { events.push([this.label, name, ms]); }, missing(name: string) { events.push([this.label, name]); }, received() { events.push(this.label); } };
  const timing = safeStartupTiming(observer)!;
  timing.start("worker_launch")(); timing.worker("resources", 31); timing.missing("prompt_recorded"); timing.received();
  expect(events).toEqual([["ithaca", "worker_launch"], "ended", ["ithaca", "resources", 31], ["ithaca", "prompt_recorded"], "ithaca"]);
});
