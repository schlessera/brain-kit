/** Explain a filesystem refusal after execution; the mount owns enforcement. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { WORKSPACES_READ_ONLY_REASON } from "@schlessera/brain-common/internal/worker-areas";
import { resolve } from "node:path";
import type { WorkerSandbox } from "./worker-sandbox.js";
import { WORKER_AREA_ROOT, WORKER_DATA_ROOT, WORKER_REFERENCE_ROOT } from "./worker-sandbox.js";

export function workspaceWriteRefusal(sandbox: WorkerSandbox | undefined, toolName: string, input: unknown, cwd?: string, failure?: unknown): string | undefined {
  if (!sandbox || !input || typeof input !== "object" || failure === undefined) return;
  const error = typeof failure === "string" ? failure : JSON.stringify(failure);
  if (!error || !/\b(?:EROFS|EACCES)\b|read-only file system|permission denied/iu.test(error)) return;
  const workspace = sandbox.areas.find(area => area.name === "workspaces");
  const roots = [WORKER_REFERENCE_ROOT];
  if (workspace && !workspace.mount.writable && !workspace.mount.missing)
    roots.push(resolve(sandbox.brain, "workspaces"), `${WORKER_AREA_ROOT}/workspaces`, `${WORKER_DATA_ROOT}/workspaces`);
  const value = input as Record<string, unknown>;
  let directory = typeof value.cwd === "string" ? resolve(sandbox.brain, value.cwd) : cwd ?? sandbox.brain;
  const target = (path: string) => !path.includes("$") && roots.some(root => isWithin(root, resolve(directory, path)));
  const path = value.file_path ?? value.notebook_path ?? value.path;
  let checkout = typeof path === "string" && target(path);
  if (["Bash", "bash"].includes(toolName) && typeof value.command === "string") {
    // Literal paths only, for explanatory context. No command is classified
    // as mutating or denied here: dry runs and verification may execute.
    const words = value.command.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|<>]+/gu) ?? [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!.replace(/^['"]|['"]$/gu, "");
      if (word === "cd" && words[i + 1]) directory = resolve(directory, words[++i]!.replace(/^['"]|['"]$/gu, ""));
      else if (target(word) || roots.some(root => error.includes(`${root}/`))) checkout = true;
    }
    checkout ||= target(".");
  }
  if (checkout) return `This command encountered a filesystem permission refusal in an inspected checkout. ${WORKSPACES_READ_ONLY_REASON}.`;
}
