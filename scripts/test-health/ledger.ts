/**
 * The test-health ledger: an append-only record of what was audited, claimed,
 * batched and landed. It is the rotation's memory and the source of every
 * metric. It lives on its own ref (`ledgerRef` in config.json), outside the
 * main tree, because a progress log does not belong in a document
 * (docs/plans/README.md, "What does not live here") and a run must be able to
 * record itself without landing a pull request.
 *
 * Records are JSON lines under `records/<yyyy-mm>.jsonl`. Existing lines are
 * never rewritten: a writer appends to the month's file and publishes a commit
 * whose parent is the commit it read, with `--force-with-lease` as the
 * compare-and-swap. This is the technique of `GitReservationStore`
 * (scripts/integration-reservation.ts), minus the single-file state.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deferralOf, UNFINISHED_REASONS, type DeferredReason, type LensId, type LensVerdict } from "./catalog";
import type { Worksheet } from "./worksheet";
import type { FileAccounting } from "./accounting";

interface Base { v: 1; at: string; runId: string }

export interface ClaimRecord extends Base { type: "claim"; files: string[]; expiresAt: string; profile: string }
export interface ReleaseRecord extends Base { type: "release" }
export interface AuditedFile { file: string; blobBefore: string; blobAfter: string | null; lenses: Record<LensId, LensVerdict> }
export interface ClusterRecord extends Base {
  type: "cluster"; cluster: number; batchId: string | null; commit: string | null;
  package: string; worksheet: Worksheet; audits: AuditedFile[];
  /** Tests and executed cases before and after, for each file the cluster changed. */
  accounting?: FileAccounting[];
  /** A fix prepared but not proven in time, stored on the ledger ref so a later run on any machine can resume it. */
  wip?: WipPatch;
}
export interface WipPatch { path: string; sha256: string; bytes: number; files: string[] }
/** Withdraws a cluster's audits, for example when its commit was dropped from a batch. */
export interface VoidRecord extends Base { type: "void"; cluster: number; reason: string }
export interface Snapshot {
  sha: string; files: number; scenarios: number; assertions: number;
  costSeconds: number; top50CostShare: number;
  signals: Record<string, number>; openIssues: number; openIssuesNeedingRepro: number;
}
export interface RunRecord extends Base {
  type: "run"; agent: string; profile: string; mode: string; package: string | null; group?: string;
  startedAt: string; outcome: "completed" | "throttled" | "blocked" | "nothing-to-do" | "failed";
  note?: string; snapshot?: Snapshot;
}
export type BatchEvent = "opened" | "pr" | "attempt" | "dropped" | "landed" | "abandoned";
export interface BatchRecord extends Base {
  type: "batch"; event: BatchEvent; batchId: string;
  /** The batch's group: a package's own name, or the shared `small` group. A record from before groups names only `package`. */
  group?: string;
  package?: string; branch?: string; base?: string; profile?: string;
  pr?: number; commit?: string; mergeSha?: string; changedFiles?: number; reason?: string;
}
export type LedgerRecord = ClaimRecord | ReleaseRecord | ClusterRecord | VoidRecord | RunRecord | BatchRecord;

const TYPES = new Set(["claim", "release", "cluster", "void", "run", "batch"]);

/** Parses ledger text. A line of an unknown type is kept out of the state but
 * never fails the read: a newer writer may have added a record type. */
export function parseRecords(text: string, label = "ledger"): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`${label}:${index + 1}: not a JSON line`); }
    const record = value as Partial<LedgerRecord>;
    if (typeof value !== "object" || value === null || typeof record.type !== "string" || typeof record.at !== "string" || typeof record.runId !== "string") {
      throw new Error(`${label}:${index + 1}: a record needs type, at and runId`);
    }
    if (TYPES.has(record.type)) records.push(record as LedgerRecord);
  }
  return records;
}

export const monthFile = (at: string): string => `records/${at.slice(0, 7)}.jsonl`;
const serialize = (records: readonly LedgerRecord[]): string => records.map(record => JSON.stringify(record) + "\n").join("");
const byTime = (a: LedgerRecord, b: LedgerRecord): number => a.at < b.at ? -1 : a.at > b.at ? 1 : 0;

export interface LedgerStore {
  read(): LedgerRecord[];
  /** Appends records, and optionally replaces whole files such as the report (`report.md`) or a stored patch (`wip/<name>`). */
  append(records: readonly LedgerRecord[], files?: Record<string, string>): void;
  /** A file stored next to the records, or null. */
  readFile(name: string): string | null;
}

/** Stored file names are a root file or one directory deep, and never inside `records`. */
function checkFileName(name: string): string[] {
  const parts = name.split("/");
  if (parts.length > 2 || parts.some(part => !part || part === "." || part === "..") || parts[0] === "records") {
    throw new Error(`Ledger file names are a root file or one directory deep, outside records: ${name}`);
  }
  return parts;
}

/** A plain directory with the ledger's layout: dry runs, tests and offline use. */
export class DirLedgerStore implements LedgerStore {
  constructor(readonly dir: string) {}
  read(): LedgerRecord[] {
    const records = join(this.dir, "records");
    if (!existsSync(records)) return [];
    return readdirSync(records).filter(name => name.endsWith(".jsonl")).sort()
      .flatMap(name => parseRecords(readFileSync(join(records, name), "utf8"), name)).sort(byTime);
  }
  append(records: readonly LedgerRecord[], files: Record<string, string> = {}): void {
    mkdirSync(join(this.dir, "records"), { recursive: true });
    for (const record of records) {
      const path = join(this.dir, monthFile(record.at));
      writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + serialize([record]));
    }
    for (const [name, content] of Object.entries(files)) {
      const parts = checkFileName(name);
      if (parts.length === 2) mkdirSync(join(this.dir, parts[0]!), { recursive: true });
      writeFileSync(join(this.dir, name), content);
    }
  }
  readFile(name: string): string | null {
    checkFileName(name);
    const path = join(this.dir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
}

interface TreeEntry { mode: string; type: string; oid: string }

/** The ledger on a remote ref. Reads fetch the commit; nothing touches the
 * working tree, the index or a local branch. */
export class GitLedgerStore implements LedgerStore {
  constructor(readonly root: string, readonly remote: string, readonly ref: string, readonly attempts = 6) {}

  private git(args: string[], input?: string): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: this.root, stdout: "pipe", stderr: "pipe",
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), env: { ...process.env,
        GIT_AUTHOR_NAME: "brain-kit test health", GIT_AUTHOR_EMAIL: "test-health@example.invalid",
        GIT_COMMITTER_NAME: "brain-kit test health", GIT_COMMITTER_EMAIL: "test-health@example.invalid" } });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${new TextDecoder().decode(result.stderr).trim()}`);
    return new TextDecoder().decode(result.stdout);
  }

  private remoteOid(): string | null {
    const output = this.git(["ls-remote", "--refs", this.remote, this.ref]).trim();
    if (!output) return null;
    const [oid, ref, ...extra] = output.split(/\s+/);
    if (!/^[a-f0-9]{40,64}$/.test(oid ?? "") || ref !== this.ref || extra.length) throw new Error("Invalid remote test-health ref");
    return oid!;
  }

  private tree(oid: string): Map<string, TreeEntry> {
    const entries = new Map<string, TreeEntry>();
    for (const line of this.git(["ls-tree", oid]).split("\n").filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line);
      if (!match) throw new Error("Unreadable test-health tree");
      entries.set(match[4]!, { mode: match[1]!, type: match[2]!, oid: match[3]! });
    }
    return entries;
  }

  private snapshot(): { oid: string | null; root: Map<string, TreeEntry>; months: Map<string, TreeEntry> } {
    const oid = this.remoteOid();
    if (!oid) return { oid, root: new Map(), months: new Map() };
    this.git(["fetch", "--no-tags", "--quiet", this.remote, oid]);
    const root = this.tree(oid);
    const records = root.get("records");
    return { oid, root, months: records ? this.tree(records.oid) : new Map() };
  }

  read(): LedgerRecord[] {
    const { months } = this.snapshot();
    return [...months.entries()].filter(([name]) => name.endsWith(".jsonl")).sort(([a], [b]) => a < b ? -1 : 1)
      .flatMap(([name, entry]) => parseRecords(this.git(["cat-file", "blob", entry.oid]), name)).sort(byTime);
  }

  append(records: readonly LedgerRecord[], files: Record<string, string> = {}): void {
    if (!records.length && !Object.keys(files).length) return;
    const mktree = (entries: Map<string, TreeEntry>) => this.git(["mktree"],
      [...entries.entries()].map(([name, entry]) => `${entry.mode} ${entry.type} ${entry.oid}\t${name}\n`).join("")).trim();
    const blob = (content: string) => this.git(["hash-object", "-w", "--stdin"], content).trim();
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const { oid, root, months } = this.snapshot();
      const byMonth = new Map<string, LedgerRecord[]>();
      for (const record of records) {
        const name = monthFile(record.at).slice("records/".length);
        byMonth.set(name, [...(byMonth.get(name) ?? []), record]);
      }
      for (const [name, added] of byMonth) {
        const existing = months.get(name);
        const before = existing ? this.git(["cat-file", "blob", existing.oid]) : "";
        months.set(name, { mode: "100644", type: "blob", oid: blob(before + serialize(added)) });
      }
      if (months.size) root.set("records", { mode: "040000", type: "tree", oid: mktree(months) });
      const subtrees = new Map<string, Map<string, TreeEntry>>();
      for (const [name, content] of Object.entries(files)) {
        const parts = checkFileName(name);
        if (parts.length === 1) { root.set(name, { mode: "100644", type: "blob", oid: blob(content) }); continue; }
        const [dir, leaf] = parts as [string, string];
        if (!subtrees.has(dir)) {
          const existing = root.get(dir);
          subtrees.set(dir, existing?.type === "tree" ? this.tree(existing.oid) : new Map());
        }
        subtrees.get(dir)!.set(leaf, { mode: "100644", type: "blob", oid: blob(content) });
      }
      for (const [dir, entries] of subtrees) root.set(dir, { mode: "040000", type: "tree", oid: mktree(entries) });
      const message = records.length ? `test-health: ${[...new Set(records.map(record => record.type))].join(", ")}` : "test-health: report";
      const commit = this.git(["commit-tree", mktree(root), ...(oid ? ["-p", oid] : []), "-m", message]).trim();
      try {
        this.git(["push", "--porcelain", "--quiet", `--force-with-lease=${this.ref}:${oid ?? ""}`, this.remote, `${commit}:${this.ref}`]);
        return;
      } catch (error) {
        // Another writer published first: read again and append to its commit.
        if (this.remoteOid() === oid) throw error;
      }
    }
    throw new Error(`The test-health ledger moved ${this.attempts} times in a row; nothing was recorded`);
  }

  readFile(name: string): string | null {
    checkFileName(name);
    const oid = this.remoteOid();
    if (!oid) return null;
    this.git(["fetch", "--no-tags", "--quiet", this.remote, oid]);
    try { return this.git(["cat-file", "blob", `${oid}:${name}`]); } catch { return null; }
  }
}

/** A deferred finding as a later run needs it, with its reason resolved. */
export interface DeferredFinding { id: string; lens: string; smell: string; action: string; note: string; deferredFor: DeferredReason }
export interface FileAuditState {
  at: string; runId: string; cluster: number; blobBefore: string; blobAfter: string | null; lenses: Record<LensId, LensVerdict>;
  /** This audit's deferred findings on the file itself; absent on states built by hand. */
  deferred?: DeferredFinding[];
  /** The ledger path of the patch this audit prepared for the file, when it stored one. */
  wip?: string;
}
export interface BatchState {
  /** A package's own name, or `small`. A batch opened before groups reads as its package's group. */
  batchId: string; group: string; branch: string; base: string; profile: string; openedAt: string;
  status: "open" | "landed" | "abandoned"; pr: number | null; attempts: number;
  clusters: Array<{ runId: string; cluster: number; commit: string | null; files: string[] }>;
  dropped: string[]; closedAt: string | null;
}
export interface LedgerState {
  /** The latest audit of each file that has not been withdrawn. */
  audits: Map<string, FileAuditState>;
  /** Files under a claim that is neither released nor expired, by claiming run. */
  claims: Map<string, string>;
  batches: Map<string, BatchState>;
  runs: RunRecord[];
  clusters: ClusterRecord[];
  /** Clusters whose audits were withdrawn; the batch gate checks their files are back at the base. */
  voided: ClusterRecord[];
}

export function ledgerState(records: readonly LedgerRecord[], now: Date): LedgerState {
  const ordered = [...records].sort(byTime);
  const voided = new Set(ordered.filter((r): r is VoidRecord => r.type === "void").map(r => `${r.runId}\n${r.cluster}`));
  const released = new Set(ordered.filter(r => r.type === "release").map(r => r.runId));
  const state: LedgerState = { audits: new Map(), claims: new Map(), batches: new Map(), runs: [], clusters: [], voided: [] };
  const finished = new Set(ordered.filter(r => r.type === "run").map(r => r.runId));
  for (const record of ordered) {
    if (record.type === "run") state.runs.push(record);
    else if (record.type === "claim") {
      if (released.has(record.runId) || finished.has(record.runId) || Date.parse(record.expiresAt) <= now.getTime()) continue;
      for (const file of record.files) state.claims.set(file, record.runId);
    } else if (record.type === "cluster") {
      if (voided.has(`${record.runId}\n${record.cluster}`)) { state.voided.push(record); continue; }
      state.clusters.push(record);
      for (const audit of record.audits) {
        const deferred = (record.worksheet?.findings ?? []).filter(finding => finding.status === "deferred" && finding.file === audit.file)
          .map(finding => ({ id: finding.id, lens: finding.lens, smell: finding.smell, action: finding.action, note: finding.note, deferredFor: deferralOf(finding) }));
        state.audits.set(audit.file, { at: record.at, runId: record.runId, cluster: record.cluster,
          blobBefore: audit.blobBefore, blobAfter: audit.blobAfter, lenses: audit.lenses, deferred,
          // A prepared fix may change only a helper: it belongs to the files whose work it resumes as well as to those it touches.
          ...(record.wip && (record.wip.files.includes(audit.file) || deferred.some(finding => UNFINISHED_REASONS.includes(finding.deferredFor))) ? { wip: record.wip.path } : {}) });
      }
      if (record.batchId) {
        state.batches.get(record.batchId)?.clusters.push({ runId: record.runId, cluster: record.cluster,
          commit: record.commit, files: record.audits.map(audit => audit.file) });
      }
    } else if (record.type === "batch") {
      const batch = state.batches.get(record.batchId);
      if (record.event === "opened") {
        const group = record.group ?? record.package;
        if (batch || !group || !record.branch || !record.base) continue;
        state.batches.set(record.batchId, { batchId: record.batchId, group, branch: record.branch,
          base: record.base, profile: record.profile ?? "cron", openedAt: record.at, status: "open", pr: null,
          attempts: 0, clusters: [], dropped: [], closedAt: null });
      } else if (batch) {
        if (record.event === "pr" && record.pr) batch.pr = record.pr;
        if (record.event === "attempt") batch.attempts++;
        if (record.event === "dropped" && record.commit) batch.dropped.push(record.commit);
        if (record.event === "landed" || record.event === "abandoned") { batch.status = record.event; batch.closedAt = record.at; }
      }
    }
  }
  // A dropped commit takes its cluster out of the batch as well as out of the audits.
  for (const batch of state.batches.values()) {
    batch.clusters = batch.clusters.filter(cluster => !voided.has(`${cluster.runId}\n${cluster.cluster}`));
  }
  return state;
}

/** Audits whose batch was abandoned never reached the base, so they do not count. */
export function landedOrPending(state: LedgerState): Map<string, FileAuditState> {
  const abandoned = new Set<string>();
  for (const batch of state.batches.values()) {
    if (batch.status === "abandoned") for (const cluster of batch.clusters) abandoned.add(`${cluster.runId}\n${cluster.cluster}`);
  }
  return new Map([...state.audits].filter(([, audit]) => !abandoned.has(`${audit.runId}\n${audit.cluster}`)));
}
