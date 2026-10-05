/**
 * Wire and provider-boundary validation for live conversation (#957). Every
 * accepted fixture is a complete, nonempty record; every refusal names the
 * bound it enforces.
 */
import { describe, expect, test } from "bun:test";
import { CONVERSATION_CAPABILITY_KEYS, CONVERSATION_LIMITS } from "../src/protocol";
import { parseClientMessage, parseServerMessage } from "../src/schemas";
import {
  assertLiveConversationProvider,
  defineLiveConversationProvider,
  parseLiveConversationEvent,
  type LiveConversationProvider,
} from "../src/server/conversation";

const pcm = (bytes: number) => Buffer.from(new Uint8Array(bytes)).toString("base64");
const client = (frame: Record<string, unknown>) => parseClientMessage(JSON.stringify(frame));
const server = (frame: Record<string, unknown>) => parseServerMessage(JSON.stringify(frame));

const capabilities = {
  nonblockingWork: "supported",
  manualEndpoint: "supported",
  finalTranscript: "unproven",
  remoteOutputCancelAck: "unsupported",
  exactPermissionSpeech: "unproven",
  echoIsolatedInput: "unproven",
  outputWordAlignment: "unsupported",
} as const;
const disclosure = {
  voiceService: "Fictional voice service of Ithaca, ithaca-live-1",
  destinations: ["Microphone audio goes to this host and the fictional voice service."],
};
const receipt = {
  conversationId: "conv-1", epoch: 1, utteranceId: "u1", requestId: "r1", turnId: "t1", sessionId: "sess-1",
  state: "completed", delivery: "returned", recognized: "count the oxen", submitted: "Count the oxen", reason: "done",
};

describe("client conversation frames", () => {
  test("every command parses with all of its fields", () => {
    const frames = [
      { type: "conversation_start", conversationId: "conv-1", sessionId: "sess-1" },
      { type: "conversation_audio", conversationId: "conv-1", epoch: 2, utteranceId: "u1", sequence: 7, rate: 16_000, pcm: pcm(320) },
      { type: "conversation_endpoint", conversationId: "conv-1", epoch: 2, utteranceId: "u1" },
      { type: "conversation_commit", conversationId: "conv-1", epoch: 2, utteranceId: "u1", requestId: "r1", text: "Count the oxen" },
      { type: "conversation_playback", conversationId: "conv-1", epoch: 2, outputId: "o1", playback: "played", playedSamples: { start: 0, end: 480 } },
      { type: "conversation_stop", conversationId: "conv-1" },
    ];
    for (const frame of frames) {
      const parsed = client(frame);
      expect(parsed).toEqual({ ok: true, message: frame as never });
    }
  });

  test("audio is bounded, base64 and whole 16-bit samples", () => {
    const base = { type: "conversation_audio", conversationId: "c", epoch: 1, utteranceId: "u", sequence: 0, rate: 16_000 };
    expect(client({ ...base, pcm: pcm(CONVERSATION_LIMITS.maxAudioChunkBytes) }).ok).toBe(true);
    expect(client({ ...base, pcm: pcm(CONVERSATION_LIMITS.maxAudioChunkBytes + 2) })).toMatchObject({ ok: false, error: expect.stringContaining("decoded bytes") });
    expect(client({ ...base, pcm: pcm(3) })).toMatchObject({ ok: false, error: expect.stringContaining("16-bit samples") });
    expect(client({ ...base, pcm: "not base64!" })).toMatchObject({ ok: false, error: expect.stringContaining("base64") });
    expect(client({ ...base, pcm: pcm(320), rate: 7_999 }).ok).toBe(false);
    expect(client({ ...base, pcm: pcm(320), epoch: 0 }).ok).toBe(false);
  });

  test("a commit needs nonempty text within the commit bound", () => {
    const base = { type: "conversation_commit", conversationId: "c", epoch: 1, utteranceId: "u", requestId: "r" };
    expect(client({ ...base, text: "   " })).toMatchObject({ ok: false, error: expect.stringContaining("empty") });
    expect(client({ ...base, text: "x".repeat(CONVERSATION_LIMITS.maxCommitChars) }).ok).toBe(true);
    expect(client({ ...base, text: "x".repeat(CONVERSATION_LIMITS.maxCommitChars + 1) }).ok).toBe(false);
  });
});

describe("server conversation frames", () => {
  test("every frame parses as a complete record", () => {
    const frames = [
      { type: "conversation_opened", conversationId: "conv-1", epoch: 2, sessionId: "sess-1", providerId: "fake-live",
        capabilities, disclosure, limits: { ...CONVERSATION_LIMITS }, resync: { work: 1, outputs: 1 } },
      { type: "conversation_output", conversationId: "conv-1", epoch: 1, outputId: "o1", generated: "Twelve oxen.", playback: "played", playedSamples: { start: 0, end: 480 } },
      { type: "conversation_closed", conversationId: "conv-1", epoch: 2, reason: "backpressure", message: "too many" },
      { type: "conversation_work", ...receipt },
      { type: "conversation_permission", conversationId: "conv-1", epoch: 2, sessionId: "sess-1", turnId: "t1", toolUseId: "tool-1", toolName: "Write", announce: false },
      { type: "tool_resolution", toolUseId: "tool-1", outcome: "expired", sessionId: "sess-1", turnId: "t1", channel: "card", reason: "Turn timed out" },
    ];
    for (const frame of frames) expect(server(frame)).toEqual({ ok: true, message: frame as never });
  });

  test("every normalized event kind parses", () => {
    const format = { encoding: "pcm16", sampleRate: 24_000, channels: 1 };
    const events = [
      { kind: "ready", model: "ithaca-live-1", api: "v1", input: { ...format, sampleRate: 16_000 }, output: format },
      { kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "count the oxen", interval: { startMs: 0, endMs: 900 },
        finalization: "final", certainty: "known", confidence: 0.82, origin: "user" },
      { kind: "output_transcript", outputId: "o1", sequence: 0, text: "Twelve oxen.", interval: { startMs: 0, endMs: 700 } },
      { kind: "audio", outputId: "o1", sequence: 0, format, pcm: pcm(480) },
      { kind: "interrupted", outputId: "o1" },
    ];
    for (const event of events) {
      const frame = { type: "conversation_event", conversationId: "conv-1", epoch: 1, event };
      expect(server(frame)).toEqual({ ok: true, message: frame as never });
    }
  });

  test("a confidence is evidence only with certainty known, and vice versa", () => {
    const fragment = { kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "stop", finalization: "unknown", origin: "unknown" };
    const frame = (event: Record<string, unknown>) => ({ type: "conversation_event", conversationId: "c", epoch: 1, event });
    expect(server(frame({ ...fragment, certainty: "unknown", confidence: 0.9 })).ok).toBe(false);
    expect(server(frame({ ...fragment, certainty: "known" })).ok).toBe(false);
    expect(server(frame({ ...fragment, certainty: "unknown" })).ok).toBe(true);
  });

  test("an unknown evidence value is refused rather than read as supported", () => {
    const frame = { type: "conversation_opened", conversationId: "c", epoch: 1, providerId: "p",
      capabilities: { ...capabilities, exactPermissionSpeech: "probably" }, disclosure, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
    expect(server(frame).ok).toBe(false);
  });
});

describe("provider boundary", () => {
  const provider = (overrides: Partial<LiveConversationProvider> = {}) => defineLiveConversationProvider({
    id: "fake-live", capabilities: { ...capabilities }, disclosure,
    open: async () => { throw new Error("not opened in this test"); },
    ...overrides,
  });

  test("a complete descriptor is accepted", () => {
    expect(() => assertLiveConversationProvider(provider())).not.toThrow();
  });

  test("every capability key must carry an evidence value", () => {
    for (const key of CONVERSATION_CAPABILITY_KEYS) {
      const { [key]: _omitted, ...rest } = capabilities;
      expect(() => assertLiveConversationProvider(provider({ capabilities: rest as never }))).toThrow(`capabilities.${key}`);
    }
  });

  test("id, disclosure and open are checked", () => {
    expect(() => assertLiveConversationProvider(provider({ id: "Fake" }))).toThrow("lowercase");
    expect(() => assertLiveConversationProvider(provider({ disclosure: { voiceService: "x", destinations: [] } }))).toThrow("disclosure");
    expect(() => assertLiveConversationProvider(provider({ open: undefined as never }))).toThrow("open");
  });

  test("provider events are validated before the host reads them", () => {
    const scope = { conversationId: "conv-1", epoch: 1 };
    const ok = parseLiveConversationEvent({ ...scope, kind: "audio", outputId: "o1", sequence: 0,
      format: { encoding: "pcm16", sampleRate: 24_000, channels: 1 }, pcm: new Uint8Array(480) });
    expect(ok.ok).toBe(true);
    expect(parseLiveConversationEvent({ ...scope, kind: "work_requested", handle: "native-1" })).toEqual({
      ok: true, event: { ...scope, kind: "work_requested", handle: "native-1" },
    });
    expect(parseLiveConversationEvent({ ...scope, kind: "audio", outputId: "o1", sequence: 0,
      format: { encoding: "pcm16", sampleRate: 24_000, channels: 1 }, pcm: new Uint8Array(3) }).ok).toBe(false);
    expect(parseLiveConversationEvent({ ...scope, kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "x",
      finalization: "final", certainty: "unknown", confidence: 0.5, origin: "user" })).toMatchObject({ ok: false });
    expect(parseLiveConversationEvent({ ...scope, kind: "grant_permission", toolUseId: "tool-1" }).ok).toBe(false);
    expect(parseLiveConversationEvent({ ...scope, kind: "output_transcript", outputId: "o1", sequence: 0,
      text: "x".repeat(CONVERSATION_LIMITS.maxFragmentChars + 1) }).ok).toBe(false);
  });
});
