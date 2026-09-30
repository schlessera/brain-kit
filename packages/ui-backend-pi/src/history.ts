/**
 * Session listing + history normalization for the pi backend.
 *
 * pi persists conversations as append-only JSONL trees (SessionManager). The
 * backend owns those raw transcripts; here we normalize the *active branch*
 * (leaf → root) into the wire protocol's SessionHistoryMessage[] at read time.
 *
 * pi's message model keeps tool calls inside the assistant message and tool
 * results as separate `toolResult` messages; the wire shape instead nests each
 * tool call (with its output) under the assistant message, so we thread results
 * back onto the assistant tool call they belong to.
 */

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import type {
  ChatSession,
  MessagePart,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/server";

import { failureFromPiError } from "./turn-failure.js";

/** List the pi sessions rooted at this brain repo, newest activity first. */
export async function listPiSessions(
  cwd: string,
  sessionDir?: string
): Promise<ChatSession[]> {
  const infos = await SessionManager.list(cwd, sessionDir);
  const sessions = infos.map((info) => ({
    id: info.id,
    title: info.name ?? firstLine(info.firstMessage) ?? null,
    createdAt: info.created.getTime(),
    lastActiveAt: info.modified.getTime(),
    // Cost/turn aggregates are the host's responsibility (brain-ui keeps a
    // sessions metadata table); computing them here would mean loading every
    // transcript on every list. Left at 0 — see getHistory for per-session cost.
    totalCostUsd: 0,
    numTurns: 0,
  }));
  return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/**
 * Normalize one session's active branch into SessionHistoryMessage[].
 * Returns [] for an unknown sessionId (the host renders an empty transcript).
 */
export async function getPiHistory(
  cwd: string,
  sessionId: string,
  sessionDir?: string
): Promise<SessionHistoryMessage[]> {
  const infos = await SessionManager.list(cwd, sessionDir);
  const info = infos.find((i) => i.id === sessionId);
  if (!info) return [];

  const sm = SessionManager.open(info.path, sessionDir);
  // getBranch() returns the active path root → leaf (chronological order).
  const branch = sm.getBranch();
  const omitted = retriedAttempts(branch);
  const messages: AgentMessage[] = [];
  for (const entry of branch) {
    if (entry.type === "message" && !omitted.has(entry.id)) messages.push(entry.message);
  }
  return normalizeMessages(messages);
}

/**
 * The failed answers pi retried. pi keeps a failed attempt in the transcript
 * and omits it from the model's context with a `context_edit` whose
 * replacement is null (`_omitRecoveryAttempt`, pi-coding-agent 0.87.1). The
 * user saw the turn go on, so the replay does not show a failure for it.
 * Only a failed answer is skipped: nothing else this edit reaches is hidden.
 */
export function retriedAttempts(branch: ReadonlyArray<SessionEntry>): Set<string> {
  const edited = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "context_edit" && entry.replacement === null) edited.add(entry.targetId);
  }
  const omitted = new Set<string>();
  for (const entry of branch) {
    if (
      entry.type === "message" &&
      edited.has(entry.id) &&
      "role" in entry.message &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error"
    ) {
      omitted.add(entry.id);
    }
  }
  return omitted;
}

/** Exported for unit tests: pure AgentMessage[] → SessionHistoryMessage[]. */
export function normalizeMessages(messages: AgentMessage[]): SessionHistoryMessage[] {
  const out: SessionHistoryMessage[] = [];
  // toolCallId → the toolCalls entry to backfill when its result arrives.
  const toolLoc = new Map<string, SessionHistoryMessage["toolCalls"][number]>();

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        out.push(normalizeUser(msg as UserMessage));
        break;
      }
      case "assistant": {
        out.push(normalizeAssistant(msg as AssistantMessage, toolLoc));
        break;
      }
      case "toolResult": {
        const r = msg as ToolResultMessage;
        const call = toolLoc.get(r.toolCallId);
        if (call) {
          call.output = textOf(r.content);
          call.isError = r.isError;
        }
        break;
      }
      default:
        // bashExecution / custom / branchSummary / compactionSummary — not
        // conversation turns in the wire model. `parts` is additive; these are
        // deliberately flattened out.
        break;
    }
  }
  return out;
}

function normalizeUser(msg: UserMessage): SessionHistoryMessage {
  const content =
    typeof msg.content === "string"
      ? msg.content
      : stripImageNotes(textOf(msg.content));
  const attachmentCount =
    typeof msg.content === "string"
      ? 0
      : msg.content.filter((p) => p.type === "image").length;
  return {
    role: "user",
    content,
    toolCalls: [],
    ...(attachmentCount > 0 ? { attachmentCount } : {}),
  };
}

function normalizeAssistant(
  msg: AssistantMessage,
  toolLoc: Map<string, SessionHistoryMessage["toolCalls"][number]>
): SessionHistoryMessage {
  const toolCalls: SessionHistoryMessage["toolCalls"] = [];
  const parts: MessagePart[] = [];
  let content = "";
  let thinking = "";

  for (const part of msg.content) {
    if (part.type === "text") {
      content += (part as TextContent).text;
      parts.push({ kind: "text", text: (part as TextContent).text });
    } else if (part.type === "thinking") {
      thinking += (part as ThinkingContent).thinking;
      parts.push({ kind: "thinking", text: (part as ThinkingContent).thinking });
    } else if (part.type === "toolCall") {
      const call = part as ToolCall;
      const entry = {
        id: call.id,
        name: call.name,
        input: call.arguments as Record<string, unknown>,
      };
      const toolIndex = toolCalls.length;
      toolCalls.push(entry);
      toolLoc.set(call.id, entry);
      parts.push({ kind: "tool", toolIndex });
    }
  }

  return {
    role: "assistant",
    content,
    ...(thinking ? { thinking } : {}),
    toolCalls,
    parts,
    // The provider failure that ended the turn, as the live result reported
    // it (#575); the partial answer before it stays in `content`.
    ...(msg.stopReason === "error" ? { failure: failureFromPiError(msg.errorMessage) } : {}),
  };
}

/**
 * One note pi writes about an attached image: that it was omitted, converted,
 * or resized (`processImage` and `formatDimensionNote`, pi-coding-agent's
 * `dist/utils/image-process.js`).
 */
const IMAGE_NOTE =
  String.raw`\[Image(?: omitted: [^\n]*| converted from [^\n]*|: original \d+x\d+, displayed at \d+x\d+\. [^\n]*)\]`;
const TRAILING_IMAGE_NOTES = new RegExp(String.raw`\n\n${IMAGE_NOTE}(?:\n${IMAGE_NOTE})*$`);

/**
 * The user's own text, without the image notes pi appended to it.
 *
 * When `AgentSession.prompt` normalises attached images it appends a note per
 * image it resized, converted or dropped, after a blank line, to the text it
 * stores (pi-coding-agent 0.87.1, `dist/core/agent-session.js`). Those notes
 * are pi telling the model about the image, not anything the user wrote, and
 * the host joins what it kept about a message (its source) by the message's
 * text as sent. Only a trailing run of notes after a blank line is removed.
 */
export function stripImageNotes(text: string): string {
  return text.replace(TRAILING_IMAGE_NOTES, "");
}

/** Join the text parts of a pi content array (images/other parts ignored). */
function textOf(content: (TextContent | ImageContent)[]): string {
  return content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function firstLine(text: string | undefined): string | null {
  if (!text) return null;
  const line = text.split("\n")[0]?.trim();
  return line ? line.slice(0, 120) : null;
}
