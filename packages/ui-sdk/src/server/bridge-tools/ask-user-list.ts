import type { AskUserListSpec } from "../../protocol.js";
import {
  ASK_USER_LIST_LIMITS,
  type AskUserListInput,
  type AskUserListPayload,
} from "../../tool-contracts/index.js";
import type { AskUserListResult, BackendBridge } from "../backend.js";

/**
 * The request with its defaults applied, after the checks the input schema
 * cannot express: ids and scale labels must be unique, because an answer is
 * keyed by the one and names the other. Refused here, before any card is
 * drawn, so the model reads which duplicate to fix.
 */
export function askUserListSpec(input: AskUserListInput): AskUserListSpec {
  const ids = new Set<string>();
  for (const item of input.items) {
    if (ids.has(item.id)) {
      throw new Error(`ask_user_list: item id "${item.id}" is used twice; ids must be unique.`);
    }
    ids.add(item.id);
  }
  const labels = new Set<string>();
  for (const option of input.scale) {
    if (labels.has(option.label)) {
      throw new Error(
        `ask_user_list: scale option "${option.label}" is listed twice; labels must be unique.`
      );
    }
    labels.add(option.label);
  }
  return {
    prompt: input.prompt,
    scale: input.scale.map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    items: input.items.map((i) => ({
      id: i.id,
      label: i.label,
      ...(i.detail ? { detail: i.detail } : {}),
      ...(i.link ? { link: i.link } : {}),
    })),
    allowSkip: input.allowSkip ?? true,
    notes: input.notes ?? false,
  };
}

/**
 * The client's answer, held to the request it answers. An answer for an id the
 * request never had, or naming an option the scale never offered, is dropped
 * rather than passed on: the model acts on this result, and the client is the
 * less trusted of the two. Every item without a kept answer is skipped, in
 * item order, so `answers` and `skipped` always partition the list.
 */
export function askUserListPayload(
  spec: AskUserListSpec,
  result: AskUserListResult
): AskUserListPayload {
  const labels = new Set(spec.scale.map((o) => o.label));
  const answers: Record<string, string> = {};
  const skipped: string[] = [];
  for (const item of spec.items) {
    const answer = Object.hasOwn(result.answers, item.id) ? result.answers[item.id] : undefined;
    if (answer !== undefined && labels.has(answer)) answers[item.id] = answer;
    else skipped.push(item.id);
  }
  const notes: Record<string, string> = {};
  if (spec.notes && result.notes) {
    for (const item of spec.items) {
      const note = Object.hasOwn(result.notes, item.id) ? result.notes[item.id] : undefined;
      const trimmed = note?.trim().slice(0, ASK_USER_LIST_LIMITS.maxNote);
      if (trimmed) notes[item.id] = trimmed;
    }
  }
  return {
    answers,
    skipped,
    ...(Object.keys(notes).length ? { notes } : {}),
  };
}

export async function handleAskUserList(
  input: AskUserListInput,
  bridge: BackendBridge,
  requestId: string = crypto.randomUUID()
): Promise<AskUserListPayload> {
  if (!bridge.askUserList) {
    throw new Error("The host does not support ask_user_list in this session.");
  }
  const spec = askUserListSpec(input);
  const result = await bridge.askUserList(requestId, spec);
  // With allowSkip false the card holds Submit until every item is answered;
  // a response that still arrives short is not refused — the user did answer
  // the rest — and `skipped` names what is missing.
  return askUserListPayload(spec, result);
}
