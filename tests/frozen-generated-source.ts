import assert from "node:assert/strict";
import {resolve} from "node:path";

// Delivered main a9bcdbd67 owns the audited producers and readers (#3548 re-audit). Read raw Git
// blobs offline: neither HEAD, worktree files nor archive substitution owns a
// frozen positive. CI checks out full history; absent history is a hard failure.
const owner = "a9bcdbd6734c1733390570e2a68c10afde3b00a9";
export function frozenGeneratedSource(file: string): string {
  const child = Bun.spawnSync(["git", "show", `${owner}:${file}`], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, "FROZEN_GENERATED_SOURCE_OWNER_AVAILABLE_OFFLINE");
  return child.stdout.toString("utf8");
}
