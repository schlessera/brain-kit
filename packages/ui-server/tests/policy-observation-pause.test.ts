// #2870: a scope pause raised by the policy's own pre-publication journal
// observation is not a refusal. That observation completes with nothing
// published, the hold and the brain lock are released so the pause can be
// answered, and a fresh, fully rechecked attempt publishes after Continue.
// The real proposal service, journal and scope monitor run together here; the
// only double is the worker process the pause freezes.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { BRAIN_LOCK_KEY, createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { AUTHORITY_HOLD_WAIT_MS, type AuthorityHold } from "../src/brain/authority-hold.js";
import { createPolicyProposals } from "../src/brain/policy-proposal.js";
import { scopeFixture } from "./helpers/scope-fixture.js";

const original = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the policy.\n";
const proposed = original.replace("interactive: governed", "interactive: strict");
const input = { content: proposed, rationale: "Strict for the next turn." };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function until(check: () => boolean, label: string, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error(`${label}: timed out`); await Bun.sleep(5); }
}

/** One governed turn whose files cap is one changed path, with a policy proposal wired as the bridge wires it. */
async function pausedPolicy(options: { waitMs?: number; caps?: Parameters<typeof scopeFixture>[0]; recordFails?: boolean } = {}) {
  const f = scopeFixture(options.caps ?? { max_files_changed: 1 });
  const controller = new AbortController();
  cleanup.push(async () => { controller.abort(); await f.close(); });
  mkdirSync(join(f.brain, "context/policies"), { recursive: true });
  const policyPath = join(f.brain, "context/policies/governance.md");
  writeFileSync(policyPath, original);
  await f.begin();
  const worker = { freezes: 0, resumes: 0, kills: 0 };
  f.scope.workerStarted("voyage", { freeze() { worker.freezes++; }, resume() { worker.resumes++; }, kill() { worker.kills++; },
    exited: new Promise<number>(() => {}) } as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
  const state = { authorized: true, approvals: 0, observations: 0 };
  const events: PolicyChangeReview[] = [];
  const paused = () => f.scope.isPaused("voyage");
  // As in the bridge: a scope stop cancels the turn, and publication runs inside its
  // own journal observation, so only a scope pause holds it.
  const principal = () => state.authorized && f.stopped === "";
  const hold: AuthorityHold = { waitMs: options.waitMs ?? AUTHORITY_HOLD_WAIT_MS,
    active: () => !controller.signal.aborted && principal() && paused(), settled: () => new Promise(() => {}) };
  const lock = createKeyedLock();
  const service = createPolicyProposals({ root: f.brain, db: f.db, lock,
    observeUserPolicy: (turnId, write) => { state.observations++; return f.journal.observeUserPolicy(turnId, write); },
    recordEvent: review => { events.push(structuredClone(review)); if (options.recordFails) throw new Error("Governance event store unavailable"); } });
  let review: PolicyChangeReview | undefined;
  const propose = () => service.propose({ principalId: "athena", turnId: "voyage", sessionId: () => "ithaca", signal: controller.signal,
    isAuthorized: () => principal() && !paused(), hold, isAvailable: () => true,
    approve: async () => { state.approvals++; return true; }, emit() {} }, "policy-1", input).then(value => (review = value));
  // An agent change the policy's own pre-publication observation is the first to see: it reaches the cap there.
  writeFileSync(join(f.brain, "voyage-log.md"), options.caps?.max_bytes_written ? "Odysseus leaves Ogygia.\n".repeat(64) : "Odysseus leaves Ogygia.\n");
  return { f, controller, policyPath, lock, worker, state, events, propose, get review() { return review; },
    /** The pause the policy observation raised, once that observation has completed and released its hold. */
    async pausedAfterObservation(pending: Promise<unknown>) {
      let settled = false; void pending.finally(() => { settled = true; });
      await until(() => settled || (paused() && !f.journal.isHeld()), "POLICY_OBSERVATION_PAUSE_REACHED");
      expect(review?.state, `POLICY_OWN_OBSERVATION_PAUSE_NOT_REFUSED: ${review?.message ?? ""}`).toBeUndefined();
      expect(paused(), "POLICY_OWN_OBSERVATION_RAISED_PAUSE").toBe(true);
      expect(f.journal.isHeld(), "POLICY_OBSERVATION_RELEASED_ITS_HOLD").toBe(false);
    },
    staging: () => readdirSync(join(f.brain, "context/policies")).filter(name => name.startsWith(".brain-policy-")) };
}

test("a pause raised by the policy's own observation completes it unpublished, leaves Continue actionable, and publishes once after Continue", async () => {
  const p = await pausedPolicy();
  const pending = p.propose();
  await p.pausedAfterObservation(pending);
  expect(p.f.receipt(), "POLICY_OBSERVATION_PAUSE_IS_THE_FILES_CAP").toMatchObject({ state: "paused", dimension: "files_changed", cap: 1, newCap: 2 });
  expect(readFileSync(p.policyPath, "utf8"), "POLICY_NOTHING_PUBLISHED_WHILE_PAUSED").toBe(original);
  expect(p.staging(), "POLICY_NOTHING_STAGED_IN_THE_PAUSED_CALLBACK").toEqual([]);
  expect(p.events, "POLICY_NO_PUBLICATION_HAS_NO_UPDATED_EVENT").toEqual([]);
  expect(p.worker.kills, "POLICY_PAUSE_IS_NOT_AN_OBSERVATION_FAILURE").toBe(0);
  expect(p.f.stopped, "POLICY_PAUSE_DOES_NOT_STOP_THE_TURN").toBe("");
  expect(p.f.journal.summary("voyage").state, "POLICY_OBSERVATION_COMPLETED").toBe("recording");
  const lockFree = await Promise.race([p.lock.withLock(BRAIN_LOCK_KEY, async () => true), Bun.sleep(1000).then(() => false)]);
  expect(lockFree, "POLICY_WAIT_RELEASED_THE_BRAIN_LOCK").toBe(true);
  expect((await p.f.scope.decide(p.f.message("continue"), true)).state, "POLICY_PAUSE_CONTINUE_ACTIONABLE").toBe("accepted");
  const result = await pending;
  expect(result.state, "POLICY_PUBLISHES_AFTER_CONTINUE").toBe("updated");
  expect(readFileSync(p.policyPath, "utf8")).toBe(proposed);
  expect(p.events.map(event => event.state), "POLICY_EXACTLY_ONE_UPDATED_EVENT").toEqual(["updated"]);
  expect(p.state.observations, "POLICY_RETRY_IS_A_FRESH_OBSERVATION").toBe(2);
  expect(p.state.approvals, "POLICY_RETRY_REUSES_THE_ONE_APPROVAL").toBe(1);
  expect(p.worker.kills).toBe(0);
  await p.f.journal.finish("voyage");
  const changes = p.f.journal.details("ithaca", "voyage")!.changes;
  expect(changes.filter(change => change.path === "context/policies/governance.md"), "POLICY_ONE_RECORDED_WRITE").toHaveLength(1);
  expect(changes.filter(change => change.path.includes("/.brain-policy-")), "POLICY_NO_STAGING_NOISE").toEqual([]);
});

test("Stop, cancellation and revocation during the wait prevent publication and every retry", async () => {
  for (const ending of ["stop", "cancel", "revoke"] as const) {
    const p = await pausedPolicy();
    const pending = p.propose();
    await p.pausedAfterObservation(pending);
    if (ending === "stop") expect((await p.f.scope.decide(p.f.message("stop"), true)).state).toBe("accepted");
    else if (ending === "cancel") p.controller.abort();
    else p.state.authorized = false;
    const result = await pending;
    expect(result.state, `POLICY_${ending.toUpperCase()}_REFUSES`).toBe("refused");
    expect(result.message).toContain("Nothing was written.");
    expect(readFileSync(p.policyPath, "utf8"), `POLICY_${ending.toUpperCase()}_PUBLISHES_NOTHING`).toBe(original);
    expect(p.events, `POLICY_${ending.toUpperCase()}_NO_UPDATED_EVENT`).toEqual([]);
    expect(p.state.observations, `POLICY_${ending.toUpperCase()}_NO_RETRY`).toBe(1);
  }
});

test("a policy edit during the wait refuses the retry as stale instead of reusing the approval", async () => {
  // A byte cap, so the edit stays inside the granted headroom: only the base check can refuse the retry.
  const p = await pausedPolicy({ caps: { max_bytes_written: 1024 } });
  const pending = p.propose();
  await p.pausedAfterObservation(pending);
  expect(p.f.receipt()).toMatchObject({ state: "paused", dimension: "turn_bytes", newCap: 2048 });
  const edited = original.replace("reviews", "rewrites");
  writeFileSync(p.policyPath, edited);
  expect((await p.f.scope.decide(p.f.message("continue"), true)).state).toBe("accepted");
  const result = await pending;
  expect(result.state, `POLICY_RETRY_RECHECKS_THE_BASE: ${result.message}`).toBe("stale");
  expect(p.state.observations, "POLICY_STALE_REFUSED_BEFORE_A_FRESH_OBSERVATION").toBe(1);
  expect(readFileSync(p.policyPath, "utf8"), "POLICY_STALE_RETRY_KEEPS_THE_EDIT").toBe(edited);
  expect(p.events).toEqual([]);
});

test("repeated pauses share one finite deadline, and expiry publishes nothing", async () => {
  const waitMs = 1200;
  const p = await pausedPolicy({ waitMs });
  const pending = p.propose();
  await p.pausedAfterObservation(pending);
  const firstPause = Date.now();
  // A second changed path: the fresh attempt's own observation reaches the granted cap, which is Stop only.
  writeFileSync(join(p.f.brain, "voyage-chart.md"), "Odysseus charts Scheria.\n");
  // Real time, the stimulus: the shared deadline is taken from Date.now() when
  // the first pause starts waiting, and no clock in this file reaches it. This
  // spends half of it, so a second pause that restarted the bound would wait
  // past waitMs + 400 and fail POLICY_PAUSES_SHARE_ONE_DEADLINE.
  await Bun.sleep(600);
  expect((await p.f.scope.decide(p.f.message("continue"), true)).state).toBe("accepted");
  const result = await pending;
  const waited = Date.now() - firstPause;
  expect(p.state.observations, "POLICY_SECOND_PAUSE_FROM_A_FRESH_OBSERVATION").toBe(2);
  expect(p.f.receipt(), "POLICY_SECOND_PAUSE_IS_STOP_ONLY").toMatchObject({ state: "paused", dimension: "files_changed", cap: 2 });
  expect(result.state, "POLICY_DEADLINE_REFUSES").toBe("refused");
  expect(result.message).toContain("past the wait bound");
  expect(waited, "POLICY_PAUSES_SHARE_ONE_DEADLINE").toBeLessThan(waitMs + 400);
  expect(readFileSync(p.policyPath, "utf8")).toBe(original);
  expect(p.events).toEqual([]);
  expect(p.worker.kills, "POLICY_SECOND_PAUSE_IS_NOT_AN_OBSERVATION_FAILURE").toBe(0);
});

test("a reporting failure after the retried publication keeps its one write and never claims nothing was written", async () => {
  const p = await pausedPolicy({ recordFails: true });
  const pending = p.propose();
  await p.pausedAfterObservation(pending);
  expect((await p.f.scope.decide(p.f.message("continue"), true)).state).toBe("accepted");
  const result = await pending;
  expect(result.state, "POLICY_POST_COMMIT_FAILURE_IS_UNCERTAIN").toBe("unknown");
  expect(result.message).not.toContain("Nothing was written");
  expect(readFileSync(p.policyPath, "utf8"), "POLICY_POST_COMMIT_WRITE_KEPT").toBe(proposed);
  expect(p.state.observations, "POLICY_POST_COMMIT_FAILURE_NEVER_RETRIES").toBe(2);
  await p.f.journal.finish("voyage");
  expect(p.f.journal.details("ithaca", "voyage")!.changes.filter(change => change.path === "context/policies/governance.md"), "POLICY_POST_COMMIT_ONE_WRITE").toHaveLength(1);
});
