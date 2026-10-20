import assert from "node:assert/strict";
import {resolve} from "node:path";

// Delivered main af0547c2d owns these audited producer bytes (#2408 re-audit). Read raw Git
// blobs offline: neither HEAD, worktree files nor archive substitution owns a
// frozen positive. CI checks out full history; absent history is a hard failure.
const owner = "af0547c2d4d197ed3766f2817cf56eb5f0486ab4";
export function frozenGeneratedSource(file: string): string {
  const child = Bun.spawnSync(["git", "show", `${owner}:${file}`], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, "FROZEN_GENERATED_SOURCE_OWNER_AVAILABLE_OFFLINE");
  return child.stdout.toString("utf8");
}
