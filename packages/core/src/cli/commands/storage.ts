import { gitPackingHeadroom, isGitWorkTree, packRepository } from "../../lib/git-storage.js";
import { resolveEnv } from "../../config/env.js";
import { resolve } from "node:path";
import { collectStorageProcess } from "../../lib/storage-process.js";
import { UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";

export const storageCommand: CoreCommand = {
  summary: "Bounded storage inventory and non-destructive Git packing",
  helpBlock: `brain storage inventory --json
brain storage pack --json

Collect metadata for BRAIN_ROOT without evaluating brain configuration, opening
a database or reading attachment bytes. Linux descriptor traversal is required.
The finite snapshot includes hierarchy pages (200 entries), observation coverage,
logical/object-union bytes and qualified filesystem capacity. Page cursors belong
to this snapshot only and expire after 60 seconds. A new invocation is a new scan.
Trusted hosts may set BRAIN_STORAGE_GIT_ROOTS to a JSON array of allowed external
Git directories. No request flag accepts or expands those roots.

pack runs the existing loose-object/incremental-pack/ref-packing maintenance.
It preserves refs, reflogs and history. Old and new packs can coexist; temporary
headroom is workload-dependent and is not reserved. Exit 2 retains a qualified
refusal/partial report; packing never runs broad gc or expires history.`,
  run: async (args, cli) => args[0] === "pack" ? runStoragePack(args, cli.brain.root, cli.json) : runStorageInventory(args, cli.json),
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

export function runStoragePack(args: string[], root: string, json: boolean): number {
  if (args[0] !== "pack" || args.slice(1).some(arg => arg !== "--json")) throw new UsageError("Usage: brain storage pack --json");
  let started = false;
  const result: { schema_version: 1; action: "pack"; state: "complete" | "refused" | "partial"; packed: number | null; reason: string | null; headroom: ReturnType<typeof gitPackingHeadroom> | null } =
    { schema_version: 1, action: "pack", state: "refused", packed: null, reason: null, headroom: null };
  try {
    if (!isGitWorkTree(root)) result.reason = "not_a_git_worktree";
    else {
      result.headroom = gitPackingHeadroom(root);
      if (result.headroom.availableBytes === 0) result.reason = "no_space";
      else { started = true; result.packed = packRepository(root).packed; result.state = "complete"; }
    }
  } catch (error) {
    result.state = started ? "partial" : "refused";
    result.reason = /ENOSPC|No space left/i.test(String(error)) ? "no_space" : "git_maintenance_unavailable";
  }
  if (json) console.log(JSON.stringify(result));
  else console.log(result.state === "complete" ? `Packed ${result.packed} loose objects; history and refs retained.` : `Packing ${result.state}: ${result.reason}. Re-measure storage before trying again.`);
  return result.state === "complete" ? 0 : 2;
}
