/**
 * The server learns at boot whether its host can run agent workers, and
 * keeps reporting the latest real probe (#1632). A failure never refuses the
 * boot, and nothing here admits a turn: every turn runs its own probe, which
 * re-records the outcome (worker-host-gate.test.ts proves the turn half).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { workerHostBoundary, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";
import type { SystemStatus, WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";

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

describe("boot probe", () => {
  test("a failing host boots anyway, logs the named requirement once, and /api/status reports it", async () => {
    const spy = probeAnswers({ ok: false, requirement: FRESH_PROC });
    const observability = createRecordingObservability();
    const t = await createTestApp({ appOptions: { observability } });
    try {
      // Only the ordinary mode: autonomous work is not enabled.
      expect(spy.mock.calls.map(([, options]) => options)).toEqual([{ restricted: false }]);
      const workerHost = await workerHostOf(await t.fetch("/api/status"));
      expect(workerHost).toEqual({ ordinary: { available: false, requirement: FRESH_PROC, trigger: "boot", checkedAt: expect.any(String) } });
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
      expect(workerHost).toEqual({ ordinary: { available: true, trigger: "boot", checkedAt: expect.any(String) } });
    } finally { await t.teardown(); }
  });

  test("with autonomous work enabled, boot also probes the restricted envelope", async () => {
    const spy = probeAnswers({ ok: true }, { ok: false, requirement: "a private network namespace with only loopback failed" });
    const t = await createTestApp({ env: { BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "100" },
      appOptions: { [INBOX_DISPATCH_FIXTURE]: { select: async () => null } } as never });
    try {
      expect(spy.mock.calls.map(([, options]) => options)).toEqual([{ restricted: false }, { restricted: true }]);
      const workerHost = await workerHostOf(await t.fetch("/api/status"));
      expect(workerHost?.ordinary).toMatchObject({ available: true, trigger: "boot" });
      expect(workerHost?.restricted).toMatchObject({ available: false, requirement: "a private network namespace with only loopback failed" });
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
      expect(await fixed.json() as WorkerHostStatus).toEqual({ ordinary: { available: true, trigger: "check", checkedAt: expect.any(String) } });
      expect(spy).toHaveBeenCalledTimes(2);
      // A pass is not cached: the next check probes again.
      const broken = await (await t.fetch("/api/status/worker-host", { method: "POST" })).json() as WorkerHostStatus;
      expect(broken.ordinary).toMatchObject({ available: false, requirement: "bubblewrap is missing", trigger: "check" });
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
