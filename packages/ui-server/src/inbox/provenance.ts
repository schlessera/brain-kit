/**
 * Trusted host provenance of an autonomous turn's origin thread (#2741,
 * maintainer ruling C). A provider-masked autonomous turn starts only when
 * every item and checkpoint of its origin thread carries a host-written
 * record showing its text was produced without the folders the turn masks,
 * and its bridge reads revalidate that before returning anything. What
 * cannot be shown compatible is refused, never assumed safe from a
 * timestamp, a policy hash or a model-authored field.
 *
 * Compatible evidence is exactly:
 * - `person`: a person's arrival through authenticated intake outside any
 *   turn (the share and queue routes), bound to the staged bytes intake read;
 * - `server`: text the server composed from no brain content and no model
 *   output (schedule instructions, cleanup, lifecycle notices);
 * - `autonomous`: written by an autonomous run whose admitted masks hid every
 *   folder now masked, as recorded on its budget reservation;
 * - a copy (`derived_from`) carries its source's origin.
 * An item a conversation added (`inbox_add`) has none: its conversation's
 * earlier history is #2726's scope, so its text is not qualified.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { stagedArrival, stagedArrivalDigest, type StagedArrival } from "./arrival.js";
import { governancePolicyReaderFor } from "../brain/governance-policy.js";
import { ProviderThreadRefusedError } from "../brain/provider-mask-refusal.js";

export type InboxSubject = { item: string } | { checkpoint: string };
export type InboxProvenance =
  | { origin: "person"; evidence: string }
  | { origin: "server" }
  | { origin: "autonomous"; runId: string }
  | { derivedFrom: InboxSubject };

interface ProvenanceRow { subject: string; digest: string; origin: "person" | "server" | "autonomous"; hidden: string | null;
  run_id: string | null; derived_from: string | null; evidence: string | null }

const key = (subject: InboxSubject): string => "item" in subject ? `item:${subject.item}` : `checkpoint:${subject.checkpoint}`;
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

function canonical(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)]))
    : entry;
  return JSON.stringify(sort(value)) ?? "null";
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The text a subject can show, and its thread: an item's content fields, a checkpoint's state and facts. */
function subjectText(db: Database, subject: InboxSubject): { threadId: string; digest: string } | null {
  if ("item" in subject) {
    const row = db.query("SELECT thread_id, data_json FROM inbox_items WHERE id = ?").get(subject.item) as { thread_id: string; data_json: string } | null;
    if (!row) return null;
    // Lifecycle fields (status, version, leases, expiry) change without changing text.
    const { queue, type, payload, options, hygiene } = JSON.parse(row.data_json) as Record<string, unknown>;
    return { threadId: row.thread_id, digest: sha256(canonical({ queue, type, payload, options, hygiene })) };
  }
  const row = db.query("SELECT thread_id, state_md, facts_json FROM inbox_checkpoints WHERE id = ?").get(subject.checkpoint) as
    { thread_id: string; state_md: string; facts_json: string } | null;
  return row ? { threadId: row.thread_id, digest: sha256(canonical({ stateMd: row.state_md, facts: JSON.parse(row.facts_json) })) } : null;
}

/** The provider folders an autonomous run had masked, as admitted; undefined when none was recorded. */
function runMasks(db: Database, runId: string): string[] | undefined {
  const row = db.query("SELECT provider_admission FROM inbox_budget_reservations WHERE run_id = ? AND provider_admission IS NOT NULL LIMIT 1")
    .get(runId) as { provider_admission: string } | null;
  if (!row) return undefined;
  const masked = (JSON.parse(row.provider_admission) as { masked?: unknown }).masked;
  return Array.isArray(masked) && masked.every(folder => typeof folder === "string") ? masked : undefined;
}

/**
 * Record who produced a subject's text, in the caller's transaction, right
 * after writing it. Without trustworthy evidence nothing is recorded, and the
 * subject then never qualifies: an autonomous run with no admitted masks, or a
 * copy of a subject that has no record.
 */
export function recordInboxProvenance(db: Database, subject: InboxSubject, provenance: InboxProvenance, now = Date.now()): void {
  const text = subjectText(db, subject);
  if (!text) throw new Error("Inbox provenance names no stored item or checkpoint");
  let origin: ProvenanceRow["origin"], hidden: string | null = null, runId: string | null = null, derived: string | null = null, evidence: string | null = null;
  if ("derivedFrom" in provenance) {
    const source = db.query("SELECT * FROM inbox_provenance WHERE subject = ?").get(key(provenance.derivedFrom)) as ProvenanceRow | null;
    if (!source) return;
    ({ origin, hidden, run_id: runId } = source);
    derived = source.subject;
  } else if (provenance.origin === "autonomous") {
    const masked = runMasks(db, provenance.runId);
    if (!masked) return;
    origin = "autonomous"; hidden = JSON.stringify(masked); runId = provenance.runId;
  } else {
    origin = provenance.origin;
    if (provenance.origin === "person") evidence = provenance.evidence;
  }
  db.query(`INSERT OR IGNORE INTO inbox_provenance (subject, thread_id, digest, origin, hidden, run_id, derived_from, evidence, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key(subject), text.threadId, text.digest, origin, hidden, runId, derived, evidence, now);
}

/** Why each subject the thread can show fails to qualify for `masked`; empty when all qualify. */
function unqualified(db: Database, threadId: string, masked: readonly string[]): { subjects: string[]; qualified: ProvenanceRow[] } {
  const subjects = [
    ...(db.query("SELECT id FROM inbox_items WHERE thread_id = ? AND deleted_at IS NULL ORDER BY rowid").all(threadId) as { id: string }[]).map(row => ({ item: row.id })),
    // The thread's state projection is built from every checkpoint's state.
    ...(db.query("SELECT id FROM inbox_checkpoints WHERE thread_id = ? ORDER BY seq").all(threadId) as { id: string }[]).map(row => ({ checkpoint: row.id })),
  ];
  const refused: string[] = [], qualified: ProvenanceRow[] = [];
  for (const subject of subjects) {
    const row = db.query("SELECT * FROM inbox_provenance WHERE subject = ?").get(key(subject)) as ProvenanceRow | null;
    const current = subjectText(db, subject);
    const hidden = row?.hidden ? JSON.parse(row.hidden) as string[] : [];
    const compatible = row !== null && row.digest === current?.digest &&
      (row.origin !== "autonomous" || masked.every(folder => hidden.some(outer => within(folder, outer))));
    if (compatible) qualified.push(row); else refused.push(key(subject));
  }
  return { subjects: refused, qualified };
}

export interface OriginThreadAdmission {
  readonly threadId: string;
  /** The provider folders the turn masks; empty, nothing is checked. */
  readonly masked: readonly string[];
  readonly policyHash: string | null;
  /** Each arrival of the thread, read once and matched to the bytes intake recorded. */
  readonly arrivals: ReadonlyMap<string, StagedArrival>;
  /**
   * Refuse unless the admission still holds: the same policy, and every item
   * and checkpoint of the thread compatible. Call it in the transaction that
   * reads what it returns or sends.
   */
  revalidate(): void;
}

/**
 * Qualify an autonomous run's origin thread for its admitted masks, before any
 * thread text is read into its prompt, and record the evidence on the run's
 * budget reservation. Refuses with `ProviderThreadRefusedError`.
 */
export async function admitOriginThread(db: Database, brainPath: string, input: { runId: string; threadId: string; masked: readonly string[]; policyHash: string | null }): Promise<OriginThreadAdmission> {
  const masked = Object.freeze([...input.masked]), arrivals = new Map<string, StagedArrival>();
  const revalidate = (): ReturnType<typeof unqualified> => {
    if (!masked.length) return { subjects: [], qualified: [] };
    if (governancePolicyReaderFor(brainPath).load().hash !== input.policyHash) throw new ProviderThreadRefusedError(input.threadId, masked, [], "policy_changed");
    const result = unqualified(db, input.threadId, masked);
    if (result.subjects.length) throw new ProviderThreadRefusedError(input.threadId, masked, result.subjects, "provenance");
    return result;
  };
  const { qualified } = db.transaction(revalidate)();
  // Queued work reads an arrival's staged bytes, outside the database: they
  // must be the bytes intake read when the person's arrival was committed.
  for (const row of qualified) {
    if (!row.subject.startsWith("item:")) continue;
    const item = db.query("SELECT type, data_json FROM inbox_items WHERE id = ?").get(row.subject.slice(5)) as { type: string; data_json: string };
    if (item.type !== "triage") continue;
    const stagingId = (JSON.parse(item.data_json) as { payload: { stagingId: string } }).payload.stagingId;
    const arrival = row.evidence ? await stagedArrival(brainPath, stagingId).catch(() => null) : null;
    if (!arrival || stagedArrivalDigest(arrival) !== row.evidence) throw new ProviderThreadRefusedError(input.threadId, masked, [row.subject], "provenance");
    arrivals.set(row.subject.slice(5), arrival);
  }
  db.transaction(() => {
    const { qualified: current } = revalidate();
    const unread = current.filter(row => row.evidence !== null && !arrivals.has(row.subject.slice(5))).map(row => row.subject);
    if (unread.length) throw new ProviderThreadRefusedError(input.threadId, masked, unread, "provenance");
    const recorded = { policyHash: input.policyHash, masked,
      subjects: current.map(row => ({ subject: row.subject, origin: row.origin, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.derived_from ? { derivedFrom: row.derived_from } : {}) })) };
    db.query("UPDATE inbox_budget_reservations SET provider_admission = ? WHERE run_id = ? AND status = 'active'").run(JSON.stringify(recorded), input.runId);
  }).immediate();
  return Object.freeze({ threadId: input.threadId, masked, policyHash: input.policyHash, arrivals, revalidate: () => { revalidate(); } });
}
