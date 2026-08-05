import type { ToolCall } from "../../stores/chat-store.js";

// ============================================================
// Approval-time risk hints
// ============================================================
//
// Non-blocking advisories surfaced in the pending-approval detail so a human
// notices known-risky shapes before hitting Allow. Detection only — the human
// still decides. Each rule is { test, message } so the list is easy to extend.

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
  if (/^\/data\/brain\//.test(path) || /^\/home\/[^/]+\/brain\//.test(path)) {
    return true;
  }
  // Repo-relative: not absolute and not escaping upward.
  if (!path.startsWith("/") && !path.split("/").includes("..")) return true;
  return false;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type RiskRule = {
  test: (tool: ToolCall) => boolean;
  message: string;
};

export const RISK_RULES: RiskRule[] = [
  {
    // Note: the Bash input view already badges this red, so this line is
    // secondary. Kept for consistency so the advisory row reflects every known
    // risk in one place rather than the human having to cross-reference badges.
    test: (t) => t.name === "Bash" && Boolean(t.input?.dangerouslyDisableSandbox),
    message: "runs without the sandbox",
  },
  {
    // Recursive + force in either flag order (-rf, -fr) or as separate flags
    // (rm -r -f). Lookaheads match a `-…r` flag and a `-…f` flag in any order.
    test: (t) =>
      t.name === "Bash" &&
      /\brm\b(?=[^\n]*\s-[a-zA-Z]*r)(?=[^\n]*\s-[a-zA-Z]*f)/.test(
        asString(t.input?.command)
      ),
    message: "removes files recursively (rm -rf)",
  },
  {
    test: (t) =>
      t.name === "Bash" &&
      /git\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/.test(
        asString(t.input?.command)
      ),
    message: "force-pushes a git branch",
  },
  {
    test: (t) =>
      t.name === "Bash" &&
      /\b(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b/.test(asString(t.input?.command)),
    message: "pipes a remote script into a shell",
  },
  {
    test: (t) => {
      if (t.name !== "Write" && t.name !== "Edit" && t.name !== "NotebookEdit")
        return false;
      const path =
        asString(t.input?.file_path) || asString(t.input?.notebook_path);
      if (!path) return false;
      return !isInsideBrainRepo(path);
    },
    message: "writes outside the brain repo",
  },
];

/** Advisory messages for every risk rule that fires. Never throws. */
export function riskHints(tool: ToolCall): string[] {
  const hints: string[] = [];
  for (const rule of RISK_RULES) {
    try {
      if (rule.test(tool)) hints.push(rule.message);
    } catch {
      // Defensive: never let a malformed input break the approval UI.
    }
  }
  return hints;
}
