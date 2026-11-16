// #2869: a conversation turn's `inbox_add` treats a journal observation or a
// scope pause that begins while it stages as a hold, not as revocation. Every
// intake write (staging, publication, the receipt commit and compensation)
// waits for one, bounded and outside any transaction, and none overlaps it.
// Real revocation, cancellation and a stale premise still refuse.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import type { AuthorityHold } from "../src/brain/authority-hold.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxBridgeTools } from "../src/inbox/bridge-tools.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxResolver } from "../src/inbox/resolve.js";

const closes: (() => unknown)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** A point in one intake at which a check of the turn's authority runs, read from what is on disk and in the store. */
type Phase = "entry" | "staging" | "publication" | "receipt";

/**
 * One interactive turn's `inbox_add` over real intake and staging. `held`
 * stands for a journal observation or a scope pause: the turn's strict
 * `isCurrent` is false while it holds, as the bridge's is. `raiseAt` raises
 * the hold the first time a check runs in that phase.
 */
function turn(options: { waitMs?: number; journal?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "inbox-intake-holds-")); closes.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createUiDb(":memory:"); closes.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, root); closes.push(() => intake.close());
  const cancel = new AbortController();
  const state = { held: false, current: true, raiseAt: undefined as Phase | undefined, raised: [] as Phase[], waitReads: 0,
    checksWhileHeld: 0, requalify: undefined as (() => void) | undefined, raiseOnCompensate: false };
  const staging = join(root, SHARE_STAGING_DIR);
  const entries = () => existsSync(staging) ? readdirSync(staging).sort() : [];
  const receipts = () => db.query("SELECT staging_id, state FROM inbox_intake_receipts ORDER BY created_at").all() as { staging_id: string; state: string }[];
  const items = () => (db.query("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n;
  // The furthest phase any preparing arrival has reached, so concurrent intakes raise the hold at the first to reach it.
  const phase = (): Phase => {
    const names = entries(), mine = receipts().filter(row => row.state === "preparing").map(row => row.staging_id);
    if (!mine.length) return "entry";
    if (mine.some(id => names.includes(id))) return "receipt";
    if (mine.some(id => existsSync(join(staging, `.${id}.partial`, "meta.json")))) return "publication";
    return "staging";
  };
  // A journal observation settles with an event; a scope pause has none and is rechecked.
  let settle: (() => void) | undefined;
  const settled = () => options.journal ? new Promise<void>(resolve => { settle = resolve; }) : new Promise<void>(() => {});
  const waitMs = options.waitMs ?? 60_000;
  const hold: AuthorityHold = { get waitMs() { state.waitReads++; return waitMs; }, settled,
    active: () => { if (state.held) state.checksWhileHeld++; return !cancel.signal.aborted && state.current && state.held; } };
  const writes: AuthorityHold = { get waitMs() { state.waitReads++; return waitMs; }, settled,
    active: () => { if (state.raiseOnCompensate) { state.raiseOnCompensate = false; state.held = true; } return state.held; } };
  const isCurrent = () => {
    if (state.raiseAt && !state.held && phase() === state.raiseAt) { state.raised.push(state.raiseAt); state.raiseAt = undefined; state.held = true; }
    if (state.held) state.checksWhileHeld++;
    return !cancel.signal.aborted && state.current && !state.held;
  };
  const tools = createInboxBridgeTools(db, intake, createInboxResolver(db, { allowedOperations: () => [] }), root).forTurn({
    principalId: principal.id, turnId: "raft-turn", origin: "interactive", membership: "interactive", sessionId: () => "raft-session",
    isCurrent, holds: { hold, writes, signal: cancel.signal }, requalify: () => state.requalify?.() });
  const add = (key = "raft") => tools.inboxAdd!({ text: "Odysseus lashes the raft before the storm.", idempotencyKey: key });
  const release = () => { state.held = false; settle?.(); };
  return { root, db, principal, intake, state, cancel, staging, entries, receipts, items, add, release };
}

/** Resolves once `ready()` holds, failing after a generous bound rather than hanging. */
async function until(ready: () => boolean, label: string) {
  for (let turn = 0; turn < 400 && !ready(); turn++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(ready(), label).toBe(true);
}

/** Lets the wait recheck several times while the hold stays. */
const rechecks = () => new Promise(resolve => setTimeout(resolve, 150));

for (const kind of ["journal", "scope"] as const) {
  test.each(["staging", "publication", "receipt"] as const)(`a ${kind} hold raised at the %s check waits, writes nothing under it and accepts one item after release (#2869)`, async at => {
    const f = turn({ journal: kind === "journal" });
    f.state.raiseAt = at;
    let outcome: unknown;
    const pending = f.add().then(value => { outcome = value; return value; }, error => { outcome = error; throw error; });
    await until(() => f.state.held, `INTAKE_HOLD_RAISED_AT_${at.toUpperCase()}`);
    const during = f.entries();
    await rechecks();
    expect(outcome, "INTAKE_HOLD_WAITS_RATHER_THAN_REFUSING").toBeUndefined();
    expect(f.state.checksWhileHeld, "INTAKE_HOLD_RECHECKS").toBeGreaterThanOrEqual(kind === "journal" ? 1 : 2);
    expect(f.entries(), "INTAKE_HOLD_NO_STAGING_WRITE_UNDER_HOLD").toEqual(during);
    expect(f.items(), "INTAKE_HOLD_NO_ACCEPTED_ITEM_UNDER_HOLD").toBe(0);
    // The wait holds no transaction: another writer commits at once.
    f.db.transaction(() => { f.db.query("SELECT 1").get(); }).immediate();
    f.release();
    const added = await pending;
    expect(added.created, "INTAKE_HOLD_ACCEPTS_AFTER_RELEASE").toBe(true);
    expect(f.items()).toBe(1);
    expect(f.receipts().map(row => row.state)).toEqual(["committed"]);
    expect(f.entries(), "INTAKE_HOLD_PUBLISHES_ONCE").toEqual([f.receipts()[0]!.staging_id]);
    expect(f.state.raised).toEqual([at]);
  });
}

test("a hold that begins after the entry check, while intake stages, keeps every staging write out of it (#2869)", async () => {
  const f = turn();
  let outcome: unknown;
  // The entry check runs synchronously; the hold begins in the next
  // macrotask, while intake is between that check and its staging writes.
  const pending = f.add().then(value => { outcome = value; return value; }, error => { outcome = error; throw error; });
  const checks = f.state.checksWhileHeld;
  setImmediate(() => { f.state.held = true; });
  await until(() => f.state.held, "INTAKE_HOLD_RAISED_AFTER_ENTRY");
  await rechecks();
  expect(outcome, "INTAKE_HOLD_AFTER_ENTRY_WAITS").toBeUndefined();
  expect(f.entries().filter(name => !name.startsWith(".")), "INTAKE_HOLD_AFTER_ENTRY_NOTHING_PUBLISHED").toEqual([]);
  expect(f.items()).toBe(0);
  expect(f.state.checksWhileHeld, "INTAKE_HOLD_AFTER_ENTRY_RECHECKS").toBeGreaterThan(checks);
  f.release();
  expect((await pending).created).toBe(true);
  expect(f.items()).toBe(1);
});

test("repeated holds share one wait deadline and a hold past it refuses with no accepted item (#2869)", async () => {
  const f = turn({ waitMs: 400 });
  f.state.raiseAt = "staging";
  let outcome: unknown;
  const started = Date.now();
  const pending = f.add().then(value => { outcome = value; return value; }, error => { outcome = error; return error; });
  await until(() => f.state.held, "INTAKE_FIRST_HOLD");
  await new Promise(resolve => setTimeout(resolve, 150));
  f.release();
  f.state.raiseAt = "receipt";
  await until(() => f.state.held, "INTAKE_SECOND_HOLD");
  const error = await pending as Error;
  expect(error, "INTAKE_HOLD_PAST_BOUND_REFUSES").toBeInstanceOf(Error);
  expect(error.message).toContain("past the wait bound");
  // One deadline, from the first hold: a fresh one per hold would read the bound again.
  expect(f.state.waitReads, "INTAKE_HOLDS_SHARE_ONE_DEADLINE").toBe(1);
  expect(Date.now() - started, "INTAKE_HOLD_DEADLINE_IS_FINITE").toBeLessThan(5_000);
  expect(f.items(), "INTAKE_HOLD_TIMEOUT_NO_QUEUE_CLAIM").toBe(0);
  // The hold still stands: the staged arrival waits, durably, for safe cleanup.
  expect(f.receipts().map(row => row.state)).toEqual(["cleanup"]);
  expect(f.entries()).toHaveLength(1);
  await f.intake.close();
  f.release();
  await f.intake.reconcile();
  expect(f.receipts(), "INTAKE_HELD_CLEANUP_RECONCILES").toEqual([]);
  expect(f.entries()).toEqual([]);
  expect(outcome).toBe(error);
});

test("revocation during a hold refuses at once; its owned cleanup waits for the hold and then removes the staging (#2869)", async () => {
  const f = turn();
  f.state.raiseAt = "receipt";
  let heldAtAnswer: boolean | undefined;
  const pending = f.add().then(value => value, error => { heldAtAnswer = f.state.held; return error; });
  await until(() => f.state.held, "INTAKE_HOLD_AT_RECEIPT");
  const published = f.entries();
  expect(published).toHaveLength(1);
  revokePrincipal(f.db, f.principal.id, Date.now());
  f.state.current = false;
  const error = await pending as Error;
  expect(error.message, "INTAKE_REVOCATION_REFUSES").toContain("no longer authorized");
  expect(heldAtAnswer, "INTAKE_REVOCATION_DOES_NOT_WAIT_FOR_HOLD").toBe(true);
  expect(f.items()).toBe(0);
  await rechecks();
  // Compensation is the host's own effect, but it does not write through the hold.
  expect(f.entries(), "INTAKE_COMPENSATION_WAITS_FOR_HOLD").toEqual(published);
  expect(f.receipts().map(row => row.state), "INTAKE_REVOKED_RECEIPT_QUEUED_FOR_CLEANUP").toEqual(["cleanup"]);
  f.release();
  await until(() => f.entries().length === 0, "INTAKE_COMPENSATION_AFTER_HOLD");
  await until(() => f.receipts().length === 0, "INTAKE_COMPENSATION_CLEARS_RECEIPT");
});

test("a turn replaced during a hold refuses without waiting for the hold to end (#2869)", async () => {
  const f = turn();
  f.state.raiseAt = "publication";
  let heldAtAnswer: boolean | undefined;
  const pending = f.add().then(value => value, error => { heldAtAnswer = f.state.held; return error; });
  await until(() => f.state.held, "INTAKE_HOLD_AT_PUBLICATION");
  const partial = f.entries();
  f.state.current = false;
  expect((await pending as Error).message, "INTAKE_REPLACED_REFUSES").toContain("no longer authorized");
  expect(heldAtAnswer, "INTAKE_REPLACED_REFUSES_WHILE_HELD").toBe(true);
  expect(f.receipts().map(row => row.state)).toEqual(["cleanup"]);
  // Not published, and the partial is not removed through the hold either.
  expect(f.entries(), "INTAKE_REPLACED_NOTHING_WRITTEN_UNDER_HOLD").toEqual(partial);
  f.release();
  await until(() => f.entries().length === 0 && f.receipts().length === 0, "INTAKE_REPLACED_CLEANED_AFTER_HOLD");
  expect(f.items()).toBe(0);
});

test("cancellation during a hold terminates without a queue claim and keeps the cleanup receipt for reconciliation (#2869)", async () => {
  const f = turn();
  f.state.raiseAt = "receipt";
  const pending = f.add().then(value => value, error => error);
  await until(() => f.state.held, "INTAKE_HOLD_BEFORE_CANCEL");
  f.cancel.abort();
  const error = await pending as Error;
  expect(error.message, "INTAKE_CANCELLED_REFUSES").toContain("cancelled");
  expect(f.items(), "INTAKE_CANCELLED_NO_QUEUE_CLAIM").toBe(0);
  // The hold still stands, so cleanup did not write through it.
  expect(f.entries(), "INTAKE_CANCELLED_CLEANUP_NOT_UNDER_HOLD").toHaveLength(1);
  await f.intake.close();
  expect(f.receipts().map(row => row.state), "INTAKE_CANCELLED_CLEANUP_RECEIPT_KEPT").toEqual(["cleanup"]);
  expect(f.entries()).toHaveLength(1);
  f.release();
  await f.intake.reconcile();
  expect(f.entries()).toEqual([]);
  expect(f.receipts()).toEqual([]);
});

test("a premise that changes during the hold is checked again before the receipt commits (#2869)", async () => {
  const f = turn();
  f.state.raiseAt = "receipt";
  const pending = f.add().then(value => value, error => error);
  await until(() => f.state.held, "INTAKE_HOLD_BEFORE_REQUALIFY");
  // A mask over the staging directory, admitted before the hold, now refuses.
  f.state.requalify = () => { throw new Error("The staging directory is masked for this turn"); };
  f.release();
  const error = await pending as Error;
  expect(error, "INTAKE_REQUALIFIES_AFTER_HOLD").toBeInstanceOf(Error);
  expect(error.message).toContain("masked");
  expect(f.items(), "INTAKE_STALE_PREMISE_NOT_ADMITTED").toBe(0);
  await f.intake.close();
  expect(f.entries()).toEqual([]);
  expect(f.receipts()).toEqual([]);
});

test("a receipt reconciled away during the hold is not accepted after it (#2869)", async () => {
  const f = turn();
  f.state.raiseAt = "receipt";
  const pending = f.add().then(value => value, error => error);
  await until(() => f.state.held, "INTAKE_HOLD_BEFORE_RECONCILE");
  // Another process's reconciliation took the receipt while this one waited.
  f.db.query("UPDATE inbox_intake_receipts SET state = 'cleanup'").run();
  f.release();
  expect((await pending as Error).message, "INTAKE_RECEIPT_OWNERSHIP_RECHECKED").toContain("reconciled");
  expect(f.items()).toBe(0);
});

/** Two concurrent intakes under one key, both staged before either commits: the hold at the first receipt check keeps them apart. */
async function duplicates(f: ReturnType<typeof turn>) {
  f.state.raiseAt = "receipt";
  const first = f.add("bow"), second = f.add("bow");
  await until(() => f.state.held && f.receipts().length === 2, "INTAKE_DUPLICATES_BOTH_PREPARED");
  await rechecks();
  expect(f.items(), "INTAKE_DUPLICATES_NOTHING_ACCEPTED_UNDER_HOLD").toBe(0);
  return [first, second] as const;
}

test("duplicate intakes held before their receipts produce one winner, and the loser cleans only its own staging (#2869)", async () => {
  const f = turn();
  const pending = await duplicates(f);
  f.release();
  const results = await Promise.all(pending);
  expect(results.map(result => result.created).sort(), "INTAKE_DUPLICATE_ONE_WINNER").toEqual([false, true]);
  expect(results[0]!.itemId).toBe(results[1]!.itemId);
  expect(f.items()).toBe(1);
  const winner = f.receipts().filter(row => row.state === "committed");
  expect(winner).toHaveLength(1);
  await f.intake.close();
  expect(f.receipts(), "INTAKE_DUPLICATE_LOSER_RECEIPT_CLEANED").toHaveLength(1);
  expect(f.entries(), "INTAKE_DUPLICATE_WINNER_KEPT").toEqual([winner[0]!.staging_id]);
});

test("a losing duplicate whose cleanup meets a hold keeps its receipt queued and never touches the winner (#2869)", async () => {
  const f = turn();
  const pending = await duplicates(f);
  // The loser's removal is the only compensation: the hold begins as it starts.
  f.state.raiseOnCompensate = true;
  f.release();
  const results = await Promise.all(pending);
  expect(results.map(result => result.created).sort(), "INTAKE_LOSER_REPORTS_THE_WINNER").toEqual([false, true]);
  await until(() => f.state.held, "INTAKE_LOSER_CLEANUP_HELD");
  const winner = f.receipts().find(row => row.state === "committed")!.staging_id;
  const loser = f.receipts().find(row => row.state === "cleanup")!.staging_id;
  await rechecks();
  expect(f.entries().sort(), "INTAKE_LOSER_CLEANUP_NOT_UNDER_HOLD").toEqual([loser, winner].sort());
  // The wait ends with the turn; the receipt stays queued.
  f.cancel.abort();
  await f.intake.close();
  expect(f.receipts().find(row => row.staging_id === loser)?.state, "INTAKE_LOSER_RECEIPT_QUEUED").toBe("cleanup");
  f.release();
  await f.intake.reconcile();
  expect(f.entries(), "INTAKE_COMMITTED_WINNER_NEVER_CLEANED").toEqual([winner]);
  expect(f.receipts().map(row => row.staging_id)).toEqual([winner]);
  expect(f.items()).toBe(1);
});
