import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { linkRule, READ_ONLY_BRAIN_RULE, turnTempRule } from "@schlessera/brain-common/internal/worker-areas";
import { SCRATCH_DIR } from "../lib/scratch.js";

/** Commands whose output belongs in the scratch area when the brain is read-only (#1626). */
const SCRATCH_WRITERS = new Set(["render", "image"]);

/**
 * Read-only worker writes are refusals, never staged commands. With `root`,
 * a command that has a scratch alternative names it: in a hosted worker the
 * brain is read-only but `.brain/scratch/` is its own writable mount (#1626).
 * The rule and its alternative are the sandbox note's own sentences
 * (`@schlessera/brain-common/internal/worker-areas`), so the refusal never
 * contradicts what the agent was told before the turn (#1654).
 */
export function readOnlyBrainError(command: string, error: unknown, root?: string): {
  schema_version: 1; ok: false; error: { code: "read_only_brain"; message: string; tool: string };
} | null {
  if ((error as NodeJS.ErrnoException)?.code !== "EROFS") return null;
  const tool = command === "add" ? "brain_add" : command === "archive" ? "brain_archive" : "apply_staged_changes";
  // A scratch directory missing from a read-only brain cannot be created, so it is no route either.
  const scratch = root === undefined ? undefined : join(root, SCRATCH_DIR);
  const sandbox = scratch === undefined ? undefined : !existsSync(scratch) || isReadOnlyBrainMount(scratch)
    ? `${SCRATCH_DIR}/ is read-only in this turn as well (a restricted autonomous turn, or it is missing, not gitignored, redirected or could not be verified), so nothing written now is kept for the reader.`
    : undefined;
  const message = command === "scratch"
    ? `The scratch area ${SCRATCH_DIR}/ is read-only here, so nothing was removed. In a hosted turn that means a restricted autonomous turn, or a scratch directory the worker sandbox would not bind writable; the server prunes it hourly.`
    : SCRATCH_WRITERS.has(command)
      ? `The brain is read-only here outside ${SCRATCH_DIR}/ (the hosted worker sandbox). ` + (sandbox
        ?? `Write the output with --scratch instead: ${SCRATCH_DIR}/ is writable and kept across turns. ${linkRule(SCRATCH_DIR)} Link the path the command prints. ${turnTempRule()}`)
      : `${READ_ONLY_BRAIN_RULE} For this command, in a hosted turn use ${tool} (Claude: mcp__brain-ui__${tool}); the CLI write is not staged or replayed. Use a writable terminal brain for other operations.`;
  return { schema_version: 1, ok: false, error: { code: "read_only_brain", tool, message } };
}

/**
 * The directory a known write form writes into: the scratch area for
 * `scratch` and for a `render` sent there, the brain root otherwise. The
 * read-only pre-check asks about this path, so a scratch write still runs
 * where the scratch area is its own writable mount.
 */
export function writeTarget(command: string, args: readonly string[], root: string): string {
  const out = args.some(arg => arg === "--out" || arg.startsWith("--out="));
  if (command === "scratch" || (command === "render" && (args.includes("--scratch") || (args.includes("-") && !out)))) {
    return join(root, SCRATCH_DIR);
  }
  return root;
}

/** Diagnostics only: the kernel remains the write boundary. Linux mount flags
 * also cover commands which catch EROFS inside their per-file result loop. */
export function isReadOnlyBrainMount(root: string): boolean {
  if (process.platform !== "linux") return false;
  try {
    const target = realpathSync(root);
    let longest = -1;
    let readOnly = false;
    for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const fields = line.split(" ");
      if (fields.length < 6) continue;
      const mount = fields[4]!.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if ((target === mount || target.startsWith(mount === "/" ? "/" : `${mount}/`)) && mount.length > longest) {
        longest = mount.length;
        readOnly = fields[5]!.split(",").includes("ro");
      }
    }
    return readOnly;
  } catch { return false; }
}
