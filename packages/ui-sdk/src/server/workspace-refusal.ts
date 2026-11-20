/** Actionable refusals for visible writes; the read-only mount also stops opaque code. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { WORKSPACES_READ_ONLY_REASON } from "@schlessera/brain-common/internal/worker-areas";
import { resolve } from "node:path";
import type { WorkerSandbox } from "./worker-sandbox.js";
import { WORKER_AREA_ROOT } from "./worker-sandbox.js";

export function workspaceWriteRefusal(sandbox: WorkerSandbox | undefined, toolName: string, input: unknown, cwd?: string): string | undefined {
  const workspace = sandbox?.areas.find(area => area.name === "workspaces");
  if (!sandbox || !workspace || workspace.mount.writable || !input || typeof input !== "object") return;
  const value = input as Record<string, unknown>;
  const directory = typeof value.cwd === "string" ? value.cwd : cwd ?? sandbox.brain;
  const roots = [resolve(sandbox.brain, "workspaces"), `${WORKER_AREA_ROOT}/workspaces`];
  const target = (path: string) => roots.some(root => isWithin(root, resolve(directory, path)));
  let writes = false;
  if (["Write", "Edit", "NotebookEdit", "write_file", "edit_file"].includes(toolName)) {
    const path = value.file_path ?? value.notebook_path ?? value.path;
    writes = typeof path === "string" && target(path);
  } else if (["Bash", "bash"].includes(toolName) && typeof value.command === "string") {
    // This recognizes explicit installs/builds and ordinary shell writers, not
    // arbitrary programs. Unknown effects still meet the kernel's read-only mount.
    const command = value.command;
    const mutating = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\b(?:install|ci|add|build)\b|(?:^|[\s;&|])(?:touch|mkdir|rmdir|rm|mv|cp|tee|truncate)\b|(?:^|[^<])>/u.test(command);
    const paths = command.match(/[^\s"';&|<>]+/gu) ?? [];
    writes = mutating && (target(".") || paths.some(word => target(word.slice(word.indexOf("=") + 1))));
  }
  if (writes) return `workspaces/ is read-only this turn: ${workspace.mount.reason}. ${WORKSPACES_READ_ONLY_REASON}. Nothing ran.`;
}
