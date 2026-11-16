/** Publish local coordination evidence; never an input to integration policy. */
import { mkdtemp, readdir, lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText } from "./check-leakage";
import { validateWorkEvent, type WorkEvent } from "./ci-throughput";

export const EVENT_REF = "refs/heads/brain-ci-metrics";
const MAX_EVENTS = 100, MAX_BYTES = 256 * 1024, MAX_EVENT_BYTES = 8192;
const opaque = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

/** Strict local-event schema plus the same personal-string screen as the tree. */
export function screenPublishedEvent(value: unknown, repository: string): WorkEvent {
  const e = validateWorkEvent(value);
  if (e.repository !== repository) throw new Error("Event repository differs from --repo");
  if (!["work-started", "work-finished", "wait-started", "wait-finished", "preempted"].includes(e.kind) ||
    Object.keys(e).some(k => !["version", "id", "repository", "kind", "at", "worker", "task", "orchestrator", "reason", "pr"].includes(k)) ||
    ![e.id, e.worker, e.task].every(opaque) || (e.orchestrator !== undefined && !opaque(e.orchestrator)) ||
    (e.reason !== undefined && !["reservation", "ci", "review", "conflict", "other"].includes(e.reason)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(e.at)) throw new Error("Unsafe local event fields");
  if (scanText("event", JSON.stringify(e)).length) throw new Error("Event refused by leakage screen");
  return e;
}

/** Git plumbing uses an isolated index; the caller's files and index never move. */
export class GitEventStore {
  constructor(readonly root: string, readonly remote = "origin") {}
  async git(args: string[], input?: string, index?: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd: this.root, stdout: "pipe", stderr: "pipe",
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), env: { ...process.env,
        ...(index ? { GIT_INDEX_FILE: index } : {}),
        GIT_AUTHOR_NAME: "brain-kit metrics", GIT_AUTHOR_EMAIL: "metrics@example.invalid",
        GIT_COMMITTER_NAME: "brain-kit metrics", GIT_COMMITTER_EMAIL: "metrics@example.invalid" } });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    // Git's raw stderr may include a private remote URL or filesystem path.
    if (code !== 0) throw new Error(`Event archive git ${args[0]} failed (${code}); check remote access`);
    void err;
    return out.trim();
  }
  async remoteOid(): Promise<string | null> {
    const output = await this.git(["ls-remote", "--refs", this.remote, EVENT_REF]);
    if (!output) return null;
    const [oid, ref, ...extra] = output.split(/\s+/);
    if (!/^[a-f0-9]{40}$/.test(oid!) || ref !== EVENT_REF || extra.length) throw new Error("Invalid event archive ref");
    return oid!;
  }
  async read(): Promise<string | null> {
    const oid = await this.remoteOid();
    if (oid) await this.git(["fetch", "--no-tags", this.remote, oid]);
    return oid;
  }
  async publish(parent: string | null, events: WorkEvent[], repository: string): Promise<{ head: string; added: number } | null> {
    const pending: WorkEvent[] = [];
    for (const event of events) {
      const path = `events/${event.id}.json`;
      const entry = parent ? await this.git(["ls-tree", parent, "--", path]) : "";
      if (entry) {
        if (!/^100644 blob [a-f0-9]{40}\t/.test(entry)) throw new Error("Invalid archived event entry");
        const previous = screenPublishedEvent(JSON.parse(await this.git(["show", `${parent}:${path}`])), repository);
        if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("Event ID already exists with different content");
      } else pending.push(event);
    }
    if (!pending.length && parent) return { head: parent, added: 0 };
    const temporary = await mkdtemp(join(tmpdir(), "brain-event-index-")), index = join(temporary, "index");
    try {
      await this.git(["read-tree", ...(parent ? [parent] : ["--empty"])], undefined, index);
      for (const event of pending) {
        const blob = await this.git(["hash-object", "-w", "--stdin"], JSON.stringify(event) + "\n");
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},events/${event.id}.json`], undefined, index);
      }
      const tree = await this.git(["write-tree"], undefined, index);
      const head = await this.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "ci: append coordination events"]);
      try {
        await this.git(["push", "--porcelain", `--force-with-lease=${EVENT_REF}:${parent ?? ""}`, this.remote, `${head}:${EVENT_REF}`]);
        return { head, added: pending.length };
      } catch (error) {
        if (await this.remoteOid() !== parent) return null;
        throw error;
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

export async function publishEvents(options: { root: string; dir: string; repository: string; store?: GitEventStore }): Promise<{ added: number; existing: number; head: string | null }> {
  const { root, dir, repository } = options;
  if (!/^[\w-]+\/[\w-]+$/.test(repository)) throw new Error("Invalid publication repository");
  const names = (await readdir(dir)).filter(name => /^event-[\w-]+\.json$/.test(name)).sort();
  if (names.length > MAX_EVENTS) throw new Error(`Event batch exceeds ${MAX_EVENTS}; select a smaller input directory`);
  const events: WorkEvent[] = [], ids = new Set<string>(); let bytes = 0;
  for (const name of names) {
    const path = join(dir, name), stat = await lstat(path);
    bytes += stat.size;
    if (!stat.isFile() || stat.size > MAX_EVENT_BYTES || bytes > MAX_BYTES) throw new Error("Event batch exceeds size bounds or contains a non-file");
    const event = screenPublishedEvent(JSON.parse(await readFile(path, "utf8")), repository);
    if (ids.has(event.id)) throw new Error("Duplicate event ID in batch");
    ids.add(event.id); events.push(event);
  }
  if (!events.length) return { added: 0, existing: 0, head: null };
  // All local input is screened before any network operation. A lost CAS is
  // retried against the new tree, preserving unrelated archive/compaction work.
  const store = options.store ?? new GitEventStore(root);
  for (let attempt = 0; attempt < 5; attempt++) {
    const parent = await store.read(), result = await store.publish(parent, events, repository);
    if (result) return { ...result, existing: events.length - result.added };
  }
  throw new Error("Event publication contention exceeded five attempts; local events retained, retry publish");
}
