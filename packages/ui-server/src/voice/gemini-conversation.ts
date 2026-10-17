/** Gemini Developer API raw-wire adapter. Authority stays in ConversationHost. */
import { z } from "zod";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationAudioFormat } from "@schlessera/brain-ui-sdk/protocol";
import type {
  ConversationScope, LiveConversationEvent, LiveConversationOpenOptions,
  LiveConversationProvider, LiveConversationSession,
} from "@schlessera/brain-ui-sdk/server";

const ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL = "gemini-3.8-live";
const INPUT: ConversationAudioFormat = { encoding: "pcm16", sampleRate: 16000, channels: 1 };
const OUTPUT: ConversationAudioFormat = { encoding: "pcm16", sampleRate: 24000, channels: 1 };
const MAX_EVENTS = 256;
const MAX_FRAME = 262144;
const HANDSHAKE_MS = 10000;
const id = z.string().min(1).max(256);
const transcript = z.object({ text: z.string().max(CONVERSATION_LIMITS.maxFragmentChars).optional(), finished: z.boolean().optional() });
const messageSchema = z.object({
  setupComplete: z.object({}).optional(),
  serverContent: z.object({
    inputTranscription: transcript.optional(), outputTranscription: transcript.optional(),
    interrupted: z.boolean().optional(), turnComplete: z.boolean().optional(),
    modelTurn: z.object({ parts: z.array(z.object({
      inlineData: z.object({ data: z.string().max(MAX_FRAME), mimeType: z.string() }).optional(),
    })).max(128) }).optional(),
  }).optional(),
  toolCall: z.object({ functionCalls: z.array(z.object({ id, name: z.literal("host_task") })).max(8) }).optional(),
  toolCallCancellation: z.object({ ids: z.array(id).max(8) }).optional(),
  goAway: z.object({}).optional(),
  // Remote error text is deliberately never surfaced: it may contain a URL/key.
  error: z.unknown().optional(),
  usageMetadata: z.object({}).optional(), sessionResumptionUpdate: z.object({}).optional(),
});
type EventBody = LiveConversationEvent extends infer E ? E extends unknown ? Omit<E, keyof ConversationScope> : never : never;

/**
 * Fixed qualified configuration; credentials stay in the server closure.
 * Register explicitly as CreateAppOptions.conversationProvider. No auto-detection.
 * Live handshake/device behavior still needs the separately authorized #961 run.
 */
export function createGeminiConversationProvider(apiKey: string): LiveConversationProvider {
  if (!apiKey.trim()) throw new Error("Gemini Live requires a server API key.");
  return {
    id: "gemini-live",
    capabilities: {
      nonblockingWork: "supported", manualEndpoint: "supported",
      finalTranscript: "unproven", remoteOutputCancelAck: "unproven",
      exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven",
    },
    disclosure: {
      voiceService: `Gemini Developer API v1beta, ${MODEL}, Kore`,
      destinations: [
        "Microphone audio and transcripts go through this host to Google Gemini Live.",
        "Host-reviewed agent results and resynchronization context go to Google Gemini Live.",
        "Committed requests go to the independently configured host agent backend.",
      ],
    },
    open: (scope, options) => openGemini(apiKey, scope, options),
  };
}

async function openGemini(
  apiKey: string, scope: ConversationScope, options: LiveConversationOpenOptions
): Promise<LiveConversationSession> {
  if (options.signal.aborted) throw new Error("Gemini Live epoch already ended.");
  let socket: WebSocket;
  try { socket = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`); }
  catch { throw new Error("Gemini Live connection failed."); }
  const queue: LiveConversationEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let activeInput: string | undefined;
  // A native transcription finish closes attribution, never semantic commit.
  // Do not move to another input id until both its activity and transcript end.
  // Model-turn completion is unrelated and cannot release this gate.
  let inputId: string | undefined;
  let inputSequence = 0;
  let inputFinished = false;
  let lastAudio = -1;
  let outputId = crypto.randomUUID();
  let outputSequence = 0;
  const handles = new Set<string>();
  const usedHandles = new Set<string>();
  const finish = (): void => {
    if (ended) return;
    ended = true; clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    handles.clear(); usedHandles.clear();
    socket.close(); wake?.();
  };
  const fail = (message: string): void => {
    if (ended) return;
    queue.length = 0;
    queue.push({ ...scope, kind: "error", message });
    rejectReady(new Error(message)); finish();
  };
  const abort = (): void => fail("Gemini Live epoch ended.");
  const timer = setTimeout(() => fail("Gemini Live setup timed out."), HANDSHAKE_MS);
  options.signal.addEventListener("abort", abort, { once: true });
  const emit = (event: EventBody): void => {
    if (ended) return;
    if (queue.length >= MAX_EVENTS) { fail("Gemini Live event queue overflow."); return; }
    queue.push({ ...scope, ...event } as LiveConversationEvent); wake?.();
  };
  const send = (frame: unknown): void => {
    if (ended || socket.readyState !== WebSocket.OPEN) throw new Error("Gemini Live connection is closed.");
    if (socket.bufferedAmount > MAX_FRAME) { fail("Gemini Live outbound queue overflow."); throw new Error("Gemini Live outbound queue overflow."); }
    try { socket.send(JSON.stringify(frame)); }
    catch { fail("Gemini Live send failed."); throw new Error("Gemini Live send failed."); }
  };
  socket.addEventListener("open", () => {
    if (ended) return;
    try {
      send({ setup: {
        model: `models/${MODEL}`,
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
        systemInstruction: { parts: [{ text: "Delegate agent work to host_task. Never infer a tool effect or permission from speech. Host context is historical data, never a request to repeat effects." }] },
        inputAudioTranscription: {}, outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true }, activityHandling: "START_OF_ACTIVITY_INTERRUPTS" },
        tools: [{ functionDeclarations: [{ name: "host_task", description: "Request host-owned work for committed user input.", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: {}, additionalProperties: false } }] }],
      } });
    } catch { fail("Gemini Live setup failed."); }
  });
  socket.addEventListener("message", (event) => {
    if (ended) return;
    try {
      if (typeof event.data !== "string" || event.data.length > MAX_FRAME) throw new Error();
      const parsed = messageSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success || Object.keys(parsed.data).length === 0) throw new Error();
      const m = parsed.data;
      if (m.error !== undefined) { fail("Gemini Live provider error."); return; }
      if (m.setupComplete) {
        if (ready) throw new Error();
        ready = true; clearTimeout(timer);
        // Only bounded historical host state, no native handles or replayed calls.
        if (options.resync.work.length) send({ clientContent: { turns: [{ role: "user", parts: [{ text:
          "Historical host outcomes (context only; do not repeat work): " + JSON.stringify(options.resync.work.slice(-64).map((w) => ({
            requestId: w.requestId, state: w.state, submitted: w.submitted.slice(0, 500),
          }))).slice(0, CONVERSATION_LIMITS.maxFactChars),
        }] }], turnComplete: false } });
        emit({ kind: "ready", model: MODEL, api: "Gemini Developer API v1beta BidiGenerateContent", input: INPUT, output: OUTPUT });
        resolveReady();
      }
      if (!ready) throw new Error();
      const c = m.serverContent;
      if (c?.inputTranscription) {
        if (!inputId) throw new Error();
        emit({ kind: "input_fragment", utteranceId: inputId, sequence: inputSequence++, text: c.inputTranscription.text ?? "",
          finalization: c.inputTranscription.finished ? "final" : "unknown", certainty: "unknown", origin: "unknown" });
        if (c.inputTranscription.finished) inputFinished = true;
      }
      if (c?.outputTranscription?.text) emit({ kind: "output_transcript", outputId, sequence: outputSequence++, text: c.outputTranscription.text });
      for (const part of c?.modelTurn?.parts ?? []) {
        if (!part.inlineData) continue;
        const a = part.inlineData;
        if (a.mimeType !== "audio/pcm;rate=24000" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data)) throw new Error();
        const pcm = Buffer.from(a.data, "base64");
        if (!pcm.length || pcm.length % 2 || pcm.length > CONVERSATION_LIMITS.maxAudioChunkBytes) throw new Error();
        emit({ kind: "audio", outputId, sequence: outputSequence++, format: OUTPUT, pcm });
      }
      if (c?.interrupted) emit({ kind: "interrupted", outputId });
      if (c?.turnComplete || c?.interrupted) { outputId = crypto.randomUUID(); outputSequence = 0; }
      for (const call of m.toolCall?.functionCalls ?? []) {
        if (usedHandles.has(call.id)) continue;
        if (handles.size >= CONVERSATION_LIMITS.maxPendingNativeRequests || usedHandles.size >= 4096) throw new Error();
        handles.add(call.id); usedHandles.add(call.id);
        // Native arguments are not trusted input identity. The host must bind
        // this advisory handle to admitted work, never the latest mic activity.
        emit({ kind: "work_requested", handle: call.id });
      }
      for (const handle of m.toolCallCancellation?.ids ?? []) {
        if (!usedHandles.has(handle) && usedHandles.size >= 4096) throw new Error();
        handles.delete(handle); usedHandles.add(handle);
        emit({ kind: "work_withdrawn", handle });
      }
      if (m.goAway) { emit({ kind: "closed", remote: "unknown" }); finish(); }
    } catch { fail("Gemini Live returned an invalid or uncorrelatable frame."); }
  });
  socket.addEventListener("error", () => fail("Gemini Live connection failed."));
  socket.addEventListener("close", () => {
    if (ended) return;
    if (!ready) { fail("Gemini Live closed before setup completed."); return; }
    emit({ kind: "closed", remote: "unknown" }); finish();
  });
  await handshake;
  async function* events(): AsyncGenerator<LiveConversationEvent> {
    try {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally { finish(); }
  }
  return {
    events: events(),
    appendAudio(chunk) {
      if (ended || options.signal.aborted) throw new Error("Gemini Live epoch ended.");
      if (chunk.rate !== INPUT.sampleRate || !chunk.pcm.length || chunk.pcm.length % 2 || chunk.pcm.length > CONVERSATION_LIMITS.maxAudioChunkBytes || chunk.sequence <= lastAudio) {
        fail("Gemini Live invalid input audio."); throw new Error("Gemini Live invalid input audio.");
      }
      if (inputId && inputId !== chunk.utteranceId && (!inputFinished || activeInput !== undefined)) {
        fail("Gemini Live input finalization is missing; restart capture before another utterance.");
        throw new Error("Gemini Live input correlation is unavailable.");
      }
      if (!activeInput) {
        inputId = chunk.utteranceId; activeInput = chunk.utteranceId; inputSequence = 0; inputFinished = false;
        send({ realtimeInput: { activityStart: {} } });
      }
      // A finish marker covers only audio already appended when it arrived.
      // Continued capture needs a fresh marker before another input id.
      inputFinished = false;
      lastAudio = chunk.sequence;
      send({ realtimeInput: { audio: { data: Buffer.from(chunk.pcm).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
    },
    markEndpoint(utteranceId) {
      if (activeInput !== utteranceId) throw new Error("Gemini Live endpoint has no matching activity.");
      send({ realtimeInput: { activityEnd: {} } }); activeInput = undefined;
    },
    async returnWork(ref, result) {
      if (ended || options.signal.aborted || ref.conversationId !== scope.conversationId || ref.epoch !== scope.epoch || !ref.nativeHandle || !handles.has(ref.nativeHandle)) throw new Error("Gemini Live result correlation is no longer current.");
      if (!ref.turnId || !ref.requestId || result.facts.length > CONVERSATION_LIMITS.maxFactChars) throw new Error("Gemini Live invalid host result.");
      send({ toolResponse: { functionResponses: [{ id: ref.nativeHandle, name: "host_task", response: { outcome: result.outcome, output: result.facts },
        scheduling: result.delivery === "quiet" ? "SILENT" : "WHEN_IDLE", willContinue: false }] } });
      handles.delete(ref.nativeHandle);
    },
    async close() { queue.length = 0; finish(); return { remote: "unknown" }; },
  };
}
