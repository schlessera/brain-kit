/// <reference types="@vitest/browser-playwright" />
import { expect, test, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { CONVERSATION_LIMITS, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { hidePage } from "./offline/fake-microphone.js";
import { SESSION, installConsumerStyles, scene, controlledMicrophone as microphone } from "./conversation-scene.js";

installConsumerStyles();
// Continuous listening reads the PCM the page's worklet sends, from fresh streams.
const controlledMicrophone = (ctx: TestContext) => microphone(ctx, true, { capture: true });



function outputPcm(seconds = 1, audibleSeconds = seconds) {
  const bytes = new Uint8Array(Math.round(48000 * seconds));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(bytes.length / 2, audibleSeconds * 24000); i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function contextualScene(ctx: TestContext, provider: "gemini" | "gpt", action: "permitted" | "confirm" | "deny" = "permitted", width = 390, newChat = false, delayedIdentity = false) {
  const mic = controlledMicrophone(ctx); mic.targetRate.value = provider === "gemini" ? 16000 : 24000;
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
  await pump(); s.client.enter(); s.client.start(); await pump();
  await expect.poll(async () => { await pump(); return s.client.state.getState().profile; }).not.toBe(null);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  await pump();
  return { ...s, mic, pump, upstream, downstream, manualDraftId, evidence: () => evidence };
}

async function discuss(s: Awaited<ReturnType<typeof contextualScene>>, provider: "gemini" | "gpt") {
  const recognized = "Odysseus discusses the harbour watch.";
  const generated = "The watch discussion remains here.";
  await s.pump(provider === "gemini" ? [
    { serverContent: { inputTranscription: { text: recognized, finished: true } } },
    { serverContent: { outputTranscription: { text: generated } } },
  ] : [
    { type: "session.input_transcript.delta", event_id: "watch-recognition", delta: recognized, start_ms: 1, end_ms: 400 },
    { type: "session.output_transcript.delta", event_id: "watch-response", delta: generated, start_ms: 500, end_ms: 900 },
  ]);
  if (provider === "gpt") {
    const audio = s.upstream.find(frame => frame.type === "session.input_audio.append")!;
    expect(audio.event_id, "actual adapter audio identity is present").toBeTypeOf("string");
    await s.pump([{ type: "session.input_transcript.delta", event_id: "watch-associated", client_event_id: audio.event_id, delta: " Keep the mast in sight.", start_ms: 901, end_ms: 1200 }]);
    expect(s.client.state.getState().recognition.some(f => f.kind === "input_fragment")).toBe(true);
  }
  const recognition = s.client.state.getState().recognition;
  expect(recognition.length).toBeGreaterThan(0);
  expect(recognition.every(f => f.contextual)).toBe(true);
  await expect.poll(() => s.host.querySelector("[data-recognized-text]")?.textContent).toContain(recognized);
  await expect.poll(() => s.host.textContent).toContain(generated);
  return { recognition, generated };
}

for (const provider of ["gemini", "gpt"] as const) test(`${provider} contextual discussion has no unsent controls before or after Leave`, async ctx => {
  const s = await contextualScene(ctx, provider, "permitted", 320);
  const { recognition, generated } = await discuss(s, provider);
  for (const afterLeave of [false, true]) {
    if (afterLeave) { await userEvent.click(s.button("End")); await s.pump(); }
    await expect.poll(() => s.host.querySelector('[aria-label="Voice review controls"]'), { message: "CONTEXT_IS_DISCUSSION_NOT_UNSENT" }).toBeNull();
    expect(s.button("Review in composer")).toBeUndefined();
    expect(s.host.textContent).not.toContain("voice fragments weren't sent");
    expect(s.client.state.getState().recognition, "readable discussion survives Leave").toEqual(recognition);
    expect(s.host.textContent).toContain(generated);
    expect(s.ui.stores.drafts.getState().drafts[s.manualDraftId]?.text).toBe("Keep the separate typed raft draft.");
    expect(s.ui.stores.voice.getState().reviewText).toBe("");
  }
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.socket.frames("conversation_playback")).toHaveLength(0);
  expect(s.evidence().tasks).toHaveLength(0);
  expect(s.evidence().effect).toBe(false);
});

for (const provider of ["gemini", "gpt"] as const) test(`${provider} direct review cannot transfer contextual discussion before or after Leave`, async ctx => {
  const s = await contextualScene(ctx, provider);
  const { recognition } = await discuss(s, provider);
  const context = s.client.state.getState().unassigned;
  for (const afterLeave of [false, true]) {
    if (afterLeave) { s.client.leave(); await s.pump(); }
    expect(s.client.reviewUnassigned(), "CONTEXT_DIRECT_REVIEW_IS_NOOP").toBe(false);
    expect(s.client.state.getState().active).toBe(!afterLeave);
    expect(s.client.state.getState().micOn).toBe(!afterLeave);
    expect(s.client.state.getState().unassigned).toEqual(context);
    expect(s.client.state.getState().recognition).toEqual(recognition);
    expect(s.ui.stores.voice.getState().reviewText).toBe("");
    expect(s.ui.stores.drafts.getState().drafts[s.manualDraftId]?.text).toBe("Keep the separate typed raft draft.");
  }
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.socket.frames("chat_message")).toHaveLength(0);
  expect(s.socket.frames("tool_denial")).toHaveLength(0);
  expect(s.socket.frames("conversation_playback")).toHaveLength(0);
  expect(s.evidence().tasks).toHaveLength(0);
  expect(s.evidence().effect).toBe(false);
});

// Native inference is scripted. Capture, PCM, both adapters, host policy and
// pending work are real; no acoustic or provider-quality claim follows.
for (const provider of ["gemini", "gpt"] as const) test(`${provider} audible interruption retains the exact initiating worklet PCM through adapter/host and resumes dialogue during held work`, async ctx => {
  const s = await contextualScene(ctx, provider);
  const native = (id: string) => provider === "gemini" ? { toolCall: { functionCalls: [{ id, name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: `native-${id}`, offset_ms: 500, delegation: { id, type: "delegation", target: "client" } };
  const recognize = (index: number, text: string) => provider === "gemini" ? { serverContent: { inputTranscription: { text } } }
    : { type: "session.input_transcript.delta", event_id: `recognition-${index}`, delta: text, start_ms: index * 500 + 1, end_ms: index * 500 + 400 };
  const output = (pcm: string) => provider === "gemini" ? { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: "audio/pcm;rate=24000" } }] } } }
    : { type: "session.output_audio.delta", delta: pcm };
  const upstreamPcm = () => s.upstream.flatMap(frame => provider === "gemini" ? frame.realtimeInput?.audio?.data ? [frame.realtimeInput.audio.data] : [] : frame.type === "session.input_audio.append" ? [frame.audio] : []);
  await s.pump([recognize(0, "Find the departure signal note."), native("held-departure")]);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0]?.started; }).toBe(true);
  s.mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  await s.pump();
  await s.pump([output(outputPcm(0.8))]);
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  const capturedAt = s.mic.captured.length;
  const framesAt = s.socket.frames("conversation_audio").length;
  s.mic.speak();
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(framesAt);
  const initiating = s.mic.captured.slice(capturedAt).find(chunk => chunk.speaking)!;
  expect(initiating, "actual first speaking AudioWorklet block witnessed before client callback").toBeDefined();
  const first = s.socket.frames("conversation_audio").slice(framesAt).find(frame => frame.pcm === initiating.pcm);
  expect(first, "INITIATING_PCM_RETAINED_BYTE_FOR_BYTE").toBeDefined();
  await s.pump([output(outputPcm(0.1)), native("queued-route")]);
  expect(upstreamPcm(), "INITIATING_PCM_REACHED_ACTUAL_ADAPTER").toContain(initiating.pcm);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().playing).toBe(false);
  expect(s.evidence().tasks).toHaveLength(1);
  expect(s.evidence().tasks[0].completed).toBe(false);
  expect(s.evidence().effect).toBe(false);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  s.mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(2);
  await expect.poll(() => s.client.state.getState().outputRecovery).toBe("audible");
  // Same output identity on GPT; no invented per-answer cancellation boundary.
  await s.pump([output(outputPcm(0.2))]);
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  expect(s.mic.opens()).toBe(1);
  const before = s.socket.frames("conversation_audio").length;
  s.mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
  await s.pump();
  expect(s.evidence().tasks).toHaveLength(1);
  // Contextual recognition is recent context, not a lifetime manual-review cap.
  for (let batch = 0; batch < 5; batch++) await s.pump(Array.from({ length: 40 }, (_, i) => recognize(1 + batch * 40 + i, "Odysseus discusses the harbour. ".repeat(4))));
  expect(s.client.state.getState().micOn, "CONTEXT_CAPACITY_RETAINS_CAPTURE").toBe(true);
  expect(s.downstream.filter(frame => frame.type === "conversation_closed")).toHaveLength(0);
  expect(s.client.state.getState().unassigned.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.maxFragmentsPerUtterance);
  expect(s.client.state.getState().unassigned.every(f => f.taskContext)).toBe(true);
  s.client.mute();
  const stoppedAt = s.socket.frames("conversation_audio").length;
  await s.pump([output(outputPcm(0.1))]);
  expect(s.client.state.getState().micOn, "manual Mute remains authoritative").toBe(false);
  expect(s.socket.frames("conversation_audio")).toHaveLength(stoppedAt);
  s.client.leave();
  await s.pump();
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.evidence().tasks).toHaveLength(1);
  expect(s.evidence().effect).toBe(false);
});

for (const provider of ["gemini", "gpt"] as const) for (const ending of ["recover", "mute", "leave"] as const) test(`${provider} hidden actual replacement ${ending}: retained host conversation, no replay and truthful capture`, async ctx => {
  const s = await contextualScene(ctx, provider);
  const conversationId = s.client.state.getState().profile!.conversationId;
  const firstEpoch = s.client.state.getState().profile!.epoch;
  await s.pump([provider === "gemini" ? { goAway: {} } : { type: "session.closed", reason: "remote_hangup" }]);
  await expect.poll(async () => { if (s.socket.frames("conversation_start").length < 2) await s.pump(); return s.socket.frames("conversation_start").length; }).toBe(2);
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  if (ending === "mute") s.client.mute();
  if (ending === "leave") s.client.leave();
  await s.pump();
  if (ending !== "leave") {
    expect(s.socket.frames("conversation_stop").filter(f => f.resumable !== true), "HIDDEN_OPENING_RETAINS_REAL_HOST_CONVERSATION").toHaveLength(0);
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().profile?.epoch; }).toBeGreaterThan(firstEpoch);
    await s.pump();
    expect(s.client.state.getState().profile?.conversationId).toBe(conversationId);
    expect(s.client.state.getState().micOn).toBe(false);
    expect(s.mic.opens()).toBe(1);
    expect(s.socket.frames("conversation_stop").filter(f => f.resumable !== true), "HIDDEN_OPENING_RETAINS_REAL_HOST_CONVERSATION").toHaveLength(0);
    expect(s.downstream.filter(f => f.type === "error" && f.code === "CONVERSATION_UNKNOWN")).toHaveLength(0);
  }
  hidden.show();
  if (ending === "recover") {
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().micOn; }).toBe(true);
    s.mic.speak();
    await expect.poll(() => s.socket.frames("conversation_audio").some(f => Number(f.epoch) > firstEpoch)).toBe(true);
    await s.pump();
    expect(s.mic.opens()).toBe(2);
    expect(s.downstream.filter(f => f.type === "conversation_closed" && f.reason === "correlation")).toHaveLength(0);
  } else {
    await s.pump();
    expect(s.client.state.getState().micOn).toBe(false);
    expect(s.mic.opens()).toBe(1);
    expect(s.socket.frames("conversation_audio").some(f => Number(f.epoch) > firstEpoch)).toBe(false);
  }
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.evidence().tasks).toHaveLength(0);
  expect(s.evidence().effect).toBe(false);
});
