/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import axe from "axe-core";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { ConversationOutput } from "../../src/components/voice/conversation-outputs.js";
import { TranscriptSymbols } from "@schlessera/brain-ui-kit/internal";
import { CONVERSATION_LIMITS, type ServerConversationOpened } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationRecognition } from "../../src/voice/conversation-client.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-raft";
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" }, disclosure: { voiceService: "Odysseus voice fixture", destinations: [] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

async function scene(ctx: TestContext, width = 320, theme: "light" | "dark" = "dark", zoom = 1, fullChat = true) {
  const previous = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, size: document.documentElement.style.fontSize };
  const outer = await commands.formViewport(width, 720);
  await page.viewport(width, 720);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = `${16 * zoom}px`;
  const network = installFaultNetwork({ routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus", capabilities: {} }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  ui.stores.ui.getState().setTheme(theme);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:720px;background:var(--bk-color-canvas);padding:${fullChat ? 0 : 16}px;color:var(--bk-color-ink);overflow:auto`;
  document.body.append(host);
  const root = createRoot(host);
  const render = (content = <ChatPage />) => flushSync(() => root.render(<BrainUiProvider root={ui}>{content}</BrainUiProvider>));
  render(fullChat ? <ChatPage /> : <></>);
  const release = ui.connection.connect();
  ctx.onTestFinished(async () => { flushSync(() => root.unmount()); release(); ui.dispose(); network.restore(); host.remove(); document.documentElement.style.fontSize = previous.size; if (previous.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previous.theme; await page.viewport(previous.width, previous.height); await commands.formViewport(outer.width, outer.height); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  return { ui, host, render };
}
function fragments(providerId = "gemini-live", count = 100): ConversationRecognition[] {
  return Array.from({ length: count }, (_, sequence) => ({ kind: "unassigned_input_fragment", conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId, activation: 1, contextual: true, sequence, timing: { kind: "unavailable" }, text: sequence === 0 ? "Find the raft preparation notes. " : "Keep the launch list within reach. ", finalization: sequence === count - 1 ? "final" : "unknown" }));
}
function qualifier(host: ParentNode, kind = "recognized") { return host.querySelector<HTMLButtonElement>(`[data-transcript-qualifiers="${kind}"]`)!; }
async function closeDetails() { await userEvent.keyboard("{Escape}"); await expect.poll(() => document.querySelector("dialog[open]")).toBeNull(); }

for (const theme of ["light", "dark"] as const) for (const width of [320, 1280]) for (const zoom of [1, 2]) test(`qualifiers preserve source and reflow ${theme} ${width} ${zoom * 100}%`, async ctx => {
  const s = await scene(ctx, width, theme, zoom);
  flushSync(() => s.ui.connection.conversation.state.setState({ profile: PROFILE, recognition: fragments(), outputs: [{ conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gemini-live", outputId: "raft-output", generated: "The launch list places the water skins beside the mast. ".repeat(8), playback: "unknown" }] }));
  await expect.poll(() => qualifier(s.host)).not.toBeNull();
  const row = s.host.querySelector<HTMLElement>("[data-conversation-recognition]")!;
  const trigger = qualifier(row);
  expect(row.querySelectorAll("button[data-transcript-qualifiers]"), "one hundred fragments produce one focus stop").toHaveLength(1);
  expect(row.querySelectorAll("[aria-live]"), "no per-fragment announcements").toHaveLength(0);
  expect(row.getAttribute("aria-label"), "do not repeat qualifier name on section").toBeNull();
  expect(trigger.getAttribute("aria-label"), "original Gemini source survives current GPT picker").toBe("Recognized speech; Gemini Live; unverified. Transcript details.");
  expect(qualifier(s.host, "generated").getAttribute("aria-label")).toContain("Gemini Live; playback unknown");
  trigger.scrollIntoView({ block: "center" });
  const box = trigger.getBoundingClientRect();
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  for (const [x,y] of [[box.left + 2,box.top + box.height/2],[box.right-2,box.top+box.height/2],[box.left+box.width/2,box.top+2],[box.left+box.width/2,box.bottom-2]]) expect(document.elementFromPoint(x,y)?.closest("button")).toBe(trigger);
  trigger.focus();
  await expect.poll(() => document.querySelector('[role="tooltip"]')?.textContent).toContain("Words may be uncertain; speaker unverified.");
  const hint = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(hint.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  expect(hint.getBoundingClientRect().right).toBeLessThanOrEqual(width);
  expect(trigger.hasAttribute("title"), "single custom explanation").toBe(false);
  expect(getComputedStyle(trigger).outlineWidth).toBe("2px");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="tooltip"]')).toBeNull();
  await new Promise(r => setTimeout(r, 350));
  expect(document.querySelector('[role="tooltip"]'), "Escape suppresses while still focused").toBeNull();
  await userEvent.keyboard("{Enter}");
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
  expect(dialog, "native Enter opens evidence").not.toBeNull();
  expect(dialog.id).toBe(trigger.getAttribute("aria-controls"));
  expect(document.activeElement?.textContent).toBe("Transcript details");
  expect(dialog.textContent).toContain("Source: Gemini Live");
  expect(dialog.querySelector("details")!.open, "technical evidence starts collapsed").toBe(false);
  await userEvent.click(dialog.querySelector("summary")!);
  expect(dialog.textContent).toContain("Timing unavailable; speaker unverified.");
  expect(dialog.textContent).toContain("Service finish marker received.");
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close transcript details"]')!;
  const body = dialog.querySelector<HTMLElement>(".bk-overlay-body")!;
  expect(close.getBoundingClientRect().bottom, "readable scroll body never passes beneath close target").toBeLessThanOrEqual(body.getBoundingClientRect().top);
  const closeBox = close.getBoundingClientRect();
  expect(document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2)?.closest("button")).toBe(close);
  const violations = (await axe.run(dialog, { rules: { "color-contrast": { enabled: true } } })).violations;
  expect(violations.map(v => v.id)).toEqual([]);
  await page.screenshot({ element: dialog, path: `../../.vitest-attachments/transcript-qualifiers/details-${theme}-${width}-${zoom}.png` });
  await closeDetails();
  expect(document.activeElement).toBe(trigger);
  expect(s.host.scrollWidth).toBeLessThanOrEqual(width);
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  // Switch the current engine again: historical source is a property of evidence.
  flushSync(() => s.ui.connection.conversation.state.setState({ profile: { ...PROFILE, providerId: "gemini-live" }, recognition: fragments("gpt-live") }));
  expect(qualifier(s.host).getAttribute("aria-label")).toContain("GPT-Live; unverified");
});

test("pointer can read tooltip then tap details; playback and restoration are independent evidence", async ctx => {
  const s = await scene(ctx, 320, "light", 1, false);
  s.render(<><TranscriptSymbols /><ConversationOutput output={{ conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", outputId: "restored-raft", generated: "The water skins belong beside the mast.", playback: "discarded" }} restored /></>);
  const trigger = qualifier(s.host, "generated");
  await userEvent.hover(trigger);
  await expect.poll(() => document.querySelector('[role="tooltip"]')?.textContent).toContain("Remaining reply not spoken locally. Earlier spoken portion unknown.");
  const hint = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  await userEvent.hover(hint);
  await new Promise(r => setTimeout(r, 350));
  expect(hint.isConnected, "hoverable explanation persists").toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  const box = trigger.getBoundingClientRect();
  await commands.rankTap({ x: box.left+box.width/2, y: box.top+box.height/2 });
  await expect.poll(() => document.querySelector('dialog[open]')?.textContent).toContain("Restored text evidence. This does not prove playback or that the current voice engine received it.");
  expect(document.querySelector('dialog[open]')?.textContent).toContain("Original discussion position unknown");
  expect(trigger.querySelectorAll("svg")).toHaveLength(3);
  await closeDetails();
  await userEvent.click(page.getByRole("button", { name: "Transcript symbols", exact: true }));
  expect(document.querySelector('dialog[open]')?.textContent).toContain("Received audio chunks played locally; spoken portion unknown.");
  await closeDetails();
});

test("host instruction stays technical while full semantic content and exact request navigation survive", async ctx => {
  const s = await scene(ctx);
  const chat = s.ui.stores.chat.getState();
  const instruction = 'Host task context. {"recognition":[{"text":"Find the raft notes."}]}';
  chat.addUserMessage(SESSION, instruction, "voice-context");
  const request = s.ui.stores.chat.getState().buffers[SESSION]!.messages.at(-1)!;
  s.ui.stores.chat.setState(state => ({ buffers: { ...state.buffers, [SESSION]: { ...state.buffers[SESSION]!, messages: state.buffers[SESSION]!.messages.map(m => m.id === request.id ? { ...m, requestId: "raft-request", turnId: "raft-turn" } : m) } } }));
  flushSync(() => s.ui.connection.conversation.state.setState({ work: { "raft-request": { conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, requestId: "raft-request", turnId: "raft-turn", taskId: "raft-task", nativeHandle: "raft-native", provenance: "contextual", state: "running", delivery: "pending", submitted: instruction, recognized: "" } } }));
  await expect.poll(() => qualifier(s.host, "task-request")).not.toBeNull();
  expect(s.host.textContent).toContain("Conversation task · Running");
  expect(s.host.textContent).not.toContain(instruction);
  expect(s.ui.stores.chat.getState().buffers[SESSION]!.messages.find(m => m.id === request.id)!.content).toBe(instruction);
  const trigger = qualifier(s.host, "task-request"); trigger.focus(); await userEvent.keyboard(" ");
  const dialog = document.querySelector('dialog[open]')!;
  expect(dialog.textContent).toContain("This is not a verified user quote.");
  expect(dialog.querySelector("details")!.open).toBe(false);
  await userEvent.click(dialog.querySelector("summary")!);
  expect(dialog.querySelector("pre")?.textContent).toBe(instruction);
  await closeDetails();
  flushSync(() => s.ui.connection.conversation.state.setState(state => ({ work: { ...state.work, "raft-request": { ...state.work["raft-request"]!, state: "error", reason: "Search could not finish. Review the task before retrying." } } })));
  expect(s.host.textContent).toContain("Conversation task · Failed");
  expect(s.host.textContent).toContain("Search could not finish. Review the task before retrying.");
});

for (const [playback, copy] of [
  ["played", "Received audio chunks played locally; spoken portion unknown."],
  ["unknown", "Playback unknown. Generated words are not proof they were spoken."],
  ["discarded", "Remaining reply not spoken locally. Earlier spoken portion unknown."],
] as const) test(`playback evidence remains limited to actual state: ${playback}`, async ctx => {
  const s = await scene(ctx, 320, "dark", 2, false);
  s.render(<ConversationOutput output={{ conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, outputId: "raft".repeat(120), generated: "The launch list is ready.", playback }} />);
  const trigger = qualifier(s.host, "generated");
  expect(trigger.getAttribute("aria-label")).toContain("source unknown");
  trigger.focus(); await userEvent.keyboard("{Enter}");
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  expect(dialog.textContent).toContain(copy);
  expect(dialog.textContent).toContain("Source: unknown");
  await userEvent.click(dialog.querySelector("summary")!);
  expect(dialog.textContent).toContain("raft".repeat(120));
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  expect(dialog.textContent).not.toContain("Recognition updating");
  await closeDetails();
});
