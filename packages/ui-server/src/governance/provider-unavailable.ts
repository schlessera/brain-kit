import { parseProviderUnavailable } from "@schlessera/brain-common/internal/provider-unavailable";

import type { GovernanceEventPayload } from "./events.js";

/**
 * Unavailable providers, read from a tool's result (#1666). A governed or
 * strict turn worker holds no provider key its own inference does not need,
 * so a `brain` command that needs one prints a notice ending in a fixed token
 * (`@schlessera/brain-common/internal/provider-unavailable`). The recorder
 * turns each distinct token in a result into one `provider_unavailable`
 * governance event, as the roadblock classifier reads failures from the
 * output the host already relays.
 *
 * The token is text in tool output, so anything the agent prints or fetches
 * can produce one. The record is diagnostic: it grants nothing, and the
 * recorder caps how many a turn writes.
 */

/** Most `provider_unavailable` events one turn records. */
export const MAX_PROVIDER_UNAVAILABLE_PER_TURN = 20;
const MAX_COMMAND = 2000;

/** The command a shell call ran, or the tool's name for any other tool. */
function commandOf(tool: string, input: unknown): string {
  const command = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  const text = typeof command === "string" ? command : tool;
  return text.length > MAX_COMMAND ? text.slice(0, MAX_COMMAND) : text;
}

/** One payload per distinct notice token in `output`. */
export function providerUnavailablePayloads(tool: string, input: unknown, output: string): GovernanceEventPayload<"provider_unavailable">[] {
  const found = parseProviderUnavailable(output);
  if (!found.length) return [];
  const command = commandOf(tool, input);
  return found.map(({ provider, capability, degradedTo }) => ({ provider, capability, command, degradedTo }));
}
