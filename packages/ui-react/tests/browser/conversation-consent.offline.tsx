/// <reference types="@vitest/browser-playwright" />
import { expect, test } from "vitest";
import { hidePage } from "./offline/fake-microphone.js";
import { CAPS, PROFILE, installConsumerStyles, scene, controlledMicrophone } from "./conversation-scene.js";

installConsumerStyles();



test("review: same-ID agent profile changes require renewed disclosure after recovery", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx);
  const before = { id: "ithaca-agent", label: "Ithaca agent", backendId: "odyssey-local", model: "odyssey-local-model" };
  s.ui.stores.provider.setState({ available: [before], selectedId: before.id, pinnedId: before.id });
  await s.start();
  s.ui.stores.provider.setState({ available: [{ ...before, label: "Changed Ithaca agent", backendId: "odyssey-remote", model: "odyssey-remote-model" }] });
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  s.opened(2);
  expect(s.client.state.getState().disclosureOpen, "AGENT_DISCLOSURE_CHANGE_REQUIRES_START").toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
});

test("review: provider closure during pending opening settles without late capture after Mute", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  s.client.mute();
  s.opened(2);
  // Frames are handled as they are delivered, and a capture opens the
  // microphone synchronously, so once epoch 2 is applied any capture its
  // opening or readiness allowed has already called getUserMedia. Without a
  // new capture session the microphone cannot turn on later.
  await expect.poll(() => s.client.state.getState().profile?.epoch).toBe(2);
  expect(mic.opens()).toBe(1);
  expect(s.client.state.getState().micOn).toBe(false);
});

test("review: hiding during replacement opening cannot delete the retained conversation", async ctx => {
  controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  expect(s.socket.frames("conversation_start")).toHaveLength(2);
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  s.opened(2);
  await Promise.resolve();
  const destructive = s.socket.frames("conversation_stop").filter(frame => frame.resumable !== true);
  expect(destructive, "HIDDEN_OPENING_MUST_NOT_DELETE_RESUMABLE_CONVERSATION").toHaveLength(0);
});

const ENTRY = { id: "ithaca-agent", label: "Ithaca agent", backendId: "odyssey-local", model: "odyssey-local-model" };
for (const change of ["backend", "model", "removed", "replaced-id"] as const) test(`entry profile ${change}: fresh disclosure and Start gate every capture restart`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx);
  s.ui.stores.provider.setState({ available: [ENTRY], selectedId: ENTRY.id, pinnedId: ENTRY.id });
  await s.start();
  const changed = change === "removed" ? [] : [{ ...ENTRY, ...(change === "backend" ? { backendId: "odyssey-remote" } : change === "model" ? { model: "odyssey-remote-model" } : { id: "pylos-agent" }) }];
  s.ui.stores.provider.setState({ available: changed });
  expect(s.client.state.getState().micOn, "PROFILE_CHANGE_REVOKES_CAPTURE_IMMEDIATELY").toBe(false);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
  expect(mic.streams[0]!.getTracks().map(track => track.readyState), "PROFILE_CHANGE_ENDS_CAPTURE_TRACKS").toEqual(["ended"]);
  s.client.resume();
  expect(mic.opens()).toBe(1);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  s.opened(2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.socket.frames("conversation_audio").filter(f => f.epoch === 2), "NO_EPOCH_2_AUDIO_BEFORE_START").toEqual([]);
  s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
});

test("entry metadata survives roster order and ordinary picker pin/adoption changes", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx);
  const other = { ...ENTRY, id: "pylos-agent", label: "Pylos agent" };
  s.ui.stores.provider.setState({ available: [ENTRY, other], selectedId: ENTRY.id, pinnedId: ENTRY.id });
  await s.start();
  const reordered = { model: ENTRY.model, label: ENTRY.label, id: ENTRY.id, backendId: ENTRY.backendId };
  s.ui.stores.provider.setState({ available: [other, reordered], selectedId: other.id, pinnedId: other.id });
  expect(s.client.state.getState().disclosureOpen).toBe(false);
  expect(s.client.state.getState().micOn).toBe(true);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  s.opened(2);
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(2);
  expect(s.client.state.getState().disclosureOpen).toBe(false);
});

test("an existing session discloses its effective pinned profile rather than the next-chat selection", async ctx => {
  controlledMicrophone(ctx, true);
  const s = await scene(ctx);
  const other = { ...ENTRY, id: "pylos-agent" };
  s.ui.stores.provider.setState({ available: [ENTRY, other], selectedId: other.id, pinnedId: ENTRY.id });
  await s.start();
  s.ui.stores.provider.setState({ available: [ENTRY, { ...other, model: "pylos-next-model" }] });
  expect(s.client.state.getState().micOn).toBe(true);
  s.ui.stores.provider.setState({ available: [{ ...ENTRY, model: "ithaca-changed-model" }, other] });
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
});

for (const phase of ["opening", "before-ready", "ready"] as const) for (const muted of [false, true]) test(`hide ${phase} retains ${muted ? "manual Mute" : "consent"} without abandoning the replacement`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  const requestId = String(s.socket.frames("conversation_start").at(-1)!.requestId);
  if (phase !== "opening") s.deliver({ ...PROFILE, epoch: 2, requestId });
  if (phase === "ready") { s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, 2); await expect.poll(() => s.client.state.getState().micOn).toBe(true); }
  const opens = mic.opens();
  const endpoints = s.socket.frames("conversation_endpoint").length;
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  if (muted) s.client.mute();
  if (phase === "opening") s.deliver({ ...PROFILE, epoch: 2, requestId });
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, 2);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(opens);
  if (phase === "opening") expect(s.socket.frames("conversation_endpoint"), "no endpoint targets an ended epoch while opening").toHaveLength(endpoints);
  expect(s.socket.frames("conversation_stop").filter(f => f.resumable !== true)).toHaveLength(0);
  hidden.show();
  if (!muted) await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  else expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(muted ? opens : opens + 1);
  expect(s.client.state.getState().profile?.epoch).toBe(2);
  expect(s.socket.frames("conversation_start")).toHaveLength(2);
});

test("an initial opening hidden before Start still requires its first disclosure", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); s.client.enter();
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  s.opened();
  expect(s.client.state.getState().profile).toBeNull();
  expect(s.socket.frames("conversation_start")).toHaveLength(0);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  hidden.show();
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
  s.client.start();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(1);
});

for (const ending of ["mute", "leave", "auth", "destination", "agent-profile"] as const) test(`hidden pending opening respects ${ending}`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  const requestId = String(s.socket.frames("conversation_start").at(-1)!.requestId);
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  if (ending === "mute") s.client.mute();
  else if (ending === "leave") s.client.leave();
  else if (ending === "auth") await s.ui.authLock.expire("Odysseus signed out", true);
  s.deliver({ ...PROFILE, epoch: 2, requestId, ...(ending === "agent-profile" ? { agentProviderId: "pylos-agent" } : {}), ...(ending === "destination" ? { disclosure: { ...PROFILE.disclosure, destinations: ["Audio: changed Odyssey fixture destination."] } } : {}) });
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, 2);
  hidden.show();
  await Promise.resolve();
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
  if (ending === "destination" || ending === "agent-profile") expect(s.client.state.getState().disclosureOpen).toBe(true);
  if (ending === "leave" || ending === "auth") expect(s.client.state.getState().active).toBe(false);
});

test("foreign, duplicate and late opening responses cannot consume the current replacement", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  const firstRequest = String(s.socket.frames("conversation_start")[0]!.requestId);
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  const requestId = String(s.socket.frames("conversation_start").at(-1)!.requestId);
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  s.deliver({ ...PROFILE, epoch: 2, requestId: "foreign-opening" });
  s.deliver({ ...PROFILE, epoch: 2, requestId, conversationId: "foreign-voice" });
  s.deliver({ ...PROFILE, epoch: 1, requestId });
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, requestId: String(firstRequest), reason: "stopped" });
  expect(s.client.state.getState().profile?.epoch).toBe(1);
  s.opened(2);
  expect(s.client.state.getState().profile?.epoch).toBe(2);
  hidden.show();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  s.deliver({ ...PROFILE, epoch: 1, requestId: firstRequest });
  expect(s.client.state.getState().profile?.epoch).toBe(2);
  expect(mic.opens()).toBe(2);
  expect(s.socket.frames("conversation_stop").filter(f => f.resumable !== true)).toHaveLength(0);
});

test("Leave and a new entry keep late old openings outside the new consent scope", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start();
  s.deliver({ type: "conversation_closed", conversationId: PROFILE.conversationId, epoch: 1, reason: "provider_closed" });
  const oldRequest = String(s.socket.frames("conversation_start").at(-1)!.requestId);
  s.client.leave(); s.client.enter(); s.client.start();
  s.deliver({ ...PROFILE, epoch: 2, requestId: oldRequest });
  await Promise.resolve();
  expect(s.socket.frames("conversation_start")).toHaveLength(3);
  expect(s.client.state.getState().profile).toBe(null);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(mic.opens()).toBe(1);
  s.opened(3);
  expect(s.client.state.getState().disclosureOpen).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
});

test("hide after initial Start but before readiness restores capture without a second Start", async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); s.client.enter(); s.client.start();
  s.deliver({ ...PROFILE, requestId: String(s.socket.frames("conversation_start").at(-1)!.requestId) });
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  s.event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  expect(mic.opens()).toBe(0);
  hidden.show();
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  expect(mic.opens()).toBe(1);
  expect(s.socket.frames("conversation_start")).toHaveLength(1);
});

for (const ending of ["mute", "leave", "hide", "auth", "disclosure"] as const) test(`late physical capture permission respects ${ending} and cannot revive its retired callback`, async ctx => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator.mediaDevices, "getUserMedia");
  const mic = controlledMicrophone(ctx, true);
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia")!;
  const fixtureCapture = descriptor.value as MediaDevices["getUserMedia"];
  let resolveFirst!: (stream: MediaStream) => void;
  let calls = 0;
  Object.defineProperty(media, "getUserMedia", { ...descriptor, value: (constraints: MediaStreamConstraints) => {
    if (++calls === 1) return new Promise<MediaStream>(resolve => { resolveFirst = resolve; });
    return fixtureCapture.call(media, constraints);
  } });
  ctx.onTestFinished(() => {
    if (originalDescriptor) Object.defineProperty(media, "getUserMedia", originalDescriptor);
    else Reflect.deleteProperty(media, "getUserMedia");
  });
  const s = await scene(ctx);
  s.ui.stores.provider.setState({ available: [ENTRY], selectedId: ENTRY.id, pinnedId: ENTRY.id });
  await s.enter(); s.client.start();
  await expect.poll(() => calls).toBe(1);
  if (ending === "mute") s.client.mute();
  else if (ending === "leave") s.client.leave();
  else if (ending === "auth") await s.ui.authLock.expire("Odysseus signed out", true);
  else if (ending === "disclosure") s.ui.stores.provider.setState({ available: [{ ...ENTRY, model: "changed-model" }] });
  else { const hidden = hidePage(); ctx.onTestFinished(() => hidden.show()); hidden.show(); }
  const late = mic.stream.clone(); ctx.onTestFinished(() => late.getTracks().forEach(track => track.stop()));
  resolveFirst(late);
  await expect.poll(() => late.getTracks().every(track => track.readyState === "ended")).toBe(true);
  if (ending === "hide") {
    await expect.poll(() => s.client.state.getState().micOn).toBe(true);
    expect(calls).toBe(2);
  } else {
    expect(s.client.state.getState().micOn).toBe(false);
    expect(calls).toBe(1);
    expect(s.socket.frames("conversation_audio")).toHaveLength(0);
  }
});

for (const providerId of ["gemini-live","gpt-live"]) test(`${providerId}: Enter and Cancel have no start; reconnect without explicit Start remains local`,async ctx=>{
 const s=await scene(ctx);const disclosed={providerId,capabilities:CAPS,disclosure:{...PROFILE.disclosure,voiceService:providerId}};
 s.socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true},conversationProfile:disclosed});
 s.client.enter();expect(s.socket.frames("conversation_start"),"ENTER_MUST_NOT_START_PROVIDER").toHaveLength(0);
 expect(s.client.state.getState().profile).toBeNull();s.client.leave();expect(s.socket.frames("conversation_start")).toHaveLength(0);
 s.client.enter();s.network.drop();s.network.recover();
 await expect.poll(()=>s.network.socket()!==s.socket).toBe(true);
 const next=s.network.socket()!;next.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true},conversationProfile:disclosed});
 expect(next.frames("conversation_start"),"RECONNECT_WITHOUT_START_CANNOT_INHERIT_CONSENT").toHaveLength(0);
 s.client.start();expect(next.frames("conversation_start")).toHaveLength(1);expect(next.frames("conversation_start")[0]!.disclosed,"CURRENT_HELLO_EXACT_PROFILE_IS_ECHOED").toEqual(disclosed);
});

test("changed hello destination retires pending opening and requires Start again",async ctx=>{
 const s=await scene(ctx);s.client.enter();s.client.start();
 const first=s.socket.frames("conversation_start").at(-1)!;
 const changed={providerId:"gemini-live",capabilities:CAPS,disclosure:{voiceService:"Gemini Live of Ithaca",destinations:["Prior text goes to the newly selected voice service."]}};
 s.socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true},conversationProfile:changed});
 expect(s.socket.frames("conversation_start"),"CHANGED_DESTINATION_HAS_NO_INFERRED_START").toHaveLength(1);
 expect(s.client.state.getState().disclosureOpen,"CHANGED_HELLO_REQUIRES_START_DISCLOSURE").toBe(true);
 s.socket.deliver({...PROFILE,requestId:first.requestId});
 expect(s.socket.frames("conversation_stop").filter(f=>f.conversationId===PROFILE.conversationId),"LATE_OLD_PROFILE_IS_STOPPED_ONCE").toHaveLength(1);
 expect(s.client.state.getState().profile).toBeNull();expect(s.client.state.getState().micOn).toBe(false);
 s.client.start();expect(s.socket.frames("conversation_start")).toHaveLength(2);
 expect(s.socket.frames("conversation_start").at(-1)!.disclosed).toEqual(changed);
});

test("an old server with no disclosure profile cannot offer voice",async ctx=>{
 const s=await scene(ctx);s.socket.deliver({type:"server_hello",protocolRev:5,capabilities:{liveConversation:true,conversationPause:true}});
 expect(s.client.state.getState().available).toBe(false);s.client.enter();s.client.start();
 expect(s.socket.frames("conversation_start"),"NO_UNDISCLOSED_OLD_SERVER_START").toHaveLength(0);
});

test("a missing replacement hello profile retires its pending opening and requires Start after recovery",async ctx=>{
 const s=await scene(ctx);s.client.enter();s.client.start();const request=s.socket.frames("conversation_start")[0]!;
 s.socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true}});
 s.socket.deliver({...PROFILE,requestId:request.requestId});
 expect(s.socket.frames("conversation_stop"),"MISSING_PROFILE_RETIRES_LATE_OPENING").toHaveLength(1);
 expect(s.client.state.getState().profile).toBeNull();expect(s.client.state.getState().micOn).toBe(false);
 const profile={providerId:PROFILE.providerId,capabilities:PROFILE.capabilities,disclosure:PROFILE.disclosure};
 s.socket.deliver({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true},conversationProfile:profile});
 await Promise.resolve();expect(s.socket.frames("conversation_start"),"RESTORED_PROFILE_DOES_NOT_RESTORE_RETIRED_START").toHaveLength(1);
 s.client.start();expect(s.socket.frames("conversation_start")).toHaveLength(2);
});
