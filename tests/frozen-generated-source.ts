import assert from "node:assert/strict";
import {resolve} from "node:path";

// Delivered main 736a3445e owns these audited producer bytes (#2279 re-audit after #2458). Read raw Git
// blobs offline: neither HEAD, worktree files nor archive substitution owns a
// frozen positive. CI checks out full history; absent history is a hard failure.
const owner = "736a3445e82aee509e10f3c8d00b95fc77749202";
export function frozenGeneratedSource(file: string): string {
  const child = Bun.spawnSync(["git", "show", `${owner}:${file}`], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, "FROZEN_GENERATED_SOURCE_OWNER_AVAILABLE_OFFLINE");
  return child.stdout.toString("utf8");
}
