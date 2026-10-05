/**
 * The client half of a cross-backend handoff (#61): what the review sheet
 * snapshots from the source transcript, the deterministic draft it falls back
 * to, and the references it suggests. Pure, so the sheet and its tests read
 * one rule.
 */
import {
  HANDOFF_DRAFT_MESSAGES,
  HANDOFF_MAX_CHARS,
  HANDOFF_MAX_REFERENCES,
} from "@schlessera/brain-ui-sdk/protocol";
import type { ChatMessage, SessionChat } from "../stores/chat-state.js";

export interface HandoffSnapshot {
  /** Settled messages, in order; the running turn is not among them. */
  messages: ChatMessage[];
  /** A reply was still running when the snapshot was taken. */
  running: boolean;
  /** Tool calls waiting on the user in the source; they stay there. */
  pendingApprovals: number;
}

/**
 * The source as of now, at its latest settled turn. A running reply and the
 * message that started it are left out: they keep running in the source.
 */
export function snapshotSource(chat: Pick<SessionChat, "messages" | "isStreaming"> | undefined): HandoffSnapshot {
  const all = chat?.messages ?? [];
  let end = all.length;
  const running = Boolean(chat?.isStreaming) || all.some((message) => message.isStreaming);
  if (running) {
    const streaming = all.findIndex((message) => message.isStreaming);
    end = streaming >= 0 ? streaming : all.length;
    // The ask that started the running reply belongs to it.
    while (end > 0 && all[end - 1]!.role === "user") end--;
  }
  const messages = all.slice(0, end);
  const pendingApprovals = all.reduce(
    (n, message) => n + message.toolCalls.filter((tool) => tool.status === "pending_approval").length,
    0
  );
  return { messages, running, pendingApprovals };
}

function firstParagraph(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/\n\s*\n/);
  return (end >= 0 ? trimmed.slice(0, end) : trimmed).trim();
}

/**
 * The draft that needs no model: the user's asks verbatim and the first
 * paragraph of each reply, from the last `HANDOFF_DRAFT_MESSAGES` settled
 * messages, held to `HANDOFF_MAX_CHARS`.
 */
export function deterministicDraft(messages: readonly ChatMessage[]): string {
  const recent = messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-HANDOFF_DRAFT_MESSAGES);
  const lines = recent.map((message) =>
    message.role === "user" ? `Asked: ${message.content.trim()}` : `Answer: ${firstParagraph(message.content)}`
  );
  const text = lines.join("\n\n");
  return text.length > HANDOFF_MAX_CHARS ? text.slice(0, HANDOFF_MAX_CHARS) : text;
}

const PATH_RE = /(?:^|[\s("'`[])((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md)(?=$|[\s)"'`\],.;:!?])/g;

/** Brain-relative paths a string mentions; external links are not paths. */
export function mentionedPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1]!.trim();
    if (path.includes("://") || path.startsWith("/")) continue;
    found.push(path);
  }
  return found;
}

/**
 * Brain files the snapshot mentions, newest first, at most
 * `HANDOFF_MAX_REFERENCES`: paths in the text and in tool inputs.
 */
export function suggestedReferences(messages: readonly ChatMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: unknown) => {
    if (typeof path !== "string" || !path.endsWith(".md") || path.startsWith("/") || path.includes("://")) return;
    const clean = path.replace(/^\.\//, "");
    if (seen.has(clean) || out.length >= HANDOFF_MAX_REFERENCES) return;
    seen.add(clean);
    out.push(clean);
  };
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    for (const tool of message.toolCalls) {
      add(tool.input.path);
      add(tool.input.file_path);
    }
    for (const path of mentionedPaths(message.content)) add(path);
  }
  return out;
}

/** A handoff key the host accepts: letters, digits, `-`, `_`. */
export function mintHandoffId(): string {
  return `h-${crypto.randomUUID()}`;
}
