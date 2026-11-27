import { afterEach, expect, test } from "bun:test";
import type { Database, Statement } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { configurationSet } from "../src/brain/journal-configuration-sets.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { createTurnBudgets } from "../src/brain/turn-budgets.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createUiDb } from "../src/db/client.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { WsHost } from "../src/ws/host.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

// History replay reads each turn's journal summary and saved budget receipt
// (#4800). The number of statements behind a replay must not grow with the
// number of turns, and each saved receipt is read and parsed once.
// Odysseus fixtures only.

/** The replayed journals of the every-kind fixture, as the per-turn replay produced them before #4971 (#4975). */
const STORED_JOURNAL = JSON.parse(readFileSync(new URL("./fixtures/history-replay-journal.golden.json", import.meta.url), "utf8"));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-replay-reads-")), brain = join(root, "brain"), path = join(root, "ui.db");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root);
  cleanups.push(() => native.close());
  const db = createUiDb(path);
  cleanups.push(() => db.close());
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects") });
  cleanups.push(() => journal.close());
  await journal.ready;
  const ledger = createJournalAccounting(db, path), objects = createJournalObjects(join(root, "objects"), ledger);
  const budgets = createTurnBudgets(db, { resolve: () => null });
  const host = new WsHost({ catalog: createSessionCatalog(() => db), registry: createStaticBackendRegistry([makeFakeBackend({ id: "claude" })], "claude"), journal, budgets });
  cleanups.push(() => host.close());
  const turn = (id: string, at: number, columns: { state?: string; ended?: boolean; summary?: string; failure?: string; configurationSet?: string } = {}) =>
    ledger.write(() => {
      db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,started_at,ended_at,state,summary,configuration_set) VALUES (?,'ithaca','interactive','fixture-model','governed',?,?,?,?,?)")
        .run(id, at, columns.ended === false ? null : at + 1, columns.state ?? "complete", columns.summary ?? null, columns.configurationSet ?? null);
      if (columns.failure) db.query("UPDATE turn_journal_turns SET failure=? WHERE turn_id=?").run(columns.failure.padEnd(64), id);
    });
  const change = (id: string, sequence: number, path: string, cls = "content") => ledger.write(() => {
    db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class) VALUES (?,?,?,'brain',?,?,?)")
      .run(id, sequence, path, JSON.stringify({ kind: "file", hash: "a".repeat(64), bytes: 8 }), JSON.stringify({ kind: "file", hash: "b".repeat(64), bytes: 9 }), cls);
  });
  const receipt = (id: string, at: number, value: unknown) =>
    db.query("INSERT INTO turn_budget_usage (turn_id,session_id,started_at,cost_usd,tokens,observed_at,receipt) VALUES (?,'ithaca',?,NULL,NULL,?,?)").run(id, at, at, JSON.stringify(value));
  const rollup = (id: string, cost: number, estimate: boolean) =>
    db.query(`INSERT INTO activity_run_rollups (run_id, origin, name, started_at, ended_at, outcome, duration_ms, span_count, effective_cost_usd, pricing_estimate, detail_pruned)
      VALUES (?, 'session', 'Voyage', 1, 2, 'success', 1, 1, ?, ?, 0)`).run(id, cost, estimate ? 1 : 0);
  /** One user and one assistant message per turn, as a backend's history reads. */
  const history = (ids: readonly string[]): SessionHistoryMessage[] => ids.flatMap((id, i) => [
    { role: "user" as const, content: `Bearing ${i} for Ithaca`, toolCalls: [] },
    { role: "assistant" as const, content: `Course ${i} set`, toolCalls: [], turnId: id },
  ]);
  return { db, journal, ledger, objects, budgets, host, turn, change, receipt, rollup, history };
}

/** Every statement executed on `db` while `run` runs; the handle's own methods are restored afterwards. */
function statementsDuring<T>(db: Database, run: () => T): { result: T; statements: string[] } {
  const statements: string[] = [];
  const own = { query: Object.getOwnPropertyDescriptor(db, "query"), prepare: Object.getOwnPropertyDescriptor(db, "prepare") };
  const wrap = (sql: string, compiled: Statement) => new Proxy(compiled, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!["all", "get", "run", "values", "iterate"].includes(String(key))) return value.bind(target);
      return (...params: unknown[]) => { statements.push(sql); return value.apply(target, params); };
    },
  });
  const query = db.query.bind(db), prepare = db.prepare.bind(db);
  Object.defineProperty(db, "query", { configurable: true, writable: true, value: (sql: string) => wrap(sql, query(sql)) });
  Object.defineProperty(db, "prepare", { configurable: true, writable: true, value: (sql: string) => wrap(sql, prepare(sql)) });
  try { return { result: run(), statements }; } finally {
    for (const key of ["query", "prepare"] as const) {
      if (own[key]) Object.defineProperty(db, key, own[key]); else Reflect.deleteProperty(db, key);
    }
  }
}

/** `JSON.parse` calls on exactly `text` while `run` runs; the global is restored afterwards. */
function parsesDuring<T>(texts: ReadonlySet<string>, run: () => T): { result: T; parses: number } {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, "parse")!, parse = JSON.parse;
  let parses = 0;
  Object.defineProperty(JSON, "parse", { ...descriptor, value: (text: string, reviver?: never) => { if (texts.has(text)) parses++; return parse(text, reviver); } });
  try { return { result: run(), parses }; } finally { Object.defineProperty(JSON, "parse", descriptor); }
}

async function endedTurns(count: number) {
  const f = await fixture();
  const ids = Array.from({ length: count }, (_, i) => `voyage-${String(i).padStart(3, "0")}`);
  ids.forEach((id, i) => {
    f.turn(id, 1_000 + i);
    f.change(id, 1, `notes/leg-${i}.md`);
    f.receipt(id, 1_000 + i, { turn: { costUsd: i / 100 }, fixture: "Ithaca" });
    f.rollup(id, i / 100, i % 2 === 0);
  });
  return { f, ids };
}

test("a replay of 100 ended turns runs as many statements as a replay of 10", async () => {
  const counts: number[] = [];
  for (const n of [10, 100]) {
    const { f, ids } = await endedTurns(n);
    const { result, statements } = statementsDuring(f.db, () => f.host.prepareHistory("ithaca", f.history(ids)));
    expect(result.filter(message => message.journal).length, "EVERY_ASSISTANT_TURN_CARRIES_A_JOURNAL").toBe(n);
    expect(result.find(message => message.turnId === ids[3])?.journal, "SUMMARY_AND_RECEIPT_ATTACHED").toMatchObject({ state: "complete", changedFiles: 1, budget: { turn: { costUsd: 0.03 } } });
    counts.push(statements.length);
  }
  expect(counts[1], "REPLAY_STATEMENTS_INDEPENDENT_OF_TURN_COUNT").toBe(counts[0]);
});

test("a replay reads and parses each saved receipt once", async () => {
  const { f, ids } = await endedTurns(10);
  const stored = new Set((f.db.query("SELECT receipt FROM turn_budget_usage").all() as { receipt: string }[]).map(row => row.receipt));
  expect(stored.size).toBe(10);
  const { result: { statements }, parses } = parsesDuring(stored, () => statementsDuring(f.db, () => f.host.prepareHistory("ithaca", f.history(ids))));
  expect(parses, "EACH_RECEIPT_PARSED_ONCE").toBe(10);
  expect(statements.filter(sql => /\bturn_budget_usage\b/.test(sql)).length, "RECEIPTS_READ_IN_ONE_STATEMENT").toBe(1);
});

test("the replayed journal of every kind of turn is what the per-turn reads return", async () => {
  const f = await fixture();
  // An active turn, recorded through the journal itself.
  await f.journal.begin("active", { sessionId: null, actor: "interactive", model: null, profile: "governed", policyHash: null, workspaceReadOnly: true }, error => { throw error; });
  // Complete, with a steering change, a shared change and a cost estimate.
  f.turn("complete", 1); f.change("complete", 1, "notes/ithaca.md"); f.change("complete", 2, "context/steering.md", "steering");
  f.ledger.write(() => f.db.query("UPDATE turn_journal_changes SET overlaps='[\"athena\"]' WHERE turn_id='complete' AND sequence=1").run());
  f.rollup("complete", 0.25, true);
  f.db.query("INSERT INTO turn_scope (turn_id,session_id,principal_id,summary,ended_at) VALUES ('complete',NULL,'odysseus',?,2)").run(JSON.stringify({ read: ["notes"], wrote: ["notes"] }));
  f.receipt("complete", 1, { turn: { costUsd: 0.25 } });
  // Partial by its stored state, and by its recorded failure.
  f.turn("partial", 2, { state: "partial" }); f.change("partial", 1, "notes/scylla.md");
  f.turn("failed", 3, { failure: "journal_capacity" });
  // Expired with a retained summary; its change rows are gone.
  f.turn("expired", 4, { state: "expired", summary: JSON.stringify({ changedFiles: 4, steeringFiles: 1, keptFiles: 3, sharedAttribution: true }) });
  // A recorded configuration set.
  const set = configurationSet(["context/rules.md"]);
  f.ledger.write(() => f.db.query("INSERT INTO turn_journal_configuration_sets (hash,paths,count) VALUES (?,?,1)").run(set.hash, JSON.stringify(set.paths)));
  f.turn("configured", 5, { configurationSet: set.hash });
  // A code receipt: its paths count as changed and kept files.
  f.turn("code", 6); f.change("code", 1, "notes/loom.md");
  expect(f.ledger.ensureCodeReceiptTables()).toBe(true);
  const pack = await f.objects.putBytes(Buffer.from("Penelope's loom"), ["code"]);
  f.ledger.write(() => f.db.query("INSERT INTO turn_journal_code_receipts (turn_id,checkout,receipt,pack_hash) VALUES ('code','workspaces/loom',?,?)")
    .run(JSON.stringify({ state: "complete", paths: ["src/warp.ts", "src/weft.ts"] }), pack));
  // A malformed receipt reads as none, as the per-turn read does.
  f.db.query("INSERT INTO turn_budget_usage (turn_id,session_id,started_at,observed_at,receipt) VALUES ('partial','ithaca',2,2,'{')").run();
  const ids = ["complete", "partial", "failed", "expired", "configured", "code", "active", "unjournaled", "complete"];
  const expected = f.history(ids).map(message => message.role === "assistant" && message.turnId
    ? { ...message, journal: { ...f.journal.summary(message.turnId), ...(f.budgets.saved(message.turnId) ? { budget: f.budgets.saved(message.turnId) } : {}) } } : message);
  const replayed = f.host.prepareHistory("ithaca", f.history(ids));
  expect(replayed, "BATCHED_REPLAY_EQUALS_PER_TURN_READS").toEqual(expected);
  // Every field against the value the per-turn replay produced before the
  // batched read (#4975), the active turn's clock-stamped observedAt aside.
  const journals = replayed.filter(message => message.journal).map(({ turnId, journal }) =>
    ({ turnId, journal: turnId === "active" ? (({ observedAt: _clock, ...rest }) => rest)(journal!) : journal }));
  expect(journals, "REPLAYED_JOURNAL_MATCHES_STORED_VALUE").toEqual(STORED_JOURNAL);
  const journalOf = (id: string) => replayed.find(message => message.turnId === id)!.journal!;
  expect(journalOf("code").changedFiles, "CODE_RECEIPT_PATHS_COUNT").toBe(3);
  expect(journalOf("code").keptFiles, "CODE_RECEIPT_PATHS_KEPT").toBe(3);
  expect(journalOf("complete"), "COMPLETE_TURN").toMatchObject({ state: "complete", changedFiles: 2, steeringFiles: 1, sharedAttribution: true, costUsd: 0.25, costIsEstimate: true, scope: { read: ["notes"] }, budget: { turn: { costUsd: 0.25 } } });
  expect(journalOf("partial"), "PARTIAL_TURN").toMatchObject({ state: "partial", changedFiles: 1 });
  expect(journalOf("partial").budget, "MALFORMED_RECEIPT_READS_AS_NONE").toBeUndefined();
  expect(journalOf("failed"), "FAILED_TURN_IS_PARTIAL").toMatchObject({ state: "partial", changedFiles: null });
  expect(journalOf("expired"), "EXPIRED_TURN_KEEPS_RETAINED_SUMMARY").toMatchObject({ state: "expired", changedFiles: 4, steeringFiles: 1, keptFiles: 3, sharedAttribution: true });
  expect(journalOf("configured"), "CONFIGURATION_SET_RECORDED").toMatchObject({ configurationCoverage: "incomplete", configurationCoverageSet: set.hash });
  expect(journalOf("active").state, "ACTIVE_TURN_KEEPS_ITS_OWN_PATH").toBe("recording");
  expect(journalOf("unjournaled"), "NO_JOURNAL_ROW_IS_UNKNOWN").toMatchObject({ state: "unknown", changedFiles: null });
});
