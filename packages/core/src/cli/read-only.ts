import { readFileSync, realpathSync } from "node:fs";

/** Read-only worker writes are refusals, never staged commands. */
export function readOnlyBrainError(command: string, error: unknown): {
  schema_version: 1; ok: false; error: { code: "read_only_brain"; message: string; tool: string };
} | null {
  if ((error as NodeJS.ErrnoException)?.code !== "EROFS") return null;
  const tool = command === "add" ? "brain_add" : command === "archive" ? "brain_archive" : "apply_staged_changes";
  return { schema_version: 1, ok: false, error: { code: "read_only_brain", tool,
    message: `The brain is read-only here. In a hosted turn use ${tool} (Claude: mcp__brain-ui__${tool}); the CLI write is not staged or replayed. Use a writable terminal brain for other operations.` } };
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
