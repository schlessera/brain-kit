/** Fixture-only filesystem boundary for live measurement SDK turns. */
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export interface MeasurementToolAccess {
  tool: string;
  allowed: boolean;
  /** A relative fixture path, or a category; never an outside path. */
  target: string;
}

/** Project-only settings keep automatic memory out of measured turns. */
export function disableMeasurementMemory(brain: string): void {
  const inspect = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Measurement fixtures must not contain symlinks.");
      if (stat.isDirectory()) inspect(path);
    }
  };
  inspect(brain);
  mkdirSync(join(brain, ".claude"), { recursive: true });
  writeFileSync(join(brain, ".claude/settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
}

/** Real paths, rather than lexical prefixes, also reject fixture symlink escapes. */
export function measurementPath(brain: string, candidate: string): string | null {
  try {
    const root = realpathSync(brain);
    const target = realpathSync(resolve(root, candidate));
    const local = relative(root, target);
    return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith("../"))
      ? local || "." : null;
  } catch {
    // A missing or malformed path has no established containment proof.
    return null;
  }
}

/** This fires before tool execution, including when permissions are bypassed. */
export function measurementIsolationHook(
  brain: string, blockTool: string, audit: MeasurementToolAccess[],
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    const data = input.tool_input as Record<string, unknown>;
    let target: string | null = null;
    if (tool === "Read") {
      target = typeof data.file_path === "string" ? measurementPath(brain, data.file_path) : null;
    } else if (tool === "Glob" || tool === "Grep") {
      const path = data.path ?? ".";
      target = typeof path === "string" ? measurementPath(brain, path) : null;
      if (tool === "Glob" && (typeof data.pattern !== "string" || isAbsolute(data.pattern) ||
        data.pattern.split(/[\\/]/).includes(".."))) target = null;
    } else if ([blockTool, "TodoWrite", "TaskOutput", "TaskStop"].includes(tool)) {
      target = "non-filesystem";
    }
    const allowed = target !== null;
    audit.push({ tool, allowed, target: target ?? "outside-or-unproved" });
    return allowed ? {} : {
      hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: "Live measurement tools may only read the staged fictional fixture brain.",
      },
    };
  };
}
