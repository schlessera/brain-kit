/**
 * The durable CI evidence archive on the measurement data ref
 * (docs/decisions/ci-evidence.md). Measurement only: never an input to proof,
 * selection or merging. Downloaded artifacts are parsed as data; nothing in
 * them is executed, and only exact normalized filenames are extracted.
 */
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText } from "./check-leakage";
import { mergeLeaseObservations } from "./ci-coordination";
import { EVENT_REF, GitEventStore } from "./ci-event-publish";
import { TimingBudgetStop } from "./ci-timing-api";
import { validateWorkEvent } from "./ci-throughput";
import { deduplicate, type TimingSnapshot } from "./ci-timings";

export const ARCHIVE_REF = EVENT_REF;
export const ARCHIVE_KINDS = ["run", "pull", "coordinator", "event", "collection", "enrichment", "reservations", "red-main", "source"] as const;
export type ArchiveKind = typeof ARCHIVE_KINDS[number];
/** Integer schema versions each kind may carry (docs/process/ci-evidence.md). Readers refuse any other. */
export const ARCHIVE_VERSIONS: Record<ArchiveKind, readonly number[]> = {
  run: [1, 2], pull: [1], coordinator: [1], event: [1], collection: [1], enrichment: [1], reservations: [1], "red-main": [1], source: [1],
};
/** GitHub refuses a blob over 100 MB; stop short of it rather than fail mid-push. */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;
const MONTH = /^\d{4}-\d{2}$/;
const ARCHIVE_PATH = /^(\d{4}-\d{2})\/(?:([a-z-]+)\.json|(run)\/(\d{2})\.json)$/;

type Row = Record<string, any>;
export interface Refusal { kind: string; key: string; reason: string }
/** One artifact walked into the archive: its identity, digest and what it contributed or had refused. */
export interface ArchiveSource {
  version: 1; repository: string; artifact: number; run: number; createdAt: string; sha256: string; records: number; refused: number;
}

const stamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The normalized kind a file name carries, or null for summaries and other non-records. */
export function kindOfFile(name: string): ArchiveKind | null {
  if (/^run-\d+-attempt-\d+\.json$/.test(name)) return "run";
  if (/^pull-\d+\.json$/.test(name)) return "pull";
  if (/^coordinator-\d+-attempt-\d+\.json$/.test(name)) return "coordinator";
  if (/^event-[\w-]+\.json$/.test(name)) return "event";
  return ({ "collection.json": "collection", "enrichment.json": "enrichment", "reservations.json": "reservations", "red-main.json": "red-main" } as const)[name] ?? null;
}

/** Each kind's partition timestamp, identity, and the repeated list whose identical entries are stored once per month. */
const SPECS: Record<ArchiveKind, { at(r: Row): unknown; key(r: Row): string; list?: "expected" | "leases" }> = {
  run: { at: r => r.run?.createdAt, key: r => `${r.run.id}/${r.run.attempt}` },
  pull: { at: r => r.createdAt, key: r => String(r.number) },
  coordinator: { at: r => r.createdAt, key: r => `${r.run}/${r.attempt}` },
  event: { at: r => r.at, key: r => r.id },
  collection: { at: r => r.collectedAt, key: r => r.id, list: "expected" },
  enrichment: { at: r => r.collectedAt, key: r => digest(r) },
  reservations: { at: r => r.collectedAt, key: r => `${r.collectedAt}/${r.sourceHead}/${r.error ?? ""}`, list: "leases" },
  "red-main": { at: r => r.collectedAt, key: r => digest(r) },
  source: { at: r => r.createdAt, key: r => String(r.artifact) },
};
const dayOf = (kind: ArchiveKind, record: Row) => new Date(SPECS[kind].at(record) as string).toISOString().slice(0, 10);
const partitionOf = (kind: ArchiveKind, record: Row) => kind === "run"
  ? `${monthOf(kind, record)}/run/${dayOf(kind, record).slice(8)}.json` : `${monthOf(kind, record)}/${kind}.json`;
export const monthOf = (kind: ArchiveKind, record: Row) => new Date(SPECS[kind].at(record) as string).toISOString().slice(0, 7);

/** Schema, identity and leakage screen for one record. Returns why it is refused, or null. */
export function screenRecord(kind: ArchiveKind, value: unknown, repository: string): string | null {
  const r = value as Row;
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not a record";
  if (!ARCHIVE_VERSIONS[kind].includes(r.version)) return `unknown ${kind} version ${JSON.stringify(r.version)}`;
  if (r.repository !== repository) return "repository differs";
  try {
    if (!stamp(SPECS[kind].at(r))) return "invalid timestamp";
    if (kind === "run") deduplicate([r as TimingSnapshot]);
    else if (kind === "event") validateWorkEvent(r);
    else if (kind === "pull" && (!positive(r.number) || !stamp(r.collectedAt) || !Array.isArray(r.problems))) return "invalid pull identity";
    else if (kind === "coordinator" && (!positive(r.run) || !positive(r.attempt) || !stamp(r.collectedAt) ||
      !(r.cancelled === null || Array.isArray(r.cancelled) && r.cancelled.every(positive)))) return "invalid coordinator identity";
    else if (kind === "collection" && (typeof r.id !== "string" || !/^[\w-]{1,100}$/.test(r.id) || !Array.isArray(r.expected) ||
      !r.expected.every((e: Row) => positive(e?.run) && positive(e.attempts) && Object.keys(e).length === 2))) return "invalid collection manifest";
    else if (kind === "reservations") { if (!Array.isArray(r.leases)) return "invalid reservation archive"; mergeLeaseObservations(r.leases); }
    else if (kind === "red-main" && (!Array.isArray(r.incidents) || !Array.isArray(r.flakes))) return "invalid red-main archive";
    else if (kind === "enrichment" && (!Array.isArray(r.expectedPRs) || !Array.isArray(r.errors))) return "invalid enrichment manifest";
    else if (kind === "source" && (!positive(r.artifact) || !positive(r.run) || !/^[a-f0-9]{64}$/.test(r.sha256))) return "invalid source identity";
  } catch (error) { return String(error instanceof Error ? error.message : error); }
  // Each record becomes one archive line; the screen is the tree's own leakage gate.
  if (scanText(kind, JSON.stringify(r)).length) return "refused by leakage screen";
  return null;
}

/** The report's own join rules, applied pairwise. Returns the retained record, or throws on a contradiction. */
function mergeTwo(kind: ArchiveKind, old: Row, row: Row): Row {
  const same = JSON.stringify(old) === JSON.stringify(row);
  if (same) return old;
  // Later observations win. A seeded snapshot keeps its collection time when a
  // later hour attributes its PR, so at equal times the attributed copy is later.
  const attributed = (r: Row) => kind === "run" ? r.run.prs.length : 0;
  const ordered = [old, row].sort((a, b) => (Date.parse(a.collectedAt ?? "") || 0) - (Date.parse(b.collectedAt ?? "") || 0) ||
    attributed(a) - attributed(b) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  switch (kind) {
    // Richer receipts and exact squash attribution survive (`deduplicate`).
    case "run": return deduplicate(ordered as TimingSnapshot[])[0]!;
    // The newer PR observation wins, as in the report.
    case "pull": return ordered[1]!;
    case "coordinator": {
      const known = ordered.filter(r => r.cancelled !== null);
      if (known.length === 2 && JSON.stringify(known[0]!.cancelled) !== JSON.stringify(known[1]!.cancelled)) throw new Error("conflicting coordinator observation");
      return known.at(-1) ?? ordered[1]!;
    }
    case "collection": case "reservations": {
      const list = SPECS[kind].list!, strip = (r: Row) => JSON.stringify({ ...r, [list]: undefined });
      if (strip(old) !== strip(row)) throw new Error(`conflicting ${kind} identity`);
      const entries = new Map([...old[list], ...row[list]].map((e: unknown) => [JSON.stringify(e), e]));
      return { ...old, [list]: [...entries.values()] };
    }
    default: throw new Error(`conflicting immutable ${kind} identity`);
  }
}

/** One archive partition and kind: identity → record. */
export class MonthFile {
  readonly rows = new Map<string, Row>();
  constructor(readonly kind: ArchiveKind) {}
  /** Adds one screened record; a contradiction refuses the newcomer and keeps the archived record. */
  add(row: Row): string | null {
    const key = SPECS[this.kind].key(row), old = this.rows.get(key);
    try { this.rows.set(key, old ? mergeTwo(this.kind, old, row) : row); return null; }
    catch (error) { return String(error instanceof Error ? error.message : error); }
  }
  /**
   * One record per line, ordered by timestamp then identity. Hourly copies of
   * collection manifests and reservation histories repeat a two-day window, so
   * an identical expected attempt or lease observation is stored only in the
   * month's earliest record carrying it. The report's joins are idempotent over
   * identical entries, so this loses nothing they read.
   */
  serialize(): string {
    const spec = SPECS[this.kind], seen = new Set<string>();
    const rows = [...this.rows.entries()].sort(([ka, a], [kb, b]) => Date.parse(spec.at(a) as string) - Date.parse(spec.at(b) as string) || (ka < kb ? -1 : ka > kb ? 1 : 0))
      .map(([, row]) => {
        if (!spec.list) return row;
        const kept = (row[spec.list] as unknown[]).filter(entry => { const k = JSON.stringify(entry); if (seen.has(k)) return false; seen.add(k); return true; });
        return { ...row, [spec.list]: kept };
      });
    return "[\n" + rows.map(row => JSON.stringify(row)).join(",\n") + "\n]\n";
  }
}

/** Parses a monthly or daily archive file, refusing unknown kinds, versions or repositories. */
export function parseMonthFile(path: string, text: string, repository: string): { kind: ArchiveKind; month: string; rows: Row[] } {
  const match = ARCHIVE_PATH.exec(path);
  if (!match || !(ARCHIVE_KINDS as readonly string[]).includes((match[2] ?? match[3])!)) throw new Error(`Unknown archive file ${path}`);
  const kind = (match[2] ?? match[3]) as ArchiveKind, rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(`Invalid archive file ${path}`);
  for (const row of rows) {
    if (!ARCHIVE_VERSIONS[kind].includes(row?.version)) throw new Error(`Unknown ${kind} version ${JSON.stringify(row?.version)} in ${path}`);
    if (row.repository !== repository) throw new Error(`Archive ${path} belongs to another repository`);
    if (match[4] && dayOf(kind, row) !== `${match[1]}-${match[4]}`) throw new Error(`Record outside its day partition in ${path}`);
    if (monthOf(kind, row) !== match[1]) throw new Error(`Record outside its month partition in ${path}`);
  }
  return { kind, month: match[1]!, rows };
}

/** Git plumbing against the data ref with an isolated index; the caller's checkout never moves. */
export class GitArchiveStore extends GitEventStore {
  /** Every archive path at `oid`, with its blob identity. */
  async files(oid: string | null): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!oid) return result;
    for (const line of (await this.git(["ls-tree", "-r", "--full-tree", oid])).split("\n").filter(Boolean)) {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      if (!match) throw new Error("Invalid archive tree entry");
      result.set(match[2]!, match[1]!);
    }
    return result;
  }
  blob(oid: string): Promise<string> { return this.git(["cat-file", "blob", oid]).then(text => text + "\n"); }
  /** Commits changed files onto `parent` and pushes with exact lease; null when another writer moved the ref first. */
  async commit(parent: string | null, changes: Map<string, string>, message: string): Promise<string | null> {
    const temporary = await mkdtemp(join(tmpdir(), "brain-archive-index-")), index = join(temporary, "index");
    try {
      await this.git(["read-tree", ...(parent ? [parent] : ["--empty"])], undefined, index);
      for (const [path, content] of changes) {
        const blob = await this.git(["hash-object", "-w", "--stdin"], content);
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, index);
      }
      const tree = await this.git(["write-tree"], undefined, index);
      const head = await this.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
      try {
        await this.git(["push", "--porcelain", `--force-with-lease=${ARCHIVE_REF}:${parent ?? ""}`, this.remote, `${head}:${ARCHIVE_REF}`]);
        return head;
      } catch (error) {
        if (await this.remoteOid() !== parent) return null;
        throw error;
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

/** Screened records from one input, tagged with the kind they carry. */
export interface Batch { records: { kind: ArchiveKind; row: Row }[]; refused: Refusal[]; sources: ArchiveSource[] }

/**
 * Merges a batch into the archive and publishes it. Each attempt reads the
 * remote head, merges into the partition files it touches, and pushes with an exact
 * lease on that head; a lost race re-reads and re-merges, so a competing writer
 * is never overwritten. A source another writer archived meanwhile is skipped.
 * An unchanged tree makes no commit.
 */
export async function publishBatch(store: GitArchiveStore, repository: string, batch: Batch, attempts = 5):
  Promise<{ head: string | null; committed: boolean; files: string[]; refused: Refusal[]; sources: number }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const parent = await store.read(), tree = await store.files(parent), refused = [...batch.refused];
    const archived = await archivedSources(store, parent, repository);
    const skip = new Set(batch.sources.filter(s => archived.has(s.artifact)).map(s => s.artifact));
    const legacyRuns = new Map<string, MonthFile>();
    const months = new Map<string, MonthFile>(), original = new Map<string, string>();
    const file = async (kind: ArchiveKind, path: string) => {
      let target = months.get(path);
      if (!target) {
        target = new MonthFile(kind); months.set(path, target);
        const blob = tree.get(path);
        if (blob) {
          const text = await store.blob(blob);
          original.set(path, text);
          for (const row of parseMonthFile(path, text, repository).rows) target.add(row);
        }
      }
      return target;
    };
    for (const { kind, row } of batch.records) {
      if (row.__source !== undefined && skip.has(row.__source)) continue;
      const { __source, ...clean } = row;
      const target = await file(kind, partitionOf(kind, clean));
      let incoming = clean;
      if (kind === "run") {
        const legacyPath = `${monthOf(kind, clean)}/run.json`, legacyBlob = tree.get(legacyPath);
        if (legacyBlob) {
          let legacy = legacyRuns.get(legacyPath);
          if (!legacy) {
            legacy = new MonthFile("run");
            for (const row of parseMonthFile(legacyPath, await store.blob(legacyBlob), repository).rows) {
              const conflict = legacy.add(row);
              if (conflict) throw new Error(conflict);
            }
            // Cache outside the output map: legacy files remain byte-identical.
            legacyRuns.set(legacyPath, legacy);
          }
          const old = legacy.rows.get(SPECS.run.key(clean));
          if (old) {
            try { incoming = mergeTwo("run", old, clean); }
            catch (error) {
              refused.push({ kind, key: SPECS.run.key(clean), reason: String(error instanceof Error ? error.message : error) });
              continue;
            }
          }
        }
      }
      const reason = target.add(incoming);
      if (reason) refused.push({ kind, key: SPECS[kind].key(clean), reason });
    }
    for (const source of batch.sources) if (!skip.has(source.artifact)) (await file("source", partitionOf("source", source))).add(source);
    // Coordination events published under events/ (#2954) are compaction inputs too; they stay where they are.
    for (const [path, blob] of tree) if (/^events\/[\w-]+\.json$/.test(path)) {
      const row = JSON.parse(await store.blob(blob)), reason = screenRecord("event", row, repository);
      if (reason) { refused.push({ kind: "event", key: path, reason }); continue; }
      const conflict = (await file("event", partitionOf("event", row))).add(row);
      if (conflict) refused.push({ kind: "event", key: row.id, reason: conflict });
    }
    const changes = new Map<string, string>();
    for (const [path, target] of months) {
      if (!target.rows.size) continue;
      const text = target.serialize();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`Archive file ${path} would exceed ${MAX_FILE_BYTES} bytes; nothing was published`);
      if (text !== original.get(path)) changes.set(path, text);
    }
    if (!changes.size) return { head: parent, committed: false, files: [], refused, sources: batch.sources.length - skip.size };
    const head = await store.commit(parent, changes, `ci: archive CI evidence (${batch.sources.length - skip.size} sources)`);
    if (head) return { head, committed: true, files: [...changes.keys()].sort(), refused, sources: batch.sources.length - skip.size };
  }
  throw new Error(`Archive publication contention exceeded ${attempts} attempts; inputs retained, retry`);
}

/** Screens one decoded input into a batch. */
function screenInto(batch: Batch, kind: ArchiveKind, row: unknown, repository: string, key: string, source?: number): boolean {
  const reason = screenRecord(kind, row, repository);
  if (reason) { batch.refused.push({ kind, key, reason }); return false; }
  batch.records.push({ kind, row: source === undefined ? row as Row : { ...(row as Row), __source: source } });
  return true;
}

/** Reads a local directory of normalized files, recursively, such as an explicit backfill collection. */
export async function directoryBatch(dir: string, repository: string): Promise<Batch> {
  const batch: Batch = { records: [], refused: [], sources: [] };
  const walk = async (path: string, relative: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(child, name); continue; }
      const kind = kindOfFile(entry.name);
      if (!kind || !entry.isFile()) continue;
      let row: unknown;
      try { row = await Bun.file(child).json(); } catch { batch.refused.push({ kind, key: name, reason: "invalid JSON" }); continue; }
      screenInto(batch, kind, row, repository, name);
    }
  };
  await walk(dir, "");
  return batch;
}

export interface ArchiveAPI { json(path: string): Promise<any>; bytes(path: string): Promise<Uint8Array> }
export interface RetainedArtifact { artifact: number; run: number; createdAt: string }

/**
 * Every retained `ci-timings` artifact uploaded by the trusted scheduled or
 * dispatched collector on the default branch, oldest first. An artifact of the
 * same name from any other workflow, event, branch or fork is not evidence.
 */
export async function retainedArtifacts(api: ArchiveAPI, repository: string, branch: string): Promise<RetainedArtifact[]> {
  const listed: { artifact: number; run: number; createdAt: string }[] = [];
  for (let page = 1; ; page++) {
    const listing = await api.json(`actions/artifacts?name=ci-timings&per_page=100&page=${page}`);
    if (!Array.isArray(listing?.artifacts)) throw new Error("Invalid artifact inventory");
    for (const a of listing.artifacts) if (a?.name === "ci-timings" && !a.expired && positive(a.id) && positive(a.workflow_run?.id) && stamp(a.created_at))
      listed.push({ artifact: a.id, run: a.workflow_run.id, createdAt: new Date(a.created_at).toISOString() });
    if (listing.artifacts.length < 100) break;
  }
  if (!listed.length) return [];
  // A branch filter caps run listings at 1,000 results, so page unfiltered,
  // newest first, until the oldest listed artifact's run is behind us.
  const oldest = Math.min(...listed.map(a => Date.parse(a.createdAt))) - 3600000, trusted = new Set<number>();
  for (let page = 1; ; page++) {
    const runs = await api.json(`actions/workflows/ci-timings.yml/runs?per_page=100&page=${page}`);
    if (!Array.isArray(runs?.workflow_runs)) throw new Error("Invalid collector run inventory");
    for (const run of runs.workflow_runs) if (positive(run?.id) && run.path === ".github/workflows/ci-timings.yml" && run.head_branch === branch &&
      ["schedule", "workflow_dispatch"].includes(run.event) && run.head_repository?.full_name === repository) trusted.add(run.id);
    if (runs.workflow_runs.length < 100 || runs.workflow_runs.every((run: Row) => Date.parse(run?.created_at) < oldest)) break;
  }
  return listed.filter(a => trusted.has(a.run)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.artifact - b.artifact);
}

const ARTIFACT_ENTRY = /^(?:run-\d+-attempt-\d+|pull-\d+|coordinator-\d+-attempt-\d+|event-[\w-]+|collection|enrichment|reservations|red-main)\.json$|^collections\/[\w-]{1,100}\/collection\.json$/;

/** Downloads one artifact and screens its normalized records. Only exact record paths are extracted. */
export async function artifactBatch(api: ArchiveAPI, repository: string, artifact: RetainedArtifact, batch: Batch): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "brain-archive-artifact-"));
  try {
    const bytes = await api.bytes(`actions/artifacts/${artifact.artifact}/zip`), zip = join(temp, "artifact.zip"), out = join(temp, "files");
    await Bun.write(zip, bytes);
    const unzip = async (args: string[]) => {
      const child = Bun.spawn(["unzip", ...args], { stdout: "pipe", stderr: "pipe", timeout: 120000 });
      const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Artifact ${artifact.artifact} is not a readable archive`);
      return text;
    };
    const names = (await unzip(["-Z1", zip])).split("\n").filter(name => ARTIFACT_ENTRY.test(name));
    if (names.length > 50000 || new Set(names).size !== names.length) throw new Error(`Artifact ${artifact.artifact} has an invalid inventory`);
    const before = batch.records.length, refusedBefore = batch.refused.length;
    if (names.length) await unzip(["-q", "-o", zip, ...names, "-d", out]);
    for (const name of names) {
      const path = join(out, name), kind = kindOfFile(name.split("/").at(-1)!)!;
      if (!(await lstat(path)).isFile()) { batch.refused.push({ kind, key: `${artifact.artifact}:${name}`, reason: "not a file" }); continue; }
      let row: unknown;
      try { row = await Bun.file(path).json(); } catch { batch.refused.push({ kind, key: `${artifact.artifact}:${name}`, reason: "invalid JSON" }); continue; }
      screenInto(batch, kind, row, repository, `${artifact.artifact}:${name}`, artifact.artifact);
    }
    batch.sources.push({ version: 1, repository, artifact: artifact.artifact, run: artifact.run, createdAt: artifact.createdAt,
      sha256: createHash("sha256").update(bytes).digest("hex"), records: batch.records.length - before, refused: batch.refused.length - refusedBefore });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export interface CompactResult {
  head: string | null; commits: number; sources: number; pending: number; files: string[]; refused: Refusal[]; stopped: string | null;
}

/**
 * Walks every retained artifact the archive does not yet hold, oldest first,
 * committing every `batchSize` sources so a budget stop or timeout keeps the
 * progress made. Repeating it after everything is archived downloads nothing
 * and commits nothing.
 */
export async function compactArtifacts(options: { store: GitArchiveStore; api: ArchiveAPI; repository: string; branch: string; batchSize?: number }): Promise<CompactResult> {
  const { store, api, repository, branch } = options, batchSize = options.batchSize ?? 50;
  const result: CompactResult = { head: null, commits: 0, sources: 0, pending: 0, files: [], refused: [], stopped: null };
  const stop = (error: unknown) => { if (!(error instanceof TimingBudgetStop)) throw error; result.stopped = error.message; };
  let pending: RetainedArtifact[] = [];
  try {
    const retained = await retainedArtifacts(api, repository, branch);
    result.head = await store.read();
    const archived = await archivedSources(store, result.head, repository);
    pending = retained.filter(a => !archived.has(a.artifact));
  } catch (error) { stop(error); }
  const files = new Set<string>();
  let done = 0;
  while (done < pending.length && !result.stopped) {
    const batch: Batch = { records: [], refused: [], sources: [] };
    for (const artifact of pending.slice(done, done + batchSize)) {
      try { await artifactBatch(api, repository, artifact, batch); }
      catch (error) {
        if (error instanceof TimingBudgetStop) { stop(error); break; }
        // An unreadable artifact is a coverage gap for the report, not a reason to drop the rest.
        result.refused.push({ kind: "source", key: String(artifact.artifact), reason: String(error instanceof Error ? error.message : error) });
      }
      done++;
    }
    if (!batch.sources.length) continue;
    const published = await publishBatch(store, repository, batch);
    result.head = published.head; result.sources += published.sources; result.refused.push(...published.refused);
    if (published.committed) result.commits++;
    for (const path of published.files) files.add(path);
  }
  result.pending = pending.length - done;
  result.files = [...files].sort();
  return result;
}

async function archivedSources(store: GitArchiveStore, head: string | null, repository: string): Promise<Set<number>> {
  const archived = new Set<number>();
  for (const [path, blob] of await store.files(head)) if (/^\d{4}-\d{2}\/source\.json$/.test(path))
    for (const row of parseMonthFile(path, await store.blob(blob), repository).rows) archived.add(row.artifact);
  return archived;
}

/** Loads the archive at the remote data ref for reporting. `months` limits the partitions read. */
export async function readArchive(store: GitArchiveStore, repository: string, months?: (month: string) => boolean):
  Promise<{ head: string | null; rows: Record<ArchiveKind, Row[]> }> {
  const head = await store.read(), rows = Object.fromEntries(ARCHIVE_KINDS.map(k => [k, [] as Row[]])) as Record<ArchiveKind, Row[]>;
  for (const [path, blob] of await store.files(head)) {
    if (path.startsWith("events/")) {
      const row = validateWorkEvent(JSON.parse(await store.blob(blob)));
      if (row.repository !== repository) throw new Error("Archived event belongs to another repository");
      if (!months || months(monthOf("event", row))) rows.event.push(row);
      continue;
    }
    const month = path.slice(0, 7);
    if (!MONTH.test(month)) throw new Error(`Unknown archive file ${path}`);
    if (months && !months(month)) continue;
    const parsed = parseMonthFile(path, await store.blob(blob), repository);
    rows[parsed.kind].push(...parsed.rows);
  }
  // Both layouts may contain an attempt. Apply the writer's deterministic join
  // before any consumer counts it; contradictions remain an explicit refusal.
  const runs = new MonthFile("run");
  for (const row of rows.run) {
    const conflict = runs.add(row);
    if (conflict) throw new Error(`Conflicting archived run: ${conflict}`);
  }
  rows.run = JSON.parse(runs.serialize());
  rows.event = [...new Map(rows.event.map(e => [JSON.stringify(e), e])).values()];
  return { head, rows };
}
