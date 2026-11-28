import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { requireNativeHostCleanup } from "../scripts/prove-native-host";
import { verifyIndexReleaseReproduction } from "../scripts/native-proof/verify-index-release-repro";
import { DEADLINE_ABORT_REASONS } from "../scripts/native-proof/native-release-observation";
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
      writeFileSync(join(directory, "native-fixture.json"), JSON.stringify([{ kind: "command", argv: ["/usr/local/bin/bun", "--no-env-file", "test", "--timeout", "30000", "/repo/scripts/native-proof/hosted-app.test.ts"], code: 1, stderr }, cleanup]));
      expect(() => requireNativeHostCleanup(cleanup)).toThrow("Native hosted proof did not provide complete owned-resource cleanup evidence.");
      expect(() => verifyIndexReleaseReproduction(directory, 1)).toThrow("NATIVE_INDEX_RELEASE_REPRO_OWNED_CLEANUP");
    }
  } finally { rmSync(directory, { recursive: true }); }
});

// A complete expected-failure fixture whose only variable is the kill signal.
function reproduction(directory: string, signal: object) {
  const stderr = "error: NATIVE_AUTOMATIC_INDEX_COMPLETED: NativeBrainManagerError: Native manager outcome is unknown\n"
    + "(fail) native hosted pi uid 0 first/warm admission, health, WebSocket, Stop and cancellation [1ms]\n"
    + ["descriptor records", "cwd records", "descriptor released just after its delete"].map(name => `(pass) ${name} [1ms]`).join("\n") + "\n1 fail\n";
  const run = join(directory, "run"), pin = { pid: 10, namespace: "mnt:[4026532000]", fd: 7, openedWallAt: 100, closedWallAt: 300, closedReason: "native-sync-failed" };
  mkdirSync(join(run, "native-release"), { recursive: true });
  writeFileSync(join(directory, "native-fixture.json"), JSON.stringify([
    { kind: "command", argv: ["/usr/local/bin/bun", "--no-env-file", "test", "--timeout", "30000", "/repo/scripts/native-proof/hosted-app.test.ts"], code: 1, stderr },
    { kind: "parent-userns-quota", unchanged: true }, clean]));
  writeFileSync(join(directory, "runner-quota.json"), JSON.stringify({ unchanged: true }));
  writeFileSync(join(run, "index-descendant-lifetime.json"), JSON.stringify({ truncated: false, pinned: pin, records: [{ pid: 10, mountNamespace: pin.namespace, deadObservedWallAt: 200 }] }));
  writeFileSync(join(run, "events.jsonl"), [{ kind: "automatic_index_failed", ordinal: 1, error: "Native manager outcome is unknown", wallAt: 250 },
    { kind: "automatic_index_finished", ordinal: 2, wallAt: 400 }].map(row => JSON.stringify(row)).join("\n"));
  const coverage = { processesTruncated: false, descriptorsTruncated: false, referencesTruncated: false, namespaceReferencesTruncated: false, mountsTruncated: false };
  const sample = { namespaceReferences: [{ pid: 20, fd: 7, namespace: pin.namespace }], references: [], mounts: [], processes: [], coverage };
  writeFileSync(join(run, "native-release", "sync.json"), JSON.stringify({ code: 137, root: { rootId: "256" }, samples: [sample, sample, sample, sample], signals: [signal] }));
  const sync = ["subvolume", "sync", "/brain-fixture", "256"];
  writeFileSync(join(run, "native-operations.jsonl"), [{ stage: "end", command: sync, code: 137, wallAt: 200 }, { stage: "end", command: sync, code: 0, wallAt: 300 }]
    .map(row => JSON.stringify(row)).join("\n"));
}

test("the expected sync kill accepts either equal deadline's abort reason and nothing else (#5027)", () => {
  // The manager's reason is the String() of the Error it aborts with; a reworded message must update the list.
  const manager = readFileSync(join(import.meta.dir, "../packages/ui-sdk/src/server/native-brain-manager.ts"), "utf8");
  expect(manager).toContain(`controller.abort(new Error("${DEADLINE_ABORT_REASONS[1].slice("Error: ".length)}"))`);
  const directory = mkdtempSync(join(tmpdir(), "index-release-abort-"));
  try {
    for (const reason of ["AbortError: The connection was closed.", "Error: Native manager transport operation timeout exceeded; configure operationTimeoutMs for this host workload."]) {
      reproduction(directory, { signal: "SIGKILL", abort: { reason } });
      expect(verifyIndexReleaseReproduction(directory, 1).kind, reason).toBe("expected-automatic-index-failure");
    }
    for (const signal of [{ signal: "SIGKILL", abort: { reason: "Error: Native release cleanup" } }, { signal: "SIGKILL" },
      { signal: "SIGTERM", abort: { reason: "AbortError: The connection was closed." } }]) {
      reproduction(directory, signal);
      expect(() => verifyIndexReleaseReproduction(directory, 1), JSON.stringify(signal)).toThrow("NATIVE_INDEX_RELEASE_REPRO_CONNECTION_ABORT");
    }
  } finally { rmSync(directory, { recursive: true }); }
});
