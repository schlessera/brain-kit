/** Classify a dead-root kernel trace against the native proof's checkpoint operations. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Event = { kind: string; pid: number; task: string; at: number; fields: Record<string, string>; stack: string[] };
export type DeadRootQueue = "with-delete" | "other-before-commit" | "after-commit" | "not-queued";
export type DeadRootDelete = { name: string; at: number; pid: number; comm: string; root?: string; queue: DeadRootQueue;
  queuedBy?: { pid: number; comm: string; afterDeleteMs: number; stack: string[] }; commitAfterDeleteMs?: number; droppedAfterDeleteMs?: number };

export function parseDeadRootTrace(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    const frame = /^\s*=> (\S+)/.exec(line);
    if (frame) { const last = events.at(-1); if (last?.kind === "dead_root") last.stack.push(frame[1]!); continue; }
    const row = /^\s*(.+?)-(\d+)\s+\[\d+\]\s+\S+\s+([\d.]+): (\w+): \([^)]*\)(.*)$/.exec(line);
    if (!row) continue;
    const fields: Record<string, string> = {};
    for (const [, key, value] of row[5]!.matchAll(/(\w+)=("[^"]*"|\S+)/g)) fields[key!] = value!.replace(/^"|"$/g, "");
    events.push({ kind: row[4]!, pid: Number(row[2]), task: row[1]!, at: Number(row[3]) * 1000, fields, stack: [] });
  }
  // Only the dead_root trigger carries a stack; keep the frames below the probe.
  for (const event of events) event.stack = event.stack.filter(frame => !frame.startsWith("kprobe") && !frame.startsWith("0x")).slice(0, 12);
  return events;
}

/** Map each deleted checkpoint name to its root from the manager's delete-then-sync command pair. */
export function checkpointRoots(operations: string): Map<string, string> {
  const roots = new Map<string, string>(); let pending: string | undefined;
  for (const line of operations.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { stage?: string; command?: string[] };
    if (row.stage !== "start" || !row.command) continue;
    if (row.command[0] === "subvolume" && row.command[1] === "delete") pending = basename(row.command.at(-1)!);
    else if (row.command[0] === "subvolume" && row.command[1] === "sync" && pending) { roots.set(pending, row.command[3]!); pending = undefined; }
  }
  return roots;
}

export function classifyDeadRoots(events: Event[], roots: Map<string, string>): DeadRootDelete[] {
  const claimed = new Set<Event>();
  return events.filter(event => event.kind === "delete").map(remove => {
    const comm = remove.fields.comm ?? remove.task, name = remove.fields.name ?? "", root = roots.get(name);
    const commit = events.find(event => event.kind === "commit_async" && event.pid === remove.pid && event.at >= remove.at);
    const after = (event: Event) => event.at >= remove.at && !claimed.has(event);
    // The deleting ioctl queues an unreferenced root itself, before its commit.
    let queued = events.find(event => event.kind === "dead_root" && after(event) && event.pid === remove.pid && (!commit || event.at <= commit.at)
      && (!root || event.fields.root === root));
    if (!queued && root) queued = events.find(event => event.kind === "dead_root" && after(event) && event.fields.root === root);
    if (queued) claimed.add(queued);
    const dropped = root ? events.find(event => event.kind === "drop" && event.at >= remove.at && event.fields.root === root) : undefined;
    const queue: DeadRootQueue = !queued ? "not-queued" : queued.pid === remove.pid && (!commit || queued.at <= commit.at) ? "with-delete"
      : commit && queued.at > commit.at ? "after-commit" : "other-before-commit";
    return { name, at: remove.at, pid: remove.pid, comm, ...(root ? { root } : {}), queue,
      ...(queued ? { queuedBy: { pid: queued.pid, comm: queued.fields.comm ?? queued.task, afterDeleteMs: queued.at - remove.at, stack: queued.stack } } : {}),
      ...(commit ? { commitAfterDeleteMs: commit.at - remove.at } : {}),
      ...(dropped ? { droppedAfterDeleteMs: dropped.at - remove.at } : {}) };
  });
}

if (import.meta.main) {
  const [trace, artifacts] = process.argv.slice(2);
  if (!trace || !artifacts) throw Error("Usage: dead-root-trace.ts <trace> <native-host-proof directory>");
  const text = readFileSync(trace, "utf8"), roots = new Map<string, string>();
  for (const entry of readdirSync(artifacts, { withFileTypes: true })) {
    const operations = join(artifacts, entry.name, "run", "native-operations.jsonl");
    if (entry.isDirectory() && existsSync(operations)) for (const [name, root] of checkpointRoots(readFileSync(operations, "utf8"))) roots.set(name, root);
  }
  const deletes = classifyDeadRoots(parseDeadRootTrace(text), roots);
  const counts = Object.fromEntries((["with-delete", "other-before-commit", "after-commit", "not-queued"] as const)
    .map(queue => [queue, deletes.filter(row => row.queue === queue).length]));
  const summary = { header: text.split("\n", 1)[0], deletes: deletes.length, counts, attention: deletes.filter(row => row.queue !== "with-delete"), all: deletes };
  writeFileSync(join(artifacts, "dead-root-summary.json"), JSON.stringify(summary, null, 2));
  console.log(`Dead-root trace: ${deletes.length} deletes ${JSON.stringify(counts)}`);
  for (const row of summary.attention) console.log(`  ${row.queue} ${row.name} root=${row.root ?? "?"} by ${row.queuedBy ? `${row.queuedBy.comm}/${row.queuedBy.pid} +${row.queuedBy.afterDeleteMs.toFixed(1)}ms [${row.queuedBy.stack.slice(0, 8).join(" < ")}]` : "nobody"}`);
}
