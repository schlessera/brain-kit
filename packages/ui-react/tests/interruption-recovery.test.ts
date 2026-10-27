import { afterEach, expect, spyOn, test } from "bun:test";
import { createInterruptionRecovery } from "../src/voice/interruption-recovery.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function recovery() {
  const phases: string[] = [];
  const r = createInterruptionRecovery(phase => phases.push(phase));
  cleanups.push(r.reset);
  r.speaking();
  return { r, phases };
}
const silence = (samples: number) => new Uint8Array(samples * 2);

test("evaluation: zero samples while speaking cannot establish a post-endpoint boundary", () => {
  const { r, phases } = recovery();
  expect(r.drop(silence(24000), 24000)).toBe(true);
  expect(phases).toEqual(["speaking"]);
  r.endpoint();
  r.drop(silence(7199), 24000);
  expect(r.held()).toBe(true);
  expect(r.drop(silence(1), 24000)).toBe(true);
  expect(r.held()).toBe(false);
  expect(phases).toEqual(["speaking", "waiting", "open"]);
  expect(r.drop(new Uint8Array([1, 0]), 24000)).toBe(false);
});

test("evaluation: any nonzero PCM16 sample resets consecutive evidence at its exact offset", () => {
  const { r } = recovery(); r.endpoint();
  r.drop(silence(6000), 24000);
  r.drop(new Uint8Array([1, 0]), 24000);
  r.drop(silence(7199), 24000);
  expect(r.held()).toBe(true);
  r.drop(silence(1), 24000);
  expect(r.held()).toBe(false);
});

test("evaluation: sample duration follows rate; a qualifying chunk is dropped in full", () => {
  const { r } = recovery(); r.endpoint();
  expect(r.drop(silence(4799), 16000)).toBe(true);
  expect(r.held()).toBe(true);
  expect(r.drop(new Uint8Array([0, 0, 100, 0]), 16000)).toBe(true);
  expect(r.held()).toBe(false);
});

test("evaluation: a late silent packet cannot bypass the fixed wall deadline", () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  cleanups.push(() => clock.mockRestore());
  const { r, phases } = recovery(); r.endpoint();
  now = 2900;
  r.drop(silence(2400), 24000);
  now = 3000;
  r.drop(silence(24000), 24000);
  expect(phases.at(-1)).toBe("manual");
  expect(r.held()).toBe(true);
  r.drop(silence(24000), 24000);
  expect(phases.at(-1)).toBe("manual");
  r.manual(); expect(r.held()).toBe(false);
});

test("evaluation: new speech and lifecycle reset retire prior silence evidence", () => {
  const { r } = recovery(); r.endpoint(); r.drop(silence(6000), 24000);
  r.speaking(); r.endpoint(); r.drop(silence(2400), 24000);
  expect(r.held()).toBe(true);
  r.reset(); expect(r.held()).toBe(false);
  r.speaking(); r.endpoint(); r.drop(silence(6000), 24000);
  expect(r.held()).toBe(true);
});
