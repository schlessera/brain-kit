import assert from "node:assert/strict";
import {resolve} from "node:path";

// Delivered main before #2370 owns these audited producer bytes. Read raw Git
// blobs offline: neither HEAD, worktree files nor archive substitution owns a
// frozen positive. CI checks out full history; absent history is a hard failure.
const owner = "498270fbdc4ef2788fdd3babb259b647d77f6c77";
export function frozenGeneratedSource(file: string): string {
  const child = Bun.spawnSync(["git", "show", `${owner}:${file}`], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, "FROZEN_GENERATED_SOURCE_OWNER_AVAILABLE_OFFLINE");
  return child.stdout.toString("utf8");
}
