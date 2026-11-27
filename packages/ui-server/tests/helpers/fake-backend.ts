import type {
  ChatSession,
  ProviderInfo,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
} from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

type ResultFrame = Extract<ServerMessage, { type: "result" }>;

/**
 * The terminal frame a scripted turn emits, in its current shape with
 * `outcome` (#4836). An override set to `undefined` drops that key:
 * `{ outcome: undefined }` keeps the older shape, which the host still reads
 * through its own branch.
 */
export function resultFrame(sessionId: string, overrides: Partial<ResultFrame> = {}): ResultFrame {
  const frame: ResultFrame = { type: "result", sessionId, outcome: "success", costUsd: 0, durationMs: 1, numTurns: 1, isError: false, ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete (frame as Partial<ResultFrame>)[key as keyof ResultFrame];
  return frame;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  resume: true,
  permissions: false,
  thinking: false,
  attachments: false,
  askUser: false,
  costReporting: false,
  concurrentSessions: true,
  followUp: false,
};

export function makeFakeBackend(options: {
  id: string;
  profiles?: ProviderInfo[];
  sessions?: ChatSession[];
  histories?: Record<string, SessionHistoryMessage[]>;
  capabilities?: Partial<BackendCapabilities>;
  historyCalls?: string[];
  /** Replace the history read entirely — e.g. to hold it open mid-connect. */
  getHistory?: (sessionId: string) => Promise<SessionHistoryMessage[]>;
  startTurn?: AgentBackend["startTurn"];
  followUp?: AgentBackend["followUp"];
}): AgentBackend {
  return {
    id: options.id,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities,
    },
    listProfiles: () =>
      options.profiles ?? [
        { id: options.id, label: options.id.toUpperCase() },
      ],
    startTurn: options.startTurn ?? (async () => {}),
    ...(options.followUp ? { followUp: options.followUp } : {}),
    async listSessions() {
      return options.sessions ?? [];
    },
    async getHistory(sessionId) {
      options.historyCalls?.push(sessionId);
      if (options.getHistory) return await options.getHistory(sessionId);
      return options.histories?.[sessionId] ?? [];
    },
  };
}
