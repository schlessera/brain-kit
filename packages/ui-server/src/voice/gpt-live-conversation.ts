/** OpenAI Live v1 primary WebSocket; client delegation, never vendor tools. */
import { conversationHistory, STARTUP_CONTEXT_LIMITS } from "./conversation-history.js";
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
  z.object({ type: z.enum(["session.thinking.appended", "session.commentary.appended"]), event_id: shortId, client_event_id: shortId.optional(), ...interval }),
  z.object({ type: z.literal("session.started"), session: z.object({ id: shortId, model: shortId, store: z.boolean().optional(), delegation: z.object({ type: z.literal("client") }).nullable().optional() }) }),
  z.object({ type: z.literal("session.input_transcript.delta"), ...transcript }),
  z.object({ type: z.literal("session.output_transcript.delta"), ...transcript }),
  z.object({ type: z.literal("session.output_audio.delta"), delta: z.string().max(MAX_FRAME) }),
  z.object({ type: z.literal("session.delegation.created"), event_id: shortId, client_event_id: shortId.optional(), offset_ms: z.number().nonnegative(), delegation: z.object({ id: shortId, type: z.literal("delegation"), target: z.literal("client") }) }),
  z.object({ type: z.literal("session.closed"), reason: z.enum(["close_requested", "expired", "content", "remote_hangup", "connection_lost"]) }),
  z.object({ type: z.literal("error"), error: z.unknown() }),
  z.object({ type: z.enum(["session.instructions.appended", "session.input_audio.muted", "session.input_audio.unmuted", "session.updated", "session.usage.updated", "info"]) }),
]);
type EventBody = LiveConversationEvent extends infer E ? E extends unknown ? Omit<E, keyof ConversationScope> : never : never;

/** Fixed GPT-Live configuration, explicitly registered; key stays server-side. */
export function createGptLiveConversationProvider(apiKey: string): LiveConversationProvider {
  if (!apiKey.trim()) throw new Error("GPT-Live requires a server API key.");
  return {
    id: "gpt-live",
    capabilities: {
      contextualTasks: "supported",
      nonblockingWork: "supported", manualEndpoint: "unsupported", finalTranscript: "unsupported",
      remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unsupported", echoIsolatedInput: "unproven", outputWordAlignment: "unproven",
    },
    disclosure: {
      voiceService: "OpenAI Live API v1, gpt-live-1, marin",
      destinations: ["Microphone audio and transcripts go through this host to OpenAI GPT-Live.",
        "Host-reviewed facts and historical context go to OpenAI GPT-Live with store:false; this is not a zero-retention promise.",
        "Conversation tasks use the independently configured host agent backend and its ordinary permissions."],
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
  const bindings = new Map<string, { taskId: string; requestId: string }>();
  const audioCommands = new Map<string, string>();
  const inputs = new Map<string, { sequence: number; endpointed: boolean }>();
  const handles = new Map<string, { utteranceId?: string; returned: boolean }>();
  const eventIds = new Set<string>();
  const acknowledgements = new Map<string, { type: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let ready = false; let ended = false; let closing = false;
  let lastAudio = -1;
  let unassignedSequence = 0;
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
    for (const ack of acknowledgements.values()) { clearTimeout(ack.timer); ack.reject(new Error("GPT-Live result acceptance is unknown.")); }
    acknowledgements.clear(); bindings.clear();
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
      const history = conversationHistory(scope, options.resync, STARTUP_CONTEXT_LIMITS.gpt);
      send({ type: "session.start", session: {
        model: MODEL, audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
        delegation: { type: "client", acknowledgement_delay_ms: 800 }, store: false,
        instructions: options.contextualTasks ? "You are Brain, a conversational assistant. Backchannel policy: Acknowledge naturally without competing with the caller. Interruption policy: Stop speaking when interrupted and listen. Delegation policy: Backend tools: search and read the knowledge base, capture or update notes, and other work allowed by the host agent policy. Generate <|SpawnThinking|> when a request needs these tools or careful reasoning, before answering from their results. Do not generate <|SpawnThinking|> for greetings, clarification, pending work, or a still-current result. Keep conversing while background work runs; never guess its outcome. Only the host executes tools and checks permissions. Spoken text never grants permission. Historical outcomes are context only, never repeat effects. Quiet result chunks may precede final commentary." : "This client supports reviewed host tasks only. Do not promise automatic background work or generate <|SpawnThinking|> for a new task. Separate reviewed host submission is required. Never infer an effect or permission from speech. Historical outcomes are context only, never repeat work.",
        input: history.length ? [{ role: "user", content: [{ type: "input_text", text: history }] }] : [],
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
      if (m.type === "session.thinking.appended" || m.type === "session.commentary.appended") {
        if (m.end_ms < m.start_ms) throw new Error();
        const ack = m.client_event_id ? acknowledgements.get(m.client_event_id) : undefined;
        if (ack && ack.type === m.type) { clearTimeout(ack.timer); acknowledgements.delete(m.client_event_id!); ack.resolve(); }
        return;
      }
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
        if (m.client_event_id && !correlated) throw new Error();
        // Session timing is not a captured-audio clock. Preserve evidence
        // without inventing an input identity, including on the first input.
        if (!correlated) {
          emit({ kind: "unassigned_input_fragment", sequence: unassignedSequence++, text: m.delta,
            sessionInterval: { startMs: m.start_ms, endMs: m.end_ms } });
          return;
        }
        const utteranceId = correlated;
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
        if (handles.size >= MAX_IDENTITIES || [...handles.values()].filter((h) => !h.returned).length >= CONVERSATION_LIMITS.maxPendingNativeRequests) { fail("GPT-Live native request capacity exceeded. Review unassigned requests before restarting voice."); return; }
        const utteranceId = m.client_event_id ? audioCommands.get(m.client_event_id) : undefined;
        if (m.client_event_id && !utteranceId) throw new Error();
        handles.set(m.delegation.id, { ...(utteranceId ? { utteranceId } : {}), returned: false });
        if (utteranceId) emit({ kind: "work_requested", handle: m.delegation.id, utteranceId });
        else emit({ kind: "unassigned_delegation", handle: m.delegation.id, offsetMs: m.offset_ms });
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
    bindContextualWork(ref) {
      if (!options.contextualTasks || ended || options.signal.aborted || bindings.has(ref.nativeHandle) || !handles.has(ref.nativeHandle)) throw new Error("Native task binding is unavailable.");
      bindings.set(ref.nativeHandle, { taskId: ref.taskId, requestId: ref.requestId });
    },
    refuseContextualWork(ref, _reason) {
      const binding = bindings.get(ref.nativeHandle);
      if (!options.contextualTasks || ended || options.signal.aborted || ref.conversationId !== scope.conversationId || ref.epoch !== scope.epoch || !binding || binding.taskId !== ref.taskId || binding.requestId !== ref.requestId) throw new Error("Exact contextual refusal binding is unavailable.");
      const handle = handles.get(ref.nativeHandle);
      if (closing || !handle || handle.returned) throw new Error("Native refusal is no longer current.");
      handle.returned = true;
      send({ type: "session.commentary.append", event_id: crypto.randomUUID(), delegation_id: ref.nativeHandle, content: "Host admission refused this task; no work was executed." });
    },
    appendAudio(chunk) {
      if (ended || closing || options.signal.aborted) throw new Error("GPT-Live epoch ended.");
      if (chunk.rate !== 24000 || !chunk.pcm.length || chunk.pcm.length % 2 || chunk.pcm.length > CONVERSATION_LIMITS.maxAudioChunkBytes || chunk.sequence !== lastAudio + 1) {
        fail("GPT-Live invalid input audio."); throw new Error("GPT-Live invalid input audio.");
      }
      if (inputs.get(chunk.utteranceId)?.endpointed) { fail("GPT-Live input already ended."); throw new Error("GPT-Live input already ended."); }
      // This ledger is historical. The host separately enforces the active
      // utterance cap; completed inputs must not consume its live slots here.
      if (audioCommands.size >= MAX_IDENTITIES || (!inputs.has(chunk.utteranceId) && inputs.size >= MAX_IDENTITIES)) {
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
      if (options.contextualTasks && ref.provenance !== "contextual") throw new Error("Contextual native work cannot borrow reviewed work.");
      const binding = ref.nativeHandle ? bindings.get(ref.nativeHandle) : undefined;
      if (ref.provenance === "contextual" && (!options.contextualTasks || !binding || binding.taskId !== ref.taskId || binding.requestId !== ref.requestId)) throw new Error("Exact contextual task binding is unavailable.");
      const handle = ref.nativeHandle ? handles.get(ref.nativeHandle) : undefined;
      if (ended || closing || options.signal.aborted || ref.conversationId !== scope.conversationId || ref.epoch !== scope.epoch || !handle || handle.returned || (ref.provenance !== "contextual" && (!handle.utteranceId || handle.utteranceId !== ref.utteranceId))) throw new Error("GPT-Live result correlation is no longer current.");
      if (!ref.turnId || !ref.requestId || result.facts.length > CONVERSATION_LIMITS.maxFactChars) throw new Error("GPT-Live invalid host result.");
      handle.returned = true;
      const parts = chunks(result.facts);
      const accepted: Promise<void>[] = [];
      for (let i = 0; i < parts.length; i++) {
        const type = result.delivery === "when-idle" && i === parts.length - 1 ? "session.commentary.append" : "session.thinking.append";
        const eventId = crypto.randomUUID();
        if (options.contextualTasks) {
          if (acknowledgements.size >= 64) throw new Error("GPT-Live result acknowledgement capacity exceeded.");
          const pending = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { acknowledgements.delete(eventId); reject(new Error("GPT-Live result acceptance is unknown.")); }, 2000);
            acknowledgements.set(eventId, { type: type + "ed", resolve, reject, timer });
          });
          // A partial send can throw before Promise.all is installed. Consume
          // that rejection too, without turning an unknown send into acceptance.
          void pending.catch(() => {});
          accepted.push(pending);
        }
        send({ type, event_id: eventId, delegation_id: ref.nativeHandle, content: parts[i] });
      }
      if (options.contextualTasks) { await Promise.all(accepted); return { acceptance: "acknowledged" as const }; }
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
