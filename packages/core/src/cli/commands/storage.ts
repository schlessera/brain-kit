import { resolveEnv } from "../../config/env.js";
import { resolve } from "node:path";
import { collectStorageProcess } from "../../lib/storage-process.js";
import { UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";

export const storageCommand: CoreCommand = {
  summary: "Bounded read-only content and Git storage inventory",
  helpBlock: `brain storage inventory --json

Collect metadata for BRAIN_ROOT without evaluating brain configuration, opening
a database or reading attachment bytes. Linux descriptor traversal is required.
The finite snapshot includes hierarchy pages (200 entries), observation coverage,
logical/object-union bytes and qualified filesystem capacity. Page cursors belong
to this snapshot only and expire after 60 seconds. A new invocation is a new scan.
Trusted hosts may set BRAIN_STORAGE_GIT_ROOTS to a JSON array of allowed external
Git directories. No request flag accepts or expands those roots.`,
  run: (args, cli) => runStorageInventory(args, cli.json),
};

export async function runStorageInventory(args: string[], json: boolean): Promise<void> {
    if (args[0] !== "inventory" || args.slice(1).some(arg => arg !== "--json")) throw new UsageError("Usage: brain storage inventory --json");
    const { brainRoot: root, storageGitRoots } = resolveEnv();
    if (!root) throw new UsageError("Storage requires an explicit BRAIN_ROOT");
    let gitRoots: string[] = [];
    if (storageGitRoots) {
      try { gitRoots = JSON.parse(storageGitRoots); }
      catch { throw new UsageError("Invalid BRAIN_STORAGE_GIT_ROOTS"); }
      if (!Array.isArray(gitRoots) || gitRoots.length > 16 || gitRoots.some(path => typeof path !== "string" || !path.startsWith("/") || path.length > 4096)) throw new UsageError("Invalid BRAIN_STORAGE_GIT_ROOTS");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    try {
      const result = await collectStorageProcess(resolve(root), gitRoots, controller.signal);
      if (json) console.log(JSON.stringify(result));
      else console.log(`${result.status}: ${result.totals.entries} entries, ${result.totals.objectLogicalBytes} observed logical bytes`);
    } finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
}
