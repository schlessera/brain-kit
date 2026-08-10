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

import { SessionManager } from "@earendil-works/pi-coding-agent";
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
  const messages: AgentMessage[] = [];
  for (const entry of branch) {
    if (entry.type === "message") messages.push(entry.message);
  }
  return normalizeMessages(messages);
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
    typeof msg.content === "string" ? msg.content : textOf(msg.content);
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
  };
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
