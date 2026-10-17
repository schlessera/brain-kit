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
    ? `${SCRATCH_DIR}/ is read-only in this turn as well; see the sandbox note for the reason; nothing written now is kept for the reader.`
    : undefined;
  const message = command === "scratch"
    ? `The scratch area ${SCRATCH_DIR}/ is read-only here, so nothing was removed. See the sandbox note for the reason; the server prunes it hourly.`
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
    const mounts = new Map<number, { id: number; parent: number; point: string; readOnly: boolean }>();
    for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const fields = line.split(" ");
      if (fields.length < 6 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!)) continue;
      const id = Number(fields[0]), parent = Number(fields[1]);
      const point = fields[4]!.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      mounts.set(id, { id, parent, point, readOnly: fields[5]!.split(",").includes("ro") });
    }
    // mountinfo parent IDs encode the stack: a same-point child covers its
    // parent. Follow the visible tree from /, taking the nearest child mount
    // on the target path before considering descendants. Otherwise a deeper
    // mount left beneath an overmounted ancestor can incorrectly win.
    // https://man.archlinux.org/man/core/man-pages/proc_pid_mountinfo.5.en
    let current = [...mounts.values()].find(mount => mount.point === "/" &&
      (mount.parent === mount.id || !mounts.has(mount.parent)));
    const visited = new Set<number>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const children = [...mounts.values()].filter(mount => mount.id !== current!.id && mount.parent === current!.id &&
        (target === mount.point || target.startsWith(mount.point === "/" ? "/" : `${mount.point}/`)));
      if (!children.length) return current.readOnly;
      const nearest = Math.min(...children.map(mount => mount.point.length));
      const next = children.filter(mount => mount.point.length === nearest);
      // Kernel data supplies one visible branch. Ambiguous/incomplete input
      // cannot establish a diagnostic refusal; the kernel still guards writes.
      if (next.length !== 1) return false;
      current = next[0];
    }
    return false;
  } catch { return false; }
}
