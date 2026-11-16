import { GITHUB_TOOL_CONTRACTS, type GithubToolCall, type GithubToolName, type GithubToolResult } from "../../tool-contracts/github.js";
import type { BackendBridge } from "../backend.js";

/** Refusal messages stay bounded, whatever the input was. */
function bounded(text: string): string {
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

/**
 * Validate a GitHub tool's input and run it on the host (#3797). Only the
 * tool and its parsed input cross: the host binds principal, session and
 * turn and holds the credential. Input that does not parse, an extra key
 * included, refuses `invalid_input` before the host sees it; a turn without
 * a host handler refuses `unavailable` (`no_host`). A refusal is a tool error
 * carrying the same envelope.
 *
 * @experimental Backend toolkit; may change before 1.0.
 */
export async function handleGithubTool(name: GithubToolName, input: unknown, bridge: Pick<BackendBridge, "github">): Promise<{ text: string; isError: boolean }> {
  const contract = GITHUB_TOOL_CONTRACTS.find(contract => contract.name === name)!;
  const parsed = contract.input.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    return { isError: true, text: JSON.stringify({ ok: false, tool: name, error: { code: "invalid_input", reason: null, message: bounded(message) } } satisfies GithubToolResult) };
  }
  if (!bridge.github) {
    return { isError: true, text: JSON.stringify({ ok: false, tool: name, error: { code: "unavailable", reason: "no_host",
      message: "GitHub is not available in this conversation." } } satisfies GithubToolResult) };
  }
  const result = await bridge.github({ tool: name, input: parsed.data } as GithubToolCall);
  return { isError: !result.ok, text: JSON.stringify(result) };
}
