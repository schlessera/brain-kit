/**
 * Managed worktree hygiene (#2431). Worktrees are volatile hosting state, not
 * canonical brain data, so their findings and dispositions live in the host
 * database and never in `context/hygiene/` or `brain hygiene list`
 * (docs/decisions/managed-worktrees.md#hygiene-and-cleanup). They reuse core's
 * finding identity, fingerprint and selection rules and answer the same
 * operations as the `brain hygiene` CLI, so the human-started review joins them
 * into one queue. Only the worktree service removes a worktree, after
 * revalidating the reviewed premise immediately before the effect.
 */
import type { Database } from "bun:sqlite";
import { referenceWrites } from "./reference-writes.js";
import { createHash } from "node:crypto";
import type { ReferenceWorktreeCleanup, ReferenceWorktreeRow, ReferenceWorktrees } from "./reference-worktrees.js";
import type { HygieneWorktreeDetailsRead } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";

/*
 * Core is an optional peer of this package, so its types never reach these
 * declarations: the shapes below are the parts of core's hygiene identity,
 * fingerprint and selection functions this module uses, and the host passes
 * the loaded module in.
 */
interface Candidate {
  category: string; path: string; evidence: string; message: string;
  source: { source: "hygiene"; name: string; severity: "warning" }; facts: Record<string, string>;
}
interface Finding {
  id: string; category: string; path: string; evidence: string; message: string; severity: string | null; urgency: string | null;
  fingerprint: string; fingerprintFields: Record<string, string>;
}
interface Entry {
  id: string; state: "open" | "dismissed" | "snoozed" | "resolved"; path: string | null; issue: string | null; firstSeen: string | null; lastSeen: string | null;
  until: string | null; dueAt: string | null; resolvedBy: string | null; resolvedOn: string | null;
  sources: { source: "hygiene"; name: string; severity: "warning" }[]; severity: "warning" | null; fingerprint: string | null;
  disposition: { kind: "dismissed" | "snoozed"; on: string | null; reason: string | null; fingerprint: string | null } | null;
  invalidation: { on: string; disposition: "dismissed" | "snoozed"; dispositionOn: string | null; changed: string[]; previousId: string | null } | null;
}
/** The loaded `@schlessera/brain/internal` module, as far as this module reads it. */
export interface ReferenceWorktreeHygieneCore {
  canonicalFindings(candidates: Candidate[]): Map<string, Finding>;
  selectHygieneNext(root: string, findings: Map<string, Finding>, entries: Entry[], now: Date, findingId?: string): { finding: Finding | null; counts: Next["counts"] };
  REVIEW_SEVERITY: Record<string, number>;
  REVIEW_URGENCY: Record<string, number>;
  reviewUrgency(value: string | null): string;
}
type Core = ReferenceWorktreeHygieneCore;
/** The CLI's `next` projection, as the review reads it. */
type NextFinding = Record<string, unknown> & { id: string; severity?: string | null; urgency?: string | null; firstSeen?: string | null };
type Next = { finding: NextFinding | null;
  counts: { eligibleRemaining: number; fixed: number; dismissed: number; snoozed: number; nextSnoozeDueAt: string | null; informationalNotShown: number } };
type Work = Pick<ReferenceWorktreeCleanup, "work" | "changedPaths" | "unverifiedPaths" | "digest">;
type Inventory = ReturnType<ReferenceWorktrees["inventory"]>[number];
/** What a worktree's host state says is wrong with it. */
type Kind = "retained" | "unknown" | "cleanup-failed";
interface Detected { kind: Kind; finding: Finding; item: Inventory }
interface FindingRow {
  id: string; worktree_id: string; kind: Kind; state: "open" | "dismissed" | "snoozed" | "resolved"; fingerprint: string; fields_json: string;
  first_seen: number; last_seen: number; disposition_fingerprint: string | null; disposition_fields_json: string | null; disposed_at: number | null;
  due_at: number | null; reason: string | null; invalidation_json: string | null; resolved_by: string | null; resolved_at: number | null;
}
/** What a review operation may do on the reviewer's behalf: read their authority once more just before an effect. */
export interface ReferenceWorktreeHygieneContext { authorize?: () => void }

export const REFERENCE_WORKTREE_HYGIENE_CATEGORY = "managed-worktree";
/** The one repair: removing the worktree. Never offered for a worktree whose work or owner is unknown. */
export const REFERENCE_WORKTREE_REMOVAL_HANDLER = "delete-worktree";
const PATH_PREFIX = "reference-worktree://";
const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const factsOf = (row: ReferenceWorktreeRow) => row.cleanup ? JSON.parse(row.cleanup) as ReferenceWorktreeCleanup : null;

const TITLES: Record<Kind, string> = {
  "retained": "A released managed worktree still holds unfinished work",
  "unknown": "A managed worktree's work or owner cannot be established",
  "cleanup-failed": "Removing a managed worktree failed",
};

/** Which finding a worktree's host state is, if any. A live holder, a clean worktree or a removal under way is none. */
function kindOf({ row, cleanup, holderLive }: Inventory): Kind | null {
  // A removal whose outcome is not yet read back is unknown, never gone.
  if (cleanup) return cleanup.state === "failed" || cleanup.state === "interrupted" ? "cleanup-failed" : cleanup.state === "started" ? "unknown" : null;
  if ((row.state !== "released" && row.state !== "expired") || holderLive === true) return null;
  const facts = factsOf(row);
  if (!facts || holderLive === null || facts.owner !== "none" || facts.work === "unknown" || facts.unverifiedPaths !== 0) return "unknown";
  return facts.work === "unpreserved" ? "retained" : null;
}

/**
 * The candidate for one worktree. Its ID names only the worktree, so a
 * worktree is one finding whatever is wrong with it; its facts carry the kind
 * of problem, the exact native identity and base, the owner and work last
 * established, any removal failure and the last explicit activity, so any of
 * them changing invalidates a disposition or a reviewed removal.
 * `fresh` replaces the recorded owner and work with a just-made assessment.
 */
export function referenceWorktreeCandidate(item: Inventory, kind: Kind, fresh?: Work): Candidate {
  const { row, cleanup, holderLive } = item, facts = factsOf(row);
  const owner = fresh ? "none" : facts?.owner ?? "unassessed", work = fresh ?? facts;
  return {
    category: REFERENCE_WORKTREE_HYGIENE_CATEGORY, path: `${PATH_PREFIX}${row.id}`, evidence: "", message: TITLES[kind],
    source: { source: "hygiene", name: REFERENCE_WORKTREE_HYGIENE_CATEGORY, severity: "warning" },
    facts: {
      kind,
      identity: `${row.id}:${row.root_uuid ?? ""}:${row.source_root}:${row.principal_id}`,
      base: `${row.domain}:${row.repository}:${row.revision}:${row.base_commit ?? ""}`,
      owner: `${owner}:${row.holder ?? ""}:${holderLive === null ? "unknown" : holderLive ? "live" : "none"}`,
      work: work ? `${work.work}:${work.changedPaths ?? ""}:${work.unverifiedPaths ?? ""}:${work.digest ?? ""}` : "unassessed",
      failure: cleanup ? `${cleanup.state}:${cleanup.error ?? ""}` : "none",
      renewed: `${row.state}:${row.accessed_at}:${row.released_at ?? ""}`,
    },
  };
}

export function createReferenceWorktreeHygiene(options: { db: Database; worktrees: ReferenceWorktrees; core: () => Promise<Core>; now?: () => number; brainPath: string }) {
  const { db, worktrees } = options;
  const write = referenceWrites(db);
  const now = options.now ?? Date.now;
  const findingRow = (id: string) => db.query("SELECT * FROM reference_worktree_findings WHERE id = ?").get(id) as FindingRow | null;

  /** Current detection, through core's canonical findings. */
  async function detect(): Promise<Map<string, Detected>> {
    const core = await options.core();
    const out = new Map<string, Detected>();
    for (const item of worktrees.inventory()) {
      const kind = kindOf(item);
      if (!kind) continue;
      const [finding] = core.canonicalFindings([referenceWorktreeCandidate(item, kind)]).values();
      out.set(finding!.id, { kind, finding: finding!, item });
    }
    return out;
  }
  /**
   * The disposition state machine of the Markdown log, kept here: an unchanged
   * dismissal holds, a snooze returns when due, a changed fingerprint reopens
   * at once with a receipt naming the changed fields, and an entry no longer
   * detected is resolved. Dispositions are bookkeeping only; none is consent
   * to remove anything.
   */
  async function reconcile(): Promise<Map<string, Detected>> {
    const detected = await detect(), at = now();
    await write("hygieneReconcile", detected, at);
    return detected;
  }
  function entry(row: FindingRow): Entry {
    return { id: row.id, state: row.state, path: `${PATH_PREFIX}${row.worktree_id}`, issue: TITLES[row.kind], firstSeen: isoDay(row.first_seen), lastSeen: isoDay(row.last_seen),
      until: row.due_at === null ? null : isoDay(row.due_at), dueAt: row.due_at === null ? null : new Date(row.due_at).toISOString(),
      resolvedBy: row.resolved_by, resolvedOn: row.resolved_at === null ? null : isoDay(row.resolved_at),
      sources: [{ source: "hygiene", name: REFERENCE_WORKTREE_HYGIENE_CATEGORY, severity: "warning" }], severity: "warning", fingerprint: row.fingerprint,
      disposition: row.state === "dismissed" || row.state === "snoozed" ? { kind: row.state, on: row.disposed_at === null ? null : isoDay(row.disposed_at), reason: row.reason, fingerprint: row.disposition_fingerprint } : null,
      invalidation: row.invalidation_json ? JSON.parse(row.invalidation_json) : null };
  }
  const entries = () => (db.query("SELECT * FROM reference_worktree_findings ORDER BY id").all() as FindingRow[]).map(entry);

  /**
   * What the review card shows. Inbox Actions replicate to every usable
   * principal, so a private worktree's card carries only its opaque identity,
   * states and counts: no repository, revision, commit or path of private
   * source. The owner principal reviews it like any other finding.
   */
  function display({ kind, item }: Detected) {
    const { row, view, cleanup } = item, facts = factsOf(row), visible = view.domain === "public";
    const work = typeof facts?.changedPaths === "number" ? `${facts.changedPaths} changed path${facts.changedPaths === 1 ? "" : "s"}` : "work not established";
    const source = visible ? `${view.repository}@${view.revision} ${view.commit.slice(0, 12)}` : "private source";
    const removal = kind === "cleanup-failed"
      ? { effect: "Try removing this worktree again", explanation: "Its earlier removal did not finish. Removing it deletes the worktree and anything it still holds, after rechecking that nothing changed since this preview." }
      : { effect: "Delete this worktree and the work it retains", explanation: "Removes the worktree, its unfinished files and local commits after rechecking that nothing changed since this preview. Dismissing or snoozing keeps it." };
    return {
      title: TITLES[kind],
      excerpt: `${source} · ${work} · ${cleanup ? `removal ${cleanup.state}` : row.state}`,
      line: null, field: null,
      handlers: kind === "unknown"
        ? [{ name: "manual", kind: "manual", input: { type: "none" }, effect: "Keep it until its state can be established",
          explanation: "Its owner or work could not be established, so it is kept and stays charged. Check again later." }]
        : [{ name: REFERENCE_WORKTREE_REMOVAL_HANDLER, kind: "choice", input: { type: "none" }, ...removal }],
      worktree: { id: row.id, domain: view.domain, state: row.state, changedPaths: facts?.changedPaths ?? null, removal: cleanup?.state ?? null,
        ...(visible ? { repository: view.repository, revision: view.revision, commit: view.commit, sample: facts?.sample ?? [] } : {}) },
    };
  }
  /** The exact state a preview stands for: a removal is confirmed only against it. */
  function previewToken(fingerprint: string, row: ReferenceWorktreeRow, work: Pick<Work, "digest"> | null) {
    return sha1(`${fingerprint}\n${row.root_uuid ?? ""}\n${work?.digest ?? ""}`).slice(0, 32);
  }
  function diff({ item }: Detected) {
    const { row, view } = item, facts = factsOf(row), visible = view.domain === "public";
    const lines = [`worktree ${row.id}`, visible ? `${view.repository}@${view.revision} ${view.commit}` : "private source",
      `${facts?.changedPaths ?? "unknown"} changed paths since its starting commit`,
      ...(visible ? (facts?.sample ?? []).map(path => `  ${path}`) : [])];
    // The wire preview needs a brain-relative-shaped path; this logical one is never a brain file.
    return { path: `reference-worktree/${row.id}`, before: lines.join("\n") + "\n", after: "", changes: lines.map((line, index) => ({ before: line, after: "", line: index + 1 })) };
  }

  /**
   * Select over fresh evidence: the winner is assessed again before it is
   * shown, so a card never offers a repair its own preview would find stale.
   * A winner whose evidence changed is selected again, a bounded few times.
   */
  async function next(findingId?: string) {
    const core = await options.core();
    for (let attempt = 0; ; attempt++) {
      const detected = await reconcile();
      const findings = new Map([...detected].map(([id, value]) => [id, value.finding]));
      const result = core.selectHygieneNext(options.brainPath, findings, entries(), new Date(now()), findingId);
      if (!result.finding) return result;
      const chosen = detected.get(result.finding.id)!;
      if (attempt < 3) {
        await worktrees.reassess(chosen.item.row.id, { remove: false });
        if ((await reconcile()).get(result.finding.id)?.finding.fingerprint !== result.finding.fingerprint) continue;
      }
      return { ...result, finding: { ...result.finding, ...display(chosen) } };
    }
  }
  /**
   * One queue from two backlogs: the winner by core's ordinal selection
   * (severity, known urgency, age, identity) across both, and summed counts.
   */
  async function merge(cli: Next, host: Next): Promise<Next> {
    const core = await options.core();
    const counts = {
      eligibleRemaining: cli.counts.eligibleRemaining + host.counts.eligibleRemaining, fixed: cli.counts.fixed + host.counts.fixed,
      dismissed: cli.counts.dismissed + host.counts.dismissed, snoozed: cli.counts.snoozed + host.counts.snoozed,
      nextSnoozeDueAt: [cli.counts.nextSnoozeDueAt, host.counts.nextSnoozeDueAt].filter((at): at is string => at !== null).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
      informationalNotShown: cli.counts.informationalNotShown + host.counts.informationalNotShown,
    };
    const rank = (f: NextFinding) => [core.REVIEW_SEVERITY[f.severity ?? "unknown"] ?? core.REVIEW_SEVERITY.unknown!,
      core.REVIEW_URGENCY[core.reviewUrgency(f.urgency ?? null)]!, f.firstSeen ? Date.parse(`${f.firstSeen}T00:00:00Z`) : Infinity] as const;
    const order = (a: NextFinding, b: NextFinding) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    };
    const winners = [cli.finding, host.finding].filter((f): f is NextFinding => f !== null).sort(order);
    return { finding: winners[0] ?? null, counts };
  }

  /** The `brain hygiene` operations the review sends, answered from host state. */
  async function run(args: string[], context: ReferenceWorktreeHygieneContext = {}): Promise<unknown> {
    const [command] = args, id = args.at(-1)!, flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    if (command === "next") return next(flag("--finding"));
    if (command === "list") { await reconcile(); return { entries: entries() }; }
    if (command === "check") {
      // Done, check again: a fresh assessment, which may establish what was unknown.
      const prior = findingRow(id);
      if (prior) await worktrees.reassess(prior.worktree_id, { remove: true });
      const detected = await reconcile();
      if (detected.has(id)) return { status: "still_detected", id };
      await write("hygieneCheck", id);
      return { status: "not_detected", id };
    }
    const expected = flag("--expect-fingerprint"), stale = command === "resolve" ? "stale" : "refused";
    const current = (await reconcile()).get(id);
    if (!current) return { status: stale, id, reason: "not-detected", expectedFingerprint: expected, currentFingerprint: null };
    if (expected !== current.finding.fingerprint)
      return { status: stale, id, reason: "stale-fingerprint", expectedFingerprint: expected, currentFingerprint: current.finding.fingerprint };
    if (command === "dismiss" || command === "snooze") {
      const until = flag("--until"), dueAt = until === undefined ? null : Date.parse(until), reason = flag("--reason") ?? null;
      if (command === "snooze" && (dueAt === null || !Number.isFinite(dueAt))) return { status: "refused", id, reason: "invalid-until" };
      await write("hygieneDispose", command === "dismiss" ? "dismissed" : "snoozed", current.finding.fingerprint, JSON.stringify(current.finding.fingerprintFields), now(), dueAt, reason, id);
      return { status: command === "dismiss" ? "dismissed" : "snoozed", id, fingerprint: current.finding.fingerprint, until: until ?? null, reason, changedFiles: [] };
    }
    if (command !== "resolve") return { status: "refused", id, reason: `Managed worktree findings do not support ${command}.` };
    if (flag("--handler") !== REFERENCE_WORKTREE_REMOVAL_HANDLER || current.kind === "unknown") return { status: "refused", id, reason: "No such repair for this finding." };
    if (args.includes("--dry-run")) {
      // A fresh assessment backs the preview, and a preview never removes anything.
      await worktrees.reassess(current.item.row.id, { remove: false });
      const fresh = (await reconcile()).get(id);
      if (!fresh || fresh.finding.fingerprint !== expected) return { status: "stale", id, reason: "The worktree changed; refresh the finding." };
      return { status: "preview", id, diff: diff(fresh), previewToken: previewToken(fresh.finding.fingerprint, fresh.item.row, factsOf(fresh.item.row)) };
    }
    const token = flag("--expect-preview"), core = await options.core();
    // The worktree service checks this against a fresh assessment immediately
    // before the effect: it must still be exactly the finding and preview reviewed.
    const outcome = await worktrees.remove(current.item.row.id, { trigger: "review", premise: expected, authorize: context.authorize, expect: fresh => {
      const item = worktrees.inventory().find(value => value.row.id === fresh.row.id);
      if (!item) return "The worktree is gone.";
      const [finding] = core.canonicalFindings([referenceWorktreeCandidate(item, current.kind, fresh.work)]).values();
      if (finding!.fingerprint !== expected) return "The worktree changed since it was reviewed.";
      return previewToken(finding!.fingerprint, item.row, fresh.work) === token ? null : "The preview no longer matches the worktree.";
    } });
    if (outcome.status === "refused") { await reconcile(); return { status: "stale", id, reason: outcome.reason }; }
    // The pool's own error can name host paths; the replicated card gets a fixed reason, the receipt keeps the detail.
    if (outcome.status === "failed") { await reconcile(); return { status: "check_failed", id, reason: "The worktree could not be removed; it is kept for review.", code: "cleanup-failed" }; }
    if ((await reconcile()).has(id)) return { status: "check_failed", id, reason: "The finding is still detected after removal." };
    await write("hygieneResolve", REFERENCE_WORKTREE_REMOVAL_HANDLER, id);
    return { status: "fixed", id };
  }
  /**
   * A finding's recorded facts for the owner's private read (#2734). It never
   * reconciles, reassesses or writes, so reading changes no fingerprint,
   * `last_seen` or state. A finding that is no longer open is `gone`; one whose
   * recorded facts no longer match the card's fingerprint is `changed`; neither
   * carries any detail. The caller authorizes the reader.
   */
  async function details(findingId: string, fingerprint: string): Promise<HygieneWorktreeDetailsRead> {
    const row = findingRow(findingId);
    const item = row?.state === "open" ? worktrees.inventory().find(value => value.row.id === row.worktree_id) : undefined;
    const kind = item ? kindOf(item) : null;
    if (!row || !item || !kind) return { status: "gone" };
    const [finding] = (await options.core()).canonicalFindings([referenceWorktreeCandidate(item, kind)]).values();
    if (finding!.id !== findingId) return { status: "gone" };
    if (finding!.fingerprint !== fingerprint || row.fingerprint !== fingerprint) return { status: "changed" };
    const facts = factsOf(item.row), principal = resolvePrincipal(db, item.row.principal_id);
    return { status: "details", details: {
      // A revoked or expired principal reads as removed: its label is not shown after its access ended.
      owner: principal && isUsablePrincipal(principal, now()) ? { label: principal.label, kind: principal.kind === "agent" ? "agent" : "device" } : null,
      repository: item.row.repository || null, revision: item.row.revision || null, commit: item.row.base_commit || null,
      changedPaths: !facts || facts.work === "unknown" ? null : facts.changedPaths, sample: facts?.sample ?? [],
      unverifiedPaths: facts?.unverifiedPaths ?? null, assessedAt: facts?.assessedAt ?? null,
    } };
  }
  return {
    /** Whether a review operation names a host-owned finding. */
    owns(id: string): boolean { return id.startsWith(`${REFERENCE_WORKTREE_HYGIENE_CATEGORY}-`) && findingRow(id) !== null; },
    run, reconcile, merge, details,
  };
}
export type ReferenceWorktreeHygiene = ReturnType<typeof createReferenceWorktreeHygiene>;
