import { REFERENCE_TOOL_CONTRACTS, type ReferenceToolCall, type ReferenceToolResult } from "../../tool-contracts/reference.js";
import type { BackendBridge } from "../backend.js";
/** Refusal messages stay within the contract's 500 bytes, whatever the input was. */
function bounded(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= 500 ? text : `${bytes.subarray(0, 497).toString().replace(/\uFFFD$/, "")}...`;
}
export type ReferenceToolName = (typeof REFERENCE_TOOL_CONTRACTS)[number]["name"];
/**
 * Validate a reference tool's input and run it on the host. Only the parsed
 * input crosses: the host binds principal, turn and worker generation itself.
 * @experimental Backend toolkit; may change before 1.0.
 */
export async function handleReferenceTool(name: ReferenceToolName, input: unknown, bridge: Pick<BackendBridge, "referenceAccess">): Promise<{ text: string; isError: boolean }> {
  const contract = REFERENCE_TOOL_CONTRACTS.find(contract => contract.name === name)!;
  const parsed = contract.input.safeParse(input);
  if (!parsed.success) return { isError: true, text: JSON.stringify({ ok: false, code: "invalid", message: bounded(parsed.error.issues.map(issue => issue.message).join("; ")) }) };
  if (!bridge.referenceAccess) return { isError: true, text: JSON.stringify({ ok: false, code: "unavailable", message: "This host has no managed reference source." }) };
  const result: ReferenceToolResult = await bridge.referenceAccess({ tool: name, input: parsed.data } as ReferenceToolCall);
  return { isError: !result.ok, text: JSON.stringify(result) };
}
