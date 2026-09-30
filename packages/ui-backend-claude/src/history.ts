import {
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatSession,
  MessagePart,
  SessionHistoryMessage,
  TurnFailure,
} from "@schlessera/brain-ui-sdk";
import { subscriptionAuthAction } from "@schlessera/brain-ui-sdk";
import { statusFromText } from "./stream-adapter.js";

/**
 * Session list + transcript reader backed by the Claude Agent SDK's native
 * JSONL persistence (no separate transcript store — the SDK is the source of
 * truth). The SDK functions are injectable so the normalization logic can be
 * unit-tested against recorded transcripts.
 */
export interface HistoryDeps {
  brainPath: string;
  listSessionsFn?: typeof sdkListSessions;
  getSessionMessagesFn?: typeof sdkGetSessionMessages;
}

export interface History {
  listSessions(): Promise<ChatSession[]>;
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
}

export function createHistory(deps: HistoryDeps): History {
  const listSessionsFn = deps.listSessionsFn ?? sdkListSessions;
  const getSessionMessagesFn =
    deps.getSessionMessagesFn ?? sdkGetSessionMessages;
  const dir = deps.brainPath;

  async function listSessions(): Promise<ChatSession[]> {
    let sdkSessions;
    try {
      sdkSessions = await listSessionsFn({ dir });
    } catch {
      return [];
    }

    // Hide automation-initiated sessions (e.g. a `sync` job) from the human
    // conversation list.
    const humanSessions = sdkSessions.filter((s) => {
      const prompt = s.firstPrompt?.trim().toLowerCase() ?? "";
      if (prompt === "/sync" || prompt === "sync") return false;
      return true;
    });

    return humanSessions.map((s) => ({
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || null,
      createdAt: s.createdAt || s.lastModified,
      lastActiveAt: s.lastModified,
      totalCostUsd: 0,
      numTurns: 0,
    }));
  }

  async function getHistory(
    sessionId: string
  ): Promise<SessionHistoryMessage[]> {
    return buildSessionHistory(sessionId, getSessionMessagesFn, dir);
  }

  return { listSessions, getHistory };
}

/**
 * Read a Claude Agent SDK session transcript (JSONL) and fold it into the
 * structured, replay-friendly {@link SessionHistoryMessage} shape the client
 * renders: consecutive same-role entries are merged, tool results are matched
 * to their tool_use blocks, and thinking/text/tool segments keep chronological
 * order via `parts`. Throws if the transcript can't be read.
 */
export async function buildSessionHistory(
  sessionId: string,
  getSessionMessagesFn: typeof sdkGetSessionMessages,
  dir: string
): Promise<SessionHistoryMessage[]> {
  const history = await getSessionMessagesFn(sessionId, { dir });

  // Build a tool result lookup from user messages (tool_result blocks)
  const toolResults = new Map<string, { output: string; isError: boolean }>();
  for (const entry of history) {
    if (entry.type !== "user") continue;
    const content = (entry as any).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as any[]) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const output = Array.isArray(block.content)
          ? block.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("")
          : typeof block.content === "string"
            ? block.content
            : "";
        toolResults.set(block.tool_use_id, {
          output,
          isError: block.is_error ?? false,
        });
      }
    }
  }

  const messages: SessionHistoryMessage[] = [];

  for (const entry of history) {
    const content = (entry as any).message?.content;

    if (entry.type === "user") {
      const text = Array.isArray(content)
        ? content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
        : typeof content === "string"
          ? content
          : "";
      const attachmentCount = Array.isArray(content)
        ? content.filter((b: any) => b.type === "image").length
        : 0;
      if (!text && attachmentCount === 0) continue;

      // Merge with previous user message if consecutive
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        if (text) {
          last.content += last.content ? "\n\n" + text : text;
        }
        if (attachmentCount > 0) {
          last.attachmentCount = (last.attachmentCount ?? 0) + attachmentCount;
        }
      } else {
        messages.push({
          role: "user",
          content: text,
          toolCalls: [],
          ...(attachmentCount > 0 ? { attachmentCount } : {}),
        });
      }
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      // The runtime's own API-error message: the failure that ended the
      // turn, not something the model said. It lands on the assistant
      // message it ended, after any partial answer, as the live frame did.
      const failure = apiErrorFailure((entry as any).message, content);
      if (failure) {
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          last.failure = failure;
        } else {
          messages.push({ role: "assistant", content: "", toolCalls: [], parts: [], failure });
        }
        continue;
      }
      let text = "";
      let thinking = "";
      const toolCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
        output?: string;
        isError?: boolean;
      }> = [];
      // Chronological segments: blocks arrive in true order within each
      // assistant entry (thinking/text/tool_use interleaved).
      const parts: MessagePart[] = [];
      const pushText = (kind: "thinking" | "text", t: string) => {
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.kind === kind) {
          lastPart.text += t;
        } else {
          parts.push({ kind, text: t });
        }
      };

      for (const block of content as any[]) {
        if (block.type === "thinking" && block.thinking) {
          thinking += block.thinking;
          pushText("thinking", block.thinking);
        }
        if (block.type === "text" && block.text) {
          text += block.text;
          pushText("text", block.text);
        }
        if (block.type === "tool_use") {
          const result = toolResults.get(block.id);
          parts.push({ kind: "tool", toolIndex: toolCalls.length });
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input ?? {},
            output: result?.output,
            isError: result?.isError,
          });
        }
      }

      // Merge with previous assistant message if consecutive
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        if (text) last.content += (last.content ? "\n\n" : "") + text;
        if (thinking)
          last.thinking =
            (last.thinking ? last.thinking + "\n\n" : "") + thinking;
        const offset = last.toolCalls.length;
        last.parts = [
          ...(last.parts ?? []),
          ...parts.map((p) =>
            p.kind === "tool" ? { ...p, toolIndex: p.toolIndex + offset } : p
          ),
        ];
        last.toolCalls.push(...toolCalls);
      } else {
        messages.push({
          role: "assistant",
          content: text,
          thinking: thinking || undefined,
          toolCalls,
          parts,
        });
      }
    }
  }

  return messages;
}

/**
 * The model name Claude Code gives the messages it writes itself, API errors
 * among them (`W3t` in the 2.1.x CLI). The SDK's transcript reader drops the
 * entry's `isApiErrorMessage` and `error` fields, so this and the text are all
 * a replay has to recognise one by.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * How Claude Code words the API errors it writes into a transcript: its
 * "API Error" prefix (also mid-text, after "Failed to authenticate."), and the
 * login and billing texts it writes without one. A synthetic message that
 * matches none of them — "No response requested.", a fallback notice — is
 * not a failure and replays as text.
 */
const API_ERROR_TEXTS: ReadonlyArray<{ pattern: RegExp; errorClass: string }> = [
  { pattern: /^Not logged in\b/, errorClass: "authentication_failed" },
  { pattern: /^Failed to authenticate\b/, errorClass: "authentication_failed" },
  { pattern: /^Invalid API key\b/, errorClass: "authentication_failed" },
  { pattern: /^Credit balance is too low\b/, errorClass: "billing_error" },
  { pattern: /^API Error\b/, errorClass: "unknown" },
];

/** What Claude Code writes when a request is aborted: a cancellation. */
const ABORTED_TEXT = /^API Error: Request was aborted\.?$/;

/**
 * The failure a replayed synthetic API-error message records, or null for
 * any other message. The class is read from the text only where the text
 * names it; everything else is `unknown`, and the status is only the one the
 * text states.
 */
export function apiErrorFailure(message: unknown, content: unknown[]): TurnFailure | null {
  if ((message as { model?: unknown } | null)?.model !== SYNTHETIC_MODEL) return null;
  const blocks = content as Array<{ type?: unknown; text?: unknown }>;
  if (!blocks.every((block) => block.type === "text")) return null;
  const text = blocks
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  // A turn the user cancelled is written the same way, and is not a failure.
  if (ABORTED_TEXT.test(text)) return null;
  const known = API_ERROR_TEXTS.find(({ pattern }) => pattern.test(text));
  if (!known) return null;
  const status = statusFromText(text);
  // Only the subscription's own wording earns its instruction: an API key
  // rejected on its own profile is not the subscription's to fix.
  const subscription = /\bOAuth\b|\/login\b/.test(text);
  return {
    errorClass: known.errorClass,
    ...(status !== undefined ? { status } : {}),
    message: text,
    ...(subscription && known.errorClass === "authentication_failed"
      ? { authAction: subscriptionAuthAction(known.errorClass) }
      : {}),
  };
}
