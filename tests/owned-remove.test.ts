import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { requireNativeHostCleanup } from "../scripts/prove-native-host";
import { verifyIndexReleaseReproduction } from "../scripts/native-proof/verify-index-release-repro";
import { ownedCleanupComplete, verifyOwnedRemove } from "../scripts/native-proof/verify-owned-remove";
const busy = { startNs: 100, endNs: 200, errno: 16, error: "[Errno 16] busy" };
const success = { startNs: 20_000_200, endNs: 20_000_300, errno: null };
test("owned removal receipt retains EBUSY and accepts only bounded success", () => {
  expect(verifyOwnedRemove({ identityCaptured: true, outcome: "removed", attempts: [busy, success] })).toBe(true);
  expect(verifyOwnedRemove({ identityCaptured: true, outcome: "removed", attempts: [{ startNs: 1, endNs: 2, errno: null }] })).toBe(true);
  for (const value of [undefined, {}, { identityCaptured: true, outcome: "removed", attempts: [] },
    { outcome: "failed", attempts: [busy] },
    { identityCaptured: true, outcome: "removed", attempts: [{ ...busy, errno: 1 }, success] },
    { identityCaptured: true, outcome: "removed", attempts: [busy, { ...success, startNs: 201 }] },
    { identityCaptured: true, outcome: "removed", attempts: [busy, { ...success, startNs: 1_000_000_200, endNs: 1_000_000_300 }] },
    { identityCaptured: true, outcome: "removed", attempts: [busy, { ...success, errno: 16 }] }]) expect(verifyOwnedRemove(value)).toBe(false);
});
test("file-only removal and refusal controls", () => {
  const child = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "../scripts/native-proof/owned-remove-control.py")], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

const validReceipt = { identityCaptured: true, outcome: "removed", attempts: [busy, success] };
const clean = { kind: "cleanup", mounted: false, attached: false, loopCreated: false, backingExists: false, errors: [], removeReceipt: validReceipt };
test("shared cleanup rejects missing, malformed and changed ownership receipts", () => {
  expect(ownedCleanupComplete(clean)).toBe(true);
  expect(() => requireNativeHostCleanup(clean)).not.toThrow();
  for (const value of [null, {}, ...["mounted", "attached", "loopCreated", "backingExists"].map(key => ({ ...clean, [key]: true })),
    { ...clean, errors: ["original failure"] }, { ...clean, errors: "" }, { ...clean, removeReceipt: undefined },
    ...[{}, { ...validReceipt, identityCaptured: false }, { ...validReceipt, attempts: [] }, { ...validReceipt, failure: "bad" },
      { ...validReceipt, attempts: [{ ...success, startNs: NaN }] }, { ...validReceipt, attempts: [{ ...success, startNs: 2**53 }] },
      { ...validReceipt, attempts: [{ ...success, startNs: -1 }] }, { ...validReceipt, attempts: [{ ...success, endNs: 1 }] }]
      .map(removeReceipt => ({ ...clean, removeReceipt }))]) expect(ownedCleanupComplete(value)).toBe(false);
});
test("both controller call sites require shared cleanup validation", () => {
  // Composition is an explicit controller boundary: deleting either call must fail.
  expect(readFileSync(join(import.meta.dir, "../scripts/prove-native-host.ts"), "utf8")).toContain("requireNativeHostCleanup(cleanup);");
  expect(readFileSync(join(import.meta.dir, "../scripts/native-proof/verify-index-release-repro.ts"), "utf8")).toContain('requireFact(ownedCleanupComplete(cleanup), "OWNED_CLEANUP")');
  const directory = mkdtempSync(join(tmpdir(), "owned-cleanup-control-"));
  try {
    const stderr = "error: NATIVE_AUTOMATIC_INDEX_COMPLETED: NativeBrainManagerError: Native manager outcome is unknown\n"
      + "(fail) native hosted pi uid 0 first/warm admission, health, WebSocket, Stop and cancellation [1ms]\n"
      + ["descriptor records", "cwd records", "descriptor released just after its delete"].map(name => `(pass) ${name} [1ms]`).join("\n") + "\n1 fail\n";
    for (const cleanup of [{ ...clean, removeReceipt: undefined }, { ...clean, errors: ["bad"] }]) {
      writeFileSync(join(directory, "native-fixture.json"), JSON.stringify([{ kind: "command", argv: ["bun", "run", "test"], code: 1, stderr }, cleanup]));
      expect(() => requireNativeHostCleanup(cleanup)).toThrow("Native hosted proof did not provide complete owned-resource cleanup evidence.");
      expect(() => verifyIndexReleaseReproduction(directory, 1)).toThrow("NATIVE_INDEX_RELEASE_REPRO_OWNED_CLEANUP");
    }
  } finally { rmSync(directory, { recursive: true }); }
});
