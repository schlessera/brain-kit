/** Actionable refusals for explicit destinations; opaque effects meet the mount. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { WORKSPACES_READ_ONLY_REASON } from "@schlessera/brain-common/internal/worker-areas";
import { resolve } from "node:path";
import type { WorkerSandbox } from "./worker-sandbox.js";
import { WORKER_AREA_ROOT, WORKER_REFERENCE_ROOT } from "./worker-sandbox.js";

export function workspaceWriteRefusal(sandbox: WorkerSandbox | undefined, toolName: string, input: unknown, cwd?: string): string | undefined {
  if (!sandbox || !input || typeof input !== "object") return;
  const workspace = sandbox.areas.find(area => area.name === "workspaces");
  const roots = [WORKER_REFERENCE_ROOT];
  if (workspace && !workspace.mount.writable && !workspace.mount.missing)
    roots.push(resolve(sandbox.brain, "workspaces"), `${WORKER_AREA_ROOT}/workspaces`);
  const value = input as Record<string, unknown>;
  let directory = typeof value.cwd === "string" ? resolve(sandbox.brain, value.cwd) : cwd ?? sandbox.brain;
  const target = (path: string) => !path.includes("$") && roots.some(root => isWithin(root, resolve(directory, path)));
  let writes = false;
  if (["Write", "Edit", "NotebookEdit", "write_file", "edit_file"].includes(toolName)) {
    const path = value.file_path ?? value.notebook_path ?? value.path;
    writes = typeof path === "string" && target(path);
  } else if (["Bash", "bash"].includes(toolName) && typeof value.command === "string") {
    // Recognize literal words/operators only. Sources are never destinations.
    // This is guidance, not a shell execution or security-boundary parser.
    const tokens = value.command.match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>"'])+|\d*>>?|<<?|&&|\|\||[;&|\n]/gu) ?? [];
    const unquote = (word: string) => word.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/gu, (_match, double: string | undefined, single: string | undefined) => single ?? double!.replace(/\\(["\\])/gu, "$1"));
    let words: string[] = [];
    const command = () => {
      const [name, ...args] = words;
      if (name === "cd") { const path = args.find(arg => !arg.startsWith("-")); if (path) directory = resolve(directory, path); }
      else if (["npm", "pnpm", "yarn", "bun"].includes(name ?? "")) {
        const install = args.some(arg => ["install", "i", "ci", "add", "build"].includes(arg)) || name === "yarn" && args.length === 0;
        let destination = ".";
        for (let i = 0; i < args.length; i++) {
          const flag = args[i]!;
          if (["--prefix", "--cwd", "--dir", "-C"].includes(flag) && args[i + 1]) destination = args[++i]!;
          else if (/^--(?:prefix|cwd|dir)=/u.test(flag)) destination = flag.slice(flag.indexOf("=") + 1);
        }
        if (install && target(destination)) writes = true;
      } else if (name === "cp" || name === "mv") {
        const operands = args.filter(arg => !arg.startsWith("-"));
        const flag = args.findIndex(arg => ["-t", "--target-directory"].includes(arg));
        const destination = flag >= 0 ? args[flag + 1] : args.find(arg => arg.startsWith("--target-directory="))?.slice(19) ?? operands.at(-1);
        if (destination && target(destination) || name === "mv" && operands.some(target)) writes = true;
      } else if (["touch", "mkdir", "rmdir", "rm", "tee", "truncate"].includes(name ?? "") && args.filter(arg => !arg.startsWith("-")).some(target)) writes = true;
      words = [];
    };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (/^\d*>>?$/u.test(token)) { const path = tokens[++i]; if (path && target(unquote(path))) writes = true; }
      else if (/^<<?$/u.test(token)) i++;
      else if (["&&", "||", ";", "&", "|", "\n"].includes(token)) command();
      else words.push(unquote(token));
    }
    command();
  }
  if (writes) return `The inspected checkout is read-only this turn. ${WORKSPACES_READ_ONLY_REASON}. Nothing ran.`;
}
