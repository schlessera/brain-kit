import { parseWebToolInput, type WebModelAccess, type WebToolCall, type WebToolEnvelope, type WebToolName } from "../../tool-contracts/web.js";
import type { BackendBridge } from "../backend.js";

/**
 * Validate one web tool call and forward it to the host (#3685). Only the
 * parsed input and the model's call id cross: the host binds principal,
 * session, turn, grant, profile, policy revision and cancellation itself. A
 * refusal, an unsupported feature and an executor failure are tool errors
 * carrying the envelope as JSON. A backend that relays the turn's inference
 * on the host passes that admitted model (#3688); nothing else names one.
 *
 * @experimental Backend toolkit; may change before 1.0.
 */
export async function handleWebTool(name: WebToolName, input: unknown, bridge: Pick<BackendBridge, "webAccess">, toolCallId: string,
  model?: WebModelAccess): Promise<{ text: string; isError: boolean }> {
  const parsed = parseWebToolInput(name, input);
  if (!parsed.ok) {
    const envelope: WebToolEnvelope = { ok: false, tool: name, error: { code: parsed.code, message: parsed.message, ...(parsed.feature ? { feature: parsed.feature } : {}) } };
    return { isError: true, text: JSON.stringify(envelope) };
  }
  if (!bridge.webAccess) {
    const envelope: WebToolEnvelope = { ok: false, tool: name, error: { code: "unavailable", message: "Web tools are not available in this conversation." } };
    return { isError: true, text: JSON.stringify(envelope) };
  }
  const result = await bridge.webAccess({ tool: name, input: parsed.input, toolCallId, ...(model ? { model } : {}) } satisfies WebToolCall);
  return { isError: !result.ok, text: JSON.stringify(result) };
}
