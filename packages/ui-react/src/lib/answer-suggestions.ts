/**
 * Answer suggestions (#40, D50): the follow-ups the model offers under its
 * own answer, as pure functions so the live transcript and a replayed one go
 * through exactly the same decisions.
 *
 * Every input here is read off the transcript (the message, the messages
 * around it) or off state that is current either way (voice, run state), never
 * off a live-only event. That is what makes a replayed session draw the same
 * closing row the live one did.
 */

import {
  SHOW_BLOCK_CONTRACT,
  parseToolPayload,
  type Block,
} from "@schlessera/brain-ui-sdk/client";
import type { VoiceMode } from "@schlessera/brain-ui-sdk/protocol";

import type { ChatMessage } from "../stores/chat-state.js";
import { isShowBlockTool } from "./tool-names.js";

export type SuggestionsBlock = Extract<Block, { kind: "suggestions" }>;
export type SuggestionsItem = SuggestionsBlock["items"][number];

/** The row label when the model gives none. */
export const DEFAULT_SUGGESTIONS_LABEL = "Ask next";

/**
 * Chips that suggest nothing: exact after case and punctuation folding, so
 * "Tell me more." and "tell me more" both go, and "Tell me more about the
 * Cyclops" stays.
 */
const FILLER = ["Tell me more", "Anything else?", "Can you elaborate?", "What else?"];

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FOLDED_FILLER = new Set(FILLER.map(fold));

/**
 * The turn's suggestions block: the LAST `show_block` call of kind
 * `suggestions` whose echo parses. A rejected or unparsed call is not a
 * candidate — it stays in the tool timeline, where its fallback says why.
 */
export function suggestionsOf(message: ChatMessage): SuggestionsBlock | null {
  let found: SuggestionsBlock | null = null;
  for (const part of message.parts) {
    if (part.kind !== "tool") continue;
    const tool = message.toolCalls[part.toolIndex];
    if (!tool || !isShowBlockTool(tool.name)) continue;
    const payload = parseToolPayload(SHOW_BLOCK_CONTRACT, tool.output);
    if (payload?.block.kind === "suggestions") found = payload.block;
  }
  return found;
}

/**
 * The items worth drawing: duplicates of each other, a restatement of the
 * user's own question, and generic filler are dropped. The schema already
 * trimmed them, bounded them and capped them at two.
 */
export function keptSuggestions(block: SuggestionsBlock, userPrompt: string | undefined): SuggestionsItem[] {
  const asked = userPrompt ? fold(userPrompt) : null;
  const seen = new Set<string>();
  const kept: SuggestionsItem[] = [];
  for (const item of block.items) {
    const label = item.label.trim();
    const key = fold(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key === asked || FOLDED_FILLER.has(key)) continue;
    kept.push({ ...item, label });
  }
  return kept;
}

/** Does the answer's last text end by asking the reader something? */
export function endsWithQuestion(message: ChatMessage): boolean {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]!;
    if (part.kind !== "text" || !part.text.trim()) continue;
    // Closing quotes, brackets, emphasis and trailing whitespace do not hide
    // the question mark: "…is that right?**" still asks.
    return /\?[\s"'”’)\]*_`]*$/u.test(part.text);
  }
  return false;
}

/** The facts the closing row depends on beyond the message itself. */
export interface SuggestionsContext {
  /** Every message of the session, in order. */
  messages: readonly ChatMessage[];
  /** The session still has a turn running or queued. */
  running: boolean;
  voiceMode: VoiceMode;
  /** Voice text waiting in the review card. */
  voiceReviewPending: boolean;
}

/** The user message that started the turn `message` answers. */
export function promptOf(message: ChatMessage, messages: readonly ChatMessage[]): ChatMessage | undefined {
  const index = messages.indexOf(message);
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i];
  }
  return undefined;
}

/**
 * The chips the closing row draws under `message`, or none. One rule for
 * live and replay; each branch is a suppression case from #40 §3.
 */
export function visibleSuggestions(message: ChatMessage, context: SuggestionsContext): SuggestionsItem[] {
  if (message.role !== "assistant") return [];
  // S7: the flip. Any message after this one — a user message, or a newer
  // answer — means the row is gone for good.
  if (context.messages[context.messages.length - 1] !== message) return [];
  // S1: nothing until the turn has ended.
  if (message.isStreaming || context.running) return [];
  // S3: the turn is waiting on the reader's answer.
  if (message.askUserExchanges?.some((exchange) => !exchange.answers && !exchange.order)) return [];
  // S4: an answer that ends in a question has already asked what is next.
  if (endsWithQuestion(message)) return [];
  // S5, S6: voice owns the composer.
  if (context.voiceMode !== "idle" || context.voiceReviewPending) return [];
  const prompt = promptOf(message, context.messages);
  // S9: the reader never saw the answer.
  if (prompt?.source === "voice-conversation") return [];
  // S2: failed turns keep their partial output but make no follow-up offer.
  if (message.failure) return [];
  // S8: no valid call, or nothing survived the drops.
  const block = suggestionsOf(message);
  return block ? keptSuggestions(block, prompt?.content) : [];
}

/**
 * The composer's text after a chip is taken, per #40 §4: the reader's draft
 * is kept byte for byte and the suggestion goes on a line of its own below
 * it; a suggestion already on a line of the draft is not added twice.
 */
export function insertSuggestion(draft: string, label: string): string {
  if (!draft.trim()) return label;
  if (draft.split("\n").some((line) => line.trim() === label)) return draft;
  return draft.endsWith("\n") ? draft + label : `${draft}\n${label}`;
}
