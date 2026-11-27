/**
 * #4301 commit C4: a launch refused for host private state keeps its typed
 * cause at every site that wraps or flattens a launch error, never reads as an
 * unavailable worker host, never refuses boot, and is recorded without a
 * synchronous write on the launch path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { privateStateRefusalOf, registerWorkerPrivateState, WorkerPrivateStateError } from "@schlessera/brain-ui-sdk/internal";
import { WorkerIdentityCleanupError } from "../../ui-sdk/src/server/worker-identity";
import { brainGitSync } from "../../ui-sdk/src/server/maintenance-worker";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
import { emitTurnError } from "../src/ws/bridge-capabilities/turn-error";
import { createActivityRuntime } from "../src/activity/runtime";
import { createUiDb } from "../src/db/client";
import { createSettingsWrites } from "../src/db/settings-writes";
import { createFixtureApp } from "./helpers/native-app-fixture";
import { testServerConfig } from "./helpers/test-config";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createPrincipal } from "../src/db/principals";
import { testAuthorization } from "./helpers/principal";
import { runSession } from "../src/ws/run-session";
import { MIN_BRAIN_CLI_VERSION } from "../src/brain/client";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { watchdogMs } from "../../../scripts/test-deadlines.js";

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

  test("brainGitSteps rethrows a refusal instead of answering 127", () => {
    const root = mkdtempSync(join(resolve(import.meta.dir, "../../../tmp"), "odysseus-git-exposure-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const host = createFixtureMaintenanceHost(root); cleanups.push(host.cleanup);
    cleanups.push(registerWorkerPrivateState(root, { roots: () => [VISIBLE], walk: () => undefined }));
    let thrown: unknown;
    try { brainGitSync(root, ["rev-parse", "--git-dir"], host); } catch (error) { thrown = error; }
    expect(privateStateRefusalOf(thrown)?.reason, "GIT_REFUSAL_NOT_127").toBe("private_state_exposed");
  }, watchdogMs(30_000));
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
    const status = await (await app.fetch(new Request("http://localhost/api/status"))).json() as { runtime?: { workerHost?: { governed?: { stateBoundary?: unknown } }; privateStateLastExposure?: unknown } };
    expect(status.runtime?.workerHost?.governed?.stateBoundary, "STATUS_REPORTS_WALK_MODE_AND_REFUSAL").toMatchObject({ mode: "walk",
      lastRefusal: { reason: "private_state_exposed", path: "/etc/passwd" } });
    expect(status.runtime?.privateStateLastExposure, "STATUS_REPORTS_LAST_EXPOSURE").toMatchObject({ reason: "private_state_exposed", setting: "odysseus alias", scope: "launch" });
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
  }, watchdogMs(90_000));
});
