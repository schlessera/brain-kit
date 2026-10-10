import type { AskUserRankSpec } from "../../protocol.js";
import { ASK_USER_RANK_INPUT_SCHEMA, type AskUserRankInput, type AskUserRankPayload } from "../../tool-contracts/index.js";
import type { AskUserRankResult, BackendBridge } from "../backend.js";

/** Checks that JSON Schema cannot express without expanding the prompt. */
export function askUserRankSpec(input: AskUserRankInput): AskUserRankSpec {
  const spec = ASK_USER_RANK_INPUT_SCHEMA.parse(input);
  if (new Set(spec.items.map((item) => item.id)).size !== spec.items.length) {
    throw new Error("ask_user_rank: item ids must be unique.");
  }
  if (spec.cutoff !== undefined && spec.cutoff > spec.items.length) {
    throw new Error("ask_user_rank: cutoff cannot exceed the item count.");
  }
  return spec;
}

/** Never forward a client-invented id or trust its claim of agreement. */
export function askUserRankPayload(spec: AskUserRankSpec, result: AskUserRankResult): AskUserRankPayload {
  const ids = spec.items.map((item) => item.id);
  const allowed = new Set(ids);
  if (result.order.length !== ids.length || new Set(result.order).size !== ids.length || result.order.some((id) => !allowed.has(id))) {
    throw new Error("ask_user_rank: order must be a complete permutation of the requested item ids.");
  }
  return { order: [...result.order], unchanged: ids.every((id, index) => id === result.order[index]) };
}

/**
 * Run `ask_user_rank` through the host bridge and check the returned order.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export async function handleAskUserRank(
  input: AskUserRankInput,
  bridge: BackendBridge,
  requestId: string = crypto.randomUUID()
): Promise<AskUserRankPayload> {
  if (!bridge.askUserRank) throw new Error("The host does not support ask_user_rank in this session.");
  const spec = askUserRankSpec(input);
  return askUserRankPayload(spec, await bridge.askUserRank(requestId, spec));
}
