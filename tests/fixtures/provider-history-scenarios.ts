/**
 * The host-tool scenarios both backends' provider-history probes run (#4846).
 *
 * Each scenario resumes one session over three turns and calls a host bridge
 * tool on every turn; what the host answers changes between turns, while the
 * tools, the system prompt and earlier history must not. Both probes import
 * these tables and handlers, so a scenario cannot exist for one backend only;
 * each `provider-history.test.ts` asserts its capture holds every name here.
 */
import type { ComputeToolCall, ReferenceToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { HistoryCapture } from "../helpers/provider-history.js";

/** The reference lifecycle (#2432): each turn calls the worktree tool, and the host's answer changes between turns. */
export const REFERENCE_ACTIONS = [{ action: "request", repository: "https://github.com/odysseus/ithaca", revision: "main" },
  { action: "renew", worktreeId: "raft-worktree" }, { action: "release", worktreeId: "raft-worktree" }];
/** #2751: shared source moves to a newer commit, then a failed refresh reports the same commit as stale. */
export const SOURCE_FRESHNESS = [{ commit: "1".repeat(40), freshness: "fresh", hour: 0, error: null }, { commit: "2".repeat(40), freshness: "fresh", hour: 1, error: null },
  { commit: "2".repeat(40), freshness: "stale", hour: 1, error: "The Ithaca remote did not answer." }] as const;
/** Scenarios whose every turn calls a reference tool: `reference` withholds the handler on turn 1, the others answer every turn. */
export const REFERENCE_SCENARIOS = ["reference", "renewal", "freshness", "immutable"];
/**
 * External compute (#3108): every turn asks the host for one job's status. Turn 1
 * has no host handler (compute disabled; for Claude the turn is also voice), and
 * the host's answer changes between the other turns; tools, system and earlier
 * history stay put.
 */
export const COMPUTE_STATES = ["running", "running", "succeeded"] as const;
/** Scenarios whose every turn calls a host bridge tool. Both probes run every one. */
export const TOOL_SCENARIOS = [...REFERENCE_SCENARIOS, "compute"];

/** The host bridge handlers `scenario` has on turn `turnIndex`, recording each call into `capture.calls`. */
export function hostToolHandlers(scenario: string, turnIndex: number, capture: HistoryCapture) {
  return {
    ...(scenario === "compute" && turnIndex !== 1 ? { async compute(call: ComputeToolCall) {
      (capture.calls ??= []).push(call);
      return { ok: true as const, job: { id: "cj_ithaca", instance: "boat-small", provider: "boat", state: COMPUTE_STATES[turnIndex]!,
        cleanup: { state: turnIndex === 2 ? "released" : "none" }, cost: { estimate: { usd: null, basis: "none" }, actual: { usd: null, coverage: "unknown", source: "none" } } } };
    } } : {}),
    // The second turn has no host handler: the tool refuses, and the roster must not change.
    ...(REFERENCE_SCENARIOS.includes(scenario) && (scenario !== "reference" || turnIndex !== 1) ? { async referenceAccess(call: ReferenceToolCall) {
      (capture.calls ??= []).push(call);
      if (scenario === "immutable") {
        const content = ["Odysseus charts Ithaca.", "Penelope checks the chart.", "Telemachus stores the chart."][turnIndex]!;
        return { ok: true as const, guidance: "Fixture immutable read.", read: { repository: "https://github.com/odysseus/ithaca", revision: "main", commit: String(turnIndex + 1).repeat(40),
          path: "README.md", offset: 0, length: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), encoding: "utf8" as const, content } };
      }
      if (scenario === "freshness") {
        const step = SOURCE_FRESHNESS[turnIndex]!;
        return { ok: true as const, guidance: "Fixture source step.", source: { repository: "https://github.com/odysseus/ithaca", revision: "main", domain: "public" as const,
          commit: step.commit, path: "/tmp/brain-reference/public/ithaca", freshness: step.freshness, refreshedAt: new Date(Date.UTC(2026, 6, 12, step.hour)).toISOString(),
          validatedAt: new Date(Date.UTC(2026, 6, 12, turnIndex)).toISOString(), error: step.error } };
      }
      const worktree = { id: "raft-worktree", repository: "https://github.com/odysseus/ithaca", revision: "main", domain: "public" as const,
        startingCommit: "1".repeat(40), state: turnIndex === 2 ? "released" as const : "active" as const, path: turnIndex === 2 ? null : "/tmp/brain-worktrees/raft-worktree",
        lastActivityAt: new Date(Date.UTC(2026, 6, 12, turnIndex)).toISOString(), expiresAt: new Date(Date.UTC(2026, 6, 15, turnIndex)).toISOString(),
        releasedAt: turnIndex === 2 ? new Date(Date.UTC(2026, 6, 12, 2)).toISOString() : null, allowanceBytes: 2 ** 31 };
      return { ok: true as const, action: REFERENCE_ACTIONS[turnIndex]!.action as "request", worktree, guidance: "Fixture lifecycle step." };
    } } : {}),
  };
}
