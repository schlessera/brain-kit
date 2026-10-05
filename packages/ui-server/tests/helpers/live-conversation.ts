/**
 * A keyless LiveConversationProvider for host tests (#957). Each `open` makes
 * a session whose events the test pushes by hand and whose operations it
 * records, so a test decides exactly when a provider event or a deferred
 * result lands relative to host cancellation, withdrawal or epoch change.
 * No network, no audio device.
 */
import type { ConversationCapabilities } from "@schlessera/brain-ui-sdk/protocol";
import {
  defineLiveConversationProvider,
  type ConversationScope,
  type ConversationWorkRef,
  type ConversationWorkResult,
  type LiveConversationAudioChunk,
  type LiveConversationEvent,
  type LiveConversationOpenOptions,
  type LiveConversationProvider,
} from "@schlessera/brain-ui-sdk/server";

type EventBody = LiveConversationEvent extends infer E ? (E extends unknown ? Omit<E, "conversationId" | "epoch"> : never) : never;

export interface FakeLiveSession {
  scope: ConversationScope;
  options: LiveConversationOpenOptions;
  audio: LiveConversationAudioChunk[];
  endpoints: string[];
  returned: Array<{ ref: ConversationWorkRef; result: ConversationWorkResult }>;
  closed: boolean;
  /** Push one event in this session's own scope. */
  emit(event: EventBody): void;
  /** Push a raw event, scope and all, exactly as given. */
  emitRaw(event: unknown): void;
  /** End the event stream as a provider whose remote side closed. */
  end(): void;
}

export const UNPROVEN: ConversationCapabilities = {
  nonblockingWork: "unproven",
  manualEndpoint: "unproven",
  finalTranscript: "unproven",
  remoteOutputCancelAck: "unproven",
  exactPermissionSpeech: "unproven",
  echoIsolatedInput: "unproven",
  outputWordAlignment: "unproven",
};

export function fakeLiveProvider(capabilities: Partial<ConversationCapabilities> = {}, behaviour: { holdReturns?: boolean } = {}): {
  provider: LiveConversationProvider;
  sessions: FakeLiveSession[];
} {
  const sessions: FakeLiveSession[] = [];
  const provider = defineLiveConversationProvider({
    id: "fake-live",
    capabilities: { ...UNPROVEN, nonblockingWork: "supported", manualEndpoint: "supported", ...capabilities },
    disclosure: {
      voiceService: "Fictional voice service of Ithaca, ithaca-live-1",
      destinations: [
        "Microphone audio goes to this host and the fictional voice service.",
        "Committed requests go to the configured agent backend.",
      ],
    },
    async open(scope, options) {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      const record: FakeLiveSession = {
        scope,
        options,
        audio: [],
        endpoints: [],
        returned: [],
        closed: false,
        emit: (event) => record.emitRaw({ ...event, ...scope }),
        emitRaw: (event) => {
          queue.push(event);
          wake?.();
        },
        end: () => {
          ended = true;
          wake?.();
        },
      };
      sessions.push(record);
      async function* events(): AsyncGenerator<LiveConversationEvent> {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as LiveConversationEvent;
            continue;
          }
          if (ended || record.closed || options.signal.aborted) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      }
      return {
        events: events(),
        appendAudio: (chunk) => record.audio.push(chunk),
        markEndpoint: (utteranceId) => record.endpoints.push(utteranceId),
        returnWork: async (ref, result) => {
          record.returned.push({ ref, result });
          // A provider that never acknowledges: the host's delivery stays pending.
          if (behaviour.holdReturns) await new Promise<never>(() => {});
        },
        close: async () => {
          record.closed = true;
          wake?.();
          return { remote: "acknowledged" as const };
        },
      };
    },
  });
  return { provider, sessions };
}

/** 160 PCM16 samples of silence, base64. */
export const SILENCE = Buffer.from(new Uint8Array(320)).toString("base64");
