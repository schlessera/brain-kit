/**
 * The hosted brain bridge's inventory check (#4325). It runs only inside the
 * turn's sandbox, with its working directory at the brain root, so the host
 * never reads a brain file to decide the roster.
 *
 * The bridge replaces the project's `brain` stdio entry, so it may stand in
 * only for the entry it reproduces exactly: `bun node_modules/.bin/brain mcp`
 * with no environment, working directory or other option. Any other entry
 * (an `env` that selects another `BRAIN_ROOT`, another command, a missing or
 * unreadable `.mcp.json`) exits with {@link NOT_CANONICAL}, and the host keeps
 * the original stdio entry (#4325 F22). A canonical entry runs
 * `brain module list --json` and passes its output and exit status through.
 */
import { readFileSync } from "node:fs";

/** Exit status for a project entry the bridge cannot reproduce. */
export const NOT_CANONICAL = 3;

/** The one project entry the bridge reproduces, byte for byte. */
export function canonicalBrainEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const { command, args, type, ...rest } = entry as Record<string, unknown>;
  return Object.keys(rest).length === 0 && (type === undefined || type === "stdio") && command === "bun"
    && Array.isArray(args) && args.length === 2 && args[0] === "node_modules/.bin/brain" && args[1] === "mcp";
}

if (import.meta.main) {
  let entry: unknown;
  try { entry = (JSON.parse(readFileSync(".mcp.json", "utf8")) as { mcpServers?: Record<string, unknown> })?.mcpServers?.brain; }
  catch { entry = undefined; }
  if (!canonicalBrainEntry(entry)) process.exit(NOT_CANONICAL);
  const child = Bun.spawnSync([process.execPath, "node_modules/.bin/brain", "module", "list", "--json"],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  await Bun.write(Bun.stdout, child.stdout);
  process.exit(child.exitCode ?? 1);
}
