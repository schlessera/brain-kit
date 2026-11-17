/**
 * The Apify bridge tools (#3162): the same ten fixed operations, names and
 * strict schemas as `brain apify` and the core MCP server's `brain_apify_*`
 * tools, forwarded to the host. Inputs carry the operation's own fields only:
 * principal, session, turn, posture, approval surface, account and spend
 * limits come from the authenticated turn on the host, and a worker never
 * holds the Apify credential. The roster is fixed for a session; choosing an
 * Actor never changes it.
 */
import {
  APIFY_DESCRIPTIONS, APIFY_INPUT_SCHEMAS, APIFY_OPERATIONS, APIFY_TOOL_NAMES,
  type ApifyEnvelope, type ApifyOperation, type ApifyToolName,
} from "@schlessera/brain-common/internal/apify-operations";
import { defineToolContract, type ToolContract } from "./contract.js";

export type { ApifyEnvelope, ApifyErrorCode, ApifyOperation, ApifyToolName } from "@schlessera/brain-common/internal/apify-operations";
export { APIFY_ERROR_CODES, APIFY_GUIDANCE, APIFY_OPERATIONS, APIFY_TOOL_NAMES, apifyOperationOf } from "@schlessera/brain-common/internal/apify-operations";

/** The ten contracts, in the order discovery leads to execution. */
export const APIFY_TOOL_CONTRACTS: readonly ToolContract<ApifyToolName>[] = Object.freeze(APIFY_OPERATIONS.map((operation: ApifyOperation) => defineToolContract({
  name: APIFY_TOOL_NAMES[operation],
  input: APIFY_INPUT_SCHEMAS[operation],
  description: APIFY_DESCRIPTIONS[operation],
  brief: name => `- \`${name}\`: ${APIFY_DESCRIPTIONS[operation]}`,
})));

/** What a backend hands the host: the tool and its parsed input, nothing else. */
export interface ApifyToolCall {
  tool: ApifyToolName;
  input: Record<string, unknown>;
}
export type ApifyToolResult = ApifyEnvelope;
