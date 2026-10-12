/** Existing per-use approvals for visible outward calls; this is not an egress grant. */
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { BackendBridge, PermissionDecision } from "./backend.js";
import { bashCommand, type CompiledConfirmPattern } from "./confirm-patterns.js";
import { runMaintenanceWorkerSync } from "./maintenance-worker.js";
import { classifyOutwardCall, outwardTarget, type OutwardClassification, type VisibleOutwardAction } from "./outward-actions.js";

export interface WorkerOutwardRule { readonly command: string; readonly remotes: readonly string[]; readonly index: number }
export interface OutwardPlan {
  classification: OutwardClassification;
  rules: Array<WorkerOutwardRule | null>;
  needsApproval: boolean;
  voiceRefusal: boolean;
  pattern?: CompiledConfirmPattern;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function remoteMatches(pattern: string, target: string): boolean {
  return new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`, "i").test(target);
}
/** Resolve only in the configuration view this running worker actually received. */
export function resolveOutwardGitRemote(action: VisibleOutwardAction, options: {
  configurationRoot?: string; maskPaths?: readonly string[];
}): string | null {
  if (!action.remote || !options.configurationRoot) return null;
  try {
    const root = realpathSync(options.configurationRoot), git = Bun.which("git");
    if (!git) return null;
    const native = realpathSync(git);
    if (native === root || native.startsWith(root + "/")) return null;
    const args = [...(action.gitOptions ?? []), "-c", `safe.directory=${root}`, "remote", "get-url", "--push", "--all", action.remote];
    const result = runMaintenanceWorkerSync({ brainPath: root, command: [native, ...args], env: { PATH: [dirname(native), "/usr/bin:/bin"].join(":") },
      credentials: false, ...(options.maskPaths ? { maskPaths: options.maskPaths } : {}), timeoutMs: 5000 });
    if (result.exitCode !== 0) return null;
    const destinations = result.stdout.trim().split("\n").map(outwardTarget);
    // Multiple push URLs are multiple destinations, not an arbitrary first match.
    return destinations.length === 1 ? destinations[0]! : null;
  } catch { return null; }
}

export function prepareOutwardPlan(options: {
  toolName: string; shellToolName: string; input: unknown; allow?: readonly WorkerOutwardRule[];
  autonomous?: boolean; voice?: boolean; configurationRoot?: string; maskPaths?: readonly string[];
}): OutwardPlan {
  const classification = options.autonomous ? { kind: "unknown" as const, actions: [] } : classifyOutwardCall(options.toolName, options.shellToolName, options.input);
  const rules = classification.actions.map(action => {
    if (action.action === "git_push" && !action.target && !options.voice && !action.historyRewrite && options.allow?.length) action.target = resolveOutwardGitRemote(action, options);
    if (!action.target) return null;
    return options.allow?.find(rule => {
      try { return new RegExp(rule.command, "i").test(action.command) && rule.remotes.some(remote => remoteMatches(remote, action.target!)); }
      catch { return false; }
    }) ?? null;
  });
  const voiceRefusal = options.voice === true && classification.actions.length > 0;
  const needsApproval = classification.actions.some((action, index) => action.historyRewrite || !rules[index]);
  const command = bashCommand(options.input);
  const reason = classification.actions.map(action => `${action.action.replaceAll("_", " ")} to ${action.target ?? "an unresolved destination"}${action.historyRewrite ? " (remote history rewrite always needs approval)" : ""}`).join("; ");
  const pattern = needsApproval && command ? Object.assign(new RegExp(`^${escape(command)}$`, "i"), { effect: `Outward action: ${reason}.` }) : undefined;
  return { classification, rules, needsApproval, voiceRefusal, ...(pattern ? { pattern } : {}) };
}
function bounded(text: string, limit: number): string {
  const suffix = "… [truncated]"; return text.length <= limit ? text : text.slice(0, limit - suffix.length) + suffix;
}
export function observeOutwardPlan(plan: OutwardPlan, options: { bridge?: Pick<BackendBridge, "activity"> | null;
  toolName: string; toolUseId: string; input: unknown; decision: PermissionDecision | "refused" }) {
  const text = JSON.stringify(options.input) ?? "null";
  try {
    options.bridge?.activity?.({ kind: "outward_classification", toolUseId: options.toolUseId, classification: plan.classification });
    for (const [index, action] of plan.classification.actions.entries()) {
      const rule = plan.rules[index];
      const decision = options.decision === "refused" ? "refused" : options.decision.behavior === "deny" ? "declined"
        : !action.historyRewrite && rule ? "policy_allowed" : "approved";
      options.bridge?.activity?.({ kind: "outward_action", toolUseId: options.toolUseId, payload: {
        tool: options.toolName, input: text.slice(0, 8192), inputTruncated: text.length > 8192,
        action: action.action, target: action.target ? bounded(action.target, 2000) : null, historyRewrite: action.historyRewrite,
        tainted: false, decision, rule: rule ? { list: "outward.allow", index: rule.index, pattern: bounded(rule.command, 1000) } : null,
      } });
    }
  } catch { /* Observation cannot grant or revoke admission. */ }
}
export const OUTWARD_VOICE_REFUSAL = "Voice cannot approve an outward action. Nothing ran; use an interactive turn to review it.";
/** Actual syntax coverage; no opaque-script or third-party descriptor promise. */
export function workerOutwardNote(): string {
  return ["# Outward actions", "Visible git pushes, GitHub writes and curl/wget non-GET or data requests require the existing per-use approval unless the admitted outward.allow rule matches the command and its known destination.",
    "Remote force pushes, ref deletion and mirror/prune writes always require approval. Voice cannot approve outward actions.",
    "Opaque scripts making HTTPS requests are not covered by this classification. Egress proxy enforcement is not active here. The shipped backend inventories contain no built-in outward mail, calendar, booking or payment MCP descriptors; third-party tools are not assigned invented effects."].join("\n");
}
