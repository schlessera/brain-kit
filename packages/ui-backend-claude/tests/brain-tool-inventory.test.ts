import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainInventoryCache } from "../src/brain-tool-inventory.js";
const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const brain = mkdtempSync(join(tmpdir(), "ithaca-inventory-cache-")); owned.push(brain);
  const path = join(brain, "brain.config.json");
  writeFileSync(path, JSON.stringify({ profile: { name: "Odysseus" } }));
  const spans: Array<{ name: string; cached?: boolean }> = [];
  const input = { brainPath: brain, req: { startupTiming: { start(name: string, attributes?: { cached?: boolean }) {
    return () => spans.push({ name, ...attributes });
  }, worker() {}, missing() {}, received() {} } } } as never;
  return { brain, path, input, spans, signal: new AbortController().signal };
}
test("a content-hash hit skips the helper; changed config bytes invalidate it", async () => {
  const f = fixture(); let calls = 0;
  const select = createBrainInventoryCache(async () => { calls++; return { inventory: "core-only", modules: [] }; });
  expect(await select(f.input, f.signal)).toBe("core-only");
  expect(await select(f.input, f.signal)).toBe("core-only");
  expect(calls, "CACHE_HIT_SKIPS_SANDBOX_HELPER").toBe(1);
  writeFileSync(f.path, JSON.stringify({ profile: { name: "Penelope" } })); // same byte count
  expect(await select(f.input, f.signal)).toBe("core-only");
  expect(calls, "CONFIG_BYTES_INVALIDATE_INVENTORY_CACHE").toBe(2);
  expect(f.spans).toEqual([{ name: "brain_tool_inventory", cached: false }, { name: "brain_tool_inventory", cached: true }, { name: "brain_tool_inventory", cached: false }]);
});
test("unreadable key inputs and failed helpers fall back, never cached as clean", async () => {
  const f = fixture(); let calls = 0;
  const select = createBrainInventoryCache(async () => { calls++; throw new Error("Odysseus cannot resolve the modules."); });
  expect(await select(f.input, f.signal)).toBe("unavailable");
  expect(await select(f.input, f.signal)).toBe("unavailable");
  expect(calls, "FAILED_HELPER_IS_RETRIED").toBe(2);
  mkdirSync(join(f.brain, "bun.lock"));
  expect(await select(f.input, f.signal)).toBe("unavailable");
  expect(calls, "UNREADABLE_HASH_NEVER_RUNS_OR_TRUSTS_HELPER").toBe(2);
});
test("a manifest or lock change invalidates a successful inventory", async () => {
  const f = fixture(); let calls = 0;
  const select = createBrainInventoryCache(async () => { calls++; return { inventory: "core-only", modules: [] }; });
  await select(f.input, f.signal);
  writeFileSync(join(f.brain, "package.json"), '{"name":"ithaca"}'); await select(f.input, f.signal);
  writeFileSync(join(f.brain, "bun.lock"), "Ithaca module version 1"); await select(f.input, f.signal);
  expect(calls).toBe(3);
});
test("concurrent new sessions share a single inventory helper", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(); let calls = 0;
  const select = createBrainInventoryCache(async () => { calls++; await gate.promise; return { inventory: "core-only", modules: [] }; });
  const first = select(f.input, f.signal), second = select(f.input, f.signal);
  try { expect(calls).toBe(1); gate.resolve(); expect(await Promise.all([first, second])).toEqual(["core-only", "core-only"]); }
  finally { gate.resolve(); await Promise.all([first, second]); }
});

test("unresolvable module inputs skip later helpers and recover after the source becomes hashable", async () => {
  const f = fixture(); let calls = 0;
  const directory = join(f.brain, "modules/ithaca"); mkdirSync(directory, { recursive: true });
  const source = join(directory, "module.ts"); writeFileSync(source, 'import fs from "node:fs"; export default {};');
  const select = createBrainInventoryCache(async () => { calls++; return { inventory: "module-tools", modules: [{ key: "./modules/ithaca", name: "ithaca" }] }; });
  expect(await select(f.input, f.signal)).toBe("unavailable");
  expect(await select(f.input, f.signal)).toBe("unavailable");
  expect(calls, "UNKNOWN_INPUTS_NEVER_REPEAT_OR_BECOME_A_CLEAN_FACT").toBe(1);
  writeFileSync(source, "export default {};");
  expect(await select(f.input, f.signal)).toBe("module-tools");
  expect(await select(f.input, f.signal)).toBe("module-tools");
  expect(calls, "HASHABLE_INPUTS_RECOVER_WITHOUT_A_HOST_RESTART").toBe(2);
});
