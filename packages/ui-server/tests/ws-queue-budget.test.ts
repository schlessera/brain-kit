import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "../src/ws/clients";
import {
  addClient,
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
} from "./helpers/test-host";
import { MAX_SESSION_QUEUE, QUEUE_MAX_BYTES, QUEUE_WARN_BYTES } from "../src/ws/host";
import { queuedBytes, queuedFollowUpBytes } from "../src/ws/turns";
import { testAuthorization } from "./helpers/principal";

const QUEUE_AUTHORIZATION = testAuthorization();

/**
 * The follow-up queue is bounded by BYTES, not by message count: a queued entry
 * is held in this process until its turn runs, and one carrying images costs
 * thousands of times what one carrying a sentence does.
 *
 * These drive the real dispatch path with a backend that has no native
 * followUp — the only configuration where the host queues at all.
 */

function makeHangingBackend() {
  const controls = new Map<string, () => void>();
  let counter = 0;

  const backend: AgentBackend = {
    id: "fake",
    capabilities: {
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: true,
      costReporting: true,
      concurrentSessions: true,
      followUp: false,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn(req) {
      const sessionId = req.sessionId ?? `s${++counter}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId, providerId: "default" });
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      controls.set(sessionId, () => {
        req.bridge.emit({ type: "result", sessionId, costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
        resolveDone();
      });
      req.signal.addEventListener("abort", () => resolveDone(), { once: true });
      await done;
    },
    async listSessions() {
      return [];
    },
    async getHistory() {
      return [];
    },
  };
  return { backend, controls };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send: (data: string) => sent.push(JSON.parse(data) as ServerMessage) };
  return { ws, sent };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

/** An attachment of a given base64 payload size — what the queue actually holds. */
function attachmentOf(bytes: number) {
  return { data: "A".repeat(bytes), mediaType: "image/jpeg" as const };
}

/**
 * Base64 length that decodes to just under MAX_IMAGE_BYTES (4 MB). Inbound
 * validation rejects anything above that per image and 8 MB total per message,
 * so this is as heavy as one message is allowed to be — 2 x 5,333,332 chars,
 * about 10.2 MiB parked per queued entry.
 */
const MAX_B64_PER_IMAGE = 5_333_332;

/** The heaviest follow-up the protocol permits: two maximum-size images. */
function heaviestMessage(sessionId: string) {
  return {
    type: "chat_message" as const,
    text: "heavy",
    sessionId,
    attachments: [attachmentOf(MAX_B64_PER_IMAGE), attachmentOf(MAX_B64_PER_IMAGE)],
  };
}

describe("queued follow-up byte accounting", () => {
  test("counts the utf-8 text plus every attachment payload", () => {
    const entry = { text: "hello", attachments: [attachmentOf(1000), attachmentOf(2000)] };
    expect(queuedFollowUpBytes(entry)).toBe(5 + 3000);
  });

  test("multi-byte characters are measured as bytes, not characters", () => {
    // Four characters, ten bytes: an emoji is 4 and each accented vowel is 2.
    expect(queuedFollowUpBytes({ text: "🧠éàx", attachments: [] })).toBe(4 + 2 + 2 + 1);
  });

  test("an empty queue is zero, and a queue sums its entries", () => {
    const turn = { queue: [] } as unknown as Parameters<typeof queuedBytes>[0];
    expect(queuedBytes(turn)).toBe(0);
    turn.queue.push({
      principalId: QUEUE_AUTHORIZATION.principalId,
      authorization: QUEUE_AUTHORIZATION,
      text: "ab",
      attachments: [attachmentOf(10)],
    });
    turn.queue.push({
      principalId: QUEUE_AUTHORIZATION.principalId,
      authorization: QUEUE_AUTHORIZATION,
      text: "cde",
      attachments: [],
    });
    expect(queuedBytes(turn)).toBe(2 + 10 + 3);
  });
});

describe("queue budget (ws handler)", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });

  afterEach(() => {
    resetForTests();
    closeDb();
  });

  async function startSession() {
    const { backend, controls } = makeHangingBackend();
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);
    await handleClientMessage(ws, { type: "chat_message", text: "first" });
    await waitFor(() => controls.size === 1);
    return { ws, sent, controls, sessionId: [...controls.keys()][0]! };
  }

  const queuedFrames = (sent: ServerMessage[]) =>
    sent.filter((f) => f.type === "status" && (f as { status: string }).status === "queued") as Array<{
      status: string;
      detail?: string;
    }>;

  const queueErrors = (sent: ServerMessage[]) =>
    sent.filter((f) => f.type === "error" && (f as { code: string }).code === "SESSION_QUEUE_FULL") as Array<{
      message: string;
    }>;

  test("a light queue is accepted with no warning attached", async () => {
    const { ws, sent, controls, sessionId } = await startSession();

    for (let i = 0; i < 5; i++) {
      await handleClientMessage(ws, { type: "chat_message", text: `follow ${i}`, sessionId });
    }

    expect(queuedFrames(sent)).toHaveLength(5);
    expect(queuedFrames(sent).every((f) => f.detail === undefined)).toBe(true);
    expect(queueErrors(sent)).toHaveLength(0);

    // Five messages used to be the hard limit; bytes are what bound it now.
    controls.get(sessionId)!();
  });

  test("crossing the warn mark attaches a detail note but still accepts", async () => {
    const { ws, sent, sessionId } = await startSession();

    for (let i = 0; i < 3; i++) {
      await handleClientMessage(ws, heaviestMessage(sessionId));
    }

    const frames = queuedFrames(sent);
    expect(frames).toHaveLength(3);
    // ~10.2 MiB per message: one is under the 20 MiB mark, two are over it.
    expect(frames[0]!.detail).toBeUndefined();
    expect(frames[1]!.detail).toContain("20.3 MB");
    expect(frames[1]!.detail).toContain("50.0 MB");
    expect(frames[2]!.detail).toContain("30.5 MB");
    // Warned, not refused — the message is still queued.
    expect(queueErrors(sent)).toHaveLength(0);
  });

  test("the hard cap refuses the message that would cross it, and says why", async () => {
    const { ws, sent, sessionId } = await startSession();

    // 5 x ~10.2 MiB would be 50.9 MiB, so the fifth is refused and four stay.
    for (let i = 0; i < 5; i++) {
      await handleClientMessage(ws, heaviestMessage(sessionId));
    }

    expect(queuedFrames(sent)).toHaveLength(4);
    const errors = queueErrors(sent);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("40.7 MB of 50.0 MB");
    expect(errors[0]!.message).toContain("this message needs 10.2 MB");
  });

  test("a refused message is not queued, so the session can still accept a small one", async () => {
    const { ws, sent, sessionId } = await startSession();

    for (let i = 0; i < 5; i++) {
      await handleClientMessage(ws, heaviestMessage(sessionId));
    }
    expect(queueErrors(sent)).toHaveLength(1);
    expect(queuedFrames(sent)).toHaveLength(4);

    // ~40.7 MiB parked: too little room for another image message, plenty for
    // a sentence. A byte budget rejects the payload, not the sender.
    await handleClientMessage(ws, { type: "chat_message", text: "small", sessionId });
    expect(queuedFrames(sent)).toHaveLength(5);
    expect(queueErrors(sent)).toHaveLength(1);
  });

  test("depth backstop refuses beyond MAX_SESSION_QUEUE tiny messages", async () => {
    const { ws, sent, sessionId } = await startSession();

    for (let i = 0; i < MAX_SESSION_QUEUE + 2; i++) {
      await handleClientMessage(ws, { type: "chat_message", text: "x", sessionId });
    }

    expect(queuedFrames(sent)).toHaveLength(MAX_SESSION_QUEUE);
    const errors = queueErrors(sent);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toContain(`${MAX_SESSION_QUEUE} messages`);
  });

  test("the thresholds are ordered and a single message can never wedge the queue", () => {
    expect(QUEUE_WARN_BYTES).toBeLessThan(QUEUE_MAX_BYTES);
    // The client frame cap (12 MB) is the ceiling on one message, so an empty
    // queue always has room — otherwise a too-big message would be refused
    // forever with nothing draining.
    expect(QUEUE_MAX_BYTES).toBeGreaterThan(12_000_000);
  });
});
