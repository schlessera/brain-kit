/**
 * #4301 commit C4: a launch refused for host private state keeps its typed
 * cause at every site that wraps or flattens a launch error, never reads as an
 * unavailable worker host, never refuses boot, and is recorded without a
 * synchronous write on the launch path.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createNativeBrainManagerClient, privateStateRefusalOf, registerWorkerPrivateState, WorkerPrivateStateError } from "@schlessera/brain-ui-sdk/internal";
import { workerPrivateStateProviders } from "../../ui-sdk/src/server/worker-private-state";
import { createHostBoundary } from "../src/brain/host-boundary";
import { createWriterGate } from "../src/brain/writer-gate";
import { createRuntimeStatus } from "../src/activity/runtime-status";
import { WorkerIdentityCleanupError } from "../../ui-sdk/src/server/worker-identity";
import * as maintenanceWorker from "../../ui-sdk/src/server/maintenance-worker";
import { runMaintenanceWorker } from "../../ui-sdk/src/server/maintenance-worker";
import { prepareWorkerSandbox } from "../../ui-sdk/src/server/worker-launcher";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
import { emitTurnError } from "../src/ws/bridge-capabilities/turn-error";
import { createActivityRuntime } from "../src/activity/runtime";
import { createUiDb } from "../src/db/client";
import { createSettingsWrites } from "../src/db/settings-writes";
import { createFixtureApp, createNativeAppFixture } from "./helpers/native-app-fixture";
import { testServerConfig } from "./helpers/test-config";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createPrincipal } from "../src/db/principals";
import { testAuthorization } from "./helpers/principal";
import { runSession } from "../src/ws/run-session";
import { MIN_BRAIN_CLI_VERSION } from "../src/brain/client";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { createRecordingObservability } from "../src/observability";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const exposure = () => new WorkerPrivateStateError("private_state_exposed", "WorkerPrivateStateError: turn journal is reachable in the worker's namespace at /opt/aeolus",
  { setting: "turn journal", path: "/srv/ithaca/state/brain-ui.db.journal", name: "/opt/aeolus", row: "31 1 8:1 /state /opt/aeolus ext4" });
/** A root every host-view sandbox shows, readable by every UID: a live exposure in any masked envelope. */
const VISIBLE = { setting: "odysseus alias", path: "/etc/passwd" };

describe("one typed refusal at every wrap and flatten site (A18)", () => {
  test("privateStateRefusalOf sees through the launch-cleanup wrapper's cause", () => {
    const refusal = exposure();
    const wrapped = Object.assign(new WorkerIdentityCleanupError("maintenance_worker_launch_cleanup_pending"), { cause: refusal });
    expect(privateStateRefusalOf(wrapped), "CLEANUP_WRAPPER_KEEPS_CAUSE").toBe(refusal);
    expect(privateStateRefusalOf(new Error("boom"))).toBeUndefined();
  });

  test("emitTurnError reports PRIVATE_STATE_EXPOSED for a thrown refusal, a wrapped one and the admission's own reason", () => {
    const refusal = exposure();
    for (const err of [refusal, Object.assign(new WorkerIdentityCleanupError("cleanup pending"), { cause: refusal }),
      Object.assign(new Error(`private_state_exposed: ${refusal.message}`), { reason: "private_state_exposed" })]) {
      const frames: unknown[] = [], failures: unknown[] = [];
      emitTurnError({ sendToClients: (frame: unknown) => frames.push(frame), reportTurnFailed: (...args: unknown[]) => failures.push(args) } as never,
        { requestId: "request-ithaca", turnId: "ithaca", sessionId: undefined } as never, err);
      expect(frames[0], "TURN_ERROR_PRIVATE_STATE_EXPOSED").toMatchObject({ type: "error", code: "PRIVATE_STATE_EXPOSED", requestId: "request-ithaca",
        failure: { errorClass: "private_state_exposed" } });
      expect((failures[0] as unknown[])[0]).toBe("PRIVATE_STATE_EXPOSED");
    }
  });

});

describe("runtime.privateStateLastExposure (A28)", () => {
  test("an exposure is recorded in its own field, retained across restart; the existing field is untouched", async () => {
    const root = mkdtempSync(join(resolve(import.meta.dir, "../../../tmp"), "odysseus-exposure-record-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const db = createUiDb(join(root, "ui.db"));
    const log = { emit() {}, enabled: () => false } as never;
    const record = { at: 1_783_814_400_000, reason: "private_state_exposed" as const, setting: "turn journal", path: "/opt/aeolus", row: "31 1 8:1 /state /opt/aeolus ext4", scope: "launch" as const };
    const first = createActivityRuntime(db, { log });
    first.runtime.recordPrivateStateExposure(record);
    expect(first.runtime.snapshot().privateStateLastExposure, "EXPOSURE_RECORDED").toEqual(record);
    expect(first.runtime.snapshot().operationalStateLastFailure, "OPERATIONAL_FIELD_UNTOUCHED").toBeUndefined();
    await first.close();
    const second = createActivityRuntime(db, { log });
    expect(second.runtime.snapshot().privateStateLastExposure, "EXPOSURE_RETAINED_ACROSS_RESTART").toEqual(record);
    await second.close();
    // A failed durable write changes nothing about the record or the caller.
    const failing = { ...createSettingsWrites(db), setSetting: () => Promise.reject(new Error("disk full on Ogygia")) };
    const third = createActivityRuntime(db, { log, settingsWrites: failing as never });
    expect(() => third.runtime.recordPrivateStateExposure({ ...record, at: record.at + 1 }), "WRITE_FAILURE_NEVER_THROWS").not.toThrow();
    expect(third.runtime.snapshot().privateStateLastExposure?.at).toBe(record.at + 1);
    await third.close(); db.close();
  });
});

describe("boot and admission with an exposure (A9, A13, A15)", () => {
  test("boot resolves with a declared minimum CLI version; the turn is refused with the cause, nothing stored; removing the alias admits the next turn", async () => {
    const root = mkdtempSync("/var/tmp/odysseus-exposure-app-"), brain = join(root, "brain"), dbPath = join(root, "ui.db");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
    // A stub CLI whose version the test chooses; it runs only inside maintenance workers.
    const cli = join(brain, "node_modules/.bin/brain"), answer = (version: string) => { rmSync(cli, { force: true }); writeFileSync(cli, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 }); };
    mkdirSync(dirname(cli), { recursive: true }); answer(MIN_BRAIN_CLI_VERSION);
    // Every maintenance launch for this brain sees the alias: the boot probes, the admission probe.
    let removeAlias: (() => void) | undefined = registerWorkerPrivateState(brain, { roots: () => [VISIBLE], walk: () => undefined });
    cleanups.push(() => removeAlias?.());
    let calls = 0;
    const backend = makeFakeBackend({ id: "offline", startTurn: async ({ bridge }) => { calls++;
      bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
      bridge.emit({ type: "result", sessionId: "sess-ithaca", durationMs: 1, numTurns: 1, isError: false }); } });
    const app = await createFixtureApp({ versionRequirements: { brainCli: MIN_BRAIN_CLI_VERSION, backends: {} },
      config: testServerConfig({ brain, db: dbPath }),
      registry: createStaticBackendRegistry([backend], backend.id) });
    cleanups.push(() => app.close());
    const bootedAt = Date.now();
    const status = await (await app.fetch(new Request("http://localhost/api/status"))).json() as { runtime?: { workerHost?: { governed?: { stateBoundary?: unknown } }; privateStateLastExposure?: unknown } };
    expect(status.runtime?.workerHost?.governed?.stateBoundary, "STATUS_REPORTS_WALK_MODE_AND_REFUSAL").toMatchObject({ mode: "walk",
      lastRefusal: { reason: "private_state_exposed", path: "/etc/passwd" } });
    expect(status.runtime?.privateStateLastExposure, "STATUS_REPORTS_LAST_EXPOSURE").toMatchObject({ reason: "private_state_exposed", setting: "odysseus alias", scope: "launch" });
    // F14: status names the exposure and advertises no strict fallback, never worker_host_unavailable.
    const governed = status.runtime?.workerHost?.governed as { available?: boolean; reason?: string; profile?: string } | undefined;
    expect(governed, "F14_STATUS_NAMES_EXPOSURE_NO_STRICT").toMatchObject({ available: false, reason: "private_state_exposed" });
    expect(governed?.profile, "F14_NO_STRICT_ADVERTISED").toBeUndefined();
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 60 }), frames: { type: string; code?: string }[] = [];
    app.wsHost.clients.add({ send: (text: string) => frames.push(JSON.parse(String(text))) } as never, principal.id);
    await runSession(app.wsHost, { authorization: testAuthorization(principal.id), text: "Inspect Ithaca", attachments: [] });
    expect(frames.find(frame => frame.type === "error"), "ADMISSION_REFUSED_WITH_CAUSE").toMatchObject({ code: "PRIVATE_STATE_EXPOSED" });
    expect(calls, "REFUSED_TURN_NEVER_STARTS").toBe(0);
    removeAlias(); removeAlias = undefined;
    // The deferred version check now runs first and is enforced: a CLI below the minimum refuses the turn.
    answer("0.1.0"); frames.length = 0;
    await runSession(app.wsHost, { authorization: testAuthorization(principal.id), text: "Inspect Ithaca again", attachments: [] });
    expect((frames.find(frame => frame.type === "error") as { message?: string } | undefined)?.message, "DEFERRED_VERSION_ENFORCED").toContain("0.1.0");
    expect(calls, "VERSION_REFUSED_TURN_NEVER_STARTS").toBe(0);
    answer(MIN_BRAIN_CLI_VERSION); frames.length = 0;
    await runSession(app.wsHost, { authorization: testAuthorization(principal.id), text: "Inspect Ithaca once more", attachments: [] });
    expect(frames.find(frame => frame.type === "error"), "RECOVERS_WITHOUT_RESTART").toBeUndefined();
    expect(calls, "NEXT_TURN_ADMITTED").toBe(1);
    // F8: status reads the live diagnostics, not the copy recorded at boot.
    const after = await (await app.fetch(new Request("http://localhost/api/status"))).json() as { runtime?: { workerHost?: { governed?: { reason?: string; stateBoundary?: { checkedAt: number | null } } } } };
    expect(after.runtime?.workerHost?.governed?.reason, "F8_STATUS_RECOVERS_LIVE").not.toBe("private_state_exposed");
    expect(after.runtime?.workerHost?.governed?.stateBoundary?.checkedAt, "F8_CHECKED_AT_IS_LIVE").toBeGreaterThan(bootedAt);
  }, watchdogMs(90_000));
});

describe("review round 1 at the boundary (F1, F2, F13)", () => {
  function brainRoot() {
    const root = mkdtempSync(join(resolve(import.meta.dir, "../../../tmp"), "odysseus-boundary-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const brain = join(root, "brain"); mkdirSync(brain); writeFileSync(join(brain, "ithaca.md"), "# Ithaca\n");
    return { root, brain };
  }
  test("F1: concurrent callers all wait for the deferred version check", async () => {
    const { brain } = brainRoot();
    const boundary = createHostBoundary({ brainPath: brain, exec: {} });
    let checks = 0;
    boundary.deferPreflight!(async () => { checks++; await Bun.sleep(200); return new WorkerPrivateStateError("private_state_exposed", "odysseus alias is reachable at /opt/aeolus"); });
    const results = await Promise.all([boundary.prepare(), boundary.prepare(), boundary.prepare()]);
    expect(results.map(result => !result.available && result.reason), "F1_EVERY_CALLER_REFUSED").toEqual(["private_state_exposed", "private_state_exposed", "private_state_exposed"]);
    expect(checks, "F1_ONE_SHARED_CHECK").toBe(1);
  }, watchdogMs(30_000));

  test("F2: the admission probe runs with the boundary's masks, so masked state does not refuse a cold admission", async () => {
    const { brain } = brainRoot();
    const native = createNativeAppFixture(brain); cleanups.push(native.close);
    // A state directory outside every fixed host mask: only the boundary's own masks hide it.
    const boundary = createHostBoundary({ brainPath: brain, exec: {}, nativeManager: createNativeBrainManagerClient(native.nativeBrain),
      privateStatePaths: [{ setting: "odysseus archive", path: "/usr/share/doc" }] });
    cleanups.push(() => boundary.disposePrivateState?.());
    const availability = await boundary.prepare();
    expect(!availability.available && availability.reason, `F2_MASKED_STATE_ADMITTED: ${JSON.stringify(availability)}`).not.toBe("private_state_exposed");
  }, watchdogMs(60_000));

  test("F13: a boundary with no layout and no masks registers nothing", () => {
    const { brain } = brainRoot();
    createHostBoundary({ brainPath: brain, exec: {} });
    expect(workerPrivateStateProviders(brain).length, "F13_TEMPORARY_BOUNDARY_REGISTERS_NOTHING").toBe(0);
  });
});

describe("an unqualified masked launch is never silent (#4301 Q1 ruling)", () => {
  test("the skip reaches the host log with its launch site and brain, and runtime status counts it", async () => {
    const root = mkdtempSync("/var/tmp/odysseus-unqualified-app-"), brain = join(root, "brain"), dbPath = join(root, "ui.db");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
    const observability = createRecordingObservability();
    const app = await createFixtureApp({ observability, config: testServerConfig({ brain, db: dbPath }),
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "offline" })], "offline") });
    cleanups.push(() => app.close());
    // A brain this process registered no layout for, launched with declared masks.
    const other = join(root, "aeolus"); mkdirSync(other); writeFileSync(join(other, "winds.md"), "# Winds\n");
    const view = createFixtureMaintenanceHost(other); cleanups.push(view.cleanup);
    const result = await runMaintenanceWorker({ brainPath: other, startupView: view.startupView, command: ["/bin/sh", "-c", "exit 0"],
      env: { PATH: "/usr/bin:/bin" }, credentials: false, maskPaths: [join(root, "state")], timeoutMs: 20_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    const warning = observability.logs.find({ severity: "WARN" }).find(log => String(log.body).includes("skipped private-state qualification"));
    expect(warning?.attributes, "UNQUALIFIED_SKIP_LOGGED").toMatchObject({ "launch.site": "maintenance", "launch.brain": realpathSync(other) });
    const status = await (await app.fetch(new Request("http://localhost/api/status"))).json() as { runtime?: { unqualifiedLaunches?: unknown } };
    expect(status.runtime?.unqualifiedLaunches, "UNQUALIFIED_SKIP_IN_STATUS").toMatchObject({ count: expect.any(Number), last: { site: "maintenance", brain: realpathSync(other) } });
  }, watchdogMs(90_000));
});

describe("review round 2 at the boundary (F19, F22, F30)", () => {
  /** An isolated native boundary whose brain also has a layout the host cannot read: every launch walks at its gate. */
  function walkingBoundary(onWalk: () => void, gate?: () => ReturnType<typeof createWriterGate>) {
    const root = mkdtempSync(join(tmpdir(), "odysseus-boundary-walk-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const brain = join(root, "brain"), marker = join(root, "marker"); mkdirSync(brain); mkdirSync(join(root, "state"));
    writeFileSync(join(brain, "ithaca.md"), "# Ithaca\n"); writeFileSync(marker, "");
    const native = createNativeAppFixture(brain); cleanups.push(native.close);
    const db = createUiDb(join(root, "state/ui.db")); cleanups.push(() => db.close());
    const writerGate = createWriterGate(db, brain);
    const boundary = createHostBoundary({ brainPath: brain, dbPath: join(root, "state/ui.db"), nativeManager: createNativeBrainManagerClient(native.nativeBrain),
      gate: gate ?? (() => writerGate) });
    cleanups.push(() => boundary.disposePrivateState?.());
    const notADirectory = join(root, "not-a-directory"); writeFileSync(notADirectory, "x");
    cleanups.push(registerWorkerPrivateState(brain, { roots: () => [{ setting: "turn journal", path: join(notADirectory, "journal") }], walk: () => { onWalk(); return undefined; } }));
    const payload = { argv: ["/bin/sh", "-c", `printf ran >> ${JSON.stringify(marker)}`], env: { PATH: "/usr/bin:/bin" }, credentials: false, purpose: "odysseus check", writeFiles: [marker] };
    return { boundary, marker, payload, writerGate };
  }
  const ran = (marker: string) => readFileSync(marker, "utf8");

  test("F22: an abort while boundary.launch waits at the gate never starts the payload", async () => {
    const controller = new AbortController();
    const f = walkingBoundary(() => controller.abort());
    await expect(f.boundary.launch({ ...f.payload, gate: "shared", signal: controller.signal }), "F22_LAUNCH_ABORT_REJECTS").rejects.toThrow();
    expect(ran(f.marker), "F22_LAUNCH_ABORT_NEVER_RAN").toBe("");
  }, watchdogMs(60_000));

  test("F22: a walk that outlasts boundary.run's timeout never starts the payload", async () => {
    const f = walkingBoundary(() => Bun.sleepSync(1_500));
    await f.boundary.run({ ...f.payload, gate: "shared", timeoutMs: 500 }).catch(() => undefined);
    expect(ran(f.marker), "F22_RUN_TIMEOUT_NEVER_RAN").toBe("");
  }, watchdogMs(60_000));

  test("F19: an ungated caller under an exclusive hold runs its own deferred check, also beside a pending gated one", async () => {
    const f = walkingBoundary(() => {});
    const modes: string[] = [];
    f.boundary.deferPreflight!(async mode => { modes.push(mode); await f.boundary.run({ ...f.payload, argv: ["/bin/sh", "-c", "exit 0"], gate: mode, timeoutMs: 20_000 }); return undefined; });
    const hold = await f.writerGate.acquire("exclusive", "workspace history revert");
    try {
      // A gated caller's check waits for the exclusive hold; the ungated one must not.
      const gated = f.boundary.run({ ...f.payload, argv: ["/bin/sh", "-c", "exit 0"], gate: "shared", timeoutMs: 20_000 });
      await Bun.sleep(200);
      const ungated = await f.boundary.run({ ...f.payload, argv: ["/bin/sh", "-c", "exit 0"], gate: "none", timeoutMs: 20_000 });
      expect(ungated.exitCode, "F19_UNGATED_RUN_UNDER_EXCLUSIVE_HOLD_RESOLVES").toBe(0);
      expect(modes, "F19_UNGATED_CHECK_IS_ITS_OWN").toEqual(["shared", "none"]);
      await hold.release();
      expect((await gated).exitCode, "F19_GATED_CALLER_COMPLETES_AFTER_RELEASE").toBe(0);
    } finally { await hold.release().catch(() => {}); }
  }, watchdogMs(90_000));

  test("F30: an exposure's log line says governed and strict turns are refused", () => {
    const lines: string[] = [];
    const status = createRuntimeStatus(undefined, { emit: (record: { body?: unknown }) => { lines.push(String(record.body)); }, enabled: () => true } as never);
    status.recordGoverned({ hostExecution: "worker", available: false, reason: "private_state_exposed", detail: "WorkerPrivateStateError: turn journal is reachable at /opt/aeolus" });
    expect(lines.join("\n"), "F30_EXPOSURE_REFUSES_BOTH_PROFILES").toContain("Governed and strict turns are refused");
    expect(lines.join("\n")).not.toContain("run under strict");
  });
});

describe("review round 3 (F38, F40)", () => {
  test("F38: a cancelled or unauthorized call never waits on a deferred check that cannot finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-preflight-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const brain = join(root, "brain"); mkdirSync(brain);
    const boundary = createHostBoundary({ brainPath: brain, exec: {} });
    let checks = 0;
    // A check that ends only when its own bound or signal ends it.
    boundary.deferPreflight!(async (_gate, signal) => { checks++; await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); return undefined; });
    const execution = { argv: ["/bin/sh", "-c", "exit 0"], env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared" as const, purpose: "odysseus check" };
    await expect(boundary.run({ ...execution, assertAuthorized: () => { throw new Error("Odysseus's session expired"); } }), "F38_UNAUTHORIZED_FIRST").rejects.toThrow("session expired");
    expect(checks, "F38_UNAUTHORIZED_NEVER_STARTS_A_CHECK").toBe(0);
    const controller = new AbortController(), started = performance.now();
    setTimeout(() => controller.abort(new Error("Telemachus cancelled")), 200);
    await expect(boundary.run({ ...execution, signal: controller.signal }), "F38_CANCELLED_CALLER_STOPS_WAITING").rejects.toThrow("Telemachus cancelled");
    expect(performance.now() - started, "F38_CANCELLATION_IS_PROMPT").toBeLessThan(5_000);
  }, watchdogMs(60_000));

  // Under path O5 the scratch query is a synchronous maintenance launch, which
  // walks and never refuses; the rethrow keeps the type for #5026's qualified
  // form, so the refusal is supplied at the query's own seam.
  test("F40: a scratch check refused for private state refuses the sandbox, never a read-only scratch", () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-scratch-exposure-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const brain = join(root, "brain"); mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
    const refused = spyOn(maintenanceWorker, "brainGitSteps").mockImplementation(() => { throw exposure(); });
    cleanups.push(() => refused.mockRestore());
    let thrown: unknown;
    try { prepareWorkerSandbox(brain, {}); } catch (error) { thrown = error; }
    expect(refused, "F40_SCRATCH_QUERY_RAN").toHaveBeenCalled();
    expect(privateStateRefusalOf(thrown)?.reason, "F40_SCRATCH_REFUSAL_KEEPS_ITS_TYPE").toBe("private_state_exposed");
  }, watchdogMs(60_000));
});
