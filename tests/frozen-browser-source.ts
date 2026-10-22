import assert from "node:assert/strict";
import {resolve} from "node:path";

// Delivered main (#2462), including the scene producers from #2369, owns
// the reviewed config and producers. Production audit pins stay unchanged.
// Read raw Git blobs offline, independently of production pins and HEAD. This
// positive is not candidate qualification; current bytes have separate controls.
const owner = "419f3a51b5017a4705e6fe4dba9982b6fc8de3bc";
function git(args: string[]): Buffer {
  const child = Bun.spawnSync(["git", ...args], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, "FROZEN_BROWSER_SOURCE_OWNER_AVAILABLE_OFFLINE");
  return Buffer.from(child.stdout);
}
export function frozenBrowserSource(file: string): Buffer {
  return git(["show", `${owner}:${file}`]);
}
export function frozenBrowserFiles(directory: string): string[] {
  return git(["ls-tree", "-r", "--name-only", "-z", owner, "--", directory])
    .toString("utf8").split("\0").filter(Boolean);
}
