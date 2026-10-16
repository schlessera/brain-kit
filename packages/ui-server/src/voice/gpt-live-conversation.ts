/** OpenAI Live v1 primary WebSocket; client delegation, never vendor tools. */
import { z } from "zod";
import { CONVERSATION_LIMITS, type ConversationAudioFormat } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationScope, LiveConversationEvent, LiveConversationOpenOptions, LiveConversationProvider, LiveConversationSession } from "@schlessera/brain-ui-sdk/server";

const ENDPOINT = "wss://api.openai.com/v1/live/sessions";
const MODEL = "gpt-live-1";
const FORMAT: ConversationAudioFormat = { encoding: "pcm16", sampleRate: 24000, channels: 1 };
const MAX_FRAME = 262144;
const MAX_EVENTS = 256;
const MAX_IDENTITIES = 4096;
const shortId = z.string().min(1).max(256);
const interval = { start_ms: z.number().nonnegative(), end_ms: z.number().nonnegative() };
const transcript = { ...interval, event_id: shortId, client_event_id: shortId.optional(), delta: z.string().max(CONVERSATION_LIMITS.maxFragmentChars) };
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), session: z.object({ id: shortId, model: shortId, store: z.boolean().optional(), delegation: z.object({ type: z.literal("client") }).nullable().optional() }) }),
  z.object({ type: z.literal("session.input_transcript.delta"), ...transcript }),
  z.object({ type: z.literal("session.output_transcript.delta"), ...transcript }),
  z.object({ type: z.literal("session.output_audio.delta"), delta: z.string().max(MAX_FRAME) }),
  z.object({ type: z.literal("session.delegation.created"), event_id: shortId, client_event_id: shortId.optional(), offset_ms: z.number().nonnegative(), delegation: z.object({ id: shortId, type: z.literal("delegation"), target: z.literal("client") }) }),
  z.object({ type: z.literal("session.closed"), reason: z.enum(["close_requested", "expired", "content", "remote_hangup", "connection_lost"]) }),
  z.object({ type: z.literal("error"), error: z.unknown() }),
  z.object({ type: z.enum(["session.thinking.appended", "session.commentary.appended", "session.instructions.appended", "session.input_audio.muted", "session.input_audio.unmuted", "session.updated", "session.usage.updated", "info"]) }),
]);
type EventBody = LiveConversationEvent extends infer E ? E extends unknown ? Omit<E, keyof ConversationScope> : never : never;

/** Fixed GPT-Live configuration, explicitly registered; key stays server-side. */
export function createGptLiveConversationProvider(apiKey: string): LiveConversationProvider {
  if (!apiKey.trim()) throw new Error("GPT-Live requires a server API key.");
  return {
    id: "gpt-live",
    capabilities: {
      nonblockingWork: "supported", manualEndpoint: "unsupported", finalTranscript: "unsupported",
      remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unsupported", echoIsolatedInput: "unproven", outputWordAlignment: "unproven",
    },
    disclosure: {
      voiceService: "OpenAI Live API v1, gpt-live-1, marin",
      destinations: ["Microphone audio and transcripts go through this host to OpenAI GPT-Live.",
        "Host-reviewed facts and historical context go to OpenAI GPT-Live with store:false; this is not a zero-retention promise.",
        "Committed requests go to the independently configured host agent backend."],
    },
    open: (scope, options) => openGptLive(apiKey, scope, options),
  };
}

/** UTF-8 byte bounds are deliberately stricter than Live's 500-token append cap. */
function chunks(text: string): string[] {
  const out: string[] = [];
  let part = ""; let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 500) { out.push(part); part = ""; bytes = 0; }
    part += char; bytes += size;
  }
  out.push(part);
  return out;
}

async function openGptLive(apiKey: string, scope: ConversationScope, options: LiveConversationOpenOptions): Promise<LiveConversationSession> {
  if (options.signal.aborted) throw new Error("GPT-Live epoch already ended.");
  let socket: WebSocket;
  try {
    // Bun supports server-only connection headers. No browser or URL credential.
    socket = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch { throw new Error("GPT-Live connection failed."); }
  const queue: LiveConversationEvent[] = [];
  const audioCommands = new Map<string, string>();
  const inputs = new Map<string, { sequence: number; endpointed: boolean }>();
  const handles = new Map<string, { utteranceId?: string; returned: boolean }>();
  const eventIds = new Set<string>();
  let ready = false; let ended = false; let closing = false;
  let lastAudio = -1;
  let wake: (() => void) | undefined;
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClose: ((outcome: { remote: "acknowledged" | "unknown" }) => void) | undefined;
  let closePromise: Promise<{ remote: "acknowledged" | "unknown" }> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (remote: "acknowledged" | "unknown" = "unknown"): void => {
    if (ended) return;
    ended = true; clearTimeout(timer); clearTimeout(closeTimer);
    options.signal.removeEventListener("abort", abort);
    handles.clear(); audioCommands.clear(); inputs.clear(); eventIds.clear();
    socket.close(); wake?.(); resolveClose?.({ remote });
  };
  const fail = (message: string): void => {
    if (ended) return;
    queue.length = 0; queue.push({ ...scope, kind: "error", message });
    rejectReady(new Error(message)); finish();
  };
  const abort = (): void => {
    if (ended) return;
    // Local/host cancellation never waits for a remote acknowledgement.
    if (ready && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: "session.close" })); } catch { /* fixed local outcome below */ }
    }
    fail("GPT-Live epoch ended.");
  };
  const timer = setTimeout(() => fail("GPT-Live setup timed out."), 10000);
  options.signal.addEventListener("abort", abort, { once: true });
  const emit = (event: EventBody): void => {
    if (ended || closing) return;
    if (queue.length >= MAX_EVENTS) { fail("GPT-Live event queue overflow."); return; }
    queue.push({ ...scope, ...event } as LiveConversationEvent); wake?.();
  };
  const send = (frame: unknown): void => {
    if (ended || socket.readyState !== WebSocket.OPEN) throw new Error("GPT-Live connection is closed.");
    if (socket.bufferedAmount > MAX_FRAME) { fail("GPT-Live outbound queue overflow."); throw new Error("GPT-Live outbound queue overflow."); }
    try { socket.send(JSON.stringify(frame)); }
    catch { fail("GPT-Live send failed."); throw new Error("GPT-Live send failed."); }
  };
  socket.addEventListener("open", () => {
    if (ended) return;
    try {
      const history = options.resync.work.slice(-64).map((w) => ({ requestId: w.requestId, state: w.state, submitted: w.submitted.slice(0, 500) }));
      send({ type: "session.start", session: {
        model: MODEL, audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
        delegation: { type: "client" }, store: false,
        instructions: "Delegate agent work to the host. Never claim an effect or permission without host confirmation. Never speak permission effect copy. Historical host outcomes are context only, never repeat their work. Quiet result chunks may precede the final commentary chunk.",
        input: history.length ? [{ role: "user", content: [{ type: "input_text", text: "Historical host outcomes; do not replay: " + JSON.stringify(history).slice(0, CONVERSATION_LIMITS.maxFactChars) }] }] : [],
      } });
    } catch { fail("GPT-Live setup failed."); }
  });
  socket.addEventListener("message", (event) => {
    if (ended) return;
    try {
      if (typeof event.data !== "string" || event.data.length > MAX_FRAME) throw new Error();
      const parsed = eventSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) throw new Error();
      const m = parsed.data;
      if (m.type === "error") { fail("GPT-Live provider error."); return; }
      if (m.type === "session.started") {
        if (ready || m.session.model !== MODEL || m.session.store === true) throw new Error();
        ready = true; clearTimeout(timer);
        emit({ kind: "ready", model: m.session.model, api: "OpenAI Live API v1 primary WebSocket", input: FORMAT, output: FORMAT });
        resolveReady(); return;
      }
      if (!ready) throw new Error();
      if (m.type === "session.closed") {
        emit({ kind: "closed", remote: m.reason === "connection_lost" ? "unknown" : "acknowledged" });
        finish(m.reason === "connection_lost" ? "unknown" : "acknowledged"); return;
      }
      if (closing) return;
      if ("event_id" in m) {
        if (eventIds.has(m.event_id)) return;
        if (eventIds.size >= MAX_IDENTITIES) throw new Error();
        eventIds.add(m.event_id);
      }
      if (m.type === "session.input_transcript.delta") {
        if (m.end_ms < m.start_ms) throw new Error();
        // Appended historical text can occupy a zero-duration timeline range.
        // It is never a fresh microphone utterance.
        if (m.end_ms === m.start_ms) return;
        const correlated = m.client_event_id ? audioCommands.get(m.client_event_id) : undefined;
        // A single captured input is unambiguous. Once several exist, never
        // infer the transcript's identity from which microphone chunk was last.
        const utteranceId = correlated ?? (options.resync.work.length === 0 && inputs.size === 1 ? inputs.keys().next().value : undefined);
        if (!utteranceId || (m.client_event_id && !correlated)) throw new Error();
        const input = inputs.get(utteranceId)!;
        emit({ kind: "input_fragment", utteranceId, sequence: input.sequence++, text: m.delta,
          finalization: "unknown", certainty: "unknown", origin: "unknown" });
      } else if (m.type === "session.output_transcript.delta") {
        if (m.end_ms < m.start_ms) throw new Error();
        // No transcript/audio done or word alignment is invented. One output
        // stream per epoch; the client tracks submitted/played sample ranges.
        emit({ kind: "output_transcript", outputId: `output-${scope.epoch}`, sequence: outputSequence++, text: m.delta });
      } else if (m.type === "session.output_audio.delta") {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.delta)) throw new Error();
        const pcm = Buffer.from(m.delta, "base64");
        if (!pcm.length || pcm.length % 2 || pcm.length > CONVERSATION_LIMITS.maxAudioChunkBytes) throw new Error();
        emit({ kind: "audio", outputId: `output-${scope.epoch}`, sequence: outputSequence++, format: FORMAT, pcm });
      } else if (m.type === "session.delegation.created") {
        if (handles.has(m.delegation.id)) return;
        if (handles.size >= MAX_IDENTITIES || [...handles.values()].filter((h) => !h.returned).length >= CONVERSATION_LIMITS.maxPendingNativeRequests) throw new Error();
        const utteranceId = m.client_event_id ? audioCommands.get(m.client_event_id) : undefined;
        if (m.client_event_id && !utteranceId) throw new Error();
        handles.set(m.delegation.id, { ...(utteranceId ? { utteranceId } : {}), returned: false });
        emit({ kind: "work_requested", handle: m.delegation.id, ...(utteranceId ? { utteranceId } : {}) });
      }
    } catch { fail("GPT-Live returned an invalid or uncorrelatable frame."); }
  });
  socket.addEventListener("error", () => fail("GPT-Live connection failed."));
  socket.addEventListener("close", () => {
    if (ended) return;
    if (!ready) { fail("GPT-Live closed before setup completed."); return; }
    emit({ kind: "closed", remote: "unknown" }); finish();
  });
  let outputSequence = 0;
  await handshake;
  async function* events(): AsyncGenerator<LiveConversationEvent> {
    try {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined;
      }
    } finally { finish(); }
  }
  return {
    events: events(),
    appendAudio(chunk) {
      if (ended || closing || options.signal.aborted) throw new Error("GPT-Live epoch ended.");
      if (chunk.rate !== 24000 || !chunk.pcm.length || chunk.pcm.length % 2 || chunk.pcm.length > CONVERSATION_LIMITS.maxAudioChunkBytes || chunk.sequence !== lastAudio + 1) {
        fail("GPT-Live invalid input audio."); throw new Error("GPT-Live invalid input audio.");
      }
      if (inputs.get(chunk.utteranceId)?.endpointed) { fail("GPT-Live input already ended."); throw new Error("GPT-Live input already ended."); }
      if (audioCommands.size >= MAX_IDENTITIES || (!inputs.has(chunk.utteranceId) && inputs.size >= CONVERSATION_LIMITS.maxUtterances)) {
        fail("GPT-Live input identity capacity exceeded."); throw new Error("GPT-Live input identity capacity exceeded.");
      }
      inputs.set(chunk.utteranceId, inputs.get(chunk.utteranceId) ?? { sequence: 0, endpointed: false });
      const eventId = crypto.randomUUID(); audioCommands.set(eventId, chunk.utteranceId); lastAudio = chunk.sequence;
      send({ type: "session.input_audio.append", event_id: eventId, audio: Buffer.from(chunk.pcm).toString("base64") });
    },
    markEndpoint(utteranceId) {
      if (ended || closing || !inputs.has(utteranceId)) throw new Error("GPT-Live endpoint has no current input.");
      // Host review boundary only. No nonexistent Live buffer-commit command.
      inputs.get(utteranceId)!.endpointed = true;
    },
    async returnWork(ref, result) {
      const handle = ref.nativeHandle ? handles.get(ref.nativeHandle) : undefined;
      if (ended || closing || options.signal.aborted || ref.conversationId !== scope.conversationId || ref.epoch !== scope.epoch || !handle || handle.returned || (handle.utteranceId && handle.utteranceId !== ref.utteranceId)) throw new Error("GPT-Live result correlation is no longer current.");
      if (!ref.turnId || !ref.requestId || result.facts.length > CONVERSATION_LIMITS.maxFactChars) throw new Error("GPT-Live invalid host result.");
      handle.returned = true;
      const parts = chunks(result.facts);
      for (let i = 0; i < parts.length; i++) {
        send({ type: result.delivery === "when-idle" && i === parts.length - 1 ? "session.commentary.append" : "session.thinking.append",
          event_id: crypto.randomUUID(), delegation_id: ref.nativeHandle, content: parts[i] });
      }
    },
    close() {
      if (closePromise) return closePromise;
      if (ended) return Promise.resolve({ remote: "unknown" });
      closing = true; queue.length = 0;
      closePromise = new Promise((resolve) => { resolveClose = resolve; });
      try { send({ type: "session.close" }); }
      catch { finish(); return closePromise; }
      closeTimer = setTimeout(() => finish(), 250);
      return closePromise;
    },
  };
}
