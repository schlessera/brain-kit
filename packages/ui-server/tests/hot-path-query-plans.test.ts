/**
 * Per-turn and per-tick lookups on tables that grow for the life of a host
 * search an index instead of scanning the table (#5071, epic #4665). Where a
 * call site can run on a fresh database, its own statements are recorded and
 * planned with the arguments it bound; the rest are planned as their source
 * text, which the comment above each names.
 */
import { expect, test } from "bun:test";
import type { Database, Statement } from "bun:sqlite";
import { createUiDb } from "../src/db/client.js";
import { safetyEvidenceSequence, safetyProjection } from "../src/governance/safety-store.js";
import { reconcileInboxBudgets } from "../src/inbox/budget.js";

const plan = (db: Database, sql: string, params: unknown[]) => {
  const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try { return (explain.all(...(params as never[])) as Array<{ detail: string }>).map(row => row.detail); } finally { explain.finalize(); }
};

/** Every statement `run` executes through `db.query`, with the arguments it bound. */
function recorded(db: Database, run: () => void): Array<{ sql: string; params: unknown[] }> {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const query = db.query;
  const wrapped = new Map<Statement, Record<string, unknown>>();
  db.query = ((sql: string) => {
    const statement = query.call(db, sql) as Statement;
    if (!wrapped.has(statement)) {
      const originals: Record<string, unknown> = {};
      for (const method of ["get", "all", "run", "values", "iterate"] as const) {
        const original = (statement as any)[method];
        originals[method] = original;
        (statement as any)[method] = (...params: unknown[]) => { seen.push({ sql, params }); return original.apply(statement, params); };
      }
      wrapped.set(statement, originals);
    }
    return statement;
  }) as typeof db.query;
  try { run(); } finally {
    db.query = query;
    for (const [statement, originals] of wrapped) Object.assign(statement, originals);
  }
  return seen;
}

/** Plan steps that read every row of one of `tables` (or an alias of it), with no index. */
const fullScans = (steps: string[], names: string[]) =>
  steps.filter(step => names.some(name => new RegExp(`^SCAN ${name}( |$)`).test(step)) && !/ USING (COVERING )?INDEX /.test(step));

test("the safety projection and evidence sequence a turn, a write and every subscribed socket read scan no ledger table (#5071)", () => {
  const db = createUiDb(":memory:");
  try {
    const statements = recorded(db, () => { safetyProjection(db, null, "odysseus-voyage"); safetyEvidenceSequence(db, null, "odysseus-voyage"); });
    const ledger = statements.filter(({ sql }) => /\bFROM safety_(collections|records) [cr]\b/.test(sql));
    expect(ledger.length, "both read the ledger").toBeGreaterThanOrEqual(4);
    const scans = ledger.flatMap(({ sql, params }) => fullScans(plan(db, sql, params), ["c", "r", "d", "b", "safety_collections", "safety_records"])
      .map(step => ({ sql: sql.replace(/\s+/g, " ").slice(0, 80), step })));
    expect(scans, "SAFETY_PROJECTION_SCANS_NO_LEDGER_TABLE").toEqual([]);
  } finally { db.close(); }
});

test("the owner lookups and the taint join search an index (#5071)", () => {
  const db = createUiDb(":memory:");
  const LOOKUPS: Array<{ name: string; sql: string; params: unknown[]; index: string }> = [
    // beginSafetyCollection, governance/safety-store.ts
    { name: "owner collected", sql: "SELECT 1 FROM safety_collections WHERE history_owner_id=? AND generation=? LIMIT 1",
      params: ["ithaca", "1"], index: "safety_collections_history_owner" },
    { name: "owner epochs", sql: "SELECT COUNT(*) n FROM safety_collections WHERE history_owner_id=? AND generation=?",
      params: ["ithaca", "1"], index: "safety_collections_history_owner" },
    // sessionTaint, governance/session-taint.ts
    { name: "taint event", sql: `SELECT g.id,r.source FROM safety_records r
    LEFT JOIN safety_legacy_events m ON m.record_id=r.id LEFT JOIN governance_events g ON g.id=m.event_id WHERE r.id=?`,
      params: ["loom"], index: "safety_legacy_events_record" },
  ];
  try {
    const planned = LOOKUPS.map(({ name, sql, params, index }) => {
      const steps = plan(db, sql, params);
      return { name, scans: fullScans(steps, ["safety_collections", "m"]), indexed: steps.some(step => step.includes(` INDEX ${index} `)) };
    });
    expect(planned, "OWNER_AND_TAINT_LOOKUPS_SEARCH_AN_INDEX").toEqual(LOOKUPS.map(({ name }) => ({ name, scans: [], indexed: true })));
  } finally { db.close(); }
});

test("the inbox drain's budget reconcile and the admission totals read only the rows they need (#5071)", () => {
  const db = createUiDb(":memory:");
  try {
    const statements = recorded(db, () => { reconcileInboxBudgets(db, Date.parse("2026-07-12T09:00:00Z")); });
    const reconcile = statements.find(({ sql }) => sql.includes("FROM inbox_budget_reservations r JOIN inbox_items i"));
    expect(reconcile, "reconcile reads the active reservations").toBeDefined();
    const steps = plan(db, reconcile!.sql, reconcile!.params);
    expect({ scans: fullScans(steps, ["r"]), partial: steps.some(step => step.includes("INDEX inbox_reservations_active")) },
      "BUDGET_RECONCILE_READS_ACTIVE_RESERVATIONS_ONLY").toEqual({ scans: [], partial: true });

    // The span arm of `totals`, inbox/budget.ts: autonomous root runs of a three-day window.
    const totals = `SELECT run_id, started_at, NULL FROM activity_spans s WHERE origin = 'autonomous' AND parent_span_id IS NULL
      AND started_at >= ? AND started_at < ?
      AND NOT EXISTS (SELECT 1 FROM activity_run_rollups h WHERE h.run_id = s.run_id)
      AND NOT EXISTS (SELECT 1 FROM inbox_budget_reservations r WHERE r.run_id = s.run_id)`;
    const span = plan(db, totals, [0, 1]);
    expect({ scans: fullScans(span, ["s"]), indexed: span.some(step => step.startsWith("SEARCH s USING INDEX activity_spans_root_origin_started ")) },
      "BUDGET_TOTALS_SEARCH_ROOT_SPANS").toEqual({ scans: [], indexed: true });
  } finally { db.close(); }
});
