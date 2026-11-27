/**
 * One parsed payload per tool-call object and contract (#4748).
 *
 * The chat store keeps a `ToolCall` object's identity until that call
 * changes, so a payload cached on the object is valid for exactly as long as
 * its output is. Each entry also records the output string it parsed and is
 * reused only while `tool.output` is that same string. A replay or a result
 * hands the row a new object, which misses the cache and parses again: the
 * key is the object, never the tool id.
 *
 * The timeline's header reads a timed copy of the call (the activity span's
 * timing spread over it), while its expanded output reads the store object.
 * `linkToolView` points the copy at the store object, so both reach one entry.
 */

import {
  parseToolPayload,
  type ToolCallView,
  type ToolComponentContract,
  type ToolPayload,
} from "@schlessera/brain-ui-sdk/client";

interface Entry {
  output: string | undefined;
  payload: unknown;
}

const entries = new WeakMap<ToolCallView, Map<ToolComponentContract, Entry>>();
const sources = new WeakMap<ToolCallView, ToolCallView>();

/** Record that `view` is a derived copy of the store tool call `source`. */
export function linkToolView<View extends ToolCallView>(view: View, source: ToolCallView): View {
  if (view !== source) sources.set(view, sources.get(source) ?? source);
  return view;
}

/** `parseToolPayload` for a tool-call object, parsed once per object, contract and output. */
export function cachedToolPayload<Contract extends ToolComponentContract>(
  contract: Contract,
  tool: ToolCallView
): ToolPayload<Contract> | null {
  const key = sources.get(tool) ?? tool;
  let byContract = entries.get(key);
  if (!byContract) {
    byContract = new Map();
    entries.set(key, byContract);
  }
  const hit = byContract.get(contract);
  if (hit && hit.output === tool.output) return hit.payload as ToolPayload<Contract> | null;
  const payload = parseToolPayload(contract, tool.output);
  byContract.set(contract, { output: tool.output, payload });
  return payload;
}
