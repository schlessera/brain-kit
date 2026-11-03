import { APIFY_TOOL_CONTRACTS, apifyOperationOf, type ApifyToolCall, type ApifyToolName } from "../../tool-contracts/apify.js";
import type { BackendBridge } from "../backend.js";

/**
 * Validate an Apify tool's input and run it on the host (#3162). Only the
 * parsed input crosses: the host binds principal, session, turn, posture and
 * approvals itself, and refuses a turn it does not admit. A refusal is a tool
 * error carrying the same envelope `brain apify --json` prints.
 *
 * @experimental Backend toolkit; may change before 1.0.
 */
export async function handleApifyTool(name: ApifyToolName, input: unknown, bridge: Pick<BackendBridge, "apify">): Promise<{ text: string; isError: boolean }> {
  const operation = apifyOperationOf(name)!;
  const contract = APIFY_TOOL_CONTRACTS.find(contract => contract.name === name)!;
  const parsed = contract.input.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ").slice(0, 500);
    return { isError: true, text: JSON.stringify({ ok: false, operation, error: { code: "invalid_input", reason: null, message } }) };
  }
  if (!bridge.apify) {
    return { isError: true, text: JSON.stringify({ ok: false, operation, error: { code: "provider_disabled", reason: "no_host",
      message: "Apify is not available in this conversation." } }) };
  }
  const result = await bridge.apify({ tool: name, input: parsed.data as Record<string, unknown> } satisfies ApifyToolCall);
  return { isError: !result.ok, text: JSON.stringify(result) };
}
