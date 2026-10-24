import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import { probeWorkerHostRecorded, requireWorkerHostRecorded } from "../src/agent/worker-host";
import { hostExecution } from "../src/brain/host-boundary";
import { workerIdentitySentinelDirectory } from "../src/brain/operational-state";
import { mockQualifiedIdentityHelper } from "./helpers/qualified-identity-helper";

const original = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
const roots: string[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  for (const close of restore.splice(0)) close();
  if (original === undefined) delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
  else process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = original;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-probe-placement-")); roots.push(root);
  const brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state);
  // Only the already-qualified marker is synthetic. Invalid helper settings
  // still use the real lookup; native proof qualifies actual executable custody.
  const helper = mockQualifiedIdentityHelper(); restore.push(helper.restore);
  process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper.path;
  return { root, brain, state, dbPath: join(state, "ui.sqlite") };
}
function observingProbe() {
  const probe = spyOn(workerHostBoundary, "probe").mockImplementation((_brain, options) => {
    const directory = options?.identitySentinelDirectory ?? _brain;
    const sentinel = mkdtempSync(join(directory, ".worker-identity-sentinel-"));
    try {
      chmodSync(sentinel, 0o700); writeFileSync(join(sentinel, "identity"), "Odysseus", { mode: 0o600 });
      return { ok: false, requirement: "observed sentinel placement" };
    } finally { rmSync(sentinel, { recursive: true, force: true }); }
  });
  restore.push(() => probe.mockRestore()); return probe;
}

test("boot/check/turn ordinary and restricted probes forward the existing outside-state placement", async () => {
  const f = fixture(); const probe = observingProbe();
  for (const mode of ["ordinary", "restricted"] as const) {
    for (const trigger of ["boot", "check"] as const) {
      probeWorkerHostRecorded(f.brain, mode, undefined, trigger, undefined, undefined, { dbPath: f.dbPath });
    }
    await expect(requireWorkerHostRecorded(f.brain, mode, undefined, { dbPath: f.dbPath })).rejects.toThrow("observed sentinel placement");
  }
  expect(probe).toHaveBeenCalledTimes(6);
  for (const [, options] of probe.mock.calls) expect(options?.identitySentinelDirectory, "SERVER_PROBE_SENTINEL_OUTSIDE_CHECKPOINT").toBe(f.state);
  expect(readdirSync(f.brain)).toEqual([]);
});

test("memory state selects only the exact native lease setting; internal carry is revalidated", () => {
  const f = fixture();
  const context = { dbPath: ":memory:", privateStatePaths: [
    { setting: "turn journal", path: join(f.brain, "untrusted") },
    { setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: join(f.state, "leases.sqlite") },
  ] };
  expect(workerIdentitySentinelDirectory(f.brain, context)).toBe(f.state);
  expect(workerIdentitySentinelDirectory(f.brain, { identitySentinelDirectory: f.state })).toBe(f.state);
  expect(() => workerIdentitySentinelDirectory(f.brain, { dbPath: ":memory:", privateStatePaths: context.privateStatePaths.slice(0, 1) })).toThrow("requires trusted server state");
  expect(() => workerIdentitySentinelDirectory(f.brain, { identitySentinelDirectory: f.brain })).toThrow("inside the brain");
});

test("missing, in-brain and replaced linked parents refuse before invoking a probe or creating state", () => {
  const f = fixture(); const probe = observingProbe();
  const alias = join(f.root, "alias"); symlinkSync(f.state, alias);
  expect(workerIdentitySentinelDirectory(f.brain, { identitySentinelDirectory: alias })).toBe(f.state);
  rmSync(alias); symlinkSync(f.brain, alias);
  for (const state of [{}, { dbPath: ":memory:" }, { dbPath: "" },
    { dbPath: join(f.brain, "ui.sqlite") }, { identitySentinelDirectory: alias },
    { dbPath: join(f.root, "absent", "ui.sqlite") }]) {
    expect(probeWorkerHostRecorded(f.brain, "ordinary", undefined, "check", undefined, undefined, state).ok).toBe(false);
    expect(hostExecution.probe(f.brain, state).ok).toBe(false);
  }
  expect(probe, "NO_PROBE_WITHOUT_TRUSTED_EXISTING_STATE").not.toHaveBeenCalled();
  expect(existsSync(join(f.root, "absent"))).toBe(false);
});

test("host-boundary probes use the same concrete memory placement; no-helper leaves SDK defaults intact", () => {
  const f = fixture(); const probe = observingProbe();
  hostExecution.probe(f.brain, { dbPath: ":memory:", identitySentinelDirectory: f.state });
  expect(probe.mock.calls[0]?.[1]?.identitySentinelDirectory).toBe(f.state);
  delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
  probeWorkerHostRecorded(f.brain, "ordinary", undefined, "check");
  expect(probe.mock.calls[1]?.[1]).toEqual({ restricted: false });
  hostExecution.probe(f.brain);
  expect(probe.mock.calls[2]?.[1]).toBeUndefined();
});


test("host-boundary preserves the configured-helper refusal instead of misattributing placement", () => {
  const f = fixture(); const probe = observingProbe();
  process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = "   ";
  const diagnostic = "BRAIN_UI_WORKER_IDENTITY_HELPER cannot be whitespace";
  expect(hostExecution.probe(f.brain, { dbPath: f.dbPath }), "PROBE_HELPER_DIAGNOSTIC_PRESERVED").toEqual({ ok: false, requirement: diagnostic });
  expect(probeWorkerHostRecorded(f.brain, "ordinary", undefined, "check", undefined, undefined, { dbPath: f.dbPath }))
    .toEqual({ ok: false, requirement: diagnostic });
  expect(probe).not.toHaveBeenCalled();
});
