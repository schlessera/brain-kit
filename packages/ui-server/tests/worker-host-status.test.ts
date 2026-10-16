/**
 * The server learns at boot whether its host can run agent workers, and
 * keeps reporting the latest real probe (#1632). A failure never refuses the
 * boot, and nothing here admits a turn: every turn runs its own probe, which
 * re-records the outcome (worker-host-gate.test.ts proves the turn half).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { WorkerStateError, workerHostBoundary, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";
import type { SystemStatus, WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";

import * as nativeLeases from "../src/brain/native-brain-leases.js";
import { hostExecution } from "../src/brain/host-boundary";
import { createRuntimeStatus } from "../src/activity/runtime-status";
import { INBOX_DISPATCH_FIXTURE } from "../src/inbox/dispatch-fixture";
import { createRecordingObservability } from "../src/observability/index";
import { createTestApp } from "./helpers/test-app";

const FRESH_PROC = "the kernel refused the worker a fresh /proc because the parent /proc has masked or covered paths;"
  + " in Docker, run the container with --security-opt systempaths=unconfined";

let probe: ReturnType<typeof spyOn<typeof workerHostBoundary, "probe">> | undefined;
afterEach(() => { probe?.mockRestore(); probe = undefined; });
function probeAnswers(...answers: WorkerHostProbe[]) {
  let i = 0;
  probe = spyOn(workerHostBoundary, "probe").mockImplementation(() => answers[Math.min(i++, answers.length - 1)]!);
  return probe;
}
const workerHostOf = async (response: Response) => ((await response.json()) as SystemStatus).runtime?.workerHost;

// The server's uid is faked for every test, non-root unless a test says
// otherwise, so the exact status shapes below hold under any test runner uid.
let uids: Array<{ mockRestore(): void }> = [];
function runAs(uid: number, euid = uid) {
  for (const spy of uids) spy.mockRestore();
  uids = [spyOn(process, "getuid").mockReturnValue(uid), spyOn(process, "geteuid").mockReturnValue(euid)];
}
let nativeOwnership: ReturnType<typeof spyOn<typeof nativeLeases, "createNativeBrainLeaseManager">>;
let maintenanceProbe: ReturnType<typeof spyOn<typeof hostExecution, "maintenanceProbe">>;
// This file characterizes status/uid observations with synthetic OS identity.
// Do not apply that identity to a real filesystem admission; actual native
// maintenance qualification and busy recovery are proved in runtime tests.
beforeEach(() => {
  nativeOwnership = spyOn(nativeLeases, "createNativeBrainLeaseManager").mockImplementation(async client => ({ client,
    async recoverDeadOwners() { return { released: [], retainedLive: 0, retainedUnverifiable: 0, unknown: [] }; }, async close() {} }));
  runAs(1000); maintenanceProbe = spyOn(hostExecution, "maintenanceProbe").mockReturnValue({ ok: true }); });
afterEach(() => { maintenanceProbe.mockRestore(); nativeOwnership.mockRestore(); });
afterEach(() => { for (const spy of uids) spy.mockRestore(); uids = []; });

describe("boot probe", () => {
  test("a failing host boots anyway, logs the named requirement once, and /api/status reports it", async () => {
    const spy = probeAnswers({ ok: false, requirement: FRESH_PROC });
    const observability = createRecordingObservability();
    const t = await createTestApp({ appOptions: { observability } });
    try {
      // Only the ordinary mode: autonomous work is not enabled.
      expect(spy.mock.calls.map(([, options]) => options)).toEqual([{ restricted: false, stateBytes: 64 * 1024 * 1024,
        turnTempBytes: 256 * 1024 * 1024 }]);
      const workerHost = await workerHostOf(await t.fetch("/api/status"));
      expect(workerHost).toEqual({ ordinary: { available: false, requirement: FRESH_PROC, trigger: "boot", checkedAt: expect.any(String) },
        // #1648: governed cannot run either, and with no turn able to change the brain its code stays on the host.
        governed: { available: false, reason: "worker_host_unavailable", detail: FRESH_PROC, hostExecution: "worker", profile: "strict", protectedPaths: expect.any(Array), identity: "shared_uid", configurationView: "startup" }, limits: expect.any(Object) });
      const warnings = observability.logs.find({ severity: "WARN" }).filter(log => String(log.body).includes(FRESH_PROC));
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]!.body)).toContain("The server keeps running");
      // The rest of the app is usable.
      expect((await t.fetch("/api/health")).status).toBe(200);
    } finally { await t.teardown(); }
  });

  test("a passing host reports the worker boundary available", async () => {
    probeAnswers({ ok: true });
    const t = await createTestApp();
    try {
      const workerHost = await workerHostOf(await t.fetch("/api/status"));
      expect(workerHost).toEqual({ ordinary: { available: true, trigger: "boot", checkedAt: expect.any(String) },
        governed: { available: true, hostExecution: "worker", profile: "governed", protectedPaths: expect.any(Array), identity: "shared_uid", configurationView: "live" }, limits: expect.any(Object) });
    } finally { await t.teardown(); }
  });

  test("with autonomous work enabled, boot also probes the restricted envelope", async () => {
    const spy = probeAnswers({ ok: true }, { ok: false, requirement: "a private network namespace with only loopback failed" });
    const t = await createTestApp({ env: { BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "100" },
      appOptions: { [INBOX_DISPATCH_FIXTURE]: { select: async () => null } } as never });
    try {
      expect(spy.mock.calls.map(([, options]) => options)).toEqual([
        { restricted: false, stateBytes: 64 * 1024 * 1024, turnTempBytes: 256 * 1024 * 1024 },
        { restricted: true, stateBytes: 64 * 1024 * 1024, turnTempBytes: 256 * 1024 * 1024 },
      ]);
      const workerHost = await workerHostOf(await t.fetch("/api/status"));
      expect(workerHost?.ordinary).toMatchObject({ available: true, trigger: "boot" });
      expect(workerHost?.restricted).toMatchObject({ available: false, requirement: "a private network namespace with only loopback failed" });
    } finally { await t.teardown(); }
  });
});

describe("worker resource limits (#1660)", () => {
  test("/api/status reports the limits each worker runs under and why the others are absent; absent ones warn once", async () => {
    probeAnswers({ ok: true });
    const observability = createRecordingObservability();
    const t = await createTestApp({ env: { BRAIN_UI_WORKER_LIMITS: "processes=2048,data=2GiB,file_size=1GiB,open_files=512,cgroup=off" },
      appOptions: { observability } });
    try {
      const limits = (await workerHostOf(await t.fetch("/api/status")))?.limits;
      expect(limits).toEqual({
        enforced: [
          { limit: "processes", source: "rlimit", value: 2048 }, { limit: "data", source: "rlimit", value: 2 * 1024 ** 3 },
          { limit: "file_size", source: "rlimit", value: 1024 ** 3 }, { limit: "open_files", source: "rlimit", value: 512 }],
        absent: (["memory", "pids", "cpu"] as const).map(limit => ({ limit, source: "cgroup" as const, reason: "turned off by the host (cgroup=off)" })),
      });
      // The operator turned the cgroup off: that is stated, not warned about.
      expect(observability.logs.find({ severity: "WARN" }).filter(log => String(log.body).includes("is not enforced"))).toEqual([]);
      // Check again re-reads them with the probe.
      const checked = await (await t.fetch("/api/status/worker-host", { method: "POST" })).json() as WorkerHostStatus;
      expect(checked.limits).toEqual(limits);
    } finally { await t.teardown(); }
  });

  test("a malformed configuration reports every limit absent, naming the entry", async () => {
    probeAnswers({ ok: true });
    const t = await createTestApp({ env: { BRAIN_UI_WORKER_LIMITS: "memory=lots" } });
    try {
      const limits = (await workerHostOf(await t.fetch("/api/status")))?.limits;
      expect(limits?.enforced).toEqual([]);
      expect(limits?.absent).toHaveLength(7);
      for (const entry of limits!.absent) expect(entry.reason).toBe("BRAIN_UI_WORKER_LIMITS is malformed: memory=lots is not a size such as 8GiB");
    } finally { await t.teardown(); }
  });
});

describe("Check again", () => {
  test("re-runs the real probe and records what it found, in both directions", async () => {
    const spy = probeAnswers({ ok: false, requirement: FRESH_PROC }, { ok: true }, { ok: false, requirement: "bubblewrap is missing" });
    const t = await createTestApp();
    try {
      const fixed = await t.fetch("/api/status/worker-host", { method: "POST" });
      expect(fixed.status).toBe(200);
      expect(await fixed.json() as WorkerHostStatus).toEqual({ ordinary: { available: true, trigger: "check", checkedAt: expect.any(String) },
        governed: { available: true, hostExecution: "worker", profile: "governed", protectedPaths: expect.any(Array), identity: "shared_uid", configurationView: "live" }, limits: expect.any(Object) });
      expect(spy).toHaveBeenCalledTimes(2);
      // A pass is not cached: the next check probes again.
      const broken = await (await t.fetch("/api/status/worker-host", { method: "POST" })).json() as WorkerHostStatus;
      expect(broken.ordinary).toMatchObject({ available: false, requirement: "bubblewrap is missing", trigger: "check" });
      expect(broken.governed).toMatchObject({ available: false, reason: "worker_host_unavailable", detail: "bubblewrap is missing" });
      expect(spy).toHaveBeenCalledTimes(3);
      expect(await workerHostOf(await t.fetch("/api/status"))).toEqual(broken);
    } finally { await t.teardown(); }
  });

  test("is behind the auth guard", async () => {
    const spy = probeAnswers({ ok: true });
    const t = await createTestApp({ env: { AUTH_MODE: "proxy", TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-fixture-user" } });
    try {
      // createTestApp forces AUTH_MODE=none before the env overrides apply,
      // so this app authenticates through the proxy header.
      expect((await t.fetch("/api/status/worker-host", { method: "POST" })).status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { await t.teardown(); }
  });
});

describe("recorded outcome", () => {
  test("re-records every probe, logging only the first outcome and each change", () => {
    const observability = createRecordingObservability();
    const runtime = createRuntimeStatus(undefined, observability.logger("activity"));
    expect(runtime.snapshot().workerHost).toBeUndefined();
    runtime.recordWorkerHost("ordinary", { ok: false, requirement: FRESH_PROC }, "boot");
    runtime.recordWorkerHost("ordinary", { ok: false, requirement: FRESH_PROC }, "turn");
    runtime.recordWorkerHost("ordinary", { ok: false, requirement: FRESH_PROC }, "turn");
    expect(runtime.snapshot().workerHost?.ordinary).toMatchObject({ available: false, trigger: "turn" });
    expect(observability.logs.find({ severity: "WARN" })).toHaveLength(1);
    runtime.recordWorkerHost("ordinary", { ok: true }, "turn");
    expect(runtime.snapshot().workerHost?.ordinary).toMatchObject({ available: true, trigger: "turn" });
    expect(observability.logs.find({ severity: "INFO" })).toHaveLength(1);
    runtime.recordWorkerHost("ordinary", { ok: false, requirement: "bubblewrap is missing" }, "turn");
    expect(observability.logs.find({ severity: "WARN" })).toHaveLength(2);
  });
});

describe("a root-run server (#1638)", () => {
  // The worker host probe is stubbed, so nothing here runs as root.
  const KEEPS = "can read root-owned files and connect to root-owned and abstract Unix sockets";
  const rootWarnings = (observability: ReturnType<typeof createRecordingObservability>) =>
    observability.logs.find({ severity: "WARN" }).filter(log => String(log.body).includes("runs as root"));

  test("boots, warns once in the log, and keeps the warning on /api/status and through Check again", async () => {
    probeAnswers({ ok: true });
    runAs(0);
    const observability = createRecordingObservability();
    const t = await createTestApp({ appOptions: { observability } });
    try {
      expect((await t.fetch("/api/health")).status).toBe(200);
      const warnings = rootWarnings(observability);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]!.body)).toContain(KEEPS);
      const workerHost = await workerHostOf(await t.fetch("/api/status"));
      expect(workerHost?.rootServer).toEqual({ warning: String(warnings[0]!.body) });
      expect(workerHost?.ordinary).toMatchObject({ available: true, trigger: "boot" });
      const checked = await (await t.fetch("/api/status/worker-host", { method: "POST" })).json() as WorkerHostStatus;
      expect(checked.rootServer?.warning).toContain(KEEPS);
      expect(rootWarnings(observability)).toHaveLength(1);
    } finally { await t.teardown(); }
  });

  test("an effective uid of 0 is enough", async () => {
    probeAnswers({ ok: true });
    runAs(1000, 0);
    const t = await createTestApp();
    try {
      expect((await workerHostOf(await t.fetch("/api/status")))?.rootServer?.warning).toContain(KEEPS);
    } finally { await t.teardown(); }
  });

  test("a non-root server reports no root warning", async () => {
    probeAnswers({ ok: true });
    runAs(1000);
    const observability = createRecordingObservability();
    const t = await createTestApp({ appOptions: { observability } });
    try {
      expect((await workerHostOf(await t.fetch("/api/status")))?.rootServer).toBeUndefined();
      expect(rootWarnings(observability)).toHaveLength(0);
    } finally { await t.teardown(); }
  });
});

describe("maintenance resource refusals (#1778)", () => {
  test.each(["worker_state_busy", "worker_state_exceeded"] as const)("a named %s maintenance refusal keeps boot and status available without host fallback", async errorClass => {
    probeAnswers({ ok: true });
    const detail = errorClass === "worker_state_exceeded"
      ? "Complete immutable startup inputs exceed available storage; nothing ran."
      : "Maintenance temporary storage is busy; nothing ran.";
    maintenanceProbe.mockImplementation(() => { throw new WorkerStateError(errorClass, detail); });
    const t = await createTestApp();
    try {
      expect((await t.fetch("/api/health")).status, "RESOURCE_REFUSAL_DOES_NOT_CRASH_BOOT").toBe(200);
      const status = await t.fetch("/api/status");
      expect(status.status, "RESOURCE_REFUSAL_DOES_NOT_CRASH_STATUS").toBe(200);
      expect((await workerHostOf(status))?.governed, "RESOURCE_REFUSAL_NEVER_SELECTS_HOST_EXECUTION").toMatchObject({
        available: false, reason: "worker_host_unavailable", detail, hostExecution: "worker",
      });
      maintenanceProbe.mockReturnValue({ ok: true });
      const checked = await t.fetch("/api/status/worker-host", { method: "POST" });
      expect(checked.status).toBe(200);
      expect((await checked.json() as WorkerHostStatus).governed, "RESOURCE_REFUSAL_RECOVERS_WITHOUT_CACHED_FAILURE").toMatchObject({
        available: true, hostExecution: "worker",
      });
    } finally { await t.teardown(); }
  });
});
