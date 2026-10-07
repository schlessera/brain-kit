/**
 * A reconnect in the middle of a running turn (#1013). The browser proof is
 * `connection-continuity-runtime.test.ts`; these pin the two rules it found
 * missing, one layer down:
 *
 * - The host greets every new connection with an unscoped `idle`, also while
 *   the session in view is still running beside another one. That greeting
 *   must not end the stream in view. The page reattaches instead, and the
 *   host's scoped answer to that resume decides.
 * - A history replay of a transcript already drawn keeps the messages it
 *   repeats (their ids, so React keeps their nodes, and their times), and a
 *   live answer it continues stays live until the host's status ends it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveObjectURL } from "node:buffer";
import { shrinkForReplication, HISTORY_CHUNK_BYTES } from "../../ui-server/src/ws/shrink.js";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(raw); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" } as CloseEvent); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  frames() { return this.sent.map((raw) => JSON.parse(raw) as { type: string; sessionId?: string }); }
}
const realSocket = globalThis.WebSocket;
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); globalThis.WebSocket = realSocket; });

const SIRENS = "Setting out: Sail past the Sirens.";
const history = (answer: string) => [
  { role: "user" as const, content: "Hold: Sail past the Sirens", toolCalls: [] },
  { role: "assistant" as const, content: answer, toolCalls: [] },
];

/** Session s1 in view, its turn streaming the opening of an answer. */
function running() {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(root);
  root.connection.connect();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  const chat = root.stores.chat.getState();
  chat.setActiveSession("s1");
  socket.deliver({ type: "session_history", sessionId: "s1", messages: history("").slice(0, 1) });
  root.stores.chat.getState().startAssistantMessage("s1");
  root.stores.chat.getState().appendText("s1", SIRENS);
  return { root, socket };
}
const buffer = (root: BrainUiRoot) => root.stores.chat.getState().buffers.s1!;

/** The socket closes under the page, and the page connects again. */
function reconnect(root: BrainUiRoot, socket: Socket): Socket {
  socket.drop();
  root.connection.reconnectNow();
  const next = Socket.instances.at(-1)!;
  expect(next, "a new socket").not.toBe(socket);
  next.open();
  return next;
}

describe("a reconnect while the turn in view runs", () => {
  test("a size-bounded tool array keeps the tool cards already drawn", () => {
    const { root, socket } = running();
    for (let i = 0; i < 150; i++) {
      root.stores.chat.getState().startToolCall("s1", `wax-${i}`, "Bash");
      root.stores.chat.getState().setToolResult("s1", `wax-${i}`, "The wax held. ".repeat(400), false);
    }
    const old = buffer(root).messages.at(-1)!;
    const replay = shrinkForReplication({ role: "assistant", content: old.content, toolCalls: old.toolCalls, parts: old.parts }, HISTORY_CHUNK_BYTES);
    expect(replay.toolCalls.length, "the actual shrinker omitted tool cards").toBeLessThan(old.toolCalls.length);
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], replay] });
    expect(buffer(root).messages.at(-1)!.id, "elided tools do not replace the answer").toBe(old.id);
    expect(buffer(root).messages.at(-1)!.parts, "elided tools keep chronological parts").toEqual(old.parts);
    expect(buffer(root).messages.at(-1)!.toolCalls).toEqual(old.toolCalls);
  });
  test("a bounded stored tool prefix keeps the unstored live tool and trailing text", () => {
    const { root, socket } = running();
    for (let i = 0; i < 149; i++) {
      root.stores.chat.getState().startToolCall("s1", `wax-${i}`, "Bash");
      root.stores.chat.getState().setToolResult("s1", `wax-${i}`, "The wax held. ".repeat(400), false);
    }
    const stored = buffer(root).messages.at(-1)!;
    const replay = shrinkForReplication({ role: "assistant", content: stored.content, toolCalls: stored.toolCalls, parts: stored.parts }, HISTORY_CHUNK_BYTES);
    expect(replay.toolCalls.length, "the stored prefix is actually bounded").toBeLessThan(149);
    root.stores.chat.getState().startToolCall("s1", "wax-live", "Bash");
    root.stores.chat.getState().appendText("s1", " The mast held.");
    const old = buffer(root).messages.at(-1)!;
    expect(old.toolCalls).toHaveLength(150);
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], replay] });
    expect(buffer(root).messages.at(-1)!.id, "a bounded stored prefix keeps the live answer").toBe(old.id);
    expect(buffer(root).messages.at(-1)!.parts).toEqual(old.parts);
    expect(buffer(root).messages.at(-1)!.toolCalls.map((t) => t.id)).toEqual(old.toolCalls.map((t) => t.id));
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    expect(buffer(root).messages).toHaveLength(2);
    expect(buffer(root).messages.at(-1)!.content).toBe(`${old.content} Landed.`);
  });
  test("Claude thinking separators preserve every chronological part", () => {
    const { root, socket } = running();
    root.stores.chat.getState().appendThinking("s1", "Wax for the crew.");
    root.stores.chat.getState().appendText("s1", " Keep rowing.");
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    root.stores.chat.getState().appendThinking("s1", "Rope for me.");
    root.stores.chat.getState().appendText("s1", " Landed.");
    const old = buffer(root).messages.at(-1)!;
    expect(old.parts.filter((p) => p.kind === "thinking")).toHaveLength(2);
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], {
      role: "assistant", content: `${SIRENS} Keep rowing.\n\n Landed.`,
      thinking: "Wax for the crew.\n\nRope for me.", toolCalls: old.toolCalls, parts: old.parts,
    }] });
    expect(buffer(root).messages.at(-1)!.parts, "thinking separators do not reorder text or tools").toEqual(old.parts);
    expect(buffer(root).messages.at(-1)!.id).toBe(old.id);
  });
  test("longer thinking merges in its original slot around text and tools", () => {
    const { root, socket } = running();
    root.stores.chat.getState().appendThinking("s1", "Wax.");
    root.stores.chat.getState().appendText("s1", " Keep rowing.");
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    root.stores.chat.getState().appendThinking("s1", "Rope.");
    root.stores.chat.getState().appendText("s1", " Landed. More drawn text.");
    const old = buffer(root).messages.at(-1)!;
    const parts = old.parts.map((p) => p.kind === "thinking" ? { ...p, text: `${p.text} Hold fast.` } : p);
    const last = parts.at(-1)!;
    if (last.kind === "text") last.text = " Landed.";
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], {
      role: "assistant", content: `${SIRENS} Keep rowing. Landed.`, thinking: "Wax. Hold fast.\n\nRope. Hold fast.", toolCalls: old.toolCalls, parts,
    }] });
    const expected = old.parts.map((p) => p.kind === "thinking" ? { ...p, text: `${p.text} Hold fast.` } : p);
    expect(buffer(root).messages.at(-1)!.parts, "longer thinking stays at each chronological slot").toEqual(expected);
  });
  test("a size-bounded history keeps the full answer already drawn and continues it", () => {
    const { root, socket } = running();
    const text = " Row through the strait.".repeat(20_000);
    root.stores.chat.getState().appendText("s1", text);
    const old = buffer(root).messages.at(-1)!;
    const replay = shrinkForReplication({ role: "assistant", content: old.content, toolCalls: [], parts: old.parts }, HISTORY_CHUNK_BYTES);
    expect(replay.content, "the real host shrinker clipped the fixture").toContain("chars elided]");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], replay] });
    expect(buffer(root).messages.at(-1)!.id, "the bounded replay keeps the drawn answer").toBe(old.id);
    expect(buffer(root).messages.at(-1)!.parts).toEqual(old.parts);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    expect(buffer(root).messages).toHaveLength(2);
    expect(buffer(root).messages.at(-1)!.content).toBe(`${old.content} Landed.`);
  });
  test("Claude's aggregate separators around a tool do not replace a live answer", () => {
    const { root, socket } = running();
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    root.stores.chat.getState().appendText("s1", " Landed.");
    const old = buffer(root).messages.at(-1)!;
    const next = reconnect(root, socket);
    // buildSessionHistory joins assistant entries with two newlines in
    // content; its chronological parts retain the original text blocks.
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], {
      role: "assistant", content: `${SIRENS}\n\n Landed.`,
      toolCalls: [{ id: "wax-1", name: "Bash", input: {} }],
      parts: [{ kind: "text", text: SIRENS }, { kind: "tool", toolIndex: 0 }, { kind: "text", text: " Landed." }],
    }] });
    expect(buffer(root).messages.at(-1)!.id, "the live answer's node survives Claude history").toBe(old.id);
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Row on." });
    expect(buffer(root).messages).toHaveLength(2);
    expect(buffer(root).messages.at(-1)!.content).toBe(`${SIRENS} Landed. Row on.`);
  });
  test("the host's unscoped greeting does not end it; the page reattaches and the host's answer decides", () => {
    const { root, socket } = running();
    const before = buffer(root).messages.map((m) => m.id);
    const next = reconnect(root, socket);
    expect(next.frames().filter((f) => f.type === "session_resume"), "the page reattaches").toEqual([{ type: "session_resume", sessionId: "s1" }]);

    // Two sessions run on the host, so it greets without a snapshot.
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    expect(buffer(root).isStreaming, "the greeting is not this session's idle").toBe(true);

    // The host's answer to the resume: the history so far, then running.
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", detail: "Session in progress" });
    expect(buffer(root).isStreaming, "still running").toBe(true);
    expect(buffer(root).messages.map((m) => m.id), "the drawn messages are kept").toEqual(before);

    // The rest of the answer streams into the same message, and the turn ends.
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(buffer(root).messages.map((m) => m.content)).toEqual(["Hold: Sail past the Sirens", `${SIRENS} Landed.`]);
    expect(buffer(root).isStreaming).toBe(false);
  });

  test("a turn that ended while the page was away is ended by the host's scoped idle", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(`${SIRENS} Landed.`) });
    next.deliver({ type: "status", sessionId: "s1", status: "idle", detail: "Session loaded" });
    expect(buffer(root).isStreaming).toBe(false);
    expect(buffer(root).messages.at(-1)).toMatchObject({ content: `${SIRENS} Landed.`, isStreaming: false });
  });

  test("a turn that ended away, with a queued follow-up now running, ends the kept answer; the new turn's text is its own", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    // The answer in view belongs to turn-1, still streaming as far as the page knows.
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing on.");
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    // The host: turn-1 ended, the follow-up's user message, and turn-2 running.
    next.deliver({ type: "session_history", sessionId: "s1", messages: [
      ...history(SIRENS),
      { role: "assistant", content: "Rowing on. Landed.", toolCalls: [], turnId: "turn-1" },
      { role: "user", content: "Then bind me to the mast", toolCalls: [] },
    ] });
    expect(buffer(root).isStreaming, "a message after the answer ends it").toBe(false);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "Bound." });
    const messages = buffer(root).messages;
    expect(messages.map((m) => m.content).slice(-3)).toEqual(["Rowing on. Landed.", "Then bind me to the mast", "Bound."]);
  });

  test("a kept answer whose turn the host reports replaced ends, though nothing follows it yet", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing on.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [...history(SIRENS), { role: "assistant", content: "Rowing on.", toolCalls: [], turnId: "turn-1" }] });
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    expect(buffer(root).isStreaming, "turn-1's answer is over").toBe(false);
  });

  test("a resume the host could not serve does not leave the stream open forever", () => {
    const { root, socket } = running();
    // An answer that knows its turn: a turnless load error is not drawn on it.
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing on.");
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "Failed to load session", sessionId: "s1" });
    expect(buffer(root).isStreaming).toBe(false);
  });

  test("a history that stops before the answer being written keeps it, and the turn's end replays the whole", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    const before = buffer(root).messages.map((m) => m.id);
    // A backend that keeps an answer only once it ends: the history so far is the question.
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS).slice(0, 1) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    expect(buffer(root).messages.map((m) => m.id), "the answer on screen stays").toEqual(before);
    expect(buffer(root).messages.at(-1)).toMatchObject({ content: SIRENS, isStreaming: true });
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(buffer(root).messages.map((m) => m.content)).toEqual(["Hold: Sail past the Sirens", `${SIRENS} Landed.`]);
    expect(next.frames().filter((f) => f.type === "session_resume"), "the reattach, then the turn's end").toHaveLength(2);
  });

  test("a replay that names no turn leaves the answer turnless (D52's seen needs a host-proven turn), and a new turn still ends it", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Bound.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [...history(SIRENS), { role: "assistant", content: "Bound.", toolCalls: [] }] });
    expect(buffer(root).messages.at(-1)!.turnId, "no turn the history did not prove").toBeUndefined();
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "Row on." });
    expect(buffer(root).messages.map((m) => [m.content, m.turnId ?? null]).slice(-2)).toEqual([["Bound.", null], ["Row on.", "turn-2"]]);
  });

  test("a second drop before any new text still knows the answer's turn", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing.");
    const first = reconnect(root, socket);
    first.deliver({ type: "session_history", sessionId: "s1", messages: [...history(SIRENS), { role: "assistant", content: "Rowing.", toolCalls: [] }] });
    first.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-1" });
    const second = reconnect(root, first);
    second.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    second.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    second.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "New turn." });
    expect(buffer(root).messages.map((m) => m.content).slice(-2)).toEqual(["Rowing.", "New turn."]);
  });

  test("an answer that started while the history was read is not the reattached one", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing.");
    const next = reconnect(root, socket);
    // Before the resume's answer: turn-1 ends and turn-2's answer opens.
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "Bound." });
    const opened = buffer(root).messages.at(-1)!.id;
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    expect(buffer(root).isStreaming, "turn-2's own answer runs on").toBe(true);
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: " Fast." });
    expect(buffer(root).messages.at(-1)).toMatchObject({ id: opened, content: "Bound. Fast." });
  });

  test("a queued status while reattaching names no running turn: the new-turn check still applies after it", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing.");
    const next = reconnect(root, socket);
    next.deliver({ type: "status", sessionId: "s1", status: "queued", detail: "1 waiting" });
    next.deliver({ type: "session_history", sessionId: "s1", messages: [...history(SIRENS), { role: "assistant", content: "Rowing.", toolCalls: [] }] });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "Bound." });
    expect(buffer(root).messages.map((m) => m.content).slice(-2)).toEqual(["Rowing.", "Bound."]);
  });

  test("a tool the host saw finish while the page was away is finished on the page too", () => {
    const { root, socket } = running();
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    root.stores.chat.getState().appendText("s1", " And more the host has not stored.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [
      history(SIRENS)[0]!,
      { role: "assistant", content: SIRENS, toolCalls: [{ id: "wax-1", name: "Bash", input: { command: "seal --ears crew" }, output: "Ears sealed.", isError: false }] },
    ] });
    const tool = buffer(root).messages.at(-1)!.toolCalls[0]!;
    expect(tool).toMatchObject({ id: "wax-1", output: "Ears sealed.", status: "complete" });
  });

  test("a question the host saw answered while the page was away is answered on the page too", () => {
    const { root, socket } = running();
    const rank = { id: "rank-1", name: "mcp__brain-ui__ask_user_rank", input: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] } };
    root.stores.chat.getState().setAskUserRankRequest("s1", "rank-1", { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] });
    root.stores.chat.getState().appendText("s1", " And more the host has not stored.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [
      history(SIRENS)[0]!,
      { role: "assistant", content: SIRENS, toolCalls: [{ ...rank, output: JSON.stringify({ order: ["timber", "rope"], unchanged: false }), isError: false }] },
    ] });
    const exchange = buffer(root).messages.at(-1)!.askUserExchanges?.find((e) => e.requestId === "rank-1");
    expect(exchange?.order, "the host's answer").toEqual(["timber", "rope"]);
  });

  test("thinking after a newly replayed tool stays after that tool", () => {
    const { root, socket } = running();
    root.stores.chat.getState().appendText("s1", " More drawn text.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [history(SIRENS)[0], {
      role: "assistant", content: SIRENS, thinking: "The wax held.",
      toolCalls: [{ id: "wax-1", name: "Bash", input: {} }],
      parts: [{ kind: "text", text: SIRENS }, { kind: "tool", toolIndex: 0 }, { kind: "thinking", text: "The wax held." }],
    }] });
    expect(buffer(root).messages.at(-1)!.parts, "thinking stays after its newly replayed tool").toEqual([
      { kind: "text", text: `${SIRENS} More drawn text.` }, { kind: "tool", toolIndex: 0 }, { kind: "thinking", text: "The wax held." },
    ]);
  });
  test("longer thinking from the host shows even when the page has more text", () => {
    const { root, socket } = running();
    root.stores.chat.getState().appendText("s1", " And more the host has not stored.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [
      history(SIRENS)[0]!,
      { role: "assistant", content: SIRENS, thinking: "Wax for the crew.", toolCalls: [], parts: [{ kind: "thinking", text: "Wax for the crew." }, { kind: "text", text: SIRENS }] },
    ] });
    const last = buffer(root).messages.at(-1)!;
    expect(last.content).toBe(`${SIRENS} And more the host has not stored.`);
    expect(last.parts.filter((p) => p.kind === "thinking").map((p) => (p as { text: string }).text).join("")).toBe("Wax for the crew.");
  });

  test("thinking the page drew stays drawn when the history's text is as long", () => {
    const { root, socket } = running();
    root.stores.chat.getState().appendThinking("s1", "Wax for the crew, rope for me.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    const last = buffer(root).messages.at(-1)!;
    expect(last.parts.filter((p) => p.kind === "thinking").map((p) => (p as { text: string }).text).join("")).toBe("Wax for the crew, rope for me.");
  });

  test("text the page missed and a tool it already drew are both kept", () => {
    const { root, socket } = running();
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(`${SIRENS} Past Scylla.`) });
    const last = buffer(root).messages.at(-1)!;
    expect(last.content).toBe(`${SIRENS} Past Scylla.`);
    expect(last.toolCalls.map((t) => t.id)).toEqual(["wax-1"]);
    expect(last.parts.filter((p) => p.kind === "tool")).toHaveLength(1);
  });

  test("a replay in chunks that splits just before the answer draws it once", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    const before = buffer(root).messages.map((m) => m.id);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS).slice(0, 1) });
    next.deliver({ type: "session_history", sessionId: "s1", append: true, messages: history(SIRENS).slice(1) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    expect(buffer(root).messages.map((m) => m.id), "one answer, the one on screen").toEqual(before);
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    expect(buffer(root).messages.map((m) => m.content)).toEqual(["Hold: Sail past the Sirens", `${SIRENS} Landed.`]);
  });

  test("a first chunk that stops early still leaves the turn's end to replay the whole", () => {
    const { root, socket } = running();
    root.stores.chat.getState().stampTurn("s1", "turn-1");
    const next = reconnect(root, socket);
    // A first chunk that ends before the question on screen, then the rest.
    next.deliver({ type: "session_history", sessionId: "s1", messages: [] });
    expect(buffer(root).messages.at(-1)!.turnId, "an unreceived live answer carries no history proof").toBeUndefined();
    next.deliver({ type: "session_history", sessionId: "s1", append: true, messages: history(SIRENS).slice(0, 1) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(next.frames().filter((f) => f.type === "session_resume"), "the reattach, then the turn's end").toHaveLength(2);
  });

  test("a history with the same text but less of the answer's tools keeps the tool on screen", () => {
    const { root, socket } = running();
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    expect(buffer(root).messages.at(-1)!.toolCalls.map((t) => t.id)).toEqual(["wax-1"]);
    expect(buffer(root).isStreaming).toBe(true);
  });

  test("a page ahead of the host's stored answer keeps what it has drawn", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history("Setting out:") });
    expect(buffer(root).messages.at(-1)).toMatchObject({ content: SIRENS, isStreaming: true });
  });

  test("a refusal of another request while reattaching is not the resume failing", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    next.deliver({ type: "error", code: "ATTACHMENT_REJECTED", message: "Too large", sessionId: "s1", requestId: "req-1" });
    expect(buffer(root).isStreaming, "the answer still runs").toBe(true);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    expect(buffer(root).isStreaming, "and the greeting is still not its idle").toBe(true);
  });

  test("once the host has answered, a later unscoped idle is the session in view's again", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    next.deliver({ type: "status", status: "idle" });
    expect(buffer(root).isStreaming).toBe(false);
  });
});

describe("a history replay of a transcript already drawn", () => {
  test("a sent image keeps its live preview and URL until the message is removed", () => {
    const { root, socket } = running();
    const chat = root.stores.chat.getState();
    chat.finishAssistantMessage("s1");
    const previewUrl = URL.createObjectURL(new Blob(["sail"]));
    chat.addUserMessage("s1", "Chart the harbour", "typed", [{ previewUrl, mediaType: "image/png" }]);
    socket.deliver({ type: "session_history", sessionId: "s1", messages: [
      { role: "user", content: "Hold: Sail past the Sirens (corrected)", toolCalls: [] },
    ] });
    expect(buffer(root).messages.at(-1)!.attachments?.[0]?.previewUrl, "an updated prefix does not drop an unreceived image").toBe(previewUrl);
    socket.deliver({ type: "session_history", sessionId: "s1", append: true, messages: [
      history(SIRENS)[1], { role: "user", content: "Chart the harbour", toolCalls: [], attachmentCount: 1 },
    ] });
    expect(buffer(root).messages.at(-1)!.attachments?.[0]?.previewUrl, "sent preview survives replay").toBe(previewUrl);
    expect(resolveObjectURL(previewUrl), "the retained URL was not revoked").toBeDefined();
    socket.deliver({ type: "status", sessionId: "s1", status: "idle" });
    socket.deliver({ type: "session_history", sessionId: "s1", messages: [] });
    socket.deliver({ type: "status", sessionId: "s1", status: "idle" });
    expect(resolveObjectURL(previewUrl), "removing the message still releases the URL").toBeUndefined();
  });
  test("a partial matching replay keeps its drawn suffix until the host settles it", () => {
    const { root, socket } = running();
    socket.deliver({ type: "status", sessionId: "s1", status: "idle" });
    const before = buffer(root).messages.map((m) => m.id);
    socket.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS).slice(0, 1) });
    expect(buffer(root).messages.map((m) => m.id), "the suffix stays between chunks").toEqual(before);
    socket.deliver({ type: "session_history", sessionId: "s1", append: true, messages: history(SIRENS).slice(1) });
    socket.deliver({ type: "status", sessionId: "s1", status: "idle" });
    expect(buffer(root).messages.map((m) => m.id)).toEqual(before);
    socket.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS).slice(0, 1) });
    socket.deliver({ type: "status", sessionId: "s1", status: "idle" });
    expect(buffer(root).messages, "a genuinely shorter authoritative history settles").toHaveLength(1);
    expect(buffer(root).replay, "the completed replay is released").toBeUndefined();
  });

  test("keeps the ids and times of the messages it repeats, and replaces the ones it changes", () => {
    const { root } = running();
    const chat = root.stores.chat.getState();
    chat.finishAssistantMessage("s1");
    const [user, answer] = buffer(root).messages;
    root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: [
      { role: "user", content: "Hold: Sail past the Sirens", toolCalls: [] },
      { role: "assistant", content: "Rowed past Scylla instead.", toolCalls: [] },
    ] });
    const [replayedUser, replayedAnswer] = buffer(root).messages;
    expect(replayedUser).toMatchObject({ id: user!.id, timestamp: user!.timestamp });
    expect(replayedAnswer!.id, "a different answer is a different message").not.toBe(answer!.id);
    expect(buffer(root).isStreaming).toBe(false);
  });

  test("a tool-only answer replaced by another request's is a different message, though neither has text", () => {
    const { root } = running();
    const chat = root.stores.chat.getState();
    chat.finishAssistantMessage("s1");
    const ask = (id: string) => ({ id, name: "mcp__brain-ui__ask_user_rank", input: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }] } });
    const replay = (id: string, turnId: string) => root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: [
      { role: "user", content: "Hold: Sail past the Sirens", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [ask(id)], parts: [{ kind: "tool", toolIndex: 0 }], turnId } as never,
    ] });
    replay("rank-1", "turn-1");
    const first = buffer(root).messages[1]!.id;
    replay("rank-1", "turn-1");
    expect(buffer(root).messages[1]!.id, "the same request is the same message").toBe(first);
    replay("rank-2", "turn-1");
    expect(buffer(root).messages[1]!.id, "another request is another message").not.toBe(first);
    const second = buffer(root).messages[1]!.id;
    replay("rank-2", "turn-2");
    expect(buffer(root).messages[1]!.id, "another turn is another message").not.toBe(second);
  });

  test("a replay of a session that was not streaming does not start one", () => {
    const { root } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: history(`${SIRENS} Landed.`) });
    expect(buffer(root).isStreaming).toBe(false);
    expect(buffer(root).messages.at(-1)!.isStreaming).toBe(false);
  });
});
