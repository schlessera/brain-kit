/**
 * Hosted external compute admission (#3108) against a fake Boat: identity
 * from the host, per-use approval that is never remembered and never asked
 * of a turn that cannot answer, data-to-provider and mask refusals before any
 * export, credentials that stay on the host, atomic budget and slot
 * reservation, unknown accounting, cancellation, restart and uncertain
 * outcomes in Activity. Keyless, offline, disposable state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ComputeToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";

import { resolveComputeConfig } from "../src/config/env.js";
import { computeFixture, SENTINEL, summary } from "./helpers/compute-host-fixture.js";

type Fixture = ReturnType<typeof computeFixture>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const fixture = (options: Parameters<typeof computeFixture>[0] = {}) => { const f = computeFixture(options); fixtures.push(f); return f; };

const ok = <T extends ComputeToolResult>(result: T) => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }> & { job: { id: string; state: string; cleanup: { state: string }; cost: { estimate: { usd: number | null } } } };
};
const code = (result: ComputeToolResult) => (result.ok ? "ok" : result.error.code);
const run = (input: Record<string, unknown> = {}) => ({ tool: "brain_compute_run" as const, input: { provider: "boat-small", argv: ["exit", "0"], ...input } as never, toolUseId: "toolu_ithaca" });
const job = (tool: "brain_compute_status" | "brain_compute_cancel" | "brain_compute_collect", id: string) => ({ tool, input: { job: id } });

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(5); }
}

describe("identity comes from the host", () => {
  test("a run records the turn's principal, session and turn; another conversation cannot address the job", async () => {
    const f = fixture();
    await f.begin("t-1");
    const started = ok(await f.host.forTurn(f.turn("t-1"))(run()));
    const row = f.db.query("SELECT principal_id, session_id, turn_id, tool_use_id FROM compute_hosted_jobs WHERE job_id = ?").get(started.job.id);
    expect(row, "HOSTED_CALLER_FROM_TURN").toEqual({ principal_id: "odysseus", session_id: "sess-ogygia", turn_id: "t-1", tool_use_id: "toolu_ithaca" });
    // A later turn of the same conversation may collect it.
    await f.begin("t-2");
    expect(code(await f.host.forTurn(f.turn("t-2"))(job("brain_compute_status", started.job.id))), "LATER_TURN_SAME_SESSION").toBe("ok");
    // Another conversation, or another principal, sees no such job.
    expect(code(await f.host.forTurn(f.turn("t-3", { sessionId: () => "sess-aeaea" }))(job("brain_compute_status", started.job.id))), "OTHER_SESSION_JOB_UNKNOWN").toBe("job_unknown");
    expect(code(await f.host.forTurn(f.turn("t-4", { principalId: "eurylochus", sessionId: () => "sess-aeaea" }))(job("brain_compute_cancel", started.job.id))), "OTHER_PRINCIPAL_JOB_UNKNOWN").toBe("job_unknown");
  });

  test("a re-login in the same conversation reaches its jobs, and the change of principal is recorded on the run", async () => {
    const f = fixture();
    await f.begin("t-1");
    const started = ok(await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] })));
    await f.begin("t-2");
    // The host authorized this principal for the conversation; the job is the conversation's (ruling R7).
    expect(code(await f.host.forTurn(f.turn("t-2", { principalId: "odysseus-relogin" }))(job("brain_compute_status", started.job.id))), "RELOGIN_SAME_SESSION_REACHES_JOB").toBe("ok");
    const events = f.store.snapshotRun(`compute:${started.job.id}`)!.events.filter(event => event.eventType === "compute_principal");
    expect(events.map(event => event.payload), "PRINCIPAL_CHANGE_RECORDED").toEqual([{ owner: "odysseus", principal: "odysseus-relogin", turn: "t-2", tool: "brain_compute_status" }]);
    expect(code(await f.host.forTurn(f.turn("t-3", { principalId: "odysseus-relogin", sessionId: () => "sess-aeaea" }))(job("brain_compute_collect", started.job.id))), "RELOGIN_OTHER_SESSION_UNKNOWN").toBe("job_unknown");
  });

  test("a turn revoked while its card was open is refused under the admission lock, with nothing reserved", async () => {
    const f = fixture();
    await f.begin("t-1");
    let current = true;
    const turn = f.turn("t-1", { isCurrent: () => current, decide: () => { current = false; return { behavior: "allow" }; } });
    expect(code(await f.host.forTurn(turn)(run())), "RECHECK_AFTER_CARD_REFUSES").toBe("policy_denied");
    expect({ reserved: (f.db.query("SELECT COUNT(*) AS n FROM compute_budget_reservations").get() as { n: number }).n, created: f.fake.created() }).toEqual({ reserved: 0, created: 0 });
  });

  test("a turn without a session yet, or no longer current, is refused before anything is read", async () => {
    const f = fixture();
    expect(code(await f.host.forTurn(f.turn("t-1", { sessionId: () => undefined }))(run()))).toBe("policy_denied");
    expect(code(await f.host.forTurn(f.turn("t-1", { isCurrent: () => false }))(run())), "REVOKED_TURN_REFUSED").toBe("policy_denied");
    expect(f.reads).toEqual([]);
  });
});

describe("approval", () => {
  test("a typed turn approves each run on a command card that names everything sent and no secret", async () => {
    const f = fixture();
    await f.begin("t-1");
    ok(await f.host.forTurn(f.turn("t-1"))(run({ source: ["notes/raft.md"], env: { VOYAGE: "ithaca" }, artifacts: [{ path: "out/log.txt", max_bytes: 1024 }] })));
    expect(f.cards, "APPROVAL_CARD_SHOWN").toHaveLength(1);
    const card = f.cards[0]!.request;
    expect(card, "APPROVAL_CARD_KIND_COMMAND").toMatchObject({ kind: "command", toolName: "mcp__brain-ui__brain_compute_run", toolUseId: "toolu_ithaca" });
    expect(card.input).toMatchObject({ instance: "boat-small", provider: "boat", lease_seconds: 3600, estimate: "unknown (no hourly ceiling configured)",
      argv: ["exit", "0"], env_names: ["VOYAGE"], source: { files: [{ path: "notes/raft.md" }] } });
    expect(JSON.stringify(card)).not.toContain(SENTINEL);
    expect(f.governance.filter(event => event.kind === "outward_action").map(event => (event.payload as { action: string; decision: string; target: string })),
      "OUTWARD_ACTION_RECORDED").toEqual([expect.objectContaining({ action: "compute_run", decision: "approved", target: "boat-small" })]);
    // Never remembered: the next run asks again.
    ok(await f.host.forTurn(f.turn("t-1"))(run()));
    expect(f.cards, "APPROVAL_PER_USE").toHaveLength(2);
  });

  test("a denied or edited card refuses and allocates nothing", async () => {
    const f = fixture();
    await f.begin("t-1");
    expect(code(await f.host.forTurn(f.turn("t-1", { decide: () => ({ behavior: "deny", message: "Not today" }) }))(run())), "DENIED_CARD").toBe("policy_denied");
    expect(code(await f.host.forTurn(f.turn("t-1", { decide: () => ({ behavior: "allow", updatedInput: { argv: ["exit", "1"] } }) }))(run())), "EDITED_CARD_REFUSED").toBe("policy_denied");
    expect(f.fake.created(), "NOTHING_ALLOCATED_AFTER_DENIAL").toBe(0);
    expect(f.governance.filter(event => event.kind === "outward_action").map(event => (event.payload as { decision: string }).decision)).toEqual(["declined", "declined"]);
  });

  test("voice, a turn without a grant surface, and a turn with no client are refused without a card", async () => {
    const f = fixture();
    await f.begin("t-1");
    for (const [label, turn] of [["voice", f.turn("t-1", { posture: "voice", noGrantSurface: true })], ["no grant surface", f.turn("t-1", { noGrantSurface: true })],
      ["no client", f.turn("t-1", { hasClient: () => false })]] as const) {
      expect(code(await f.host.forTurn(turn)(run())), `NO_PROMPT_${label}`).toBe("approval_required");
    }
    expect(f.cards, "NO_CARD_SHOWN").toHaveLength(0);
    expect(f.fake.created()).toBe(0);
    expect(f.governance.filter(event => event.kind === "outward_action").map(event => (event.payload as { decision: string }).decision)).toEqual(["refused", "refused", "refused"]);
  });

  test("a plan shows what a run would get and never shows a card", async () => {
    const f = fixture();
    expect(ok(await f.host.forTurn(f.turn("t-1"))({ tool: "brain_compute_plan", input: { provider: "boat-small", argv: ["true"], source: ["notes/raft.md"] } }))).toMatchObject({ plan: { instance: "boat-small" } });
    expect(code(await f.host.forTurn(f.turn("t-1", { posture: "voice", noGrantSurface: true }))({ tool: "brain_compute_plan", input: { provider: "boat-small", argv: ["true"] } }))).toBe("approval_required");
    expect(f.cards).toHaveLength(0);
  });
});

describe("data routing before export", () => {
  test("a masked folder, a .env file and a Tier A path are refused as sources before any allocation", async () => {
    const f = fixture();
    await f.begin("t-1");
    const refused: unknown[] = [];
    const maskGuard = { assert(tool: string, paths: readonly string[]) {
      const hit = paths.find(path => path === "health" || path.startsWith("health/"));
      if (hit) { refused.push({ tool, hit }); throw Object.assign(new (require("../src/brain/provider-mask-refusal.js").ProviderMaskRefusedError)({ tool, path: hit, rule: { list: "providers", index: 0, pattern: "health/**" } })); }
    } };
    const turn = f.turn("t-1", { maskGuard });
    expect(code(await f.host.forTurn(turn)(run({ source: ["health/sea-sickness.md"] }))), "MASKED_SOURCE_REFUSED").toBe("source_refused");
    expect(refused).toEqual([{ tool: "mcp__brain-ui__brain_compute_run", hit: "health/sea-sickness.md" }]);
    expect(code(await f.host.forTurn(turn)(run({ source: [".env"] }))), "ENV_SOURCE_REFUSED").toBe("source_refused");
    expect(code(await f.host.forTurn(turn)(run({ source: ["context/policies/governance.md"] }))), "TIER_A_SOURCE_REFUSED").toBe("source_refused");
    expect(code(await f.host.forTurn(turn)(run({ cwd: "health" }))), "MASKED_CWD_REFUSED").toBe("source_refused");
    expect({ cards: f.cards.length, created: f.fake.created() }).toEqual({ cards: 0, created: 0 });
  });

  test("the turn's frozen provider rules apply with the instance as recipient", async () => {
    const f = fixture();
    await f.begin("t-1");
    const turn = f.turn("t-1", { policy: { providers: [{ paths: ["notes/**"], allow: ["boat-large"] }], protect: [], release: [] } as never });
    expect(code(await f.host.forTurn(turn)(run({ source: ["notes/raft.md"] }))), "FROZEN_PROVIDER_RULE").toBe("policy_denied");
    expect(f.fake.created()).toBe(0);
  });
});

describe("credentials stay on the host", () => {
  test("the bound credential reaches the vendor request only: not the records, results, card or governance", async () => {
    const f = fixture();
    await f.begin("t-1");
    const compute = f.host.forTurn(f.turn("t-1"));
    const started = ok(await compute(run({ argv: ["printenv"] })));
    await until(async () => (ok(await compute(job("brain_compute_status", started.job.id))).job.state !== "running"), "the job to end");
    const collected = await compute(job("brain_compute_collect", started.job.id));
    expect(f.fake.requests.some(request => request.headers.authorization?.includes(SENTINEL)), "VENDOR_GETS_KEY").toBe(true);
    expect(f.stateFilesContaining(SENTINEL), "NO_SECRET_IN_RECORDS").toEqual([]);
    expect(JSON.stringify([started, collected, f.cards, f.governance]), "NO_SECRET_IN_RESULTS").not.toContain(SENTINEL);
    expect(JSON.stringify(f.db.query("SELECT * FROM compute_hosted_jobs").all())).not.toContain(SENTINEL);
  });

  test("a collect names artifacts by path and hash, never by host file", async () => {
    const f = fixture();
    await f.begin("t-1");
    const compute = f.host.forTurn(f.turn("t-1"));
    const started = ok(await compute(run({ argv: ["write", "out/log.txt", "Ithaca in sight"], artifacts: [{ path: "out/log.txt" }] })));
    await until(async () => (ok(await compute(job("brain_compute_status", started.job.id))).job.state === "succeeded"), "the job to succeed");
    const collected = ok(await compute(job("brain_compute_collect", started.job.id))) as unknown as { artifacts: Array<Record<string, unknown>> };
    expect(collected.artifacts, "COLLECT_HIDES_HOST_PATH").toEqual([expect.objectContaining({ path: "out/log.txt", status: "collected" })]);
    expect(collected.artifacts[0], "COLLECT_NO_FILE_FIELD").not.toHaveProperty("file");
    expect(JSON.stringify(collected)).not.toContain(f.state);
  });

  test("an unbound credential variable and a provider value are provider_unavailable", async () => {
    const f = fixture({ config: summary({ "boat-heavy": { apiKeyEnv: "BOAT_HEAVY_KEY" }, "ithaca-host": { provider: null, byValue: true, apiKeyEnv: null } }) });
    await f.begin("t-1");
    const compute = f.host.forTurn(f.turn("t-1"));
    const unbound = await compute(run({ provider: "boat-heavy" }));
    expect(code(unbound), "UNBOUND_KEY_REFUSED").toBe("provider_unavailable");
    expect(JSON.stringify(unbound), "UNBOUND_KEY_REFUSED_BY_HOST_BINDING").toContain("BRAIN_UI_COMPUTE_KEYS");
    expect(code(await compute(run({ provider: "ithaca-host" }))), "PROVIDER_VALUE_REFUSED").toBe("provider_unavailable");
    expect({ cards: f.cards.length, created: f.fake.created() }).toEqual({ cards: 0, created: 0 });
  });

  test("a bound credential that would also reach workers turns hosted compute off, and readiness says so", async () => {
    const f = fixture({ workerEnvExtra: ["BOAT_CI_KEY"] });
    await f.host.recover();
    const status = f.host.status();
    expect(status, "LEAKED_KEY_DISABLES").toMatchObject({ enabled: false });
    expect(status.reason).toContain("BOAT_CI_KEY");
    expect(status.bindings[0]!.credentials.find(c => c.name === "BOAT_CI_KEY")).toMatchObject({ leakedToWorkers: true });
    expect(code(await f.host.forTurn(f.turn("t-1"))(run())), "LEAKED_KEY_REFUSES_RUN").toBe("compute_disabled");
  });

  test("Boat's environment option is allowed on hosted runs (ruling R6)", async () => {
    const f = fixture({ config: summary({ "boat-small": { options: { environment: "odysseus-ci" } } }) });
    await f.begin("t-1");
    ok(await f.host.forTurn(f.turn("t-1"))(run()));
    const create = f.fake.requests.find(request => request.route === "create")!;
    expect(JSON.parse(create.body), "BOAT_ENVIRONMENT_ALLOWED").toMatchObject({ environment: "odysseus-ci" });
  });
});

describe("budget and concurrency", () => {
  test("two concurrent runs racing for the last slot: exactly one starts", async () => {
    const f = fixture({ config: summary({ "boat-small": { maxConcurrent: 1 } }) });
    await f.begin("t-1"); await f.begin("t-2");
    const results = await Promise.all([f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] })), f.host.forTurn(f.turn("t-2"))(run({ argv: ["sleep", "600"] }))]);
    expect(results.map(code).sort(), "LAST_SLOT_ONCE").toEqual(["concurrency_exhausted", "ok"]);
    expect(f.fake.created()).toBe(1);
  });

  test("two concurrent runs racing for the last budget: exactly one reserves", async () => {
    // A $1.20 reservation each against a $2 turn block in the same turn.
    const f = fixture({ config: summary({ "boat-small": { hourlyCeilingUsd: 1.2, maxConcurrent: 5 } }) });
    await f.begin("t-1");
    const compute = f.host.forTurn(f.turn("t-1"));
    const results = await Promise.all([compute(run({ argv: ["sleep", "600"] })), compute(run({ argv: ["sleep", "600"] }))]);
    expect(results.map(code).sort(), "LAST_BUDGET_ONCE").toEqual(["budget_exceeded", "ok"]);
    const reserved = f.db.query("SELECT COUNT(*) AS n, SUM(reserved_usd) AS usd FROM compute_budget_reservations").get();
    expect(reserved).toEqual({ n: 1, usd: 1.2 });
    expect(f.budgets.receipt("t-1").scopes[0]!.costUsd, "RESERVATION_COUNTS").toBeCloseTo(1.2);
  });

  test("a ledger that throws refuses with accounting_unavailable; no ceiling admits with the cost unknown, never zero", async () => {
    const broken = fixture({ host: { budgets: { compute: { reserve: async () => { throw new Error("ledger offline"); }, settle: async () => false } } as never } });
    await broken.begin("t-1");
    expect(code(await broken.host.forTurn(broken.turn("t-1"))(run())), "LEDGER_THROW_REFUSES").toBe("accounting_unavailable");
    expect(broken.fake.created()).toBe(0);
    const none = fixture({ budgets: false });
    expect(code(await none.host.forTurn(none.turn("t-1"))(run())), "NO_LEDGER_REFUSES").toBe("accounting_unavailable");

    const f = fixture();
    await f.begin("t-1");
    const admitted = await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] }));
    expect(code(admitted), "NO_CEILING_ADMITTED").toBe("ok");
    const started = ok(admitted);
    expect(started.job.cost.estimate.usd, "NO_CEILING_UNKNOWN_ESTIMATE").toBeNull();
    const turn = f.budgets.receipt("t-1").scopes[0]!;
    expect({ unknownRuns: turn.unknownRuns, blocked: turn.blocked }, "UNKNOWN_COST_NOT_ZERO_NOT_BLOCKING").toEqual({ unknownRuns: 2, blocked: false });
    expect(f.db.query("SELECT reserved_usd FROM compute_budget_reservations").get()).toEqual({ reserved_usd: null });
  });

  test("a turn without a frozen budget admission is refused, not admitted unmetered", async () => {
    const f = fixture();
    expect(code(await f.host.forTurn(f.turn("t-unadmitted"))(run())), "NO_ADMISSION_REFUSES").toBe("accounting_unavailable");
  });
});

describe("lifecycle", () => {
  test("cancelling a turn cancels its jobs and records the cleanup; a normal end keeps them", async () => {
    const f = fixture();
    await f.begin("t-1"); await f.begin("t-2");
    const kept = ok(await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] })));
    const stopped = ok(await f.host.forTurn(f.turn("t-2"))(run({ argv: ["sleep", "600"] })));
    f.host.endTurn("t-1");
    await f.host.cancelTurn("t-2", "the turn was cancelled");
    await until(() => f.store.getSpan(`compute:${stopped.job.id}`)?.outcome != null, "the cancelled run to end");
    const span = f.store.getSpan(`compute:${stopped.job.id}`)!;
    expect({ outcome: span.outcome, cleanup: span.attrs["brain.compute.cleanup"] }, "ABORT_CANCELS_JOB").toEqual({ outcome: "cancelled", cleanup: "released" });
    expect(f.store.getSpan(`compute:${kept.job.id}`)!.outcome, "NORMAL_END_KEEPS_JOB").toBeNull();
    expect(f.fake.liveSandboxes()).toBe(1);
  });

  test("a restarted host reattaches an unsettled job, settles its ledger once and does not interrupt it", async () => {
    const first = fixture();
    await first.begin("t-1");
    const started = ok(await first.host.forTurn(first.turn("t-1"))(run({ argv: ["sleep", "30"] })));
    await first.host.close();
    // The job runs on while the host is away; Boat has its own remote expiry, so close cancelled nothing.
    expect(first.fake.liveSandboxes(), "CLOSE_KEEPS_REMOTE_EXPIRY_JOB").toBe(1);
    const second = computeFixture({ db: first.db, dirs: { base: first.base, brain: first.brain, state: first.state }, vendor: { fake: first.fake, clock: first.vendorClock } });
    fixtures.unshift(second);
    second.tick(60_000);
    await second.host.recover();
    await until(() => second.store.getSpan(`compute:${started.job.id}`)?.outcome != null, "the reattached run to settle");
    expect(second.store.getSpan(`compute:${started.job.id}`)!.outcome, "REATTACHED_RUN_SUCCEEDS").toBe("success");
    const reservation = first.db.query("SELECT status FROM compute_budget_reservations WHERE job_id = ?").get(started.job.id);
    expect(reservation, "LEDGER_SETTLED").toEqual({ status: "settled" });
    expect(await second.budgets.compute.settle(started.job.id, null), "LEDGER_SETTLES_ONCE").toBe(false);
  });

  test("shutdown cancels the jobs whose provider has no remote expiry, and only those", async () => {
    const f = fixture();
    await f.begin("t-1");
    const started = ok(await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] })));
    // The same Boat adapter, reported without remote expiry: nothing would bound it while the host is down.
    const options = f.host as unknown as { close(): Promise<void> };
    const plain = computeFixture({ db: f.db, dirs: { base: f.base, brain: f.brain, state: f.state }, vendor: { fake: f.fake, clock: f.vendorClock },
      host: { serviceOptions: { registry: { boat: { load: async () => {
        const { createBoatProvider } = await import("../../compute-boat/src/provider.js");
        const provider = createBoatProvider({ now: () => f.vendorClock.now, sleep: async ms => { f.vendorClock.now += ms; } });
        return { provider: { ...provider, capabilities: { ...provider.capabilities, remoteExpiry: false } }, keyEnv: "BRAIN_COMPUTE_BOAT_API_KEY" };
      } } }, fetch: f.fake.fetch, callTimeoutMs: 5_000, lockWaitMs: 2_000, clock: { now: () => f.vendorClock.now } } } });
    fixtures.unshift(plain);
    await options.close();
    expect(f.fake.liveSandboxes(), "REMOTE_EXPIRY_JOB_KEPT_ON_CLOSE").toBe(1);
    await plain.host.recover();
    await plain.host.close();
    expect(f.fake.liveSandboxes(), "NO_REMOTE_EXPIRY_CANCELLED_ON_CLOSE").toBe(0);
    expect(plain.store.getSpan(`compute:${started.job.id}`)!.outcome).toBe("cancelled");
  });

  test("an uncertain exec stays open and flagged stuck, and is never retried", async () => {
    const f = fixture();
    await f.begin("t-1");
    f.fake.failNext("exec", { status: 502, code: "bad_gateway" });
    const started = ok(await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] })));
    expect(started.job.state, "EXEC_UNCERTAIN").toBe("uncertain");
    await f.host.drive();
    const span = f.store.getSpan(`compute:${started.job.id}`)!;
    expect({ outcome: span.outcome, stuck: span.attrs["brain.compute.stuck"] }, "UNCERTAIN_STAYS_OPEN").toEqual({ outcome: null, stuck: true });
    expect(f.fake.requests.filter(request => request.route === "exec"), "UNCERTAIN_NOT_RETRIED").toHaveLength(1);
  });
});

describe("readiness", () => {
  test("names the state directory, its mask, each binding and the last configuration read, without a vendor call", async () => {
    const f = fixture({ config: summary({ "boat-small": {}, "ithaca-host": { provider: null, byValue: true, apiKeyEnv: null } }) });
    await f.host.recover();
    await f.begin("t-1");
    await f.host.forTurn(f.turn("t-1"))({ tool: "brain_compute_plan", input: { provider: "boat-small", argv: ["true"] } });
    const status = f.host.status();
    expect(status).toMatchObject({ enabled: true, reason: null, core: "present", stateDir: f.state, stateMasked: true,
      bindings: [{ provider: "boat", package: "present", remoteExpiry: true, defaultKeyEnv: "BRAIN_COMPUTE_BOAT_API_KEY",
        credentials: [{ name: "BOAT_CI_KEY", implicit: false, present: true, leakedToWorkers: false }, { name: "BRAIN_COMPUTE_BOAT_API_KEY", implicit: true, present: false, leakedToWorkers: false }] }] });
    expect(status.instances, "READINESS_INSTANCES").toEqual([
      { id: "boat-small", provider: "boat", builtin: true, credential: "BOAT_CI_KEY", bound: true, present: true, refusal: null },
      { id: "ithaca-host", provider: null, builtin: false, credential: null, bound: false, present: false, refusal: "provider value" }]);
    expect(f.fake.requests, "NO_VENDOR_CALL_FOR_READINESS").toEqual([]);
  });

  test("no durable state turns hosted compute off", async () => {
    const f = fixture({ host: { stateDir: null } });
    expect(f.host.status()).toMatchObject({ enabled: false });
    expect(code(await f.host.forTurn(f.turn("t-1"))(run()))).toBe("compute_disabled");
  });
});

describe("cancellation racing admission (R7)", () => {
  test("a turn cancelled while its run reserves never allocates: the job is cancelled before any provider call", async () => {
    let f!: Fixture;
    let cancelling: Promise<void> | undefined;
    f = fixture({ host: { budgets: { compute: {
      async reserve(jobId: string, turnId: string, sessionId: string | null, usd: number | null) {
        const reserved = await f.budgets.compute.reserve(jobId, turnId, sessionId, usd);
        // The turn is cancelled while core awaits the reservation, before the job's row exists.
        cancelling = f.host.cancelTurn("t-1", "the turn was cancelled");
        return reserved;
      },
      settle: (jobId: string, usd: number | null) => f.budgets.compute.settle(jobId, usd),
    } } as never } });
    await f.begin("t-1");
    const result = await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] }));
    await cancelling;
    expect(f.fake.created(), "CANCELLED_TURN_NEVER_ALLOCATES").toBe(0);
    const started = ok(result);
    expect(started.job.state, "CANCELLED_TURN_JOB_CANCELLED").toBe("cancelled");
    expect(f.store.getSpan(`compute:${started.job.id}`)!.outcome, "CANCELLED_TURN_RUN_ENDS").toBe("cancelled");
    expect(f.db.query("SELECT status FROM compute_budget_reservations WHERE job_id = ?").get(started.job.id), "CANCELLED_TURN_RESERVATION_SETTLED").toEqual({ status: "settled" });
  });

  test("a turn revoked while its run reserves never allocates either", async () => {
    let f!: Fixture;
    let current = true;
    f = fixture({ host: { budgets: { compute: {
      async reserve(jobId: string, turnId: string, sessionId: string | null, usd: number | null) {
        const reserved = await f.budgets.compute.reserve(jobId, turnId, sessionId, usd);
        current = false;
        return reserved;
      },
      settle: (jobId: string, usd: number | null) => f.budgets.compute.settle(jobId, usd),
    } } as never } });
    await f.begin("t-1");
    const result = await f.host.forTurn(f.turn("t-1", { isCurrent: () => current }))(run({ argv: ["sleep", "600"] }));
    expect(f.fake.created(), "REVOKED_DURING_RESERVE_NEVER_ALLOCATES").toBe(0);
    expect(ok(result).job.state).toBe("cancelled");
  });

  test("cancelling a turn waits for its in-flight compute calls and cancels what they started", async () => {
    let f!: Fixture;
    let release!: () => void, reserving = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    f = fixture({ host: { budgets: { compute: {
      async reserve(jobId: string, turnId: string, sessionId: string | null, usd: number | null) { reserving = true; await held; return f.budgets.compute.reserve(jobId, turnId, sessionId, usd); },
      settle: (jobId: string, usd: number | null) => f.budgets.compute.settle(jobId, usd),
    } } as never } });
    await f.begin("t-1");
    const running = f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] }));
    await until(() => f.cards.length === 1 && reserving, "the held reservation");
    let cancelled = false;
    const cancelling = f.host.cancelTurn("t-1", "the turn was cancelled").then(() => { cancelled = true; });
    // The call is held inside its reservation, before its job row exists, so
    // cancelTurn's first sweep finds nothing and only the in-flight call can
    // keep it waiting. That sweep is in memory: one macrotask runs it out.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled, "CANCEL_WAITS_FOR_INFLIGHT_CALL").toBe(false);
    release();
    await Promise.all([running, cancelling]);
    expect({ created: f.fake.created(), open: f.host.status().openJobs }, "INFLIGHT_RUN_CANCELLED").toEqual({ created: 0, open: 0 });
  });
});

describe("credential binding (R6)", () => {
  test("with BRAIN_UI_COMPUTE_KEYS unset nothing is bound, not even a built-in's default, and readiness does not change after a turn", async () => {
    const f = fixture({ keys: {}, config: summary({ "boat-small": { apiKeyEnv: null } }), credentials: { BRAIN_COMPUTE_BOAT_API_KEY: SENTINEL } });
    await f.host.recover();
    const before = f.host.status().bindings;
    await f.begin("t-1");
    expect(code(await f.host.forTurn(f.turn("t-1"))(run())), "UNSET_KEYS_DEFAULT_NOT_BOUND").toBe("provider_unavailable");
    expect({ before, after: f.host.status().bindings }, "READINESS_STABLE_FROM_BOOT").toEqual({ before: [], after: [] });
    expect(f.fake.requests, "UNSET_KEYS_NO_VENDOR_CALL").toEqual([]);
  });

  test("BRAIN_UI_COMPUTE_KEYS lists a provider alone to bind only its default; unset binds nothing", () => {
    const keys = (value?: string) => resolveComputeConfig(value === undefined ? {} : { BRAIN_UI_COMPUTE_KEYS: value }, "/srv/ithaca/ui.db").keys;
    expect(keys(), "UNSET_KEYS_EMPTY").toEqual({});
    expect(keys("boat; ithaca=ITHACA_KEY,ITHACA_SPARE"), "PROVIDER_ALONE_LISTED").toEqual({ boat: [], ithaca: ["ITHACA_KEY", "ITHACA_SPARE"] });
    expect(keys("boat="), "PROVIDER_EMPTY_NAMES_LISTED").toEqual({ boat: [] });
    for (const bad of ["=BOAT_CI_KEY", "Boat", "boat=1KEY"]) expect(() => keys(bad), `MALFORMED_${bad}`).toThrow("BRAIN_UI_COMPUTE_KEYS");
  });

  test("listing a provider without names binds just its default variable, from boot", async () => {
    const f = fixture({ keys: { boat: [] }, config: summary({ "boat-small": { apiKeyEnv: null } }), credentials: { BRAIN_COMPUTE_BOAT_API_KEY: SENTINEL } });
    await f.host.recover();
    expect(f.host.status().bindings, "LISTED_PROVIDER_BINDS_DEFAULT").toEqual([{ provider: "boat", package: "present", remoteExpiry: true, defaultKeyEnv: "BRAIN_COMPUTE_BOAT_API_KEY",
      credentials: [{ name: "BRAIN_COMPUTE_BOAT_API_KEY", implicit: true, present: true, leakedToWorkers: false }] }]);
    await f.begin("t-1");
    expect(code(await f.host.forTurn(f.turn("t-1"))(run())), "LISTED_DEFAULT_RUNS").toBe("ok");
  });

  test("health sends each instance only its own bound credential and never calls a refused instance", async () => {
    const OTHER = "ithaca_other_provider_secret_77";
    const f = fixture({ keys: { boat: ["BOAT_CI_KEY"], ithaca: ["ITHACA_KEY"] }, credentials: { BOAT_CI_KEY: SENTINEL, ITHACA_KEY: OTHER },
      config: summary({ "boat-small": {}, "boat-borrowed": { apiKeyEnv: "ITHACA_KEY" } }) });
    await f.host.recover();
    const report = ok(await f.host.forTurn(f.turn("t-1"))({ tool: "brain_compute_health", input: {} })) as unknown as { instances: Array<{ id: string; status: string }> };
    expect(JSON.stringify(f.fake.requests), "HEALTH_NO_FOREIGN_KEY").not.toContain(OTHER);
    expect(report.instances.map(({ id, status }) => ({ id, status })), "HEALTH_REFUSED_INSTANCE_UNAVAILABLE").toEqual([
      { id: "boat-borrowed", status: "provider_unavailable" }, { id: "boat-small", status: "ready" }]);
    expect(f.fake.requests.every(request => request.headers.authorization === `Bearer ${SENTINEL}`), "HEALTH_OWN_KEY_ONLY").toBe(true);
  });
});

describe("ledger settlement", () => {
  const reservation = (f: Fixture, id: string) => f.db.query("SELECT status, actual_usd FROM compute_budget_reservations WHERE job_id = ?").get(id);
  const hostRow = (f: Fixture, id: string) => (f.db.query("SELECT settled_at FROM compute_hosted_jobs WHERE job_id = ?").get(id) as { settled_at: number | null }).settled_at;

  test("a ledger settle that fails keeps the job open and is retried until it commits", async () => {
    let f!: Fixture;
    let failing = true;
    f = fixture({ host: { budgets: { compute: {
      reserve: (jobId: string, turnId: string, sessionId: string | null, usd: number | null) => f.budgets.compute.reserve(jobId, turnId, sessionId, usd),
      async settle(jobId: string, usd: number | null) { if (failing) throw new Error("ledger write failed"); return f.budgets.compute.settle(jobId, usd); },
    } } as never } });
    await f.begin("t-1");
    const started = ok(await f.host.forTurn(f.turn("t-1"))(run()));
    for (let i = 0; i < 3; i++) await f.host.drive();
    expect({ released: f.fake.liveSandboxes(), reservation: reservation(f, started.job.id), row: hostRow(f, started.job.id), outcome: f.store.getSpan(`compute:${started.job.id}`)!.outcome },
      "FAILED_SETTLE_KEEPS_JOB_OPEN").toEqual({ released: 0, reservation: { status: "active", actual_usd: null }, row: null, outcome: null });
    failing = false;
    for (let i = 0; i < 3; i++) await f.host.drive();
    expect(reservation(f, started.job.id), "HOST_SETTLE_RETRIED").toEqual({ status: "settled", actual_usd: null });
    expect({ row: hostRow(f, started.job.id) !== null, outcome: f.store.getSpan(`compute:${started.job.id}`)!.outcome }, "SETTLED_AFTER_LEDGER_COMMITS").toEqual({ row: true, outcome: "success" });
  });

  test("a job the host can no longer read settles its reservation as unknown when its run is abandoned", async () => {
    const f = fixture({ config: summary({ "boat-small": { hourlyCeilingUsd: 0.6 } }) });
    await f.begin("t-1");
    const started = ok(await f.host.forTurn(f.turn("t-1"))(run({ argv: ["sleep", "600"] })));
    f.db.query("UPDATE compute_hosted_jobs SET instance_config = '{' WHERE job_id = ?").run(started.job.id);
    await f.host.drive();
    expect(f.store.getSpan(`compute:${started.job.id}`)!.outcome).toBe("error");
    expect(reservation(f, started.job.id), "ABANDONED_RUN_SETTLES_RESERVATION").toEqual({ status: "settled", actual_usd: null });
    // Unknown is never zero: the reservation still counts at its reserved amount.
    expect(f.budgets.receipt("t-1").scopes[0]!.costUsd, "ABANDONED_STILL_COUNTS").toBeCloseTo(0.6);
  });

  test("boot settles a reservation whose job was never recorded, as unknown and never zero", async () => {
    const f = fixture();
    await f.begin("t-1");
    await f.budgets.compute.reserve("cj_lostattheseaaaaaaaaaaaaa", "t-1", "sess-ogygia", 0.6);
    await f.host.recover();
    expect(reservation(f, "cj_lostattheseaaaaaaaaaaaaa"), "ORPHAN_RESERVATION_SWEPT").toEqual({ status: "settled", actual_usd: null });
    expect(f.budgets.receipt("t-1").scopes[0]!.costUsd, "SWEPT_RESERVATION_STILL_COUNTS").toBeCloseTo(0.6);
  });

  test("a later visit to a settled job rewrites neither its row nor its run", async () => {
    // The host's own clock, so a rewrite would carry a later stamp.
    let hostNow = Date.UTC(2026, 6, 12, 9);
    const f = fixture({ host: { clock: () => hostNow } as never });
    await f.begin("t-1");
    const compute = f.host.forTurn(f.turn("t-1"));
    const started = ok(await compute(run()));
    await until(async () => { await compute(job("brain_compute_status", started.job.id)); return hostRow(f, started.job.id) !== null; }, "the job to settle");
    const snapshot = () => ({ row: hostRow(f, started.job.id), endedAt: f.store.getSpan(`compute:${started.job.id}`)!.endedAt,
      events: f.store.snapshotRun(`compute:${started.job.id}`)!.events.length });
    const before = snapshot();
    hostNow += 60_000;
    ok(await compute(job("brain_compute_status", started.job.id)));
    ok(await compute(job("brain_compute_collect", started.job.id)));
    expect(snapshot(), "SETTLED_ROW_NOT_REWRITTEN").toEqual(before);
  });
});

describe("boot", () => {
  const recorder = () => {
    const warnings: string[] = [];
    return { warnings, log: { emit: (record: { severityText?: string; body?: unknown }) => { if (record.severityText === "WARN") warnings.push(String(record.body)); } } };
  };

  test("an unconfigured host boots silently: no bound credential, no warning (UNCONFIGURED_BOOT_SILENT)", async () => {
    const { warnings, log } = recorder();
    const f = fixture({ keys: {}, host: { stateMasked: false, log } as never });
    await f.host.recover();
    expect(warnings, "UNCONFIGURED_BOOT_SILENT").toEqual([]);
    expect(f.host.status()).toMatchObject({ enabled: false, reason: "no compute credential is bound (BRAIN_UI_COMPUTE_KEYS)" });
  });

  test("a host with a bound credential that is still off says why at boot", async () => {
    const { warnings, log } = recorder();
    const f = fixture({ host: { stateMasked: false, log } as never });
    await f.host.recover();
    expect(warnings).toEqual([expect.stringContaining("hosted external compute is off: the host compute state directory is not masked from workers")]);
  });
});
