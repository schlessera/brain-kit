/// <reference types="@vitest/browser-playwright" />
import { transcriptTimelineFor } from "../../src/lib/transcript-timeline.js";
import { expect, test, type TestContext } from "vitest";
import { userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { SESSION, installConsumerStyles, scene as conversationScene, controlledMicrophone as microphone } from "./conversation-scene.js";

installConsumerStyles();
// The export specs answer `/render` themselves; the microphone hands out a fresh stream each time.
const scene = (ctx: TestContext, width?: number, shell?: boolean, theme?: "light" | "dark") => conversationScene(ctx, width, shell, theme, { exportStops: true });
const controlledMicrophone = (ctx: TestContext) => microphone(ctx, true);



// The replay ledger spans the epoch; Discard owns only the current draft.
for (const consumed of ["submitted", "question", "permission", "lost-profile"] as const) test(`Discard retains earlier ${consumed} recognition and rejects retired input replay`, async ctx => {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx, 390, true);
  await s.start();
  const first = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  const text = consumed === "permission" ? "brain, stop" : "First retained question.";
  if (consumed === "question") {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Which departure works?" });
    s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  }
  if (consumed === "permission") {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Checking the raft plan." });
    s.deliver({ type: "tool_approval_request", sessionId: SESSION, turnId: "ithaca-turn", toolUseId: "ithaca-write", toolName: "Write", kind: "tool", input: { file_path: "notes/raft.md", content: "Repair the raft." }, description: "Review the raft change." });
    s.event({ kind: "input_fragment", utteranceId: first, sequence: 0, text, finalization: "final", certainty: "known", confidence: 0.99, origin: "user" });
    expect(s.socket.frames("tool_denial")).toHaveLength(1);
  } else {
    s.input(text);
    expect(s.client.commit(s.client.state.getState().token)).toBe(true);
    await expect.poll(() => s.socket.frames(consumed === "question" ? "ask_user_response" : "conversation_commit").length).toBe(1);
  }
  const firstEntry = transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.find(e => e.kind === "recognition" && e.fragments.some(f => f.kind === "input_fragment" && f.utteranceId === first))!;
  mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBeGreaterThan(0);
  mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").at(-1)?.utteranceId).not.toBe(first);
  const second = String(s.socket.frames("conversation_audio").at(-1)!.utteranceId);
  s.event({ kind: "unassigned_input_fragment", sequence: 0, text: "Independent recognition.", timing: { kind: "unavailable" } });
  s.input("Discard this second draft.");
  await expect.poll(() => s.host.querySelectorAll("[data-recognized-text]").length).toBe(3);
  if (consumed === "lost-profile") {
    s.deliver({ type: "error", code: "CONVERSATION_UNKNOWN", message: "Voice scope is unavailable." });
    expect(s.client.state.getState().profile).toBe(null);
    // A lost voice scope stops the conversation (L9): Close and Start again, the draft kept as a saved draft.
    await expect.poll(() => s.host.querySelector<HTMLElement>("[data-conversation-field]")?.dataset.liveState).toBe("L9");
    expect(s.host.querySelector('[data-conversation-field] button[aria-label="Discard draft"]')).toBe(null);
    flushSync(() => s.client.discard());
  } else await userEvent.click(s.button("Discard draft"));
  expect(s.client.state.getState().recognition.map(f => f.text), "Discard must retain earlier consumed recognition").toEqual([text, "Independent recognition."]);
  await expect.poll(() => [...s.host.querySelectorAll("[data-recognized-text]")].map(n => n.textContent)).toEqual([text, "Independent recognition."]);
  expect(transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.some(e => e.key === firstEntry.key)).toBe(true);
  const late = (utteranceId: string) => s.event({ kind: "input_fragment", utteranceId, sequence: 1, text: "Late retired words.", finalization: "final", certainty: "known", confidence: 0.99, origin: "user" }, 1);
  late(first); late(second);
  expect(s.client.state.getState().text, "Retired input cannot become a new draft").toBe("");
  expect(s.client.state.getState().recognition.map(f => f.text)).toEqual([text, "Independent recognition."]);
  s.client.discard(); // An empty draft must not erase earlier consumed input either.
  expect(s.client.state.getState().recognition.map(f => f.text)).toEqual([text, "Independent recognition."]);
  expect(s.client.state.getState().text).toBe("");
  expect(s.socket.frames("conversation_commit")).toHaveLength(consumed === "submitted" || consumed === "lost-profile" ? 1 : 0);
  expect(s.socket.frames("ask_user_response")).toHaveLength(consumed === "question" ? 1 : 0);
  expect(s.socket.frames("tool_denial")).toHaveLength(consumed === "permission" ? 1 : 0);
  expect(s.socket.frames("tool_approval")).toHaveLength(0);
  expect(s.client.state.getState().micOn).toBe(consumed !== "lost-profile");
});
