import type { ToolSemantics } from "@schlessera/brain-ui-sdk/client";
import type { ToolCall } from "../../stores/chat-store.js";

// ============================================================
// Approval-time risk hints
// ============================================================
//
// Non-blocking advisories surfaced in the pending-approval detail so a human
// notices known-risky shapes before hitting Allow. Detection only — the human
// still decides. Rules test backend-neutral SEMANTICS (the command line run,
// the path written), supplied by the tool's renderer, so a rule written once
// covers Claude's `Bash`, pi's `bash`, and any future backend's equivalent.

/**
 * Does this path resolve inside the brain repo?
 *
 * Deliberately STRICTER than tool-views.tsx's `toRepoRelative`: this drives a
 * *risk advisory*, so it must err toward warning — a bare `/brain/` substring
 * match would wrongly clear `/tmp/brain/secrets`. Inside means either
 * repo-relative (not absolute, no `..` escape) or anchored at a known brain
 * root: the container path `/data/brain/` or a home checkout `/home/<user>/brain/`
 * (`~/brain`).
 */
export function isInsideBrainRepo(path: string): boolean {
  if (path.startsWith("/data/brain/") || /^\/home\/[^/]+\/brain\//.test(path)) {
    return true;
  }
  // Repo-relative: not absolute and not escaping upward.
  if (!path.startsWith("/") && !path.split("/").includes("..")) return true;
  return false;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The extracted, plain-value meaning risk rules test against. */
export type ResolvedSemantics = {
  /** Shell command line the call executes, or "". */
  command: string;
  /** Filesystem path the call writes, or "". */
  writePath: string;
  /** Call explicitly opts out of its backend's sandbox. */
  unsandboxed: boolean;
};

/**
 * Shape-sniffing fallback for renderers that declare no semantics, so an
 * unknown tool with a recognizable input still gets its advisories.
 */
function sniffSemantics(tool: ToolCall): ResolvedSemantics {
  const input = tool.input ?? {};
  const writeSignal =
    "content" in input ||
    "old_string" in input ||
    "new_string" in input ||
    "new_source" in input;
  return {
    command: asString(input.command) || asString(input.cmd),
    writePath: writeSignal
      ? asString(input.file_path) ||
        asString(input.notebook_path) ||
        asString(input.path)
      : "",
    unsandboxed: Boolean(input.dangerouslyDisableSandbox),
  };
}

/** Evaluate a renderer's semantics accessors (each optional) for one call. */
export function resolveSemantics(
  tool: ToolCall,
  semantics?: ToolSemantics
): ResolvedSemantics {
  const sniffed = sniffSemantics(tool);
  if (!semantics) return sniffed;
  return {
    command: semantics.command ? semantics.command(tool) ?? "" : sniffed.command,
    writePath: semantics.writePath
      ? semantics.writePath(tool) ?? ""
      : sniffed.writePath,
    unsandboxed: semantics.unsandboxed
      ? semantics.unsandboxed(tool)
      : sniffed.unsandboxed,
  };
}

export type RiskRule = {
  test: (sem: ResolvedSemantics) => boolean;
  message: string;
};

export const RISK_RULES: RiskRule[] = [
  {
    // Note: the Bash input view already badges this red, so this line is
    // secondary. Kept for consistency so the advisory row reflects every known
    // risk in one place rather than the human having to cross-reference badges.
    test: (sem) => sem.unsandboxed,
    message: "runs without the sandbox",
  },
  {
    // Recursive + force in either flag order (-rf, -fr) or as separate flags
    // (rm -r -f). Lookaheads match a `-…r` flag and a `-…f` flag in any order.
    test: (sem) =>
      /\brm\b(?=[^\n]*\s-[a-zA-Z]*r)(?=[^\n]*\s-[a-zA-Z]*f)/.test(sem.command),
    message: "removes files recursively (rm -rf)",
  },
  {
    test: (sem) =>
      /git\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/.test(
        sem.command
      ),
    message: "force-pushes a git branch",
  },
  {
    test: (sem) =>
      /\b(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b/.test(sem.command),
    message: "pipes a remote script into a shell",
  },
  {
    test: (sem) => Boolean(sem.writePath) && !isInsideBrainRepo(sem.writePath),
    message: "writes outside the brain repo",
  },
];

/** Advisory messages for every risk rule that fires. Never throws. */
export function riskHints(tool: ToolCall, semantics?: ToolSemantics): string[] {
  const hints: string[] = [];
  let sem: ResolvedSemantics;
  try {
    sem = resolveSemantics(tool, semantics);
  } catch {
    // Defensive: never let a malformed input break the approval UI.
    return hints;
  }
  for (const rule of RISK_RULES) {
    try {
      if (rule.test(sem)) hints.push(rule.message);
    } catch {
      // Same defensiveness per rule.
    }
  }
  return hints;
}
