import { COMPUTE_TOOL_CONTRACTS, type ComputeToolCall, type ComputeToolName, type ComputeToolResult } from "../../tool-contracts/compute.js";
import type { BackendBridge } from "../backend.js";

/** Refusal messages stay bounded, whatever the input was. */
function bounded(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= 500 ? text : `${bytes.subarray(0, 497).toString().replace(/�$/, "")}...`;
}

const refusal = (code: "policy_denied" | "compute_disabled", message: string): ComputeToolResult => ({ ok: false, error: { code, message: bounded(message) } });

/**
 * Validate an external compute tool's input and run it on the host (#3108).
 * Only the parsed input and the model's call id cross: the host binds the
 * caller, the turn's policy and every credential itself. Input that does not
 * parse, extra keys included, refuses with `policy_denied` before the host
 * sees it; a turn without a host handler refuses with `compute_disabled`.
 * @experimental Backend toolkit; may change before 1.0.
 */
export async function handleComputeTool(name: ComputeToolName, input: unknown, bridge: Pick<BackendBridge, "compute">, toolUseId?: string): Promise<{ text: string; isError: boolean }> {
  const contract = COMPUTE_TOOL_CONTRACTS.find(contract => contract.name === name)!;
  const parsed = contract.input.safeParse(input);
  if (!parsed.success) return { isError: true, text: JSON.stringify(refusal("policy_denied", parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "))) };
  if (!bridge.compute) return { isError: true, text: JSON.stringify(refusal("compute_disabled", "External compute is not available in this turn.")) };
  const result = await bridge.compute({ tool: name, input: parsed.data, ...(toolUseId ? { toolUseId } : {}) } as ComputeToolCall);
  return { isError: !result.ok, text: JSON.stringify(result) };
}
