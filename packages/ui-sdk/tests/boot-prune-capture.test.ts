import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installBootPruneCapture } from "./fixtures/boot-prune-capture";
import { bootPruneCaptureVariant, bootPruneCaptureSelected } from "../../../scripts/native-proof/owned-prune-variant";
import { APPLICATION_SCENARIOS, applicationQualificationScenario } from "./fixtures/application-qualification";
const key = Symbol.for("brain-kit.fixture.boot-prune");
const source = await Bun.file(resolve(import.meta.dir, "../../ui-server/src/cron/scratch-prune.ts")).text();
async function factory() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-boot-prune-"));
  try {
    const variant = bootPruneCaptureVariant(source).cron.replace('"../governance/event-writes.js"', JSON.stringify(resolve(import.meta.dir, "../../ui-server/src/governance/event-writes.ts")));
    const file = join(root, "scratch-prune.ts"); writeFileSync(file, variant);
    return { start: (await import(file)).startScratchPrune, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test("actual automatic boot Promise is captured and completes without a second manual tick", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, key), f = await factory(), capture = installBootPruneCapture();
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let calls = 0, completed = false; const warnings: unknown[] = [];
  const pruner = f.start({ brain: { async scratchPrune() { calls++; await gate; completed = true; return "Odysseus prune complete"; } }, every: () => () => {}, log: { emit(value: unknown) { warnings.push(value); } } });
  try {
    expect(() => capture.capture(), "BOOT_PRUNE_ACTUAL_CAPTURE_AVAILABLE").not.toThrow();
    const actual = Object.getOwnPropertyDescriptor(globalThis, key)!.value.promise;
    expect(actual).toBeInstanceOf(Promise); capture.capture(); expect(calls).toBe(1); expect(completed).toBe(false);
    const joined = capture.join(); release(); await joined;
    expect(Object.getOwnPropertyDescriptor(globalThis, key)!.value.promise).toBe(actual);
    expect(completed).toBe(true); expect(calls).toBe(1); expect(warnings).toEqual([]);
  } finally {
    release(); try { await pruner.close(); } finally { try { capture.restore(); } finally { f.cleanup(); } }
  }
  expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(original);
});

test("actual automatic boot cancellation preserves the existing signal and warning", async () => {
  const f = await factory(), capture = installBootPruneCapture(); let calls = 0; let signal: AbortSignal | undefined;
  const warnings: unknown[] = [];
  const pruner = f.start({ brain: { async scratchPrune(options: { signal: AbortSignal }) {
    calls++; signal = options.signal;
    return await new Promise<string>((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  } }, every: () => () => {}, log: { emit(value: unknown) { warnings.push(value); } } });
  try {
    capture.capture(); await pruner.close(); await capture.join();
    expect(calls).toBe(1); expect(signal!.aborted).toBe(true);
    expect(warnings).toEqual([{ severityText: "WARN", body: "scratch prune failed; the next pass is in an hour", attributes: { error: "the server is shutting down" } }]);
  } finally { try { await pruner.close(); } finally { try { capture.restore(); } finally { f.cleanup(); } } }
});

test("capture refuses missing, occupied and drifting ownership while restoring exact prior descriptors", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    Object.defineProperty(globalThis, key, { value: undefined, configurable: true, enumerable: true, writable: false });
    const previous = Object.getOwnPropertyDescriptor(globalThis, key), missing = installBootPruneCapture();
    try { expect(() => missing.capture()).toThrow("BOOT_PRUNE_CAPTURE_MISSING"); }
    finally { missing.restore(); }
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(previous);
    Object.defineProperty(globalThis, key, { value: "Odysseus occupied", configurable: true });
    expect(() => installBootPruneCapture()).toThrow("BOOT_PRUNE_CAPTURE_SLOT_NOT_EMPTY");
    Reflect.deleteProperty(globalThis, key);
    for (const drift of ["owner", "promise"] as const) {
      const capture = installBootPruneCapture(), owner = Object.getOwnPropertyDescriptor(globalThis, key)!.value;
      owner.promise = Promise.resolve(); capture.capture();
      if (drift === "owner") Object.defineProperty(globalThis, key, { value: {}, configurable: true });
      else owner.promise = Promise.resolve();
      await expect(capture.join()).rejects.toThrow();
      expect(() => capture.restore()).toThrow();
      expect(Object.getOwnPropertyDescriptor(globalThis, key)).toBeUndefined();
    }
  } finally { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); }
});

test("fixed capture and explicit scenarios cannot silently alter original five-phase/default selection", () => {
  expect(() => bootPruneCaptureVariant(source.replace("  void tick();", ""))).toThrow();
  expect(() => bootPruneCaptureVariant(source + "\n  void tick();")).toThrow();
  expect(bootPruneCaptureSelected([], false)).toBe(false);
  expect(() => bootPruneCaptureSelected(["--boot-prune-capture"], false)).toThrow();
  expect(bootPruneCaptureSelected(["--boot-prune-capture"], true)).toBe(true);
  expect(applicationQualificationScenario([], true)).toBeUndefined();
  for (const name of ["governed", "strict", "db-repeat"] as const) {
    const selected = [`--application-scenario=${name}`, "--boot-prune-capture"];
    expect(applicationQualificationScenario(selected, true)).toBe(name);
    expect(() => applicationQualificationScenario(selected, false)).toThrow();
    expect(() => applicationQualificationScenario(selected.slice(0, 1), true)).toThrow();
  }
  expect(() => applicationQualificationScenario(["--application-scenario=unknown", "--boot-prune-capture"], true)).toThrow();
  expect(APPLICATION_SCENARIOS).toEqual({ governed: ["private-positive", "fresh-git", "fresh-app", "warm"], strict: ["private-positive", "fresh-git", "strict"], "db-repeat": ["private-positive", "fresh-app", "warm"] });
});
