/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ConversationCapabilities, type ConversationWireEvent, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { transcriptTimelineFor } from "../../src/lib/transcript-timeline.js";
import { BLOCKS } from "../block-fixtures.js";
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
  const streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; const stream = destination.stream.clone(); streams.push(stream); return stream; } });
  ctx.onTestFinished(() => { if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); void context.close(); });
  return { opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}

function outputPcm(seconds = 1, audibleSeconds = seconds) {
  const bytes = new Uint8Array(Math.round(48000 * seconds));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(bytes.length / 2, audibleSeconds * 24000); i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function contextualScene(ctx: TestContext, provider: "gemini" | "gpt", action: "permitted" | "confirm" | "deny" = "permitted", width = 390, newChat = false, delayedIdentity = false) {
  const mic = controlledMicrophone(ctx);
  const s = await scene(ctx, width, true);
  if (newChat) { s.ui.stores.chat.getState().setActiveSession(null); s.ui.stores.chat.getState().setMessages(null, []); }
  const manualDraftId = s.ui.stores.drafts.getState().idFor(newChat ? null : SESSION);
  s.ui.stores.drafts.getState().edit(manualDraftId, newChat ? null : SESSION, { text: "Keep the separate typed raft draft." });
  const fixture = await commands.conversationServer({ op: "start", contextual: true, provider, action, delayedIdentity }) as { id: string };
  ctx.onTestFinished(async () => { await commands.conversationServer({ op: "stop", id: fixture.id }); });
  let cursor = 0;
  const upstream: any[] = [];
  const downstream: ServerMessage[] = [];
  let evidence: any;
  const pump = async (provider: unknown[] = [], release = false, identify = false) => {
    const client = s.socket.sent.slice(cursor).map(bytes => JSON.parse(String(bytes.data))); cursor = s.socket.sent.length;
    evidence = await commands.conversationServer({ op: "step", id: fixture.id, client, provider, release, identify });
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

// #3131 characterization: the peer scripts recognition/output and acknowledges
// transport only. No assertion here establishes a provider's semantic recall.
for (const provider of ["gemini", "gpt"] as const) test(`${provider} research-result evidence: exact bytes, later references, interruption and replacement context`, async ctx => {
  // Use the production Claude runner with scripted inference and a real read
  // through the host bridge; identity and completion have separate barriers.
  const s = await contextualScene(ctx, provider, "permitted", 390, true, true);
  const fact = "The departure signal is a bronze owl.";
  const recognize = (n: number, text: string) => provider === "gemini"
    ? { serverContent: { inputTranscription: { text } } }
    : { type: "session.input_transcript.delta", event_id: `recall-input-${n}`, delta: text, start_ms: n * 2000, end_ms: n * 2000 + 500 };
  const reply = (n: number, text: string, seconds = 0.15) => provider === "gemini"
    ? [{ serverContent: { outputTranscription: { text }, modelTurn: { parts: [{ inlineData: { data: outputPcm(seconds), mimeType: "audio/pcm;rate=24000" } }] }, turnComplete: true } }]
    : [{ type: "session.output_transcript.delta", event_id: `recall-output-${n}`, delta: text, start_ms: n * 2000 + 600, end_ms: n * 2000 + 800 }, { type: "session.output_audio.delta", delta: outputPcm(seconds) }];
  const native = provider === "gemini" ? { toolCall: { functionCalls: [{ id: "recall-research", name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: "recall-delegation", offset_ms: 500, delegation: { id: "recall-research", type: "delegation", target: "client" } };
  const returns = () => s.upstream.flatMap(f => provider === "gemini" ? (f.toolResponse?.functionResponses ?? []).map((r: any) => ({ native: r.id, text: r.response.output, scheduling: r.scheduling }))
    : f.type === "session.thinking.append" || f.type === "session.commentary.append" ? [{ native: f.delegation_id, text: f.content, scheduling: f.type }] : []);
  expect(JSON.stringify(s.upstream)).not.toContain("bronze owl");
  await s.pump([recognize(0, "Find the departure signal note."), native]);
  await s.pump([], false, true);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0]?.read; }).toContain(fact);
  const firstEpoch = s.client.state.getState().profile!.epoch;
  s.mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  await s.pump();
  const spoken = async (n: number, text: string) => {
    const audio = s.socket.frames("conversation_audio").length;
    const endpoints = s.socket.frames("conversation_endpoint").length;
    s.mic.speak();
    await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(audio);
    await s.pump([recognize(n, text)]);
    s.mic.quiet();
    await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBeGreaterThan(endpoints);
    await s.pump();
  };
  for (let n = 1; n <= 2; n++) {
    await spoken(n, n === 1 ? "Tell me about the route while we wait." : "And the harbour watch?");
    await s.pump(reply(n, `Still waiting for the research ${n}.`));
    await expect.poll(() => s.client.state.getState().playing).toBe(true);
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
    expect(s.evidence().tasks[0].completed).toBe(false);
    expect(returns()).toHaveLength(0);
  }
  expect(s.host.textContent).not.toContain(fact);
  expect(s.evidence().tasks[0].prompt).not.toContain("bronze owl");
  await s.pump([], true);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0]?.completed; }).toBe(true);
  await expect.poll(async () => { await s.pump(); return returns().length; }).toBe(1);
  const exact = s.evidence().tasks[0].read + " The host task has finished.";
  expect(returns()).toEqual([{ native: "recall-research", text: exact, scheduling: provider === "gemini" ? "WHEN_IDLE" : "session.commentary.append" }]);
  const receipt = s.downstream.filter(f => f.type === "conversation_work" && f.nativeHandle === "recall-research").at(-1)!;
  expect(receipt).toMatchObject({ provenance: "contextual", epoch: firstEpoch, state: "completed", delivery: provider === "gemini" ? "unknown" : "returned", taskId: expect.any(String), requestId: expect.any(String), turnId: expect.any(String) });
  expect(s.downstream.filter(f => f.type === "text_delta" && (f as any).turnId === (receipt as any).turnId).map(f => (f as any).text).join("")).toBe(exact);
  expect(s.client.state.getState().outputs.some(o => o.generated.includes(fact)), "backend rendering does not synthesize voice output").toBe(false);
  await s.pump(reply(3, fact));
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
  expect(s.socket.frames("conversation_playback").some(f => f.playback === "played")).toBe(true);

  // The peer deliberately ignores a delivered fact: transport acceptance alone
  // permits no claim of comprehension. Then script incorporation and cut output.
  await spoken(4, "What is it made of?");
  await s.pump(reply(4, "I do not know."));
  await expect.poll(() => s.client.state.getState().outputs.some(o => o.generated.includes("I do not know."))).toBe(true);
  await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
  await spoken(5, "Which animal does the departure signal depict?");
  await s.pump(reply(5, fact, 0.5));
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  s.client.stopReply();
  await s.pump();
  expect(s.client.state.getState().profile!.epoch, "local Stop reply retains the healthy epoch").toBe(firstEpoch);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  await expect.poll(() => s.client.state.getState().outputRecovery).toBe("audible");
  await s.pump(reply(6, "The conversation continues after the local cut."));
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  // #3142's historical Stop/Resume receipts characterize the old client.
  // A real provider closure now supplies the independent replacement witness;
  // retained research facts from #3141 must accompany the replacement.
  await s.pump([provider === "gemini" ? { goAway: {} } : { type: "session.closed", reason: "remote_hangup" }]);
  await expect.poll(async () => { await s.pump(); return s.client.state.getState().profile!.epoch; }).toBeGreaterThan(firstEpoch);
  await expect.poll(async () => { await s.pump(); return s.client.state.getState().micOn; }).toBe(true);
  s.mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").some(frame => Number(frame.epoch) > firstEpoch)).toBe(true);
  s.mic.quiet();
  const replacement = provider === "gemini" ? s.upstream.filter(f => f.clientContent).at(-1)?.clientContent
    : s.upstream.filter(f => f.type === "session.start").at(-1)?.session.input;
  expect(JSON.stringify(replacement)).toContain("completed");
  expect(JSON.stringify(replacement)).toContain("Find the departure signal note.");
  expect(JSON.stringify(replacement)).toContain("bronze owl");
  const historicalText = provider === "gemini" ? replacement.turns[0].parts[0].text : replacement[0].content[0].text;
  const historical = JSON.parse(historicalText.slice(historicalText.indexOf("[")));
  expect(historical).toContainEqual(expect.objectContaining({ request: "Find the departure signal note.", outcome: "completed", delivery: provider === "gemini" ? "unknown" : "returned", hostResult: exact }));
  expect(s.client.state.getState().outputs.some(o => o.generated.includes(fact))).toBe(true);
  expect(s.socket.frames("conversation_playback").some(f => f.epoch === firstEpoch && f.playback === "unknown")).toBe(true);
  expect(returns()).toHaveLength(1);
  expect(s.evidence().tasks).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
});

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
  // The result arrived after four continued exchanges, not at its request's position.
  await expect.poll(() => s.host.querySelector(".chat-message-body")?.textContent?.includes("bronze owl")).toBe(true);
  const transcript = s.host.querySelector('[data-reading-column]') ?? s.host;
  const order = transcript.textContent!;
  expect(order.indexOf("The departure signal is a bronze owl."), "new backend answer follows the already displayed fourth exchange").toBeGreaterThan(order.indexOf("Continuing the voyage conversation 4."));
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
  const answers = [...s.host.querySelectorAll(".chat-message-body")].filter(node => node.textContent?.includes("The host task has finished."));
  expect(answers).toHaveLength(2);
  const spoken = [...s.host.querySelectorAll("[data-conversation-output]")].findLast(node => node.textContent?.includes("bronze owl"))!;
  expect(answers.at(-1)!.compareDocumentPosition(spoken) & Node.DOCUMENT_POSITION_FOLLOWING, "later spoken incorporation follows both actual host answers, even with GPT's epoch-wide output ID").toBeTruthy();
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/conversation/ordered-${provider}-${mode}.png` });
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

for (const provider of ["gemini", "gpt"] as const) test(`${provider} delayed backend identity keeps the first automatic task in one voice epoch`, async ctx => {
  const s = await contextualScene(ctx, provider, "permitted", 390, true, true);
  const native = (id: string) => provider === "gemini" ? { toolCall: { functionCalls: [{ id, name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: `native-${id}`, offset_ms: 500, delegation: { id, type: "delegation", target: "client" } };
  const recognized = provider === "gemini" ? { serverContent: { inputTranscription: { text: "Find the departure signal." } } }
    : { type: "session.input_transcript.delta", event_id: "identity-input", delta: "Find the departure signal.", start_ms: 0, end_ms: 500 };
  await s.pump([recognized, native("identity-first")]);
  await s.pump([provider === "gemini" ? { serverContent: { inputTranscription: { text: "Also check the harbour watch." } } }
    : { ...recognized, event_id: "identity-queued-input", delta: "Also check the harbour watch.", start_ms: 600, end_ms: 900 }, native("identity-queued")]);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks.length; }).toBe(1);
  const token = s.client.state.getState().token;
  expect(s.client.state.getState().sessionId).toBe(null);
  expect(s.client.state.getState().micOn).toBe(true);
  await s.pump([], false, true);
  expect(s.client.state.getState().active, "backend identity adoption must not be mistaken for user navigation").toBe(true);
  await expect.poll(() => s.client.state.getState().sessionId).toBe("odysseus-pylos");
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().token).toBe(token);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  const identityIndex = s.downstream.findIndex(f => f.type === "session_info" && f.sessionId === "odysseus-pylos");
  const receiptIndex = s.downstream.findIndex(f => f.type === "conversation_work" && f.sessionId === "odysseus-pylos");
  expect(identityIndex).toBeGreaterThan(-1);
  expect(receiptIndex, "real host identity broadcast precedes its updated work receipt").toBeGreaterThan(identityIndex);
  expect(s.ui.stores.chat.getState().activeSessionId).toBe("odysseus-pylos");
  expect(s.ui.stores.chat.getState().draft).not.toBe(null);
  expect(s.ui.stores.drafts.getState().drafts[s.manualDraftId]?.text).toBe("Keep the separate typed raft draft.");
  await s.pump([], true);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks.filter((task: any) => task.completed).length; }).toBe(2);
  await s.pump([provider === "gemini" ? { serverContent: { inputTranscription: { text: "Check the signal once more." } } }
    : { ...recognized, event_id: "identity-followup-input", delta: "Check the signal once more.", start_ms: 1000, end_ms: 1400 }, native("identity-followup")]);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks.filter((task: any) => task.completed).length; }).toBe(3);
  const identities = s.upstream.flatMap(f => provider === "gemini" ? (f.toolResponse?.functionResponses ?? []).map((r: any) => r.id) : f.type === "session.commentary.append" ? [f.delegation_id] : []);
  expect(identities).toEqual(["identity-first", "identity-queued", "identity-followup"]);
  const facts = s.upstream.flatMap(f => provider === "gemini" ? (f.toolResponse?.functionResponses ?? []).map((r: any) => r.response.output) : f.type === "session.commentary.append" ? [f.content] : []);
  expect(facts).toHaveLength(3);
  expect(facts.every((text: string) => text.includes("bronze owl")), "each exact native binding receives the retrieved backend fact").toBe(true);
  expect(s.evidence().tasks.every((task: any) => task.applied.ok)).toBe(true);
  s.mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  await s.pump(provider === "gemini" ? [{ serverContent: { outputTranscription: { text: facts[0] }, modelTurn: { parts: [{ inlineData: { data: outputPcm(0.15), mimeType: "audio/pcm;rate=24000" } }] }, turnComplete: true } }]
    : [{ type: "session.output_transcript.delta", event_id: "identity-result", delta: facts[0], start_ms: 600, end_ms: 800 }, { type: "session.output_audio.delta", delta: outputPcm(0.15) }]);
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(async () => { await s.pump(); return s.client.state.getState().playing; }).toBe(false);
  expect(s.client.state.getState().active).toBe(true);
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  s.ui.stores.chat.getState().setActiveSession("odysseus-troy");
  expect(s.client.state.getState().active, "intentional navigation still closes capture").toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_stop")).toHaveLength(1);
});

test("contextual identity rejects unrelated, queued, mismatched and stale frames without claiming the typed draft", async ctx => {
  controlledMicrophone(ctx);
  const s = await scene(ctx, 390, true);
  s.ui.stores.chat.getState().setActiveSession(null);
  s.ui.stores.chat.getState().setMessages(null, []);
  // Negotiate contextual mode through the normal opened frame, then capture.
  s.client.enter();
  s.opened(2, { ...CAPS, contextualTasks: "supported" });
  await expect.poll(() => s.button("Start")).not.toBeUndefined();
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  const token = s.client.state.getState().token;
  const typedDraft = s.ui.stores.chat.getState().startDraftTurn();
  const work = { type: "conversation_work", conversationId: PROFILE.conversationId, epoch: 2, requestId: "odysseus-task", taskId: "odysseus-host-task", nativeHandle: "odysseus-native", provenance: "contextual", state: "running", delivery: "pending", recognized: "", submitted: "Find the harbour watch.", turnId: "odysseus-turn" } as const;
  s.deliver({ ...work, requestId: "odysseus-stale", epoch: 1, sessionId: "odysseus-old" });
  expect(s.client.state.getState().work["odysseus-stale"]?.epoch, "historical receipt is valid wire input, not schema rejection").toBe(1);
  expect(s.client.state.getState().sessionId).toBe(null);
  s.deliver(work);
  s.deliver({ ...work, requestId: "odysseus-queued", turnId: undefined, state: "queued" });
  for (const frame of [
    { requestId: "odysseus-unrelated", turnId: "odysseus-turn" },
    { requestId: work.requestId, turnId: "odysseus-wrong-turn" },
    { requestId: "odysseus-queued", turnId: "odysseus-turn" },
    { requestId: "odysseus-stale", turnId: "odysseus-turn" },
  ]) {
    s.deliver({ type: "session_info", isNew: true, sessionId: "odysseus-other", ...frame });
    expect(s.client.state.getState().sessionId).toBe(null);
    expect(s.ui.stores.chat.getState().activeSessionId).toBe(null);
    expect(s.ui.stores.chat.getState().draft).not.toBe(null);
    expect(s.ui.stores.chat.getState().pendingDraftId).toBe(typedDraft);
    expect(s.client.state.getState().micOn).toBe(true);
  }
  s.deliver({ type: "session_info", isNew: true, sessionId: "odysseus-pylos", requestId: work.requestId, turnId: work.turnId });
  expect(s.client.state.getState().sessionId).toBe("odysseus-pylos");
  expect(s.client.state.getState().token).toBe(token);
  // A later/out-of-order receipt cannot rename the selected task session.
  s.deliver({ ...work, sessionId: "odysseus-other" });
  expect(s.client.state.getState().sessionId).toBe("odysseus-pylos");
  s.ui.stores.chat.getState().setActiveSession(null);
  expect(s.client.state.getState().active).toBe(false);
  s.deliver({ type: "session_info", isNew: true, sessionId: "odysseus-pylos", requestId: work.requestId, turnId: work.turnId });
  expect(s.ui.stores.chat.getState().activeSessionId).toBe(null);
  expect(s.ui.stores.chat.getState().draft).not.toBe(null);
});

for (const reconnect of [false, true]) test(`typed legacy identity after contextual voice leave, reconnect=${reconnect}, rejects late contextual work`, async ctx => {
  const s = await scene(ctx);
  s.ui.stores.chat.getState().setActiveSession(null);
  s.ui.stores.chat.getState().setMessages(null, []);
  s.client.enter();
  s.opened(2, { ...CAPS, contextualTasks: "supported" });
  const work = { type: "conversation_work", conversationId: PROFILE.conversationId, epoch: 2, requestId: "odysseus-late-task", taskId: "odysseus-late-host-task", nativeHandle: "odysseus-late-native", provenance: "contextual", state: "running", delivery: "pending", recognized: "", submitted: "Find the harbour watch.", turnId: "odysseus-late-turn" } as const;
  s.deliver(work);
  s.client.leave();
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().profile?.capabilities.contextualTasks).toBe("supported");
  if (reconnect) {
    s.network.drop(); s.network.recover(); s.ui.connection.reconnectNow();
    await expect.poll(() => s.network.socket() !== s.socket && s.ui.stores.connection.getState().wsStatus === "connected").toBe(true);
  }
  const socket = s.network.socket()!;
  // The reconnected host's hello supplies no contextual capability. Voice is
  // inactive, but its historical work receipt must still fence late identities.
  const chat = s.ui.stores.chat.getState();
  const draft = chat.startDraftTurn();
  chat.addUserMessage(null, "Which harbour is sheltered?", "typed");
  chat.startAssistantMessage(null, undefined, "odysseus-typed-request");
  expect(s.ui.connection.send({ type: "chat_message", text: "Which harbour is sheltered?", requestId: "odysseus-typed-request", draftId: draft, source: "typed" })).toBe(true);
  socket.deliver({ type: "session_info", isNew: true, sessionId: "odysseus-late-contextual", requestId: work.requestId, turnId: work.turnId });
  expect(s.ui.stores.chat.getState().activeSessionId, "known contextual requests cannot borrow a typed draft after leave").toBe(null);
  expect(s.ui.stores.chat.getState().pendingDraftId).toBe(draft);
  expect(s.ui.stores.chat.getState().buffers["odysseus-late-contextual"]).toBeUndefined();
  // A legacy host omits the draft echo even for this client's typed request.
  socket.deliver({ type: "session_info", isNew: true, sessionId: "odysseus-typed-harbour", requestId: "odysseus-typed-request" });
  expect(s.ui.stores.chat.getState().activeSessionId, "inactive historical voice capabilities must not disable legacy typed adoption").toBe("odysseus-typed-harbour");
  expect(s.ui.stores.chat.getState().pendingDraftId).toBe(null);
  expect(s.ui.stores.chat.getState().draft).toBe(null);
  socket.deliver({ type: "text_delta", sessionId: "odysseus-typed-harbour", text: "The sheltered harbour is Ithaca." });
  s.ui.connection.flushChatDeltas();
  expect(s.ui.stores.chat.getState().buffers["odysseus-typed-harbour"]?.messages.at(-1)?.content).toBe("The sheltered harbour is Ithaca.");
});


test("mixed transcript window, reading anchor, history resync and session isolation", async ctx => {
  controlledMicrophone(ctx);
  const s = await scene(ctx, 390, true);
  await s.start();
  s.client.mute();
  const chat = s.ui.stores.chat.getState();
  chat.addUserMessage(SESSION, "Find the departure note.", "voice-context");
  chat.startAssistantMessage(SESSION, "ithaca-task");
  const output = (id: string, text: string, epoch = 1) => s.event({ kind: "output_transcript", outputId: id, sequence: 0, text }, epoch);
  for (let i = 0; i < 45; i++) output(`voyage-${i}`, `Voyage exchange ${i}.`);
  await expect.poll(() => s.host.querySelectorAll("[data-conversation-output]").length).toBe(40);
  const scroll = s.host.querySelector('[data-conversation-output]')!.parentElement!.parentElement as HTMLElement;
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  const anchor = s.host.querySelector('[data-output-id="voyage-5"]')!;
  const top = anchor.getBoundingClientRect().top;
  await userEvent.click(page.getByRole("button", { name: /Show .*earlier/ }));
  await expect.poll(() => s.host.querySelectorAll("[data-conversation-output]").length).toBe(45);
  expect(Math.abs(anchor.getBoundingClientRect().top - top), "revealing earlier mixed entries preserves the reading anchor").toBeLessThan(2);
  s.deliver({ type: "text_delta", sessionId: SESSION, text: "The bronze" });
  // Same turn as the following voice frame: buffered backend text must flush first.
  output("epoch-reused", "A continued discussion.");
  s.deliver({ type: "text_delta", sessionId: SESSION, text: " owl." });
  s.ui.connection.flushChatDeltas();
  await expect.poll(() => s.host.textContent).toContain("owl.");
  const entries = [...s.host.querySelectorAll(".chat-message-body,[data-conversation-output]")].map(n => n.textContent!.trim());
  expect(entries.findIndex(t => t === "The bronze")).toBeLessThan(entries.findIndex(t => t.includes("A continued discussion.")));
  expect(entries.findIndex(t => t === "owl.")).toBeGreaterThan(entries.findIndex(t => t.includes("A continued discussion.")));
  const keys = transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.map(e => e.key);
  const snapshot = s.ui.stores.chat.getState().buffers[SESSION]!.messages;
  s.deliver({ type: "session_history", sessionId: SESSION, messages: snapshot.map(m => ({
    role: m.role, content: m.content, source: m.source, turnId: m.turnId, toolCalls: [],
  })) });
  await expect.poll(() => transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.map(e => e.key)).toEqual(keys);
  s.deliver({ type: "conversation_output", conversationId: PROFILE.conversationId, epoch: 1, outputId: "epoch-reused", generated: "A continued discussion.", playback: "unknown" });
  output("stale", "A stale epoch must never appear.", 0);
  expect(transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.map(e => e.key)).toEqual(keys);
  expect(s.host.textContent).not.toContain("A stale epoch");
  s.ui.stores.chat.getState().setActiveSession("odysseus-pylos");
  await expect.poll(() => s.host.querySelectorAll("[data-conversation-output]").length).toBe(0);
  s.ui.stores.chat.getState().setActiveSession(SESSION);
  await expect.poll(() => s.host.querySelectorAll("[data-conversation-output]").length).toBeGreaterThan(0);
  expect(transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.map(e => e.key)).toEqual(keys);
});


test("cold restored speech explicitly has unknown original discussion position", async ctx => {
  const s = await scene(ctx);
  await s.enter();
  s.deliver({ type: "conversation_output", conversationId: PROFILE.conversationId, epoch: 1, outputId: "historical-voyage", generated: "An earlier voyage reply.", playback: "unknown" });
  await expect.poll(() => s.host.querySelector("[data-conversation-output]")?.textContent).toContain("original discussion position unknown");
  expect(s.client.state.getState().micOn).toBe(false);
});


async function arrivalProjectionScene(ctx: TestContext) {
  controlledMicrophone(ctx);
  const s = await scene(ctx, 390, true);
  await s.start(); s.client.mute();
  const chat = s.ui.stores.chat.getState();
  chat.addUserMessage(SESSION, "Find the raft note.", "voice-context");
  chat.startAssistantMessage(SESSION, "raft-projection-turn");
  const delta = (text: string) => {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "raft-projection-turn", text });
    s.ui.connection.flushChatDeltas();
  };
  const speech = () => s.event({ kind: "output_transcript", outputId: "raft-projection-speech", sequence: 0, text: "A calm sea while the task continues." });
  const settle = () => s.deliver({ type: "status", sessionId: SESSION, turnId: "raft-projection-turn", status: "idle" });
  return { ...s, delta, speech, settle };
}

for (const interleaved of [false, true]) test(`arrival projection recovers a leading prefix through production history replay, interleaved=${interleaved}`, async ctx => {
  const s = await arrivalProjectionScene(ctx);
  if (interleaved) { s.delta("bronze"); s.speech(); s.delta(" owl"); } else s.delta("bronze owl");
  const text = () => [...s.host.querySelectorAll(".chat-message-body")].map(n => n.textContent).join("");
  await expect.poll(text).toBe("bronze owl");
  const snapshot = s.ui.stores.chat.getState().buffers[SESSION]!.messages;
  const id = snapshot.at(-1)!.id;
  s.deliver({ type: "session_history", sessionId: SESSION, messages: snapshot.map((m, i) => ({
    role: m.role, source: m.source, content: i === snapshot.length - 1 ? "The bronze owl" : m.content,
    turnId: m.turnId, toolCalls: [],
  })) });
  expect(s.ui.stores.chat.getState().buffers[SESSION]!.messages.at(-1)!.id).toBe(id);
  await expect.poll(text).toBe("The bronze owl");
});

test("arrival projection preserves one complete Markdown link across speech and promotion", async ctx => {
  const s = await arrivalProjectionScene(ctx);
  s.delta("See [raft](");
  await expect.poll(() => s.host.querySelector(".chat-message-body")?.textContent).toBe("See");
  s.speech();
  s.delta("notes/raft.md) before sailing."); s.settle();
  await expect.poll(() => s.host.querySelectorAll('a[href="#/files/notes/raft.md"]').length).toBe(1);
  expect([...s.host.querySelectorAll(".chat-message-body")].map(n => n.textContent).join(" ")).not.toContain("notes/raft.md)");
  const link = s.host.querySelector('a[href="#/files/notes/raft.md"]')!;
  expect(s.host.querySelector("[data-conversation-output]")!.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  s.deliver({ type: "message_links", sessionId: SESSION, turnId: "raft-projection-turn", links: [{ from: "notes/raft.md", to: "notes/odysseus-raft.md" }] });
  await expect.poll(() => s.host.querySelectorAll('a[href="#/files/notes/odysseus-raft.md"]').length).toBe(1);
  expect(s.host.querySelectorAll('a[href="#/files/notes/raft.md"]')).toHaveLength(0);
});

for (const precedingPart of [false, true]) test(`arrival projection retains a classified table spanning speech exactly once, preceding part=${precedingPart}`, async ctx => {
  const s = await arrivalProjectionScene(ctx);
  const table = "| Island | Nights |\n| --- | ---: |\n| Ogygia | 2555 |";
  if (precedingPart) {
    s.delta("The island watch follows.");
    s.deliver({ type: "tool_use_start", sessionId: SESSION, turnId: "raft-projection-turn", toolUseId: "watch-read", toolName: "Read" });
    s.deliver({ type: "tool_use_complete", sessionId: SESSION, turnId: "raft-projection-turn", toolUseId: "watch-read", toolName: "Read", input: { path: "notes/raft.md" } });
    s.deliver({ type: "tool_result", sessionId: SESSION, turnId: "raft-projection-turn", toolUseId: "watch-read", output: "The island watch note is ready.", isError: false });
  }
  s.delta(table.slice(0, 24)); s.speech(); s.delta(table.slice(24)); s.settle();
  s.deliver({ type: "message_blocks", sessionId: SESSION, turnId: "raft-projection-turn", blocks: [{ partIndex: precedingPart ? 1 : 0, start: 0, end: table.length, confidence: 1, block: BLOCKS.table }] });
  await expect.poll(() => s.host.querySelectorAll('[data-classified-block="table"]').length).toBe(1);
  expect(s.host.querySelector('[data-classified-block="table"]')!.textContent).toContain("Aeaea");
  expect(s.host.querySelector('[data-classified-block="table"]')!.textContent).toContain("Ogygia");
  expect(s.host.querySelectorAll(".chat-message-body .brain-prose table")).toHaveLength(0);
  const words = [...s.host.querySelectorAll(".chat-message-body")].map(n => n.textContent).join("");
  expect(words.match(/Aeaea/g)).toHaveLength(1);
  expect(words.match(/Ogygia/g)).toHaveLength(1);
  expect(words).not.toContain("| Island |");
  expect(s.host.querySelectorAll('[aria-label="Share message"]')).toHaveLength(1);
});


for (const shape of ["emphasis", "reference", "autolink", "escape", "code", "share", "footnotes", "bare", "wiki"] as const) test(`arrival Markdown context across speech: ${shape}`, async ctx => {
  const s = await arrivalProjectionScene(ctx);
  const cases = {
    footnotes: { text: "Odysseus[^watch] and Penelope[^watch].\n\n[^watch]: Bronze owl.", at: 16, words: "Bronze owl." },
    bare: { text: "See notes/raft.md before sailing.", at: 12, words: "See notes/raft.md before sailing." },
    wiki: { text: "See [[notes/raft.md|raft]] before sailing.", at: 15, words: "See raft before sailing." },
    emphasis: { text: "Before **bronze owl** after.", at: 15, words: "Before bronze owl after." },
    reference: { text: "See [raft][note].\n\n[note]: notes/raft.md", at: 10, words: "See raft." },
    autolink: { text: "See https://example.org/raft before sailing.", at: 16, words: "See" },
    escape: { text: "Bronze &amp; olive \\*watch\\*.", at: 10, words: "Bronze & olive *watch*." },
    code: { text: "Use `notes/raft.md` for the watch.", at: 12, words: "Use notes/raft.md for the watch." },
    share: { text: '<share format="text" title="Raft">A bronze owl. <script>globalThis.odysseusRangeExecuted = true</script></share>', at: 39, words: "A bronze owl." },
  };
  const sample = cases[shape];
  s.delta(sample.text.slice(0, sample.at)); s.speech(); s.delta(sample.text.slice(sample.at)); s.settle();
  await expect.poll(() => [...s.host.querySelectorAll(".chat-message-body")].map(n => n.textContent).join("")).toContain(sample.words);
  if (shape === "emphasis") expect([...s.host.querySelectorAll(".chat-message-body strong")].map(n => n.textContent).join("")).toBe("bronze owl");
  if (shape === "reference" || shape === "code" || shape === "bare" || shape === "wiki") expect(s.host.querySelectorAll('a[href="#/files/notes/raft.md"]')).toHaveLength(1);
  if (shape === "autolink") expect(s.host.querySelectorAll('a[href="https://example.org/raft"]')).toHaveLength(1);
  if (shape === "footnotes") {
    expect(s.host.querySelectorAll("[data-footnotes]")).toHaveLength(1);
    expect(s.host.querySelectorAll('[id="user-content-fn-watch"]')).toHaveLength(1);
    expect([...s.host.querySelectorAll(".chat-message-body")].map(n => n.textContent).join("").match(/Bronze owl\./g)).toHaveLength(1);
  }
  if (shape === "share") {
    expect(page.getByRole("button", { name: "Share as plain text", exact: true }).elements()).toHaveLength(1);
    expect(s.host.querySelectorAll(".chat-message-body script")).toHaveLength(0);
    expect((globalThis as typeof globalThis & { odysseusRangeExecuted?: boolean }).odysseusRangeExecuted).toBeUndefined();
  }
  expect(s.host.querySelectorAll('[aria-label="Share message"]')).toHaveLength(1);
});


test("a growing Markdown table retains its first source anchor across speech", async ctx => {
  const s = await arrivalProjectionScene(ctx);
  s.delta("| Island | Watch |\n| --- | --- |\n| Ithaca | Dawn |\n");
  await expect.poll(() => s.host.querySelectorAll(".brain-prose table").length).toBe(1);
  const first = s.host.querySelector(".brain-prose table")!.closest(".chat-message-body")!;
  s.speech(); s.delta("| Pylos | Dusk |\n"); s.settle();
  await expect.poll(() => first.textContent).toContain("Dusk");
  expect(s.host.querySelectorAll(".brain-prose table")).toHaveLength(1);
  expect(first.compareDocumentPosition(s.host.querySelector("[data-conversation-output]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([...s.host.querySelectorAll(".chat-message-body")].map(n => n.textContent).join("").match(/Ithaca/g)).toHaveLength(1);
});
