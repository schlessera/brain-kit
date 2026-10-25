// #2853: a journal observation or a scope pause that begins after the bridge's
// `idle()` is a transient hold, not revoked authority. A valid host effect waits
// for it, bounded, and runs after it; nothing commits while it holds; a
// principal that really lost authority still refuses `authority_revoked`.
import { createFixtureHostBoundary } from "./helpers/native-host-fixture.js";
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyedLock, type BackendBridge, type BrainApplicationResult, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { boundaryPlanner } from "../src/brain/application.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createUiDb } from "../src/db/client.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { runSession } from "../src/ws/run-session.js";
import { WsHost } from "../src/ws/host.js";
import type { TurnJournal } from "../src/brain/turn-journal.js";
import type { TurnScope } from "../src/brain/turn-scope.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

/**
 * The journal's hold accounting: a hold counts from the moment it begins and
 * serializes behind earlier ones, and `idle()` waits for the tail, as the real
 * journal's `held()`/`idle()` do. `afterIdle` begins a hold the moment an
 * `idle()` the bridge awaited resolves: the observation a concurrent
 * `tool_result` frame starts in the issue's race.
 */
function holdingJournal() {
  let holds = 0, tail: Promise<unknown> = Promise.resolve();
  const idles: number[] = [];
  const state = { afterIdle: undefined as (() => void) | undefined };
  const hold = () => {
    holds++;
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    tail = Promise.all([tail, done]);
    let released = false;
    return () => { if (released) return; released = true; holds--; release(); };
  };
  const journal = {
    isHeld: () => holds > 0,
    async idle() {
      idles.push(holds);
      let waiting: Promise<unknown>;
      do { waiting = tail; await waiting; } while (waiting !== tail);
      const next = state.afterIdle; state.afterIdle = undefined; next?.();
    },
    observe: async () => {},
    toolStarted() {},
    toolEnded: async () => {},
    summary: () => ({ state: "unknown" }),
    bindSession: async () => {},
    finish: async () => {},
  };
  return { journal: journal as unknown as TurnJournal, hold, idles, state };
}

function pausableScope() {
  // `whilePaused` counts the checks that saw the pause: the route had an opportunity to commit and declined.
  const state = { paused: false, whilePaused: 0 };
  const scope = { isPaused: () => { if (state.paused) state.whilePaused++; return state.paused; }, toolCall() {}, bindSession() {}, finish() {}, close() {} };
  return { scope: scope as unknown as TurnScope, state };
}

/** `onLock` runs as a holder's body begins under the shared lock: a hold that begins after the route's entry check. */
async function session(options: { journal?: TurnJournal; scope?: TurnScope; authorized?: () => boolean; onLock?: () => void; turn: (bridge: BackendBridge, root: string) => Promise<void> }) {
  const root = mkdtempSync(join(tmpdir(), "ws-authority-hold-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "authority-hold-test" });
  const stream = createActivityStream(store);
  let failure: unknown;
  const backend = makeFakeBackend({ id: "pi", startTurn: async req => { try { await options.turn(req.bridge, root); } catch (error) { failure = error; } } });
  backend.brainApplicationPolicy = () => ({ autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() });
  const host = new WsHost({ brainPath: root, applicationPlanner: boundaryPlanner(createFixtureHostBoundary({ brainPath: root })), registry: createStaticBackendRegistry([backend], "pi"),
    catalog: createSessionCatalog(() => db), isPrincipalAuthorized: options.authorized ?? (() => true), activity: { store, stream, query: () => ({ ok: true, events: [] }) },
    ...(options.journal ? { journal: options.journal } : {}), ...(options.scope ? { scope: options.scope } : {}) });
  // Host effects take the host's worker lock, whatever lock the backend names.
  const base = host.workerLock;
  (host as { workerLock: KeyedLock }).workerLock = Object.assign(Object.create(base) as KeyedLock,
    { withLock: ((key, body, lockOptions) => base.withLock(key, async () => { options.onLock?.(); return body(); }, lockOptions)) as KeyedLock["withLock"] });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  try {
    const running = runSession(host, { authorization, text: "Repair the raft", attachments: [] });
    authorization.release(); await running;
    if (failure) throw failure;
  } finally { host.close(); stream.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

const raft = (path: string) => ({ operation: "write" as const, path, content: "Odysseus lashes the raft.\n", expectedBaseHash: null });

/**
 * Resolves once the bridge awaits the journal again while a hold is active
 * (the route saw the hold and declined to commit), or once `settled` says the
 * effect already answered.
 */
async function waitingOn(idles: number[], seen: number, settled: () => boolean) {
  for (let turn = 0; turn < 1000 && !settled() && idles.slice(seen).every(holds => holds === 0); turn++) await new Promise(resolve => setImmediate(resolve));
}

test("a write overlapping a journal observation that began after idle() waits and commits after it (#2853)", async () => {
  const { journal, hold, idles, state } = holdingJournal();
  let result: BrainApplicationResult | undefined;
  await session({ journal, turn: async (bridge, root) => {
    let release: (() => void) | undefined;
    state.afterIdle = () => { release = hold(); };
    const seen = idles.length;
    const pending = bridge.applyBrain!(raft("notes/held-raft.md")).then(value => { result = value; return value; });
    await waitingOn(idles, seen, () => result !== undefined);
    expect(release, "AUTHORITY_HOLD_BEGAN_AFTER_IDLE").toBeDefined();
    expect(existsSync(join(root, "notes/held-raft.md")), "AUTHORITY_HOLD_NOTHING_COMMITS_WHILE_JOURNAL_HOLDS").toBe(false);
    expect(result, "AUTHORITY_HOLD_WRITE_NOT_REFUSED_WHILE_HELD").toBeUndefined();
    expect(idles.slice(seen).some(holds => holds > 0), "AUTHORITY_HOLD_ROUTE_WAITS_ON_JOURNAL").toBe(true);
    release!();
    const settled = await pending;
    expect(settled, "AUTHORITY_HOLD_WRITE_COMMITS_AFTER_HOLD").toMatchObject({ ok: true });
    expect(readFileSync(join(root, "notes/held-raft.md"), "utf8")).toBe("Odysseus lashes the raft.\n");
  } });
  expect(result?.ok).toBe(true);
});

test("a write overlapping a scope pause waits and commits once the pause is answered (#2853)", async () => {
  const { journal, state: journalState } = holdingJournal();
  const { scope, state } = pausableScope();
  let result: BrainApplicationResult | undefined;
  await session({ journal, scope, turn: async (bridge, root) => {
    journalState.afterIdle = () => { state.paused = true; };
    const pending = bridge.applyBrain!(raft("notes/paused-raft.md")).then(value => { result = value; return value; });
    // A pause has no event; the route rechecks it. Two checks that saw it
    // mean the route waited through one recheck and still did not commit.
    for (let turn = 0; turn < 200 && state.whilePaused < 2 && result === undefined; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(existsSync(join(root, "notes/paused-raft.md")), "AUTHORITY_PAUSE_NOTHING_COMMITS_WHILE_PAUSED").toBe(false);
    expect(result, "AUTHORITY_PAUSE_WRITE_NOT_REFUSED_WHILE_PAUSED").toBeUndefined();
    expect(state.whilePaused, "AUTHORITY_PAUSE_ROUTE_RECHECKS").toBeGreaterThanOrEqual(2);
    state.paused = false;
    expect(await pending, "AUTHORITY_PAUSE_WRITE_COMMITS_AFTER_PAUSE").toMatchObject({ ok: true });
    expect(existsSync(join(root, "notes/paused-raft.md"))).toBe(true);
  } });
  expect(result?.ok).toBe(true);
});

test("a principal that really lost authority during a journal hold still refuses authority_revoked at once (#2853)", async () => {
  const { journal, hold, idles, state } = holdingJournal();
  let authorized = true, release: (() => void) | undefined, heldAtAnswer: boolean | undefined;
  await session({ journal, authorized: () => authorized, turn: async (bridge, root) => {
    state.afterIdle = () => { release = hold(); authorized = false; };
    const seen = idles.length;
    const pending = bridge.applyBrain!(raft("notes/revoked-raft.md")).then(value => { heldAtAnswer = journal.isHeld(); return value; });
    await waitingOn(idles, seen, () => heldAtAnswer !== undefined);
    release!();
    expect(await pending, "AUTHORITY_REVOKED_DURING_HOLD_REFUSES").toMatchObject({ ok: false, code: "authority_revoked", changes: [] });
    // Refused while the hold was still active: revocation never waits for it.
    expect(heldAtAnswer, "AUTHORITY_REVOKED_REFUSES_WITHOUT_WAITING").toBe(true);
    expect(existsSync(join(root, "notes/revoked-raft.md"))).toBe(false);
  } });
});

test("a principal revoked while a write waits on earlier journal work refuses authority_revoked at once (#2853)", async () => {
  const { journal, hold, idles } = holdingJournal();
  let authorized = true, heldAtAnswer: boolean | undefined;
  await session({ journal, authorized: () => authorized, turn: async (bridge, root) => {
    const release = hold();
    const seen = idles.length;
    const pending = bridge.applyBrain!(raft("notes/idle-revoked-raft.md")).then(value => { heldAtAnswer = journal.isHeld(); return value; });
    await waitingOn(idles, seen, () => heldAtAnswer !== undefined);
    expect(idles.slice(seen).some(holds => holds > 0), "AUTHORITY_IDLE_WAIT_BEGAN_HELD").toBe(true);
    authorized = false;
    // The hold stays: only the recheck can end the wait.
    expect(await pending, "AUTHORITY_REVOKED_DURING_IDLE_REFUSES").toMatchObject({ ok: false, code: "authority_revoked", changes: [] });
    expect(heldAtAnswer, "AUTHORITY_REVOKED_DURING_IDLE_DOES_NOT_WAIT").toBe(true);
    release();
    expect(existsSync(join(root, "notes/idle-revoked-raft.md"))).toBe(false);
  } });
});

test("a parent effect overlapping a journal observation that began after idle() waits rather than refusing (#2853)", async () => {
  const { journal, hold, idles, state } = holdingJournal();
  let outcome: unknown;
  await session({ journal, turn: async bridge => {
    let release: (() => void) | undefined;
    state.afterIdle = () => { release = hold(); };
    const seen = idles.length;
    const pending = bridge.queryActivity!({} as never).then(value => { outcome = value; return value; }, error => { outcome = error; return error; });
    await waitingOn(idles, seen, () => outcome !== undefined);
    expect(outcome, "AUTHORITY_HOLD_PARENT_EFFECT_WAITS").toBeUndefined();
    expect(idles.slice(seen).some(holds => holds > 0), "AUTHORITY_HOLD_PARENT_EFFECT_WAITS_ON_JOURNAL").toBe(true);
    release!();
    expect(await pending, "AUTHORITY_HOLD_PARENT_EFFECT_RUNS_AFTER_HOLD").toEqual({ ok: true, events: [] });
  } });
});

test.each(["journal", "scope"] as const)("a write whose %s hold begins inside the brain lock waits outside it and commits after (#2853)", async kind => {
  const { journal, hold, idles } = holdingJournal();
  const { scope, state } = pausableScope();
  let result: BrainApplicationResult | undefined, release: (() => void) | undefined, locks = 0;
  const onLock = () => {
    if (locks++ > 0) return;
    if (kind === "journal") release = hold();
    else { state.paused = true; release = () => { state.paused = false; }; }
  };
  await session({ journal, scope, onLock, turn: async (bridge, root) => {
    const seen = idles.length;
    const pending = bridge.applyBrain!(raft(`notes/${kind}-locked-raft.md`)).then(value => { result = value; return value; });
    // The route met the hold under the lock and is waiting on it again.
    if (kind === "journal") await waitingOn(idles, seen, () => result !== undefined);
    else for (let turn = 0; turn < 200 && state.whilePaused < 2 && result === undefined; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(locks, "AUTHORITY_LOCKED_HOLD_BEGAN_UNDER_LOCK").toBeGreaterThan(0);
    expect(existsSync(join(root, `notes/${kind}-locked-raft.md`)), "AUTHORITY_LOCKED_NOTHING_COMMITS_WHILE_HELD").toBe(false);
    expect(result, "AUTHORITY_LOCKED_WRITE_NOT_REFUSED_WHILE_HELD").toBeUndefined();
    if (kind === "journal") expect(idles.slice(seen).some(holds => holds > 0), "AUTHORITY_LOCKED_ROUTE_WAITS_ON_JOURNAL").toBe(true);
    else expect(state.whilePaused, "AUTHORITY_LOCKED_ROUTE_RECHECKS_PAUSE").toBeGreaterThanOrEqual(2);
    release!();
    expect(await pending, "AUTHORITY_LOCKED_WRITE_COMMITS_AFTER_HOLD").toMatchObject({ ok: true });
    expect(locks, "AUTHORITY_LOCKED_RETRY_TAKES_THE_LOCK_AGAIN").toBe(2);
    expect(readFileSync(join(root, `notes/${kind}-locked-raft.md`), "utf8")).toBe("Odysseus lashes the raft.\n");
  } });
  expect(result?.ok).toBe(true);
});
