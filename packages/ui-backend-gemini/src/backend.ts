/**
 * @brainform/ui-backend-gemini — an AgentBackend built directly on Google's
 * @google/genai model SDK.
 *
 * Unlike the pi and Claude SDK backends, @google/genai supplies neither an
 * agent loop nor transcript persistence. This package streams model parts
 * directly into the brain-ui protocol, executes the curated tool surface with
 * permission gating, preserves raw Content parts (including thoughtSignature)
 * across tool calls, and stores resumable sessions as atomic JSON files.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  GoogleGenAI,
  type FunctionCall,
  type Part,
} from "@google/genai";

import {
  BackendBusyError,
  BackendRequestError,
  createWriteLock,
  type AgentBackend,
  type BackendCapabilities,
  type MessagePart,
  type ProviderInfo,
  type ServerMessage,
  type SessionHistoryMessage,
  type StartTurnRequest,
  type WriteLock,
} from "@brainform/ui-sdk/server";

import { createBrainAccess } from "./brain-access";
import {
  createGeminiSessionStore,
  type StoredSession,
} from "./session-store";
import {
  callTool,
  GEMINI_FUNCTION_DECLARATIONS,
} from "./tools";
import { createTurnContext, type TurnContext } from "./turn-context";

export const GEMINI_BACKEND_ID = "gemini";
const DEFAULT_MODEL = "gemini-3.5-flash";
const MAX_IN_MEMORY_SESSIONS = 5;
// Per-turn model-call cap: a runaway backstop only. The host's 10-minute turn
// timeout (AbortController) is the real bound; agentic tasks legitimately need
// many read→edit→run→observe rounds, so keep this high enough to never clip
// normal work.
const MAX_AGENT_ITERATIONS = 200;

const CAPABILITIES: BackendCapabilities = {
  resume: true,
  permissions: true,
  thinking: true,
  attachments: true,
  askUser: true,
  costReporting: false,
  concurrentSessions: true,
  followUp: false,
};

export interface GeminiProfile {
  id: string;
  label: string;
  vendor?: string;
  model: string;
}

export interface CreateGeminiBackendOptions {
  /** Absolute path to the brain repository (the agent's working tree). */
  brainPath: string;
  /** Defaults to GEMINI_API_KEY, then GOOGLE_API_KEY. */
  apiKey?: string;
  /** Default model for deployments without explicit profiles. */
  model?: string;
  /** Selectable model profiles. First is the default for new sessions. */
  profiles?: GeminiProfile[];
  /** Default: <brainPath>/.brainform-ui/gemini-sessions. */
  sessionDir?: string;
  /** Shared advisory mutex for mutating tools. */
  writeLock?: WriteLock;
}

interface SessionEntry {
  store: StoredSession;
  turnContext: TurnContext;
  running: boolean;
}

interface ResolvedModel {
  model: string;
  providerId?: string;
}

interface PendingFunctionCall {
  name: string;
  args: Record<string, unknown>;
  toolUseId: string;
  /** Provider id is echoed in FunctionResponse when Gemini supplied one. */
  providerCallId?: string;
  historyEntry: SessionHistoryMessage["toolCalls"][number];
}

export function createGeminiBackend(options: CreateGeminiBackendOptions): AgentBackend {
  const brainPath = options.brainPath;
  const apiKey =
    options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const ai = new GoogleGenAI({ apiKey });
  const systemInstruction = buildSystemInstruction(brainPath);
  const sessionDir =
    options.sessionDir ?? join(brainPath, ".brainform-ui", "gemini-sessions");
  const sessionStore = createGeminiSessionStore(sessionDir);
  const brain = createBrainAccess(brainPath);
  const writeLock = options.writeLock ?? createWriteLock();

  // Insertion order is LRU order: touch() re-inserts at the tail and eviction
  // removes idle entries from the head. Raw transcripts remain on disk.
  const sessions = new Map<string, SessionEntry>();

  function resolveModel(profileId?: string): ResolvedModel {
    const profiles = options.profiles;
    if (profileId) {
      const profile = profiles?.find((candidate) => candidate.id === profileId);
      if (profile) return { model: profile.model, providerId: profile.id };

      // Direct resource-style ids (models/foo, tunedModels/foo, vendor/model)
      // remain usable without inventing vendor/model parsing.
      if (profileId.includes("/")) {
        return { model: profileId, providerId: profileId };
      }

      // The implicit profile advertised by listProfiles().
      if ((!profiles || profiles.length === 0) && profileId === GEMINI_BACKEND_ID) {
        return {
          model: options.model ?? DEFAULT_MODEL,
          providerId: GEMINI_BACKEND_ID,
        };
      }
      throw new BackendRequestError(`Unknown profileId: ${profileId}`);
    }

    if (profiles && profiles.length > 0) {
      return { model: profiles[0].model, providerId: profiles[0].id };
    }
    return {
      model: options.model ?? DEFAULT_MODEL,
      providerId: GEMINI_BACKEND_ID,
    };
  }

  /**
   * Resolve and claim one session. Busy/unknown/profile errors happen here,
   * before startTurn creates its scoped emitter or sends any frame.
   */
  async function acquire(
    req: StartTurnRequest
  ): Promise<{ entry: SessionEntry; isNew: boolean }> {
    if (req.sessionId) {
      const existing = sessions.get(req.sessionId);
      if (existing) {
        if (existing.running) {
          throw new BackendBusyError(GEMINI_BACKEND_ID, req.sessionId);
        }
        existing.running = true;
        touch(req.sessionId);
        return { entry: existing, isNew: false };
      }

      const stored = await sessionStore.load(req.sessionId);
      if (!stored) {
        throw new BackendRequestError(
          `Cannot resume unknown session: ${req.sessionId}`
        );
      }

      // Another resume may have populated the resident map while disk I/O was
      // in flight. Reuse it rather than clobbering its mutable TurnContext.
      const raced = sessions.get(req.sessionId);
      if (raced) {
        if (raced.running) {
          throw new BackendBusyError(GEMINI_BACKEND_ID, req.sessionId);
        }
        raced.running = true;
        touch(req.sessionId);
        return { entry: raced, isNew: false };
      }

      const entry: SessionEntry = {
        store: stored,
        turnContext: createTurnContext(),
        running: true,
      };
      register(entry);
      return { entry, isNew: false };
    }

    const resolved = resolveModel(req.profileId);
    const stored = sessionStore.create({
      id: crypto.randomUUID(),
      model: resolved.model,
      providerId: resolved.providerId,
    });
    const entry: SessionEntry = {
      store: stored,
      turnContext: createTurnContext(),
      running: true,
    };
    register(entry);
    return { entry, isNew: true };
  }

  function register(entry: SessionEntry): void {
    sessions.set(entry.store.id, entry);
  }

  /** Move a reused session to the LRU tail so eviction favours colder entries. */
  function touch(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    sessions.set(sessionId, entry);
  }

  /** Remove idle resident state LRU-first until the five-session cap is met. */
  function evictIdle(): void {
    if (sessions.size <= MAX_IN_MEMORY_SESSIONS) return;
    for (const [id, entry] of sessions) {
      if (sessions.size <= MAX_IN_MEMORY_SESSIONS) break;
      if (entry.running) continue;
      sessions.delete(id);
    }
  }

  return {
    id: GEMINI_BACKEND_ID,
    capabilities: CAPABILITIES,

    listProfiles(): ProviderInfo[] {
      if (options.profiles && options.profiles.length > 0) {
        return options.profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          vendor: profile.vendor,
        }));
      }
      return [
        {
          id: GEMINI_BACKEND_ID,
          label: options.model ?? "Gemini 3.5 Flash",
          vendor: "google",
        },
      ];
    },

    async startTurn(req: StartTurnRequest): Promise<void> {
      const startedAt = Date.now();

      // Caller errors reject before any frame, exactly as required by rev 2.
      const { entry, isNew } = await acquire(req);
      const { store, turnContext } = entry;
      const sessionId = store.id;
      const emit = (message: ServerMessage) =>
        req.bridge.emit(scopeFrame(message, sessionId));

      turnContext.bridge = req.bridge;
      turnContext.signal = req.signal;

      // Passing req.signal into GenerateContentConfig aborts HTTP consumption;
      // returning the active generator also stops local chunk iteration.
      let closeActiveStream: (() => Promise<unknown>) | null = null;
      const onAbort = () => {
        if (closeActiveStream) void closeActiveStream();
      };
      req.signal.addEventListener("abort", onAbort, { once: true });

      emit({
        type: "session_info",
        sessionId,
        isNew,
        ...(store.providerId ? { providerId: store.providerId } : {}),
      });

      appendUserMessage(store, req);
      emit({ type: "status", status: "thinking" });

      let modelCallCount = 0;
      let completed = false;
      let persistenceError: unknown;

      try {
        if (!apiKey) {
          throw new Error(
            "GEMINI_API_KEY not set (GOOGLE_API_KEY is also accepted)."
          );
        }

        for (let loopIndex = 0; loopIndex < MAX_AGENT_ITERATIONS; loopIndex++) {
          if (req.signal.aborted) break;
          modelCallCount += 1;

          const stream = await ai.models.generateContentStream({
            model: store.model,
            contents: store.contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }],
              thinkingConfig: { includeThoughts: true },
              abortSignal: req.signal,
            },
          });
          closeActiveStream = async () => {
            await stream.return(undefined);
          };

          const rawParts: Part[] = [];
          const wireParts: MessagePart[] = [];
          const pendingCalls: PendingFunctionCall[] = [];
          const historyToolCalls: SessionHistoryMessage["toolCalls"] = [];
          let text = "";
          let thinking = "";

          try {
            for await (const chunk of stream) {
              if (req.signal.aborted) break;
              const parts = chunk.candidates?.[0]?.content?.parts ?? [];
              for (const part of parts) {
                // Keep the SDK part object whole. In particular, do not peel a
                // functionCall away from the thoughtSignature attached to it.
                rawParts.push(part);

                if (part.thought === true && typeof part.text === "string") {
                  if (part.text) {
                    emit({ type: "thinking_delta", text: part.text });
                    thinking += part.text;
                    wireParts.push({ kind: "thinking", text: part.text });
                  }
                } else if (typeof part.text === "string" && part.text) {
                  emit({ type: "text_delta", text: part.text });
                  text += part.text;
                  wireParts.push({ kind: "text", text: part.text });
                }

                if (part.functionCall) {
                  collectFunctionCall(
                    part.functionCall,
                    loopIndex,
                    pendingCalls,
                    historyToolCalls,
                    wireParts
                  );
                }
              }
            }
          } finally {
            closeActiveStream = null;
          }

          store.contents.push({ role: "model", parts: rawParts });
          const assistantMessage: SessionHistoryMessage = {
            role: "assistant",
            content: text,
            ...(thinking ? { thinking } : {}),
            toolCalls: historyToolCalls,
            parts: wireParts,
          };
          store.messages.push(assistantMessage);

          if (req.signal.aborted) break;
          if (pendingCalls.length === 0) {
            completed = true;
            break;
          }

          const functionResponseParts: Part[] = [];
          for (const call of pendingCalls) {
            if (req.signal.aborted) break;
            emit({
              type: "tool_use_start",
              toolUseId: call.toolUseId,
              toolName: call.name,
            });
            emit({
              type: "tool_use_complete",
              toolUseId: call.toolUseId,
              toolName: call.name,
              input: call.args,
            });
            emit({ type: "status", status: "tool_executing" });

            const result = await callTool(call.name, call.args, {
              brain,
              turn: turnContext,
              writeLock,
              toolCallId: call.toolUseId,
            });
            emit({
              type: "tool_result",
              toolUseId: call.toolUseId,
              output: result.text,
              isError: result.isError,
            });
            call.historyEntry.output = result.text;
            call.historyEntry.isError = result.isError;

            functionResponseParts.push({
              functionResponse: {
                name: call.name,
                response: { result: result.text },
                ...(call.providerCallId ? { id: call.providerCallId } : {}),
              },
            });
          }

          if (req.signal.aborted) break;
          // @google/genai's own automatic-function-calling implementation uses
          // role "user" and one Content for all response parts.
          store.contents.push({ role: "user", parts: functionResponseParts });
        }

        if (!req.signal.aborted && !completed) {
          // Reached the per-turn step cap. End the turn gracefully rather than
          // surfacing an error — the pending tool responses are already in
          // store.contents, so a follow-up message resumes the work.
          emit({
            type: "text_delta",
            text: `\n\n_(Paused after ${MAX_AGENT_ITERATIONS} steps in a single turn — send another message to continue.)_`,
          });
        }
      } catch (err) {
        if (!req.signal.aborted) {
          emit({ type: "error", code: "agent_error", message: errorMessage(err) });
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        turnContext.bridge = null;
        turnContext.signal = null;
        entry.running = false;
        store.lastActiveAt = Date.now();
        try {
          await sessionStore.save(store);
        } catch (err) {
          persistenceError = err;
        }
        evictIdle();
      }

      if (persistenceError && !req.signal.aborted) {
        emit({
          type: "error",
          code: "agent_error",
          message: `Failed to persist Gemini session: ${errorMessage(persistenceError)}`,
        });
      }

      if (req.signal.aborted) {
        emit({ type: "status", status: "cancelled" });
        return;
      }

      emit({
        type: "result",
        sessionId,
        costUsd: 0,
        durationMs: Date.now() - startedAt,
        numTurns: modelCallCount,
        isError: false,
      });
    },

    listSessions() {
      return sessionStore.listSessions();
    },

    getHistory(sessionId: string) {
      return sessionStore.getHistory(sessionId);
    },
  };
}

function appendUserMessage(store: StoredSession, req: StartTurnRequest): void {
  const attachments = req.attachments ?? [];
  const parts: Part[] = attachments.map((attachment) => ({
    inlineData: {
      mimeType: attachment.mediaType,
      data: attachment.data,
    },
  }));
  parts.push({ text: req.prompt });
  store.contents.push({ role: "user", parts });

  const isFirstUserMessage = !store.messages.some((message) => message.role === "user");
  if (isFirstUserMessage) store.title = firstLine(req.prompt);
  store.messages.push({
    role: "user",
    content: req.prompt,
    toolCalls: [],
    ...(attachments.length > 0 ? { attachmentCount: attachments.length } : {}),
  });
}

function collectFunctionCall(
  functionCall: FunctionCall,
  loopIndex: number,
  pendingCalls: PendingFunctionCall[],
  historyToolCalls: SessionHistoryMessage["toolCalls"],
  wireParts: MessagePart[]
): void {
  const callIndex = pendingCalls.length;
  const name = functionCall.name ?? "unknown";
  const args = functionCall.args ?? {};
  const toolUseId = functionCall.id ?? `call_${loopIndex}_${callIndex}`;
  const historyEntry = { id: toolUseId, name, input: args };
  const toolIndex = historyToolCalls.length;
  historyToolCalls.push(historyEntry);
  wireParts.push({ kind: "tool", toolIndex });
  pendingCalls.push({
    name,
    args,
    toolUseId,
    ...(functionCall.id ? { providerCallId: functionCall.id } : {}),
    historyEntry,
  });
}

/**
 * Stamp sessionId on every outgoing frame so multiplexed clients can demux
 * concurrent Gemini sessions.
 */
function scopeFrame(message: ServerMessage, sessionId: string): ServerMessage {
  return { ...message, sessionId } as ServerMessage;
}

function buildSystemInstruction(brainPath: string): string {
  const sections = [
    "You are an assistant operating on a personal “brain” knowledge-base git repository. " +
      "Use the provided tools to inspect, search, clarify, and—with approval—modify the repo. " +
      "Ground answers in repository content and keep changes focused.",
  ];

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const content = readFileSync(join(brainPath, name), "utf-8").trim();
      if (content) sections.push(`${name}:\n${content}`);
    } catch {
      // Context files are optional; construction remains best-effort.
    }
  }
  return sections.join("\n\n");
}

function firstLine(text: string): string | null {
  const line = text.split("\n")[0]?.trim();
  return line ? line.slice(0, 120) : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
