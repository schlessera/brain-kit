/**
 * The Apify run ledger (#3161,
 * [the contract](../../../../docs/decisions/apify-capability.md#selected-execution-eligibility-and-monetary-enforcement)).
 *
 * Private operational evidence, never `brain.db`, never Markdown and never a
 * worker file: one SQLite file outside every brain, owned by the host user
 * and unreadable by anyone else. Every process that admits Apify work for the
 * same account opens the same file (hosted server, standalone CLI and MCP),
 * and the file's stored `ledger_id` is the identity they share. Admission is
 * one `BEGIN IMMEDIATE` transaction in WAL mode, so two processes, sessions or
 * brains cannot both spend the same remaining allowance.
 *
 * Money is integer microdollars, rounded up when it is reserved. A run's
 * liability is its reservation until it settles; after settlement it is the
 * known event charges plus its whole lifecycle request allowance and the
 * reserved remote storage, which local expiry never releases. A charge report raises the
 * liability it belongs to and never adds a second one: duplicate and late
 * reports are idempotent by content and only ever raise it. An unsettled run
 * counts against its start day and every later UTC day until it settles.
 */
import type { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";

const DAY_MS = 86_400_000;
export const utcDay = (at: number) => Math.floor(at / DAY_MS) * DAY_MS;
const SCHEMA_VERSION = 1;

/** Where a run is in its lifecycle. `unknown`: the start may or may not have happened; liability is retained. */
export type ApifyRunState =
  | "dispatching" | "unknown" | "refused"
  | "running" | "succeeded" | "failed" | "timed_out" | "aborting" | "aborted";
export const APIFY_OPEN_STATES: readonly ApifyRunState[] = ["dispatching", "unknown", "running", "aborting"];
export const APIFY_TERMINAL_STATES: readonly ApifyRunState[] = ["succeeded", "failed", "timed_out", "aborted"];

/** How well the run's cost is known. */
export type ApifyCostBasis = "reserved" | "events" | "unknown" | "operator" | "none";

export interface ApifyRunRow {
  handle: string;
  ledger_id: string;
  account_id: string;
  generation: string;
  brain_id: string;
  principal_id: string;
  session_id: string;
  turn_id: string;
  proposal_digest: string;
  actor_id: string;
  build_id: string;
  build_number: string;
  profile_id: string;
  input_sha256: string;
  state: ApifyRunState;
  remote_run_id: string | null;
  dataset_id: string | null;
  validated: number;
  run_cap_micro: number;
  request_micro: number;
  storage_micro: number;
  request_unit_micro: number;
  reserved_micro: number;
  charged_micro: number | null;
  final_micro: number | null;
  cost_basis: ApifyCostBasis;
  settled: number;
  price_changed: number;
  opened_day: number;
  created_at: number;
  dispatched_at: number | null;
  finished_at: number | null;
  deadline_at: number;
  retention_seconds: number;
  timeout_secs: number;
  memory_mbytes: number;
  items_bound: number;
  max_result_items: number;
  max_result_bytes: number;
  status_requests: number;
  result_requests: number;
  abort_requests: number;
  status_budget: number;
  result_budget: number;
  abort_budget: number;
  result_items: number;
  result_bytes: number;
  abort_state: "requested" | "confirmed" | "unresolved" | null;
  note: string | null;
  updated_at: number;
}

/** A refusal raised inside a ledger transaction; nothing it guarded was written. */
export class ApifyLedgerRefusal extends Error {
  constructor(readonly code: "budget_exceeded" | "proposal_stale", readonly reason: string, message: string) {
    super(message);
    this.name = "ApifyLedgerRefusal";
  }
}
/** The ledger cannot be opened, read or written: paid admission refuses. */
export class ApifyLedgerUnavailable extends Error {
  constructor(message = "Apify accounting is unavailable, so no paid Apify work was admitted.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApifyLedgerUnavailable";
  }
}

/** Effective allowances in microdollars and counts, already intersected with global budgets. */
export interface ApifyAdmissionLimits {
  run_micro: number;
  turn_micro: number;
  session_micro: number;
  /** Account-wide, across every brain and principal using the account. */
  day_micro: number;
  /** This brain's share of the global day budget not already spent on inference. */
  brain_day_micro: number;
  max_runs_per_turn: number;
  max_concurrent_runs: number;
}

export interface ApifyReservation {
  account_id: string; generation: string; brain_id: string;
  principal_id: string; session_id: string; turn_id: string; proposal_digest: string;
  actor_id: string; build_id: string; build_number: string; profile_id: string; input_sha256: string;
  run_cap_micro: number; request_micro: number; storage_micro: number; request_unit_micro: number;
  deadline_at: number; retention_seconds: number; timeout_secs: number; memory_mbytes: number;
  items_bound: number; max_result_items: number; max_result_bytes: number;
  status_budget: number; result_budget: number; abort_budget: number;
}

/** Liability in one scope, microdollars. Pending reservations count as spend. */
export interface ApifyScopeTotals {
  liability_micro: number;
  /** Known charges in settled and running work. */
  charged_micro: number;
  /** Held for work whose charges are not yet (or never) known. */
  reserved_micro: number;
  /** Settled runs' lifecycle requests and remote storage still held, which local expiry never releases. */
  residual_micro: number;
  runs: number;
  open_runs: number;
  unknown_runs: number;
  /** Unknown starts an operator resolved from evidence outside BrainKit; never silently zeroed. */
  operator_resolved: number;
}

export interface ApifyLedger {
  /** The identity every process opening this file shares. */
  readonly id: string;
  readonly path: string;
  /** Count `requests` against the turn's bound; throws `budget_exceeded` past it. */
  countRequests(scope: { brain_id: string; session_id: string; turn_id: string }, requests: number, bound: number): void;
  /**
   * Atomic admission: checks every scope, counts the start request against the
   * turn's `requestBound` and writes the dispatch intent, or throws without writing.
   */
  reserve(reservation: ApifyReservation, limits: ApifyAdmissionLimits, now: number, requestBound: number): ApifyRunRow;
  get(handle: string): ApifyRunRow | null;
  /** Runs this brain owns that are not settled. */
  unsettled(brainId: string): ApifyRunRow[];
  /** Apply a transition to one run under the write lock; returns the updated row. */
  update(handle: string, change: (row: ApifyRunRow) => Partial<ApifyRunRow> | null, now: number): ApifyRunRow;
  /** Record one charge report exactly once by its content; returns whether it was new and the row after it. */
  charge(handle: string, report: { counts: Readonly<Record<string, number>>; status: string; micro: number | null; price_changed: boolean }, now: number): { fresh: boolean; row: ApifyRunRow };
  /** Reserve one lifecycle request of `kind`; throws `budget_exceeded` past the profile's allowance. */
  lifecycleRequest(handle: string, kind: "status" | "result" | "abort", now: number): ApifyRunRow;
  totals(scope: { account_id: string; brain_id: string; session_id: string; turn_id: string }, now: number): Record<"turn" | "session" | "day" | "brain_day", ApifyScopeTotals>;
  /** An opaque, unforgeable cursor bound to one run and offset. */
  cursor(handle: string, offset: number): string;
  /** The offset a cursor names for this run, or null when it is foreign or forged. */
  offset(handle: string, cursor: string): number | null;
  close(): void;
}

/** A row's liability, microdollars. */
export function liability(row: Pick<ApifyRunRow, "settled" | "final_micro" | "reserved_micro" | "charged_micro" | "state">): number {
  if (row.state === "refused") return row.final_micro ?? 0;
  if (row.settled) return row.final_micro ?? row.reserved_micro;
  return Math.max(row.reserved_micro, row.charged_micro ?? 0);
}

const OPEN_SQL = `state IN ('dispatching','unknown','running','aborting')`;

function privateFile(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.() ?? 0;
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0)
    throw new ApifyLedgerUnavailable("The Apify ledger's directory must be owned by the host user and not writable by others.");
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const node = lstatSync(path);
  if (!node.isFile() || node.nlink !== 1 || node.uid !== uid || (node.mode & 0o077) !== 0)
    throw new ApifyLedgerUnavailable("The Apify ledger must be a private regular file owned by the host user.");
}

/**
 * Open (creating if needed) the ledger at `path`, outside every brain. Throws
 * {@link ApifyLedgerUnavailable} when it cannot be opened safely; callers
 * refuse paid admission then.
 */
export function openApifyLedger(path: string): ApifyLedger {
  let db: Database;
  try {
    privateFile(path);
    const { Database } = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
    db = new Database(path, { strict: true });
    // Money is evidence: a committed reservation survives a crash (FULL), and writers queue (busy_timeout).
    db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (
          handle TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, account_id TEXT NOT NULL, generation TEXT NOT NULL, brain_id TEXT NOT NULL,
          principal_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, proposal_digest TEXT NOT NULL UNIQUE,
          actor_id TEXT NOT NULL, build_id TEXT NOT NULL, build_number TEXT NOT NULL, profile_id TEXT NOT NULL, input_sha256 TEXT NOT NULL,
          state TEXT NOT NULL, remote_run_id TEXT UNIQUE, dataset_id TEXT, validated INTEGER NOT NULL DEFAULT 0,
          run_cap_micro INTEGER NOT NULL, request_micro INTEGER NOT NULL, storage_micro INTEGER NOT NULL, request_unit_micro INTEGER NOT NULL,
          reserved_micro INTEGER NOT NULL, charged_micro INTEGER, final_micro INTEGER, cost_basis TEXT NOT NULL,
          settled INTEGER NOT NULL DEFAULT 0, price_changed INTEGER NOT NULL DEFAULT 0, opened_day INTEGER NOT NULL,
          created_at INTEGER NOT NULL, dispatched_at INTEGER, finished_at INTEGER, deadline_at INTEGER NOT NULL,
          retention_seconds INTEGER NOT NULL, timeout_secs INTEGER NOT NULL, memory_mbytes INTEGER NOT NULL,
          items_bound INTEGER NOT NULL, max_result_items INTEGER NOT NULL, max_result_bytes INTEGER NOT NULL,
          status_requests INTEGER NOT NULL DEFAULT 0, result_requests INTEGER NOT NULL DEFAULT 0, abort_requests INTEGER NOT NULL DEFAULT 0,
          status_budget INTEGER NOT NULL, result_budget INTEGER NOT NULL, abort_budget INTEGER NOT NULL,
          result_items INTEGER NOT NULL DEFAULT 0, result_bytes INTEGER NOT NULL DEFAULT 0,
          abort_state TEXT, note TEXT, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS runs_account ON runs(account_id, settled, opened_day);
        CREATE INDEX IF NOT EXISTS runs_scope ON runs(brain_id, session_id, turn_id);
        CREATE TABLE IF NOT EXISTS charges (receipt TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES runs(handle),
          observed_at INTEGER NOT NULL, status TEXT NOT NULL, counts TEXT NOT NULL, micro INTEGER);
        CREATE TABLE IF NOT EXISTS requests (brain_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          count INTEGER NOT NULL, PRIMARY KEY (brain_id, session_id, turn_id));`);
      const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
      if (version && Number(version.value) !== SCHEMA_VERSION) throw new ApifyLedgerUnavailable("The Apify ledger was written by a different version.");
      db.query("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?), ('ledger_id', ?), ('cursor_key', ?)")
        .run(String(SCHEMA_VERSION), randomUUID(), randomBytes(32).toString("hex"));
    }).immediate();
  } catch (error) {
    if (error instanceof ApifyLedgerUnavailable) throw error;
    throw new ApifyLedgerUnavailable(undefined, { cause: error });
  }
  const meta = (key: string) => (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string }).value;
  const id = meta("ledger_id");
  const cursorKey = Buffer.from(meta("cursor_key"), "hex");

  /** Every ledger statement runs here: a failure becomes `accounting_unavailable`, a refusal stays itself. */
  const guarded = <T>(work: () => T): T => {
    try { return work(); }
    catch (error) {
      if (error instanceof ApifyLedgerRefusal || error instanceof ApifyLedgerUnavailable) throw error;
      throw new ApifyLedgerUnavailable(undefined, { cause: error });
    }
  };
  const row = (handle: string) => db.query("SELECT * FROM runs WHERE handle = ?").get(handle) as ApifyRunRow | null;
  const sum = (rows: ApifyRunRow[]): ApifyScopeTotals => rows.reduce<ApifyScopeTotals>((total, entry) => {
    const owed = liability(entry);
    const refused = entry.state === "refused";
    const known = refused ? owed : Math.min(owed, entry.charged_micro ?? 0);
    return {
      liability_micro: total.liability_micro + owed,
      charged_micro: total.charged_micro + known,
      reserved_micro: total.reserved_micro + (entry.settled || refused ? 0 : owed - known),
      residual_micro: total.residual_micro + (entry.settled && !refused ? owed - known : 0),
      runs: total.runs + (refused && entry.cost_basis !== "operator" ? 0 : 1),
      open_runs: total.open_runs + ((APIFY_OPEN_STATES as readonly string[]).includes(entry.state) ? 1 : 0),
      unknown_runs: total.unknown_runs + (entry.state === "unknown" || entry.cost_basis === "unknown" ? 1 : 0),
      operator_resolved: total.operator_resolved + (entry.cost_basis === "operator" ? 1 : 0),
    };
  }, { liability_micro: 0, charged_micro: 0, reserved_micro: 0, residual_micro: 0, runs: 0, open_runs: 0, unknown_runs: 0, operator_resolved: 0 });
  /** An unsettled run holds liability on its start day and every later day; a settled one on its start day only. */
  const dayRows = (where: string, value: string, day: number) =>
    db.query(`SELECT * FROM runs WHERE ${where} = ? AND ((settled = 0 AND state <> 'refused' AND opened_day <= ?) OR opened_day = ?)`).all(value, day, day) as ApifyRunRow[];
  const totals: ApifyLedger["totals"] = (scope, now) => {
    const day = utcDay(now);
    return {
      turn: sum(db.query("SELECT * FROM runs WHERE brain_id = ? AND session_id = ? AND turn_id = ?").all(scope.brain_id, scope.session_id, scope.turn_id) as ApifyRunRow[]),
      session: sum(db.query("SELECT * FROM runs WHERE brain_id = ? AND session_id = ?").all(scope.brain_id, scope.session_id) as ApifyRunRow[]),
      day: sum(dayRows("account_id", scope.account_id, day)),
      brain_day: sum(dayRows("brain_id", scope.brain_id, day)),
    };
  };
  const over = (reason: string, message: string) => new ApifyLedgerRefusal("budget_exceeded", reason, message);
  /** Inside a write transaction: count `requests` for the turn, refusing past `bound`. */
  const count = (scope: { brain_id: string; session_id: string; turn_id: string }, requests: number, bound: number) => {
    const used = (db.query("SELECT count FROM requests WHERE brain_id = ? AND session_id = ? AND turn_id = ?").get(scope.brain_id, scope.session_id, scope.turn_id) as { count: number } | null)?.count ?? 0;
    if (used + requests > bound) throw over("requests_per_turn", `This turn already made ${used} of its ${bound} Apify requests. Continue in a new turn.`);
    db.query("INSERT INTO requests(brain_id, session_id, turn_id, count) VALUES (?,?,?,?) ON CONFLICT(brain_id, session_id, turn_id) DO UPDATE SET count = count + excluded.count")
      .run(scope.brain_id, scope.session_id, scope.turn_id, requests);
  };
  const usd = (micro: number) => `$${(micro / 1e6).toFixed(6).replace(/\.?0+$/u, "")}`;

  return {
    id, path,
    countRequests(scope, requests, bound) { guarded(() => db.transaction(() => count(scope, requests, bound)).immediate()); },
    reserve(reservation, limits, now, requestBound) {
      return guarded(() => db.transaction(() => {
        const reserved = reservation.run_cap_micro + reservation.request_micro + reservation.storage_micro;
        if (!Number.isSafeInteger(reserved) || reserved <= 0) throw over("run_usd", "This run has no finite positive reservation.");
        if (reserved > limits.run_micro)
          throw over("run_usd", `This run would reserve ${usd(reserved)} (its cap plus lifecycle and storage), more than the ${usd(limits.run_micro)} one run may.`);
        const scope = { account_id: reservation.account_id, brain_id: reservation.brain_id, session_id: reservation.session_id, turn_id: reservation.turn_id };
        const current = totals(scope, now);
        const checks: Array<[keyof typeof current, number, string]> = [
          ["turn", limits.turn_micro, "turn_usd"], ["session", limits.session_micro, "session_usd"],
          ["day", limits.day_micro, "day_usd"], ["brain_day", limits.brain_day_micro, "day_budget"],
        ];
        for (const [name, limit, reason] of checks) {
          if (current[name].liability_micro + reserved > limit)
            throw over(reason, `This run would reserve ${usd(reserved)}, but only ${usd(Math.max(0, limit - current[name].liability_micro))} remains in the ${name === "brain_day" ? "UTC day's global budget" : name === "day" ? "account's UTC day" : name} allowance (pending runs count as spent).`);
        }
        if (current.turn.runs >= limits.max_runs_per_turn) throw over("max_runs_per_turn", `This turn already started ${current.turn.runs} of its ${limits.max_runs_per_turn} Apify runs.`);
        const open = (db.query(`SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND ${OPEN_SQL}`).get(reservation.account_id) as { n: number }).n;
        if (open >= limits.max_concurrent_runs) throw over("max_concurrent_runs", `${open} Apify runs are already open on this account, the most at once.`);
        if (db.query("SELECT 1 FROM runs WHERE proposal_digest = ?").get(reservation.proposal_digest))
          throw new ApifyLedgerRefusal("proposal_stale", "proposal_spent", "This proposal was already dispatched once.");
        // The start request counts against the turn in the same commit as the reservation.
        count(scope, 1, requestBound);
        const handle = randomBytes(32).toString("base64url");
        db.query(`INSERT INTO runs (handle, ledger_id, account_id, generation, brain_id, principal_id, session_id, turn_id, proposal_digest,
            actor_id, build_id, build_number, profile_id, input_sha256, state, run_cap_micro, request_micro, storage_micro, request_unit_micro,
            reserved_micro, cost_basis, opened_day, created_at, deadline_at, retention_seconds, timeout_secs, memory_mbytes, items_bound,
            max_result_items, max_result_bytes, status_budget, result_budget, abort_budget, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'dispatching',?,?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          handle, id, reservation.account_id, reservation.generation, reservation.brain_id, reservation.principal_id, reservation.session_id,
          reservation.turn_id, reservation.proposal_digest, reservation.actor_id, reservation.build_id, reservation.build_number,
          reservation.profile_id, reservation.input_sha256, reservation.run_cap_micro, reservation.request_micro, reservation.storage_micro,
          reservation.request_unit_micro, reserved, utcDay(now), now, reservation.deadline_at, reservation.retention_seconds,
          reservation.timeout_secs, reservation.memory_mbytes, reservation.items_bound, reservation.max_result_items,
          reservation.max_result_bytes, reservation.status_budget, reservation.result_budget, reservation.abort_budget, now);
        return row(handle)!;
      }).immediate());
    },
    get: handle => guarded(() => row(handle)),
    unsettled: brainId => guarded(() => db.query("SELECT * FROM runs WHERE brain_id = ? AND settled = 0 AND state <> 'refused' ORDER BY created_at").all(brainId) as ApifyRunRow[]),
    update(handle, change, now) {
      return guarded(() => db.transaction(() => {
        const current = row(handle);
        if (!current) throw new ApifyLedgerRefusal("proposal_stale", "unknown_run", "That Apify run is unknown.");
        const patch = change(current);
        if (!patch || !Object.keys(patch).length) return current;
        const keys = Object.keys(patch).filter(key => key !== "handle" && key in current);
        db.query(`UPDATE runs SET ${keys.map(key => `${key} = ?`).join(", ")}, updated_at = ? WHERE handle = ?`)
          .run(...keys.map(key => (patch as Record<string, string | number | null>)[key] ?? null), now, handle);
        return row(handle)!;
      }).immediate());
    },
    charge(handle, report, now) {
      return guarded(() => db.transaction(() => {
        const current = row(handle);
        if (!current) throw new ApifyLedgerRefusal("proposal_stale", "unknown_run", "That Apify run is unknown.");
        const receipt = sha256(canonicalJson({ handle, counts: report.counts, status: report.status }));
        const fresh = db.query("INSERT OR IGNORE INTO charges(receipt, handle, observed_at, status, counts, micro) VALUES (?,?,?,?,?,?)")
          .run(receipt, handle, now, report.status, canonicalJson(report.counts), report.micro).changes > 0;
        if (!fresh) return { fresh, row: current };
        const patch: Partial<ApifyRunRow> = {};
        if (report.price_changed) patch.price_changed = 1;
        // Counts are cumulative: a report only ever raises the known charge, and an unpriced one makes it unknown.
        if (report.micro === null) patch.cost_basis = "unknown";
        else {
          if (report.micro > (current.charged_micro ?? -1)) patch.charged_micro = report.micro;
          // A fully priced report replaces an earlier missing one; it never lowers what is held.
          if (current.cost_basis === "unknown" && !current.settled) patch.cost_basis = "reserved";
        }
        if (current.settled && current.final_micro !== null && report.micro !== null && report.micro > (current.charged_micro ?? 0))
          patch.final_micro = current.final_micro + (report.micro - (current.charged_micro ?? 0));
        if (Object.keys(patch).length) {
          const keys = Object.keys(patch);
          db.query(`UPDATE runs SET ${keys.map(key => `${key} = ?`).join(", ")}, updated_at = ? WHERE handle = ?`)
            .run(...keys.map(key => (patch as Record<string, string | number | null>)[key] ?? null), now, handle);
        }
        return { fresh, row: row(handle)! };
      }).immediate());
    },
    lifecycleRequest(handle, kind, now) {
      return guarded(() => db.transaction(() => {
        const current = row(handle);
        if (!current) throw new ApifyLedgerRefusal("proposal_stale", "unknown_run", "That Apify run is unknown.");
        const used = current[`${kind}_requests`], budget = current[`${kind}_budget`];
        if (used >= budget) throw over(`${kind}_requests`, `This run has used all ${budget} of its reserved ${kind} requests.`);
        db.query(`UPDATE runs SET ${kind}_requests = ${kind}_requests + 1, updated_at = ? WHERE handle = ?`).run(now, handle);
        return row(handle)!;
      }).immediate());
    },
    totals: (scope, now) => guarded(() => totals(scope, now)),
    cursor(handle, offset) {
      const mac = createHmac("sha256", cursorKey).update(`${handle}\u0000${offset}`).digest("base64url").slice(0, 32);
      return `${offset.toString(36)}.${mac}`;
    },
    offset(handle, cursor) {
      const match = /^([0-9a-z]{1,8})\.([A-Za-z0-9_-]{32})$/u.exec(cursor);
      if (!match) return null;
      const offset = Number.parseInt(match[1]!, 36);
      const expected = createHmac("sha256", cursorKey).update(`${handle}\u0000${offset}`).digest("base64url").slice(0, 32);
      return Number.isSafeInteger(offset) && expected === match[2] ? offset : null;
    },
    close() { db.close(); },
  };
}
