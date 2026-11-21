/** Explain a filesystem refusal after execution; the mount owns enforcement. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { WORKSPACES_READ_ONLY_REASON } from "@schlessera/brain-common/internal/worker-areas";
import { resolve } from "node:path";
import type { WorkerSandbox } from "./worker-sandbox.js";
import { WORKER_AREA_ROOT, WORKER_DATA_ROOT, WORKER_REFERENCE_ROOT } from "./worker-sandbox.js";

export function workspaceWriteRefusal(sandbox: WorkerSandbox | undefined, toolName: string, input: unknown, cwd?: string, failure?: unknown): string | undefined {
  if (!sandbox || !input || typeof input !== "object" || failure == null) return;
  const detail = failure as { path?: unknown; code?: unknown; stderr?: unknown; error?: unknown; message?: unknown };
  const error = typeof failure === "string" ? failure : [detail.code, detail.stderr, detail.error, detail.message].filter(value => typeof value === "string").join("\n");
  const diagnostics = error.split("\n").filter(line => /\b(?:EROFS|EACCES)\b|read-only file system|permission denied/iu.test(line)).join("\n");
  if (!diagnostics) return;
  const workspace = sandbox.areas.find(area => area.name === "workspaces");
  const roots = [WORKER_REFERENCE_ROOT];
  if (workspace && !workspace.mount.writable && !workspace.mount.missing)
    roots.push(resolve(sandbox.brain, "workspaces"), `${WORKER_AREA_ROOT}/workspaces`, `${WORKER_DATA_ROOT}/workspaces`);
  const value = input as Record<string, unknown>;
  let directory = typeof value.cwd === "string" ? resolve(sandbox.brain, value.cwd) : cwd ?? sandbox.brain;
  const shell = ["Bash", "bash"].includes(toolName);
  if (shell && typeof value.command === "string") {
    const changes = value.command.matchAll(/(?:^|[;&|]\s*)\s*cd\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|]+))/gu);
    for (const change of changes) directory = resolve(directory, change[1] ?? change[2] ?? change[3]!);
  }
  // The failure owns attribution. Read operands, stdout mentions and merely
  // having visited a checkout do not establish where a write failed.
  const reported = typeof detail?.path === "string" ? detail.path
    : diagnostics.match(/\bcannot (?:touch|create(?: regular file)?|remove|open|access|stat)\s+['"]([^'"]+)['"]/iu)?.[1]
      ?? diagnostics.match(/\b(?:open|mkdir|unlink|rmdir|rename|stat|scandir|access)\s+['"]([^'"]+)['"]/iu)?.[1]
      ?? (/npm (?:ERR!|error) code\s+(?:EROFS|EACCES)\b/iu.test(diagnostics) ? error.match(/(?:^|\n)npm (?:ERR!|error) path\s+([^\n]+)/iu)?.[1] : undefined)
      ?? diagnostics.match(/(?:^|\n)(?:[^:\n]+:\s*)+([^:\n]+):\s*(?:Read-only file system|Permission denied)/iu)?.[1];
  const path = reported ?? (shell ? undefined : value.file_path ?? value.notebook_path ?? value.path);
  const checkout = typeof path === "string" && !path.includes("$") && roots.some(root => isWithin(root, resolve(directory, path.trim())));
  if (checkout) return `This command encountered a filesystem permission refusal in an inspected checkout. ${WORKSPACES_READ_ONLY_REASON}.`;
}
