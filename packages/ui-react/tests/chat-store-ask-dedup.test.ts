/**
 * One request is one card (#910), through the real frame handlers and store.
 *
 * The host re-sends every pending ask on each socket open, and after
 * `session_resume`, often right after a history snapshot that already rebuilt
 * the same ask from its tool call. Each of those used to append another card.
 * These deliver the frames as the host does, for all four kinds with
 * nonempty payloads, and count cards.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { flushChatDeltas, handleServerMessage } from "../src/hooks/use-websocket";
import { useChatStore } from "../src/stores/chat-store";
import { matchAskExchanges } from "../src/components/chat/message-bubble";

type Kind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
const KINDS: Kind[] = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"];

const TOOL: Record<Kind, string> = {
  ask_user: "mcp__brain-ui__ask_user",
  ask_user_list: "mcp__brain-ui__ask_user_list",
  ask_user_rank: "mcp__brain-ui__ask_user_rank",
  ask_user_form: "mcp__brain-ui__ask_user_form",
};

const INPUT: Record<Kind, Record<string, unknown>> = {
  ask_user: {
    questions: [
      { question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: "Ithaca Ἰθάκη", description: "Home" }, { label: "Pylos", description: "Nestor" }] },
    ],
  },
  ask_user_list: { prompt: "Which stores are aboard?", scale: [{ label: "Aboard" }, { label: "Missing" }], items: [{ id: "oars", label: "Spare oars" }, { id: "wine", label: "Wine from Maron \u{1F377}" }], allowSkip: true, notes: false },
  ask_user_rank: { prompt: "Rank the landings", items: [{ id: "aeolia", label: "Aeolia" }, { id: "scheria", label: "Scheria — Σχερίη" }] },
  ask_user_form: { prompt: "Plan the crossing", nodes: [{ id: "course", kind: "single", prompt: "Which course? →", options: [{ label: "Coast" }, { label: "Open sea" }] }] },
};

function requestFrame(kind: Kind, requestId: string, turnId: string, sessionId = "s1"): ServerMessage {
  const scope = { requestId, turnId, sessionId };
  switch (kind) {
    case "ask_user":
      return { type: "ask_user_request", ...scope, questions: INPUT.ask_user.questions } as ServerMessage;
    case "ask_user_list":
      return { type: "ask_user_list_request", ...scope, ...INPUT.ask_user_list } as ServerMessage;
    case "ask_user_rank":
      return { type: "ask_user_rank_request", ...scope, ...INPUT.ask_user_rank } as ServerMessage;
    case "ask_user_form":
      return { type: "ask_user_form_request", ...scope, ...INPUT.ask_user_form } as ServerMessage;
  }
}

/** History with the ask's tool call still open (no output): the rebuilt card is pending. */
function historyWithPendingAsk(kind: Kind, toolUseId: string, sessionId = "s1"): ServerMessage {
  const messages: SessionHistoryMessage[] = [
    { role: "user", content: "Plan the voyage", toolCalls: [] },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolUseId, name: TOOL[kind], input: INPUT[kind] }],
      parts: [{ kind: "tool", toolIndex: 0 }],
    },
  ];
  return { type: "session_history", sessionId, messages } as ServerMessage;
}

function cards(sessionId = "s1") {
  const buffer = useChatStore.getState().buffers[sessionId];
  return (buffer?.messages ?? []).flatMap((m) => m.askUserExchanges ?? []);
}

/** Cards a message actually draws: one per ask tool part plus any trailing. */
function drawnCards(sessionId = "s1") {
  const buffer = useChatStore.getState().buffers[sessionId]!;
  return buffer.messages.reduce((n, m) => {
    const { byPart, unmatched } = matchAskExchanges(m.parts, m.toolCalls, m.askUserExchanges);
    return n + byPart.size + unmatched.length;
  }, 0);
}

function startSession(sessionId = "s1") {
  useChatStore.getState().setActiveSession(sessionId);
  handleServerMessage({ type: "session_info", sessionId, isNew: false } as ServerMessage);
  handleServerMessage({ type: "text_delta", sessionId, turnId: "turn-1", text: "Let me ask." } as ServerMessage);
  flushChatDeltas();
}

beforeEach(() => {
  flushChatDeltas();
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {}, deliveries: {} });
});

describe("one request, one card", () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      test("the same request delivered twice leaves one card", () => {
        startSession();
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        expect(cards()).toHaveLength(1);
        expect(cards()[0]).toMatchObject({ requestId: "toolu_1", turnId: "turn-1" });
        expect(JSON.stringify(cards()[0])).toContain(kind === "ask_user" ? "Ithaca" : kind === "ask_user_list" ? "Maron" : kind === "ask_user_rank" ? "Scheria" : "crossing");
      });

      test("a history snapshot, then the host's re-send, leaves one card, which learns its turn", () => {
        useChatStore.getState().setActiveSession("s1");
        handleServerMessage(historyWithPendingAsk(kind, "toolu_1"));
        expect(cards()).toHaveLength(1);
        expect(cards()[0]!.turnId).toBeUndefined();
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        expect(cards()).toHaveLength(1);
        expect(cards()[0]!.turnId).toBe("turn-1");
        expect(drawnCards()).toBe(1);
        expect(useChatStore.getState().buffers.s1!.askUser?.requestId).toBe("toolu_1");
      });

      test("the re-send, then a history snapshot, keeps the turn the live card learned", () => {
        startSession();
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        handleServerMessage(historyWithPendingAsk(kind, "toolu_1"));
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        expect(cards()).toHaveLength(1);
        expect(cards()[0]!.turnId).toBe("turn-1");
        expect(drawnCards()).toBe(1);
      });

      test("a replay cannot revive an answered or dismissed card", () => {
        startSession();
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        useChatStore.getState().cancelAskUser("s1", "toolu_1");
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        expect(cards()).toHaveLength(1);
        expect(cards()[0]!.cancelled).toBe(true);
      });

      test("a contradictory duplicate (another turn) does not replace the card", () => {
        startSession();
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1"));
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-from-elsewhere"));
        expect(cards()).toHaveLength(1);
        expect(cards()[0]!.turnId).toBe("turn-1");
      });

      test("different sessions keep their own cards", () => {
        startSession("s1");
        handleServerMessage(requestFrame(kind, "toolu_1", "turn-1", "s1"));
        startSession("s2");
        handleServerMessage(requestFrame(kind, "toolu_2", "turn-1", "s2"));
        expect(cards("s1").map((c) => c.requestId)).toEqual(["toolu_1"]);
        expect(cards("s2").map((c) => c.requestId)).toEqual(["toolu_2"]);
      });
    });
  }

  test("a draft the user is writing in a card survives the re-send", () => {
    // The card component keeps its own selections; the store must keep the
    // exchange object it is keyed by, not swap in a new one.
    startSession();
    handleServerMessage(requestFrame("ask_user", "toolu_1", "turn-1"));
    const before = cards()[0];
    handleServerMessage(requestFrame("ask_user", "toolu_1", "turn-1"));
    expect(cards()[0]).toBe(before!);
  });
});

describe("exchanges are drawn under their own tool call", () => {
  test("an exchange is matched by id, not by position", () => {
    useChatStore.getState().setActiveSession("s1");
    const messages: SessionHistoryMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "toolu_a", name: TOOL.ask_user, input: INPUT.ask_user },
          { id: "toolu_b", name: TOOL.ask_user_rank, input: INPUT.ask_user_rank },
        ],
        parts: [{ kind: "tool", toolIndex: 0 }, { kind: "tool", toolIndex: 1 }],
      },
    ];
    handleServerMessage({ type: "session_history", sessionId: "s1", messages } as ServerMessage);
    const m = useChatStore.getState().buffers.s1!.messages[0]!;
    const swapped = { ...m, askUserExchanges: [...m.askUserExchanges!].reverse() };
    const { byPart, unmatched } = matchAskExchanges(swapped.parts, swapped.toolCalls, swapped.askUserExchanges);
    expect(byPart.get(0)!.requestId).toBe("toolu_a");
    expect(byPart.get(1)!.requestId).toBe("toolu_b");
    expect(unmatched).toEqual([]);
  });
});
