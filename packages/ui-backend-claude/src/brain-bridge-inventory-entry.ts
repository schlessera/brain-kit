/**
 * The hosted brain bridge's inventory check (#4325). It runs only inside the
 * turn's sandbox, with its working directory at the brain root, so the host
 * never reads a brain file to decide the roster.
 *
 * The bridge replaces the project's `brain` stdio entry, so it may stand in
 * only for an entry it reproduces exactly, which the runtime would start:
 * - `bun node_modules/.bin/brain mcp` with no environment, working directory
 *   or other option (an `env` could select another `BRAIN_ROOT`, F22);
 * - not disabled by the project's Claude settings (F13);
 * - served by the same `@schlessera/brain` version as the host's static read
 *   definitions, passed as the first argument, so the bridge never advertises
 *   a tool or argument the brain's own server lacks (F14; versions move in
 *   lockstep).
 * Anything else, including a missing or unreadable file, exits with
 * {@link NOT_CANONICAL}, and the host keeps the original stdio entry. A
 * qualifying brain runs `brain module list --json` and passes its output and
 * exit status through.
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

/** Whether project Claude settings turn the `brain` project server off (F13). */
export function projectDisablesBrain(settings: readonly unknown[]): boolean {
  return settings.some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const { disabledMcpjsonServers, enabledMcpjsonServers, enableAllProjectMcpServers } = value as Record<string, unknown>;
    if (Array.isArray(disabledMcpjsonServers) && disabledMcpjsonServers.includes("brain")) return true;
    if (enableAllProjectMcpServers === false) return true;
    return enableAllProjectMcpServers !== true && Array.isArray(enabledMcpjsonServers) && !enabledMcpjsonServers.includes("brain");
  });
}

const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

/** The version of `@schlessera/brain` the brain itself resolves, or undefined. */
function brainCoreVersion(): string | undefined {
  try {
    const manifest = readJson(Bun.resolveSync("@schlessera/brain/package.json", process.cwd())) as { name?: unknown; version?: unknown } | undefined;
    return manifest?.name === "@schlessera/brain" && typeof manifest.version === "string" ? manifest.version : undefined;
  } catch { return undefined; }
}

if (import.meta.main) {
  const expectedVersion = process.argv[2];
  const entry = (readJson(".mcp.json") as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers?.brain;
  const settings = [readJson(".claude/settings.json"), readJson(".claude/settings.local.json")];
  if (!canonicalBrainEntry(entry) || projectDisablesBrain(settings) || !expectedVersion || brainCoreVersion() !== expectedVersion)
    process.exit(NOT_CANONICAL);
  const child = Bun.spawnSync([process.execPath, "node_modules/.bin/brain", "module", "list", "--json"],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  await Bun.write(Bun.stdout, child.stdout);
  process.exit(child.exitCode ?? 1);
}
