// #2853: a hold that begins right before a route's final pre-commit check is
// waited out, bounded and outside the lock, then the route commits. Nothing
// commits while it holds; real revocation and cancellation still refuse.
import { createFixtureHostBoundary } from "./helpers/native-host-fixture.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_LOCK_KEY, createKeyedLock, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { AUTHORITY_HOLD_WAIT_MS, AUTHORITY_RECHECK_MS, AuthorityHeld, retryHeld, waitWhile, type AuthorityHold } from "../src/brain/authority-hold.js";
import { boundaryPlanner, contentHash, createBrainApplication } from "../src/brain/application.js";
import { createMaskApplication, readMaskBase } from "../src/brain/mask-application.js";
import { createPolicyProposals } from "../src/brain/policy-proposal.js";
import { createUiDb } from "../src/db/client.js";

/**
 * A hold the test begins and releases; `waits` counts each time a route waited
 * on it. Like the bridge's, it is inactive once the turn is cancelled or its
 * authority is gone.
 */
function testHold(waitMs = AUTHORITY_HOLD_WAIT_MS, signal?: AbortSignal) {
  const waiting = Promise.withResolvers<void>();
  const state = { held: false, authorized: true, waits: 0 };
  let release: () => void = () => {}, cleared: Promise<void> = Promise.resolve();
  const hold: AuthorityHold = { waitMs, active: () => !signal?.aborted && state.authorized && state.held, settled: () => { state.waits++; waiting.resolve(); return cleared; } };
  return { hold, state,
    /** Actual subscription by the route, after it has unwound the commit lock. */
    async entered(operation: Promise<unknown>) {
      await Promise.race([waiting.promise, operation.then(value => {
        throw new Error(`AUTHORITY_HOLD_NOT_REACHED: operation completed before hold entry: ${JSON.stringify(value)}`);
      })]);
      expect(state.waits, "AUTHORITY_HOLD_CONDITION_REACHED").toBeGreaterThan(0);
    },
    /** What the route's `isAuthorized` reads: authority stands and no hold is active. */
    isAuthorized: () => state.authorized && !state.held,
    begin() { state.held = true; cleared = new Promise(resolve => { release = () => { state.held = false; resolve(); }; }); },
    release: () => release() };
}
/** Register ownership before any await, including a runner timeout. Nested suite
 * hooks drain operations before deleting roots and before the native helper closes. */
function testOwner() {
  const controllers: AbortController[] = [], releases: (() => void)[] = [], pending: Promise<unknown>[] = [];
  const cleanup: (() => void)[] = [];
  return {
    cleanup,
    controller() { const controller = new AbortController(); controllers.push(controller); return controller; },
    hold(waitMs = AUTHORITY_HOLD_WAIT_MS, signal?: AbortSignal) {
      const f = testHold(waitMs, signal); releases.push(f.release); return f;
    },
    releaseWith(release: () => void) { releases.push(release); },
    track<T>(operation: Promise<T>): Promise<T> {
      // Observe rejection immediately; retain the actual promise/error for the caller and teardown.
      pending.push(operation); void operation.catch(() => {}); return operation;
    },
    async close() {
      controllers.forEach(controller => controller.abort()); releases.forEach(release => release());
      const results = await Promise.allSettled(pending);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      for (const close of cleanup.reverse()) { try { close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "AUTHORITY_HOLD_OWNED_CLEANUP_FAILED");
    },
  };
}

test("hold entry reports early refusal and preserves an operation error", async () => {
  const f = testHold();
  await expect(f.entered(Promise.resolve({ ok: false, code: "permission_denied" })))
    .rejects.toThrow("AUTHORITY_HOLD_NOT_REACHED");
  const error = new Error("Odysseus preparation failed");
  await expect(f.entered(Promise.reject(error))).rejects.toBe(error);
});

test("owned cleanup cancels, releases and drains before deleting fixture state", async () => {
  const owner = testOwner(), controller = owner.controller(), f = owner.hold();
  let drained = false;
  f.begin();
  owner.track(f.hold.settled().then(() => {
    expect(controller.signal.aborted, "CLEANUP_ABORTS_BEFORE_DRAIN").toBe(true);
    expect(f.state.held, "CLEANUP_RELEASES_BEFORE_DRAIN").toBe(false);
    drained = true;
  }));
  owner.cleanup.push(() => { expect(drained, "CLEANUP_DRAINS_BEFORE_DELETE").toBe(true); });
  await owner.close();
  const failed = testOwner(), error = new Error("Odysseus pending operation failed");
  failed.track(Promise.reject(error));
  await expect(failed.close()).rejects.toMatchObject({ errors: [error] });
});

test("the production wait bound is sixty seconds", () => {
  expect(AUTHORITY_HOLD_WAIT_MS).toBe(60_000);
});

test("retryHeld waits out each reported hold and refuses once its bound passes", async () => {
  const f = testHold(20);
  f.begin();
  let attempts = 0;
  const refused = await retryHeld(f.hold, new AbortController().signal, () => { attempts++; throw new AuthorityHeld(); }, () => { throw new Error("expired"); })
    .then(() => "committed", (error: Error) => error.message);
  expect(refused, "AUTHORITY_HOLD_BOUND_REFUSES").toBe("expired");
  expect(attempts).toBe(1);
  f.release();
});

test("a wait subscribes to a stalled settlement once, however often it rechecks", async () => {
  let subscriptions = 0;
  const started = Date.now();
  const cleared = await waitWhile(() => true, () => { subscriptions++; return new Promise(() => {}); }, new AbortController().signal, started + AUTHORITY_RECHECK_MS * 4);
  expect(cleared, "WAIT_EXPIRES_AT_ITS_DEADLINE").toBe(false);
  expect(Date.now() - started, "WAIT_RECHECKED_SEVERAL_TIMES").toBeGreaterThanOrEqual(AUTHORITY_RECHECK_MS * 3);
  expect(subscriptions, "WAIT_SUBSCRIBES_ONCE_TO_A_STALLED_SETTLEMENT").toBe(1);
});

test("a settlement that is always due does not starve the timer that ends the wait", async () => {
  let pending = true;
  const timer = setTimeout(() => { pending = false; }, 5);
  try {
    const started = Date.now();
    const cleared = await waitWhile(() => pending, () => Promise.resolve(), new AbortController().signal, started + 1000);
    expect(cleared, "WAIT_SEES_THE_TIMER_CLEAR_IT").toBe(true);
    expect(Date.now() - started, "WAIT_DOES_NOT_RUN_TO_ITS_DEADLINE").toBeLessThan(1000);
  } finally { clearTimeout(timer); }
});

describe("brain application", () => {
  let owner: ReturnType<typeof testOwner>;
  let root: string, controller: AbortController, receipts: BrainApplicationResult[], beforeCommit: (() => void) | undefined;
  const path = "notes/raft.md", raw = "Odysseus repairs the raft.\n";
  beforeEach(() => {
    owner = testOwner();
    root = mkdtempSync(join(tmpdir(), "authority-hold-application-"));
    mkdirSync(join(root, "notes")); writeFileSync(join(root, path), raw);
    controller = owner.controller(); receipts = []; beforeCommit = undefined;
  });
  afterEach(async () => { try { await owner.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const application = (f: ReturnType<typeof testHold>, lock = createKeyedLock()) => {
    const apply = createBrainApplication({ root, planner: boundaryPlanner(createFixtureHostBoundary({ brainPath: root })),
    principalId: "odysseus", turnId: "turn-raft", signal: controller.signal, isAuthorized: f.isAuthorized, hold: f.hold,
    policy: { autoAllowed: ["write"], available: ["write"], lock }, approve: async () => true, record: result => receipts.push(result),
    beforeCommit: () => beforeCommit?.() });
    return (request: Parameters<typeof apply>[0]) => owner.track(apply(request));
  };
  const write = { operation: "write" as const, path, content: "Odysseus sails.\n", expectedBaseHash: contentHash(raw) };

  test("a hold that begins at the final pre-commit check is waited out and the write commits after it", async () => {
    const f = owner.hold();
    let commits = 0;
    beforeCommit = () => { if (commits++ === 0) f.begin(); };
    let result: BrainApplicationResult | undefined;
    const lock = createKeyedLock();
    const unlock = await lock.acquire(BRAIN_LOCK_KEY); owner.releaseWith(unlock);
    const pending = application(f, lock)({ principalId: "odysseus", turnId: "turn-raft", input: write }).then(value => (result = value));
    let observation: "entered" | "failed" | undefined;
    const entry = f.entered(pending).then(() => { observation = "entered" as const; }, error => { observation = "failed"; throw error; });
    owner.track(entry);
    // Adversarial scheduling control: the acknowledged lock prevents hold entry
    // across the old observer's entire turn budget. This is not a readiness wait.
    for (let turn = 0; turn < 1000; turn++) await new Promise(resolve => setImmediate(resolve));
    expect(observation, "HOLD_OBSERVER_REMAINS_PENDING_BEHIND_ACKNOWLEDGED_LOCK").toBeUndefined();
    expect(f.state.waits).toBe(0);
    unlock();
    await entry;
    expect(readFileSync(join(root, path), "utf8"), "APPLICATION_NOTHING_COMMITS_WHILE_HELD").toBe(raw);
    expect(result, "APPLICATION_HOLD_NOT_REFUSED").toBeUndefined();
    f.release();
    expect(await pending, "APPLICATION_COMMITS_AFTER_HOLD").toMatchObject({ ok: true, changes: [{ path }] });
    expect(readFileSync(join(root, path), "utf8")).toBe("Odysseus sails.\n");
    expect(commits, "APPLICATION_RETRY_PREPARES_AGAIN").toBe(2);
    expect(receipts).toHaveLength(1);
  });

  test("a write that waits out a hold still captures its committed bytes into the turn's data tree (#2848)", async () => {
    const f = owner.hold();
    const captured: { path: string; content: string | null; base: string | null }[][] = [];
    let commits = 0, capturedWhileHeld = 0;
    beforeCommit = () => { if (commits++ === 0) f.begin(); };
    const apply = createBrainApplication({ root, planner: boundaryPlanner(createFixtureHostBoundary({ brainPath: root })),
      principalId: "odysseus", turnId: "turn-raft", signal: controller.signal, isAuthorized: f.isAuthorized, hold: f.hold,
      policy: { autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() }, approve: async () => true, record: result => receipts.push(result),
      turnTree: { commit: effects => { if (f.state.held && effects.length) capturedWhileHeld++; captured.push(effects.map(effect => ({ ...effect }))); }, barrier: async () => {} },
      beforeCommit: () => beforeCommit?.() });
    const pending = owner.track(apply({ principalId: "odysseus", turnId: "turn-raft", input: write }));
    await f.entered(pending);
    expect(captured.flat(), "TURN_TREE_RECEIVES_NOTHING_WHILE_HELD").toEqual([]);
    f.release();
    expect(await pending).toMatchObject({ ok: true });
    expect(capturedWhileHeld).toBe(0);
    expect(captured.flat(), "TURN_TREE_CAPTURES_THE_WRITE_AFTER_THE_HOLD").toEqual([{ path, content: "Odysseus sails.\n", base: raw }]);
  });

  test("a hold that outlasts its bound refuses without claiming revocation, with nothing written", async () => {
    const f = owner.hold(20);
    beforeCommit = () => f.begin();
    const result = await application(f)({ principalId: "odysseus", turnId: "turn-raft", input: write });
    expect(result, "APPLICATION_HOLD_BOUND_REFUSES").toMatchObject({ ok: false, code: "application_failed", changes: [] });
    expect(result.message).toContain("wait bound");
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
  });

  test("a principal revoked during a hold refuses authority_revoked without waiting", async () => {
    const f = owner.hold();
    beforeCommit = () => { f.begin(); f.state.authorized = false; };
    const result = await application(f)({ principalId: "odysseus", turnId: "turn-raft", input: write });
    expect(result, "APPLICATION_REVOKED_DURING_HOLD_REFUSES").toMatchObject({ ok: false, code: "authority_revoked", changes: [] });
    expect(result.message).not.toContain("wait bound");
    expect(f.state.waits, "APPLICATION_REVOKED_NEVER_WAITS").toBe(0);
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    f.release();
  });

  test("a principal revoked while the write waits for a hold refuses authority_revoked before the hold clears", async () => {
    const f = owner.hold();
    beforeCommit = () => f.begin();
    let heldAtAnswer: boolean | undefined;
    const pending = application(f)({ principalId: "odysseus", turnId: "turn-raft", input: write }).then(value => { heldAtAnswer = f.state.held; return value; });
    await f.entered(pending);
    f.state.authorized = false;
    expect(await pending, "APPLICATION_REVOKED_WHILE_WAITING_REFUSES").toMatchObject({ ok: false, code: "authority_revoked", changes: [] });
    expect(heldAtAnswer, "APPLICATION_REVOKED_WHILE_WAITING_DOES_NOT_WAIT_FOR_THE_HOLD").toBe(true);
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    f.release();
  });

  test("a turn cancelled while it waits for a hold refuses cancelled", async () => {
    const f = owner.hold(AUTHORITY_HOLD_WAIT_MS, controller.signal);
    beforeCommit = () => f.begin();
    const pending = application(f)({ principalId: "odysseus", turnId: "turn-raft", input: write });
    await f.entered(pending);
    controller.abort();
    expect(await pending, "APPLICATION_CANCELLED_DURING_HOLD").toMatchObject({ ok: false, code: "cancelled", changes: [] });
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    f.release();
  });

  test("a cancelled turn whose authority is held refuses cancelled, not authority_revoked", async () => {
    const f = owner.hold(AUTHORITY_HOLD_WAIT_MS, controller.signal);
    f.begin(); controller.abort();
    expect(await application(f)({ principalId: "odysseus", turnId: "turn-raft", input: write }), "APPLICATION_CANCELLED_WHILE_HELD").toMatchObject({ ok: false, code: "cancelled", changes: [] });
    expect(f.state.waits).toBe(0);
    f.release();
  });

  test("a turn cancelled while it waits for a hold at entry refuses cancelled, not authority_revoked", async () => {
    const f = owner.hold(AUTHORITY_HOLD_WAIT_MS, controller.signal);
    f.begin();
    const pending = application(f)({ principalId: "odysseus", turnId: "turn-raft", input: write });
    await f.entered(pending);
    controller.abort();
    expect(await pending, "APPLICATION_CANCELLED_AT_ENTRY_HOLD").toMatchObject({ ok: false, code: "cancelled", changes: [] });
    expect(readFileSync(join(root, path), "utf8")).toBe(raw);
    f.release();
  });

  test("a waiting write never keeps the brain lock", async () => {
    const f = owner.hold(), lock = createKeyedLock();
    let commits = 0;
    beforeCommit = () => { if (commits++ === 0) f.begin(); };
    const apply = createBrainApplication({ root, planner: boundaryPlanner(createFixtureHostBoundary({ brainPath: root })),
      principalId: "odysseus", turnId: "turn-raft", signal: controller.signal, isAuthorized: f.isAuthorized, hold: f.hold,
      policy: { autoAllowed: ["write"], available: ["write"], lock }, approve: async () => true, record: result => receipts.push(result),
      beforeCommit: () => beforeCommit?.() });
    const pending = owner.track(apply({ principalId: "odysseus", turnId: "turn-raft", input: write }));
    await f.entered(pending);
    const release = await lock.acquire(BRAIN_LOCK_KEY);
    release(); f.release();
    expect((await pending).ok).toBe(true);
  });
});

describe("mask application", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), imagePath = "assets/raft.png", maskPath = "assets/raft-mask.png";
  let root: string, owner: ReturnType<typeof testOwner>;
  beforeEach(() => { owner = testOwner(); root = mkdtempSync(join(tmpdir(), "authority-hold-mask-")); mkdirSync(join(root, "assets")); writeFileSync(join(root, imagePath), png); });
  afterEach(async () => { try { await owner.close(); } finally { rmSync(root, { recursive: true, force: true }); } });

  test("a hold that begins at the final pre-commit check is waited out and the mask commits after it", async () => {
    const f = owner.hold(), records: BrainApplicationResult[] = [];
    let commits = 0;
    const apply = createMaskApplication({ root, principalId: "odysseus", turnId: "raft-turn", signal: owner.controller().signal, lock: createKeyedLock(),
      isAuthorized: f.isAuthorized, hold: f.hold, isAvailable: () => true, record: result => records.push(result),
      beforeCommit: () => { if (commits++ === 0) f.begin(); } });
    let result: BrainApplicationResult | undefined;
    const pending = owner.track(apply({ principalId: "odysseus", turnId: "raft-turn", base: readMaskBase(root, imagePath), input: { imagePath, maskPath, png } }).then(value => (result = value)));
    await f.entered(pending);
    expect(existsSync(join(root, maskPath)), "MASK_NOTHING_COMMITS_WHILE_HELD").toBe(false);
    expect(result, "MASK_HOLD_NOT_REFUSED").toBeUndefined();
    f.release();
    expect(await pending, "MASK_COMMITS_AFTER_HOLD").toMatchObject({ ok: true });
    expect(readFileSync(join(root, maskPath))).toEqual(png);
    expect(records).toHaveLength(1);
  });

  test("a principal revoked during a hold refuses authority_revoked", async () => {
    const f = owner.hold();
    const apply = createMaskApplication({ root, principalId: "odysseus", turnId: "raft-turn", signal: owner.controller().signal, lock: createKeyedLock(),
      isAuthorized: f.isAuthorized, hold: f.hold, isAvailable: () => true, record() {}, beforeCommit: () => { f.begin(); f.state.authorized = false; } });
    const result = await owner.track(apply({ principalId: "odysseus", turnId: "raft-turn", base: readMaskBase(root, imagePath), input: { imagePath, maskPath, png } }));
    expect(result, "MASK_REVOKED_DURING_HOLD_REFUSES").toMatchObject({ ok: false, code: "authority_revoked", changes: [] });
    expect(existsSync(join(root, maskPath))).toBe(false);
    f.release();
  });
});

describe("policy proposal", () => {
  let owner: ReturnType<typeof testOwner>;
  beforeEach(() => { owner = testOwner(); });
  afterEach(async () => { await owner.close(); });
  const original = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the policy.\n";
  const proposed = original.replace("interactive: governed", "interactive: strict");
  test("a scope pause that begins before publication is waited out and the policy publishes after it", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-hold-policy-")), db = createUiDb(":memory:");
    owner.cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    owner.cleanup.push(() => db.close());
    mkdirSync(join(root, "context/policies"), { recursive: true });
    const path = join(root, "context/policies/governance.md"); writeFileSync(path, original);
    const f = owner.hold();
    let commits = 0;
    const service = createPolicyProposals({ root, db, lock: createKeyedLock(), observeUserPolicy: (_id, write) => write(), recordEvent() {},
      beforeCommit: () => { if (commits++ === 0) f.begin(); } });
    let review: PolicyChangeReview | undefined;
    const pending = owner.track(service.propose({ principalId: "odysseus", turnId: "policy-turn", sessionId: () => null, signal: owner.controller().signal,
      isAuthorized: f.isAuthorized, hold: f.hold, isAvailable: () => true, approve: async () => true, emit() {} }, "policy-1",
      { content: proposed, rationale: "Strict for the next turn." }).then(value => (review = value)));
    await f.entered(pending);
    expect(readFileSync(path, "utf8"), "POLICY_NOTHING_PUBLISHES_WHILE_HELD").toBe(original);
    expect(review, "POLICY_HOLD_NOT_REFUSED").toBeUndefined();
    f.release();
    expect((await pending).state, "POLICY_PUBLISHES_AFTER_HOLD").toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(proposed);
  });
});
