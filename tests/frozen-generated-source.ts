import assert from "node:assert/strict";
import {resolve} from "node:path";

// Delivered main b7f6360a8 owns these audited producer bytes (#2408 re-audit after #2459). Read raw Git
// blobs offline: neither HEAD, worktree files nor archive substitution owns a
// frozen positive. CI checks out full history; absent history is a hard failure.
const owner = "b7f6360a86be68f7da8cefa93c316ecc0bf9bf42";
export function frozenGeneratedSource(file: string): string {
  const child = Bun.spawnSync(["git", "show", `${owner}:${file}`], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, "FROZEN_GENERATED_SOURCE_OWNER_AVAILABLE_OFFLINE");
  return child.stdout.toString("utf8");
}
