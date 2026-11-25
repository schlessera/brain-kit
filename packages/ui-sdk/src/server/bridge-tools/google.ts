import { GOOGLE_TOOL_CONTRACTS, type GmailToolName, type GoogleToolCall, type GoogleToolResult } from "../../tool-contracts/google.js";
import type { BackendBridge } from "../backend.js";

/** Refusal messages stay bounded, whatever the input was. */
function bounded(text: string): string {
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

/**
 * Validate a Gmail tool's input and run it on the host (#4207). Only the
 * tool and its parsed input cross: the host binds principal, session and
 * turn, holds the credential and decides the call under the turn's policy.
 * Input that does not parse, an extra key included, refuses `invalid_input`
 * before the host sees it; the issues name the schema's field and the rule,
 * never a value or an unknown key the call supplied. A turn without a host handler refuses `unavailable` (`no_host`). A
 * refusal is a tool error carrying the same envelope.
 *
 * @experimental Backend toolkit; may change before 1.0.
 */
export async function handleGoogleTool(name: GmailToolName, input: unknown, bridge: Pick<BackendBridge, "google">): Promise<{ text: string; isError: boolean }> {
  const contract = GOOGLE_TOOL_CONTRACTS.find(contract => contract.name === name)!;
  const parsed = contract.input.safeParse(input);
  if (!parsed.success) {
    // Zod names an unknown key in its message; the model wrote it, but nothing it supplied is echoed back.
    const message = parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.code === "unrecognized_keys" ? "a field the tool does not take" : issue.message}`).join("; ");
    return { isError: true, text: JSON.stringify({ ok: false, tool: name, error: { code: "invalid_input", reason: "schema", message: bounded(`The input was refused: ${message}.`) } } satisfies GoogleToolResult) };
  }
  if (!bridge.google) {
    return { isError: true, text: JSON.stringify({ ok: false, tool: name, error: { code: "unavailable", reason: "no_host",
      message: "Gmail is not available in this conversation." } } satisfies GoogleToolResult) };
  }
  const result = await bridge.google({ tool: name, input: parsed.data } as GoogleToolCall);
  return { isError: !result.ok, text: JSON.stringify(result) };
}
