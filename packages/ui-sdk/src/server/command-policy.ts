/** Captured host policy, consumed by the existing permission paths (#1661). */
import type { BackendBridge, PermissionDecision, PermissionRequest } from "./backend.js";
import { bashCommand, compileConfirmPatterns, type CompiledConfirmPattern } from "./confirm-patterns.js";
import { requestToolPermission, type RequestToolPermissionOptions } from "./permission-gate.js";

export interface WorkerCommandRule {
  readonly pattern: string;
  readonly reason?: string;
  /** Original position in the policy file, including skipped invalid entries. */
  readonly index: number;
}
export interface WorkerCommandPolicy {
  readonly outwardAllow?: readonly import("./outward-policy.js").WorkerOutwardRule[];
  readonly hash: string | null;
  readonly deny: readonly WorkerCommandRule[];
  readonly confirm: readonly WorkerCommandRule[];
}
type CompiledRule = CompiledConfirmPattern & { readonly rule: WorkerCommandRule };
export interface CompiledWorkerCommandPolicy {
  readonly hash: string | null;
  readonly deny: readonly CompiledRule[];
  readonly confirm: readonly CompiledRule[];
}

export function compileWorkerCommandPolicy(policy?: WorkerCommandPolicy): CompiledWorkerCommandPolicy {
  const compile = (rules: readonly WorkerCommandRule[]) => rules.map(rule => {
    const [pattern] = compileConfirmPatterns([rule.reason ? { pattern: rule.pattern, effect: rule.reason } : rule.pattern], () => {});
    return Object.assign(pattern!, { rule: Object.freeze({ ...rule }) });
  });
  return { hash: policy?.hash ?? null, deny: compile(policy?.deny ?? []), confirm: compile(policy?.confirm ?? []) };
}

function match(rules: readonly CompiledRule[], toolName: string, shellToolName: string, input: unknown): CompiledRule | undefined {
  if (toolName !== shellToolName) return undefined;
  const command = bashCommand(input);
  return command ? rules.find(pattern => pattern.test(command)) : undefined;
}

function bounded(value: string, limit: number): string {
  const suffix = "… [truncated]";
  return value.length <= limit ? value : value.slice(0, limit - suffix.length) + suffix;
}
function payload<L extends "commands.deny" | "commands.confirm">(policy: CompiledWorkerCommandPolicy, rule: WorkerCommandRule, list: L,
  toolName: string, input: unknown) {
  const text = JSON.stringify(input) ?? "null";
  return { tool: toolName, input: text.slice(0, 8192), inputTruncated: text.length > 8192,
    rule: { list, index: rule.index, pattern: bounded(rule.pattern, 1000),
      ...(rule.reason !== undefined ? { reason: bounded(rule.reason, 2000) } : {}) }, policyHash: policy.hash };
}

/** A deny precedes every shortcut, approval wait, edited admission and lock acquisition. */
export function denyWorkerCommand(policy: CompiledWorkerCommandPolicy, options: {
  bridge?: Pick<BackendBridge, "activity"> | null; toolName: string; shellToolName: string; input: unknown; toolUseId: string;
}): string | null {
  const matched = match(policy.deny, options.toolName, options.shellToolName, options.input);
  if (!matched) return null;
  const message = `Policy commands.deny[${matched.rule.index}] refused this command: ${matched.rule.reason || matched.rule.pattern} Nothing ran.`;
  try {
    options.bridge?.activity?.({ kind: "policy_block", toolUseId: options.toolUseId,
      payload: payload(policy, matched.rule, "commands.deny", options.toolName, options.input) });
    options.bridge?.activity?.({ kind: "permission_denied", toolUseId: options.toolUseId, requestKind: "command", reason: message });
  } catch { /* Observation cannot turn a refusal into a grant. */ }
  return message;
}

/** Same card/authority/snapshot mechanism; policy confirmation is always per use. */
export async function requestPolicyPermission(policy: CompiledWorkerCommandPolicy, options: {
  bridge?: BackendBridge | null; request: PermissionRequest; shellToolName: string;
  permission: RequestToolPermissionOptions; signal?: AbortSignal | null;
}): Promise<PermissionDecision> {
  const { bridge, request, permission, signal } = options;
  const matched = request.kind === "command" ? match(policy.confirm, request.toolName, options.shellToolName, request.input) : undefined;
  const record = (decision: "approved" | "declined" | "cancelled") => {
    if (!matched) return;
    try { bridge?.activity?.({ kind: "policy_confirm", toolUseId: request.toolUseId,
      payload: { ...payload(policy, matched.rule, "commands.confirm", request.toolName, request.input), decision } }); }
    catch { /* The actual permission decision stands. */ }
  };
  try {
    const decision = await requestToolPermission(bridge, request, permission);
    if (signal?.aborted) {
      record("cancelled");
      return { behavior: "deny", message: "Turn cancelled before tool admission. Nothing ran." };
    }
    record(decision.behavior === "allow" ? "approved" : "declined");
    return decision;
  } catch (error) { record(signal?.aborted ? "cancelled" : "declined"); throw error; }
}

/** Disclose the same captured sources and operator patterns the adapters enforce. */
export function workerCommandPolicyNote(policy: WorkerCommandPolicy | undefined,
  configured: readonly CompiledConfirmPattern[]): string {
  if (!policy) return "";
  const describe = (list: "deny" | "confirm") => policy[list].map(rule =>
    `- commands.${list}[${rule.index}]: ${JSON.stringify(rule.pattern)}${rule.reason ? ` — ${JSON.stringify(rule.reason)}` : ""}`);
  return ["# Command rules in this turn", "Patterns match the Bash command input case-insensitively; approved edits are rechecked.",
    "Denied before execution:", ...(policy.deny.length ? describe("deny") : ["- No policy deny patterns."]),
    "Requires the existing per-use approval:", ...describe("confirm"),
    ...configured.map(pattern => `- Configured confirmation: ${JSON.stringify(pattern.source)}${pattern.effect ? ` — ${JSON.stringify(pattern.effect)}` : ""}`),
    ...(!policy.confirm.length && !configured.length ? ["- No confirmation patterns."] : []),
  ].join("\n");
}
