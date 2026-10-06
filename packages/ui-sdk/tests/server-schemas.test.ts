/**
 * Server → client frame validation (F3 / W1).
 *
 * The properties that matter are not "does a good frame parse" — it is what
 * happens to the frames nobody designed for. The protocol is additive by
 * contract, so a newer server's extra fields must SURVIVE the boundary and an
 * unknown frame type must fail softly enough that the receiver can ignore it
 * rather than crash. Getting that wrong turns every additive server change
 * into a breaking one for old clients.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_SERVER_FRAME_BYTES,
  parseServerMessage,
  serverMessageSchema,
} from "../src/schemas.js";
import { CONVERSATION_LIMITS, type ServerMessage } from "../src/protocol.js";

import { actionItem, thread } from "./inbox-fixtures.js";

function parse(frame: unknown) {
  return parseServerMessage(JSON.stringify(frame));
}

/** One valid example of every member of the union. */
const SAMPLES: ServerMessage[] = [
  { type: "inbox_snapshot", view: "actions", threads: [thread], items: [actionItem], highWaterSeq: { [thread.id]: 1 }, cursor: 2 },
  { type: "inbox_delta", view: "actions", change: { kind: "upsert_item", changeId: 3, threadId: thread.id, itemId: actionItem.id, seq: 2, item: actionItem } },
  { type: "ask_user_form_request", requestId: "r1", prompt: "Notes", nodes: [{ id: "n", kind: "text", prompt: "Why?" }] },
  { type: "ask_user_rank_request", requestId: "r1", prompt: "Which first?", items: [{ id: "a", label: "A" }, { id: "b", label: "B" }], cutoff: 1 },
  { type: "retry_receipt", sessionId: "s1", requestId: "retry-one", state: "accepted", text: "Original", attachmentCount: 2 },
  { type: "server_hello", protocolRev: 2, capabilities: { multiSession: true } },
  { type: "text_delta", text: "hi", sessionId: "s1" },
  { type: "thinking_delta", text: "hmm", sessionId: "s1" },
  { type: "tool_use_start", toolUseId: "t1", toolName: "Read", sessionId: "s1" },
  { type: "tool_input_delta", toolUseId: "t1", partialJson: '{"a"', sessionId: "s1" },
  { type: "tool_use_complete", toolUseId: "t1", toolName: "Read", input: { a: 1 }, sessionId: "s1" },
  { type: "tool_result", toolUseId: "t1", output: "ok", isError: false, sessionId: "s1" },
  {
    type: "tool_approval_request",
    toolUseId: "t1",
    toolName: "Write",
    input: { path: "x" },
    kind: "command",
    sessionId: "s1",
  },
  { type: "result", sessionId: "s1", durationMs: 10, numTurns: 1, isError: false },
  { type: "error", code: "PARSE_ERROR", message: "bad" },
  { type: "status", status: "thinking", sessionId: "s1" },
  { type: "session_info", sessionId: "s1", isNew: true },
  { type: "session_history", messages: [], sessionId: "s1" },
  {
    type: "ask_user_request",
    requestId: "r1",
    questions: [
      {
        question: "Which?",
        header: "Pick",
        multiSelect: false,
        options: [{ label: "A", description: "a", preview: "Details" }],
      },
    ],
    sessionId: "s1",
  },
  {
    type: "ask_user_list_request",
    requestId: "r2",
    prompt: "Rate?",
    scale: [{ label: "loved" }, { label: "meh", description: "fine" }],
    items: [{ id: "a", label: "A", detail: "2024", link: "https://example.org/a" }],
    allowSkip: true,
    notes: false,
    sessionId: "s1",
  },
  {
    type: "location_request",
    requestId: "r1",
    options: { enableHighAccuracy: true, timeoutMs: 15_000, maximumAgeMs: 60_000 },
    sessionId: "s1",
  },
  { type: "mask_request", requestId: "r1", imagePath: "a.png", sessionId: "s1" },
  {
    type: "activity_snapshot",
    view: "run",
    runId: "r1",
    spans: [
      {
        spanId: "sp1",
        runId: "r1",
        name: "invoke_agent",
        kind: "turn",
        origin: "session",
        sessionId: "s1",
        startedAt: 1,
      },
    ],
    events: [{ spanId: "sp1", eventIndex: 0, ts: 2, eventType: "text", payload: "hi" }],
    highWaterSeq: { r1: 1 },
  },
  {
    type: "activity_delta",
    runId: "r1",
    seq: 2,
    event: { spanId: "sp1", eventIndex: 1, ts: 3, eventType: "text", payload: "more" },
  },
  {
    type: "message_blocks",
    sessionId: "s1",
    blocks: [
      {
        partIndex: 0,
        start: 12,
        end: 80,
        block: { kind: "quote", quote: "Sing to me of the man, Muse." },
        confidence: 0.91,
      },
    ],
  },
  { type: "local_exchange_result", sessionId: "s1", exchangeId: "x1", saved: false, reason: "No store." },
  { type: "handoff_draft", handoffId: "h-ithaca-01-p1", state: "ready", text: "Odysseus is sailing home.", runId: "r1", costUsd: 0.03 },
  { type: "handoff_receipt", handoffId: "h-ithaca-01", state: "created", sessionId: "s2" },
  { type: "tool_resolution", toolUseId: "t1", outcome: "expired", sessionId: "s1", turnId: "turn-1", reason: "Turn timed out" },
  {
    type: "session_queue",
    sessionId: "s1",
    followUps: [{ id: "fu-2", requestId: "r2", text: "Keep the bag of winds shut", textTruncated: true, attachmentCount: 1, queuedAt: 1783854000000 }],
    started: { id: "fu-1", requestId: "r1", text: "Ask Aeolus about the winds", source: "voice-dictate", queuedAt: 1783853990000, turnId: "turn-2" },
    dropped: [{ id: "fu-0", requestId: "r0", reason: "Cancelled by user" }],
  },
  {
    type: "conversation_opened", conversationId: "c1", epoch: 1, sessionId: "s1", providerId: "fake-live",
    capabilities: {
      nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unsupported",
      exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unsupported",
    },
    disclosure: { voiceService: "Fictional voice service of Ithaca", destinations: ["Audio goes to this host and the voice service."] },
    limits: { ...CONVERSATION_LIMITS },
    resync: { work: 1, outputs: 1 },
  },
  { type: "conversation_output", conversationId: "c1", epoch: 1, outputId: "o1", generated: "Twelve oxen.", playback: "played", playedSamples: { start: 0, end: 480 } },
  { type: "conversation_closed", conversationId: "c1", epoch: 1, reason: "stopped" },
  { type: "conversation_event", conversationId: "c1", epoch: 1, event: { kind: "interrupted", outputId: "o1" } },
  {
    type: "conversation_work", conversationId: "c1", epoch: 1, utteranceId: "u1", requestId: "r1", state: "queued",
    delivery: "pending", recognized: "count the oxen", submitted: "Count the oxen",
  },
  { type: "conversation_permission", conversationId: "c1", epoch: 1, sessionId: "s1", turnId: "turn-1", toolUseId: "t1", toolName: "Write", announce: false },
  { type: "ask_answer_receipt", sessionId: "s1", turnId: "t1", requestId: "toolu_1", submissionId: "sub-1", state: "closed", reason: "ended" },
  { type: "pong", probeId: "probe-1" },
];

describe("coverage", () => {
  test("every ServerMessage member round-trips", () => {
    for (const sample of SAMPLES) {
      const result = parse(sample);
      expect(result.ok, `${sample.type} failed to parse`).toBe(true);
      if (result.ok) expect(result.message).toEqual(sample);
    }
  });

  test("the union covers exactly the frame types the protocol declares", () => {
    // A frame added to protocol.ts without a schema would be dropped by every
    // validating client — silently, since drops are not fatal.
    const declared = new Set(SAMPLES.map((s) => s.type));
    const options = (serverMessageSchema as unknown as { options: Array<{ shape: { type: { value: string } } }> })
      .options;
    const covered = new Set(options.map((o) => o.shape.type.value));
    expect([...covered].sort()).toEqual([...declared].sort());
  });
});

describe("the additive contract", () => {
  test("a newer server's unknown fields survive the boundary", () => {
    // If these were stripped, a client one version behind would silently
    // discard data it was meant to pass through.
    const result = parse({
      type: "text_delta",
      text: "hi",
      sessionId: "s1",
      futureField: { nested: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.message as unknown as Record<string, unknown>).futureField).toEqual({ nested: true });
    }
  });

  test("an unknown frame type fails softly rather than throwing", () => {
    const result = parseServerMessage(JSON.stringify({ type: "invented_in_rev_3", x: 1 }));
    expect(result.ok).toBe(false);
    // The caller's contract is "drop and report", so this must be an ordinary
    // value, never an exception.
    if (!result.ok) expect(typeof result.error).toBe("string");
  });

  test("turnId is accepted but never required", () => {
    expect(parse({ type: "text_delta", text: "x", sessionId: "s", turnId: "t1" }).ok).toBe(true);
    expect(parse({ type: "text_delta", text: "x", sessionId: "s" }).ok).toBe(true);
  });
});

describe("rejections", () => {
  test("a wrong field type is refused, with a path in the message", () => {
    const result = parse({ type: "tool_result", toolUseId: "t1", output: 42, isError: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("output");
  });

  test("a missing required field is refused", () => {
    expect(parse({ type: "tool_use_start", toolName: "Read" }).ok).toBe(false);
  });

  test("known optional server fields retain their protocol value types", () => {
    expect(
      parse({
        type: "tool_approval_request",
        toolUseId: "t1",
        toolName: "Write",
        input: {},
        kind: "unexpected",
      }).ok
    ).toBe(false);
    expect(
      parse({
        type: "ask_user_request",
        requestId: "r1",
        questions: [
          {
            question: "Which?",
            header: "Pick",
            multiSelect: false,
            options: [{ label: "A", description: "a", preview: 42 }],
          },
        ],
      }).ok
    ).toBe(false);
    expect(
      parse({
        type: "location_request",
        requestId: "r1",
        options: { enableHighAccuracy: "yes" },
      }).ok
    ).toBe(false);
  });

  test("malformed JSON and oversized frames are refused, not thrown", () => {
    expect(parseServerMessage("{not json").ok).toBe(false);
    const huge = "x".repeat(MAX_SERVER_FRAME_BYTES + 1);
    const result = parseServerMessage(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exceeds");
  });

  test("deep nesting is refused before anything re-serializes it", () => {
    let nested: Record<string, unknown> = { type: "text_delta", text: "x" };
    for (let i = 0; i < 200; i++) nested = { wrap: nested };
    const result = parseServerMessage(JSON.stringify(nested));
    expect(result.ok).toBe(false);
  });

  test("a tool part without its index is refused", () => {
    // MessagePart is a discriminated union upstream; a flat object with three
    // optional fields would have accepted this.
    const result = parse({
      type: "session_history",
      sessionId: "s1",
      messages: [{ role: "assistant", content: "x", toolCalls: [], parts: [{ kind: "tool" }] }],
    });
    expect(result.ok).toBe(false);
  });
});
