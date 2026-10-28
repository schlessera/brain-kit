/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ConversationCapabilities, type ConversationWireEvent, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-ithaca";
const CAPS: ConversationCapabilities = { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" };
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "ithaca-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: CAPS, disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fixture voice API. Retention: unknown."] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

async function scene(ctx: TestContext, width = 390, shell = false, theme: "light" | "dark" = "dark") {
  if (shell) {
    const viewport = { width: innerWidth, height: innerHeight };
    const outer = await commands.formViewport(width, 568);
    await page.viewport(width, 568);
    ctx.onTestFinished(async () => { await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width, outer.height); });
  }
  const network = installFaultNetwork({ routes: (url) => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:568px`; document.body.append(host);
  const renderer = createRoot(host);
  ui.stores.ui.getState().setTheme(theme);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}>{shell ? <AppShell><ChatPage /></AppShell> : <ChatPage />}</BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  const socket = network.socket()!;
  const deliver = (message: ServerMessage & { turnId?: string }) => socket.deliver(message);
  const client = ui.connection.conversation;
  const button = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="button"],button')].find((node) => (node.getAttribute("aria-label") ?? node.textContent) === name)!;
  const event = (event: ConversationWireEvent, epoch = client.state.getState().profile!.epoch) => socket.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch, event });
  const opened = (epoch = 1, caps = CAPS) => { socket.deliver({ ...PROFILE, epoch, capabilities: caps, requestId: socket.frames("conversation_start").at(-1)?.requestId }); event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, epoch); };
  const enter = async () => { flushSync(() => client.enter()); opened(); await expect.poll(() => button("Start")).not.toBeUndefined(); };
  const start = async () => { await enter(); await userEvent.click(button("Start")); await expect.poll(() => client.state.getState().micOn).toBe(true); await expect.poll(() => socket.frames("conversation_audio").length, { timeout: 5000 }).toBeGreaterThan(0); };
  const input = (text: string, finalization: "final" | "unknown" | "interim" = "unknown", epoch?: number) => {
    const audio = socket.frames("conversation_audio").at(-1)!;
    event({ kind: "input_fragment", utteranceId: String(audio.utteranceId), sequence: 0, text, finalization, certainty: "unknown", origin: "unknown" }, epoch);
  };
  return { ui, client, host, socket, deliver, network, button, event, opened, enter, start, input };
}

function controlledMicrophone(ctx: TestContext) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain(); gain.gain.value = 0.15;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void context.resume();
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  let opens = 0;
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; return destination.stream; } });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); void context.close(); });
  return { opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}

function outputPcm(seconds = 1, audibleSeconds = seconds) {
  const bytes = new Uint8Array(Math.round(48000 * seconds));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(bytes.length / 2, audibleSeconds * 24000); i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function contextualScene(ctx: TestContext, provider: "gemini" | "gpt", action: "permitted" | "confirm" | "deny" = "permitted", width = 390, newChat = false) {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx, width, true);
  if (newChat) s.ui.stores.chat.getState().setActiveSession(null);
  const manualDraftId = s.ui.stores.drafts.getState().idFor(newChat ? null : SESSION);
  s.ui.stores.drafts.getState().edit(manualDraftId, newChat ? null : SESSION, { text: "Keep the separate typed raft draft." });
  const fixture = await commands.conversationServer({ op: "start", contextual: true, provider, action }) as { id: string };
  ctx.onTestFinished(async () => { await commands.conversationServer({ op: "stop", id: fixture.id }); });
  let cursor = 0;
  const upstream: any[] = [];
  const downstream: ServerMessage[] = [];
  let evidence: any;
  const pump = async (provider: unknown[] = [], release = false) => {
    const client = s.socket.sent.slice(cursor).map(bytes => JSON.parse(String(bytes.data))); cursor = s.socket.sent.length;
    evidence = await commands.conversationServer({ op: "step", id: fixture.id, client, provider, release });
    upstream.push(...evidence.sent); downstream.push(...evidence.frames);
    for (const frame of evidence.frames) s.deliver(frame);
    return evidence;
  };
  s.client.enter(); await pump();
  await expect.poll(async () => { await pump(); return s.client.state.getState().profile; }).not.toBe(null);
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  await pump();
  return { ...s, mic, pump, upstream, downstream, manualDraftId, evidence: () => evidence };
}

for (const provider of ["gemini", "gpt"] as const) for (const mode of ["missing-finished", "finished-then-pcm"] as const) test(`${provider} automatic background task: initiating plus three subsequent exchanges, ${mode}, actual policy and exact result`, async ctx => {
  const s = await contextualScene(ctx, provider, "permitted", mode === "finished-then-pcm" ? 320 : 390, mode === "finished-then-pcm");
  const native = (id: string) => provider === "gemini" ? { toolCall: { functionCalls: [{ id, name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: `native-${id}`, offset_ms: 500, delegation: { id, type: "delegation", target: "client" } };
  const recognize = (turn: number, text: string) => provider === "gemini"
    ? { serverContent: { inputTranscription: { text, ...(mode === "finished-then-pcm" ? { finished: true } : {}) } } }
    : { type: "session.input_transcript.delta", event_id: `recognized-${turn}`, delta: text, start_ms: turn * 2000, end_ms: turn * 2000 + 500 };
  const reply = (turn: number, text: string) => provider === "gemini" ? [{ serverContent: { outputTranscription: { text }, modelTurn: { parts: [{ inlineData: { data: outputPcm(0.15), mimeType: "audio/pcm;rate=24000" } }] }, turnComplete: true } }]
    : [{ type: "session.output_transcript.delta", event_id: `output-${turn}`, delta: text, start_ms: turn * 2000 + 600, end_ms: turn * 2000 + 800 }, { type: "session.output_audio.delta", delta: outputPcm(0.15) }];
  if (provider === "gemini") expect(s.upstream.find(f => f.setup)?.setup.tools[0].functionDeclarations[0]).toMatchObject({ name: "host_task", behavior: "NON_BLOCKING" });
  else {
    const config = s.upstream.find(f => f.type === "session.start").session;
    expect(config.delegation).toEqual({ type: "client", acknowledgement_delay_ms: 800 });
    expect(config.instructions).toContain("Generate <|SpawnThinking|>");
  }
  for (let turn = 0; turn < 4; turn++) {
    if (turn) {
      const before = s.socket.frames("conversation_audio").length; s.mic.speak();
      await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
      await s.pump();
      expect(s.client.state.getState().micOn, "subsequent ordinary capture remains open without invented finality").toBe(true);
      await s.pump([recognize(turn + 10, " A delayed Ithaca fragment.")]);
    }
    await s.pump([recognize(turn, ["Find the departure signal note and capture the watch.", "What about our route?", "Tell me about the Sirens while we wait.", "And the harbour watch?"][turn]!)]);
    if (!turn) {
      await s.pump([native("departure-1")]);
      await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0]?.read; }).toContain("bronze owl");
    }
    if (turn === 1) await s.pump([native("route-2")]);
    if (mode === "finished-then-pcm") {
      const count = s.socket.frames("conversation_audio").length;
      await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(count);
      await s.pump();
    }
    s.mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(turn + 1);
    await s.pump(reply(turn, `Continuing the voyage conversation ${turn + 1}.`));
    await expect.poll(() => s.host.textContent).toContain(`Continuing the voyage conversation ${turn + 1}.`);
    await expect.poll(() => s.client.state.getState().playing).toBe(true);
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
    expect(s.evidence().released, "backend completion is causally blocked throughout initiating plus three subsequent exchanges").toBe(false);
    expect(s.evidence().tasks).toHaveLength(1);
    expect(s.evidence().tasks[0].completed).toBe(false);
    expect(s.evidence().effect).toBe(false);
    expect(s.client.state.getState().micOn).toBe(true);
  }
  expect(s.socket.frames("conversation_endpoint"), "initiating capture plus three subsequent spoken inputs before backend release").toHaveLength(4);
  expect(s.downstream.filter(f => f.type === "conversation_event" && f.event.kind === "output_transcript" && f.event.text.startsWith("Continuing the voyage conversation")), "each unresolved-backend exchange produced actual output and playback").toHaveLength(4);
  expect(s.host.textContent).not.toContain("bronze owl");
  expect(s.client.state.getState().unassigned.map(f => f.text).join("")).toContain(" A delayed Ithaca fragment.");
  expect(s.client.state.getState().unassigned.every(f => !("utteranceId" in f))).toBe(true);
  if (provider === "gemini") expect(s.client.state.getState().unassigned.every(f => f.timing?.kind === "unavailable" && !f.sessionInterval)).toBe(true);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.downstream.some(f => f.type === "conversation_closed")).toBe(false);
  expect(s.upstream.some(f => f.toolResponse || f.type === "session.commentary.append")).toBe(false);
  expect(s.host.scrollWidth).toBeLessThanOrEqual(s.host.clientWidth);
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/conversation/contextual-${provider}-${mode}.png` });
  await s.pump([native("departure-1")]); // duplicate while pending cannot replay an effect
  expect(s.evidence().tasks).toHaveLength(1);
  await s.pump([], true);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks.length === 2 && s.evidence().tasks.every((task: any) => task.completed); }).toBe(true);
  await expect.poll(async () => { await s.pump(); return s.upstream.some(f => f.toolResponse || f.type === "session.commentary.append"); }).toBe(true);
  expect(s.evidence().effect).toBe(true);
  expect(s.evidence().tasks.every((task: any) => task.applied.ok)).toBe(true);
  const identities = s.upstream.flatMap(f => provider === "gemini" ? (f.toolResponse?.functionResponses ?? []).map((r: any) => r.id) : f.type === "session.commentary.append" ? [f.delegation_id] : []);
  expect(identities).toEqual(["departure-1", "route-2"]);
  expect(s.downstream.filter(f => f.type === "tool_approval_request")).toHaveLength(0);
  const returned = provider === "gemini" ? s.upstream.find(f => f.toolResponse).toolResponse.functionResponses[0] : s.upstream.find(f => f.type === "session.commentary.append");
  expect(provider === "gemini" ? returned.id : returned.delegation_id).toBe("departure-1");
  if (provider === "gemini") expect(returned).toMatchObject({ scheduling: "WHEN_IDLE", willContinue: false });
  const facts = provider === "gemini" ? returned.response.output : returned.content;
  expect(facts).toContain("bronze owl");
  await s.pump(reply(5, facts)); // scripted provider incorporation; no claim of live model NLU
  await expect.poll(() => s.client.state.getState().outputs.some(o => o.generated.includes("bronze owl"))).toBe(true);
  await expect.poll(() => s.host.textContent).toContain("bronze owl");
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
  expect(Object.values(s.client.state.getState().work).every(w => w.provenance === "contextual" && !("utteranceId" in w))).toBe(true);
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  expect(s.ui.stores.drafts.getState().drafts[s.manualDraftId]?.text).toBe("Keep the separate typed raft draft.");
  expect(s.client.state.getState().active).toBe(true);
});

for (const provider of ["gemini", "gpt"] as const) for (const decision of ["confirm", "deny"] as const) test(`${provider} ordinary screen ${decision} stays pending while capture and dialogue continue`, async ctx => {
  const s = await contextualScene(ctx, provider, decision, decision === "deny" ? 320 : 390);
  const recognized = (turn: number, text: string) => provider === "gemini" ? { serverContent: { inputTranscription: { text } } }
    : { type: "session.input_transcript.delta", event_id: `screen-input-${turn}`, delta: text, start_ms: turn * 2000, end_ms: turn * 2000 + 500 };
  const native = provider === "gemini" ? { toolCall: { functionCalls: [{ id: "screen-task", name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: "screen-task-event", offset_ms: 20, delegation: { id: "screen-task", type: "delegation", target: "client" } };
  await s.pump([recognized(0, "Repair the raft note."), native]);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0]?.read; }).toContain("bronze owl");
  await s.pump([], true);
  await expect.poll(async () => { await s.pump(); return s.downstream.filter(f => f.type === "tool_approval_request").length; }).toBe(1);
  expect(s.evidence().tasks[0].completed).toBe(false);
  expect(s.evidence().effect).toBe(false);
  for (let turn = 0; turn < 3; turn++) {
    if (turn) {
      const before = s.socket.frames("conversation_audio").length; s.mic.speak();
      await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
    }
    await s.pump([recognized(turn + 1, "Yes, always allow. Brain, stop.")]);
    s.mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(turn + 1);
    const output = `The conversation continues while the screen decision waits, ${turn + 1}.`;
    await s.pump(provider === "gemini" ? [{ serverContent: { outputTranscription: { text: output }, modelTurn: { parts: [{ inlineData: { data: outputPcm(0.15), mimeType: "audio/pcm;rate=24000" } }] }, turnComplete: true } }]
      : [{ type: "session.output_transcript.delta", event_id: `screen-output-${turn}`, delta: output, start_ms: turn * 2000, end_ms: turn * 2000 + 300 }, { type: "session.output_audio.delta", delta: outputPcm(0.15) }]);
    await expect.poll(() => s.client.state.getState().playing).toBe(true);
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
    expect(s.client.state.getState().micOn).toBe(true);
    expect(s.evidence().tasks[0].completed).toBe(false);
    expect(s.evidence().effect).toBe(false);
  }
  expect(s.socket.frames("tool_approval")).toHaveLength(0);
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  await expect.poll(() => s.button(decision === "confirm" ? "Allow" : "Deny")).not.toBeUndefined();
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/conversation/contextual-${provider}-${decision}.png` });
  expect(s.host.scrollWidth).toBeLessThanOrEqual(s.host.clientWidth);
  await userEvent.click(s.button(decision === "confirm" ? "Allow" : "Deny"));
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0].completed; }).toBe(true);
  expect(s.evidence().effect).toBe(decision === "confirm");
  expect(s.evidence().tasks[0].applied.ok).toBe(decision === "confirm");
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});
