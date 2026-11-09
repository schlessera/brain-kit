/// <reference types="@vitest/browser-playwright" />
// Spoken-turn marks in the chat (#3700): the kit's #3692 components, driven
// only by recorded provenance. Live, settled and reloaded chats are each
// rendered through the real ChatPage and transcript timeline.
import { afterAll, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import axe from "axe-core";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { CONVERSATION_LIMITS, type DialogueRecord, type ServerConversationOpened, type SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationRecognition } from "../../src/voice/conversation-client.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-raft";
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gemini-live", capabilities: { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "supported", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" }, disclosure: { voiceService: "Odysseus voice fixture", destinations: [] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
let styles: HTMLStyleElement;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-07-12T09:00:00Z")); styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => { styles.remove(); vi.useRealTimers(); });

async function scene(ctx: TestContext, history: SessionHistoryMessage[] = [], width = 320) {
  const previous = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, 720);
  await page.viewport(width, 720);
  const network = installFaultNetwork({ routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus", capabilities: {} }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: history }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:720px;background:var(--bk-color-canvas);color:var(--bk-color-ink);overflow:auto`;
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(async () => { flushSync(() => root.unmount()); release(); ui.dispose(); network.restore(); host.remove(); await page.viewport(previous.width, previous.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  return { ui, host, socket: network.socket()! };
}

/** Captured input with exactly the confidence evidence given; nothing is filled in. */
function captured(sequence: number, text: string, evidence: { confidence?: number; finalization?: "interim" | "final" | "unknown" } = {}): ConversationRecognition {
  return { kind: "input_fragment", conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gemini-live", activation: 1, contextual: true, utteranceId: "calypso-axe", sequence, text,
    finalization: evidence.finalization ?? "final", origin: "user", ...(evidence.confidence === undefined ? { certainty: "unknown" as const } : { certainty: "known" as const, confidence: evidence.confidence }) };
}
const marks = (root: ParentNode) => ({
  you: root.querySelectorAll('.bk-spoken-mark[data-speaker="you"]').length,
  brain: root.querySelectorAll('.bk-spoken-mark[data-speaker="brain"]').length,
});
const uncertainWords = (root: ParentNode) => [...root.querySelectorAll(".bk-uncertain")].map(w => w.firstChild?.textContent);

test("a live spoken exchange carries the mic and speaker marks; only a low calibrated score is uncertain", async ctx => {
  const s = await scene(ctx, [{ role: "user", content: "Which timber is left for the raft?", toolCalls: [] }, { role: "assistant", content: "Eleven logs of seasoned pine.", toolCalls: [] }]);
  await expect.poll(() => s.host.textContent).toContain("Eleven logs of seasoned pine.");
  expect(marks(s.host), "a typed exchange carries no mark").toEqual({ you: 0, brain: 0 });
  flushSync(() => s.ui.connection.conversation.state.setState({ active: true, sessionId: SESSION, profile: PROFILE,
    recognition: [captured(1, "When is ", { confidence: 0.97 }), captured(2, "Calypso's ", { confidence: 0.41 }), captured(3, "axe back?", { finalization: "interim" })],
    outputs: [{ conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gemini-live", outputId: "axe-reply", generated: "Calypso returns the bronze axe at dusk.", playback: "discarded" }] }));
  const row = await vi.waitFor(() => s.host.querySelector<HTMLElement>("[data-conversation-recognition]")!);
  expect(marks(s.host)).toEqual({ you: 1, brain: 1 });
  expect(uncertainWords(row), "only the calibrated 0.41 fragment, without its trailing space").toEqual(["Calypso's"]);
  expect(row.querySelector(".bk-spoken-bubble")!.getAttribute("data-in-progress"), "an interim fragment is still being recognized").toBe("true");
  expect(row.querySelector(".bk-voice-cursor")).not.toBeNull();
  expect(s.host.querySelector(".bk-unplayed"), "no text position is known, so nothing is dimmed as unplayed").toBeNull();
  expect(s.host.querySelector(".bk-cut-off"), "a cut-off claim needs retained barge-in evidence, which this chat has none of").toBeNull();
  expect(s.host.textContent, "the old turn labels are gone").not.toMatch(/Recognized speech|Voice reply/);
  // The spoken turns only: the header time stamp is outside this change.
  for (const turn of s.host.querySelectorAll("[data-conversation-recognition], [data-conversation-output]")) expect((await axe.run(turn)).violations.flatMap(v => v.nodes.map(n => `${v.id} ${n.target.join(" ")}: ${n.failureSummary}`))).toEqual([]);
  await page.screenshot({ element: s.host, path: "../../.vitest-attachments/spoken-turn-marks/live-320.png" });

  // Settled: the interim fragment finishes, and the cursor goes.
  flushSync(() => s.ui.connection.conversation.state.setState(state => ({ recognition: state.recognition.map(f => f.sequence === 3 ? { ...f, finalization: "final" as const } : f) })));
  expect(row.querySelector(".bk-spoken-bubble")!.hasAttribute("data-in-progress")).toBe(false);
  expect(row.querySelector(".bk-voice-cursor")).toBeNull();
});

// #3729: one retained barge-in on one reply, and one retained end. The live
// and reloaded scenes below receive the same evidence and draw the same marks.
const STARTED = Date.parse("2026-07-12T09:00:00Z");
const voiceRecord = (sequence: number, event: Extract<DialogueRecord["evidence"], { kind: "voice" }>["event"]): DialogueRecord =>
  ({ sequence, identity: `record-${sequence}`, evidence: { kind: "voice", conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live", event } });
const MARKS: DialogueRecord[] = [
  { sequence: 10, identity: "barge-in", evidence: { kind: "voice_interruption", conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live", outputId: "axe-reply" } },
  { sequence: 11, identity: "ended", evidence: { kind: "voice_end", conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live", startedAt: STARTED, endedAt: STARTED + 72_000 } },
];
const retained = (records: DialogueRecord[]) => ({ ownerId: "odysseus-voice", sessionId: SESSION, generation: 1, coverage: "complete" as const, through: records.at(-1)!.sequence, records });
const drawn = (root: ParentNode) => ({
  cutOff: [...root.querySelectorAll(".bk-cut-off")].map(tag => tag.closest<HTMLElement>("[data-conversation-output]")?.dataset.outputId),
  dividers: [...root.querySelectorAll(".bk-voice-divider")].map(d => d.getAttribute("aria-label")),
});
const EXPECTED = { cutOff: ["axe-reply"], dividers: ["Live conversation ended: Live · 1:12"] };

test("live: the cut-off tag and the end divider come from retained evidence as it arrives", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.connection.conversation.state.setState({ active: true, sessionId: SESSION, profile: PROFILE, recognition: [captured(1, "Is the raft ready?")],
    outputs: [
      { conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gemini-live", outputId: "axe-reply", generated: "Calypso returns the bronze axe at", playback: "played" },
      { conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gemini-live", outputId: "raft-reply", generated: "The raft is lashed and ready.", playback: "played" },
    ] }));
  await vi.waitFor(() => expect(s.host.querySelectorAll("[data-conversation-output]").length).toBe(2));
  // Seventy-two seconds of local time pass, then the operator leaves.
  vi.setSystemTime(STARTED + 72_000);
  flushSync(() => s.ui.connection.conversation.state.setState({ active: false }));
  expect(drawn(s.host), "nothing is retained yet, so no mark is drawn from local observation").toEqual({ cutOff: [], dividers: [] });
  s.socket.deliver({ type: "dialogue_history", ...retained(MARKS) });
  await vi.waitFor(() => expect(drawn(s.host)).toEqual(EXPECTED));
  expect(s.host.querySelector('[data-output-id="raft-reply"] .bk-cut-off'), "a reply with no recorded interruption is never cut off").toBeNull();
  expect(s.host.textContent).not.toContain("Voice ended");
  for (const node of s.host.querySelectorAll(".bk-voice-divider, [data-output-id=\"axe-reply\"]")) expect((await axe.run(node)).violations.flatMap(v => v.nodes.map(n => `${v.id} ${n.target.join(" ")}: ${n.failureSummary}`))).toEqual([]);
  await page.screenshot({ element: s.host, path: "../../.vitest-attachments/spoken-turn-marks/ended-320.png" });
});

test("reloaded: the same retained evidence draws the same cut-off tag and end divider", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.connection.conversation.state.setState({ sessionId: SESSION, dialogueRestoredThrough: { [SESSION]: 11 }, dialogue: { [SESSION]: retained([
    voiceRecord(1, { kind: "input_fragment", utteranceId: "calypso-axe", sequence: 1, text: "Is the raft ready?", finalization: "final", certainty: "unknown", origin: "user" }),
    voiceRecord(2, { kind: "output_transcript", outputId: "axe-reply", sequence: 0, text: "Calypso returns the bronze axe at" }),
    voiceRecord(3, { kind: "output_transcript", outputId: "raft-reply", sequence: 0, text: "The raft is lashed and ready." }),
    ...MARKS,
  ]) } }));
  await vi.waitFor(() => expect(drawn(s.host)).toEqual(EXPECTED));
  expect(s.host.querySelector('[data-output-id="raft-reply"] .bk-cut-off'), "a reply with no recorded interruption is never cut off").toBeNull();
  const order = [...s.host.querySelectorAll("[data-conversation-output], .bk-voice-divider")].map(n => n.getAttribute("data-output-id") ?? "divider");
  expect(order, "the end follows the conversation it ends").toEqual(["axe-reply", "raft-reply", "divider"]);
  await page.screenshot({ element: s.host, path: "../../.vitest-attachments/spoken-turn-marks/reloaded-marks-320.png" });
});

test("an interruption naming no output, or another output, cuts off no reply", async ctx => {
  const s = await scene(ctx);
  flushSync(() => s.ui.connection.conversation.state.setState({ sessionId: SESSION, dialogueRestoredThrough: { [SESSION]: 4 }, dialogue: { [SESSION]: retained([
    voiceRecord(1, { kind: "output_transcript", outputId: "axe-reply", sequence: 0, text: "Calypso returns the bronze axe at dusk." }),
    { sequence: 2, identity: "unnamed", evidence: { kind: "voice_interruption", conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live" } },
    { sequence: 3, identity: "other-epoch", evidence: { kind: "voice_interruption", conversationId: "odysseus-voice", epoch: 2, providerId: "gemini-live", outputId: "axe-reply" } },
    { sequence: 4, identity: "other-output", evidence: { kind: "voice_interruption", conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live", outputId: "sail-reply" } },
  ]) } }));
  await vi.waitFor(() => expect(s.host.querySelector("[data-output-id=\"axe-reply\"]")).not.toBeNull());
  expect(drawn(s.host)).toEqual({ cutOff: [], dividers: [] });
});

test("a reloaded chat renders the same marks from retained evidence; a legacy turn stays plain", async ctx => {
  const s = await scene(ctx, [
    { role: "user", content: "Which timber is left for the raft?", toolCalls: [] },
    { role: "user", content: "Count the pine logs again.", toolCalls: [], source: "voice-dictate" },
  ]);
  await expect.poll(() => s.host.textContent).toContain("Count the pine logs again.");
  const record = (sequence: number, event: Extract<DialogueRecord["evidence"], { kind: "voice" }>["event"]): DialogueRecord =>
    ({ sequence, identity: `record-${sequence}`, evidence: { kind: "voice", conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live", event } });
  flushSync(() => s.ui.connection.conversation.state.setState({ sessionId: SESSION, dialogueRestoredThrough: { [SESSION]: 3 }, dialogue: { [SESSION]: { ownerId: "odysseus-voice", sessionId: SESSION, generation: 1, coverage: "complete", through: 3, records: [
    record(1, { kind: "input_fragment", utteranceId: "calypso-axe", sequence: 1, text: "When is Calypso's ", finalization: "final", certainty: "known", confidence: 0.98, origin: "user" }),
    // Saved while still interim: retained, but no longer being recognized.
    record(2, { kind: "input_fragment", utteranceId: "calypso-axe", sequence: 2, text: "axe back?", finalization: "interim", certainty: "known", confidence: 0.3, origin: "user" }),
    record(3, { kind: "output_transcript", outputId: "axe-reply", sequence: 3, text: "Calypso returns the bronze axe at dusk." }),
  ] } } }));
  const row = await vi.waitFor(() => s.host.querySelector<HTMLElement>("[data-conversation-recognition]")!);
  expect(marks(s.host), "the dictated turn, the recognized turn and the voice reply").toEqual({ you: 2, brain: 1 });
  expect(uncertainWords(row), "the retained calibrated score marks the same words").toEqual(["axe back?"]);
  expect(row.querySelector(".bk-spoken-bubble")!.hasAttribute("data-in-progress"), "restored text is never shown as still being recognized").toBe(false);
  const typed = [...s.host.querySelectorAll(".chat-message-body")].find(b => b.textContent === "Which timber is left for the raft?")!;
  expect(typed.closest(".bk-spoken-turn"), "a turn with no voice source renders plain").toBeNull();
  expect(s.host.querySelector(".bk-unplayed")).toBeNull();
  await page.screenshot({ element: s.host, path: "../../.vitest-attachments/spoken-turn-marks/reloaded-320.png" });
});
