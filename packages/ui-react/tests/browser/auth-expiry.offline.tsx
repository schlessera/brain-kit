/// <reference types="@vitest/browser-playwright" />
/** Real microphone/recorder with #1016's offline host and speech faults.
 * Host auth expiry cancels streaming and local capture; transport loss alone
 * leaves local capture and protected views live. Each cell owns its root.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { LocalWorkStatus, WorkRestore } from "../../src/lib/local-work.js";
import type { VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { watchMicrophone } from "./offline/fake-microphone.ts";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork, type FaultNetwork } from "./offline/fault-network.ts";

const ITHACA = "odysseus-ithaca";
const SPEECH = "wss://speech.invalid/v1/listen";

const HELLO = [
  { type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } },
  { type: "session_info", sessionId: ITHACA, isNew: false },
  { type: "session_history", sessionId: ITHACA, messages: [] },
  { type: "status", sessionId: ITHACA, status: "idle" },
];

const capabilities = { streaming: true, interimResults: true, keyterms: false, endpointing: false };

function session(providerId: "deepgram" | "webspeech"): VoiceSessionResponse {
  return { providerId, url: SPEECH, token: "odysseus-grant", expiresAt: Date.now() + 60 * 60_000, capabilities };
}

// The consumer's stylesheet, so the composer lays out as the app's does.
let styles: HTMLStyleElement | undefined;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles?.remove());
afterEach(() => {
  vi.unstubAllGlobals();
});

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; net: FaultNetwork; snapshot: { entered: boolean; finish(): void } };

async function mount(ctx: TestContext, providerId: "deepgram" | "webspeech", local = false): Promise<Scene> {
  const net = installFaultNetwork({
    routes: (url) => {
      if (url.pathname.endsWith("/voice/session")) return Response.json(session(providerId));
      if (url.pathname.endsWith("/voice/overrides")) return Response.json({ overrides: [] });
      if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] });
      return undefined;
    },
    // The host says hello on its own socket; the speech socket hears nothing until the test speaks.
    onOpen: (socket) => { if (!socket.url.startsWith(SPEECH)) for (const frame of HELLO) socket.deliver(frame); },
  });
  ctx.onTestFinished(() => net.restore());
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:390px;height:780px";
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: net.request, localCapture: local ? {sink:()=>({chunk(){},end(){}}),timesliceMs:200} : null });
  let finish!: () => void;
  const commit = new Promise<void>((yes) => { finish = yes; });
  const snapshot = { entered: false, finish };
  ui.localWork = {
    status: createStore<LocalWorkStatus>(() => ({ failed: false, pending: false })),
    restore: createStore<WorkRestore>(() => ({ selection: null, focusId: null, scroll: null })),
    snapshotNow: async () => { snapshot.entered = true; await commit; },
    addTranscript: async () => { throw new Error("This auth fixture has no durable recordings"); },
    openDeviceVersion: async () => { throw new Error("This auth fixture has no draft versions"); },
    register: () => () => {}, changed() {}, restoring: async () => {}, lock() {}, quiesce: async () => {}, resume: async () => false, dispose() {},
  };
  ctx.onTestFinished(finish);
  const renderer = createRoot(host);
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  ui.stores.chat.getState().setActiveSession(ITHACA);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><ConnectionGate><ChatPage /></ConnectionGate></BrainUiProvider>));

  await expect.poll(() => ui.stores.connection.getState().wsStatus, { message: "the app reached the host" }).toBe("connected");
  return { ui, host, net, snapshot };
}

const dictate = (s: Scene) => s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label="Dictate"]');

/** Taps Dictate and waits for the provider's client to be listening. */
async function startDictating(s: Scene) {
  await expect.poll(() => dictate(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(dictate(s)!);
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the dictation sheet is open" }).toBe("dictate");
  await expect.poll(() => s.ui.stores.voice.getState().connecting, { message: "the microphone is live", timeout: 5_000 }).toBe(false);
}


/** Host auth cannot close the independent speech provider socket. Keep the
 * #1016 host/probe fault, while only the shipped capture-end path may close speech. */
function expireHost(s: Scene) {
  const speech = s.net.socket(SPEECH);
  const finish = speech?.finish;
  if (speech && finish) speech.finish = (code, reason, clean) => { if (code !== 1008) finish.call(speech, code, reason, clean); };
  s.net.expireAuth();
  if (speech && finish) speech.finish = finish;
}

async function settle() {
  await expect.poll(() => document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity), { message: "entrances settled" }).toBe(false);
}

test("host auth expiry cancels live streaming dictation through the capture-end path and removes protected DOM", {timeout:20_000}, async(ctx)=>{
 const mic=watchMicrophone(); ctx.onTestFinished(()=>mic.restore());
 const s=await mount(ctx,"deepgram"); await settle(); await startDictating(s);
 await expect.poll(()=>s.net.frames.filter((f)=>f.url.startsWith(SPEECH)&&f.data instanceof Blob).length).toBeGreaterThan(0);
 s.net.socket(SPEECH)!.deliver({type:"Results",is_final:true,speech_final:false,channel:{alternatives:[{transcript:"Tie Odysseus to the mast"}]}});
 await expect.poll(()=>s.ui.stores.voice.getState().finalText).toBe("Tie Odysseus to the mast");
 expect(mic.streams.length,"the real mic opened").toBeGreaterThan(0);
 expireHost(s);
 await expect.poll(()=>s.snapshot.entered).toBe(true);
 expect(s.host.querySelector("textarea[data-composer]"),"capture stops before protected views unmount").not.toBeNull();
 expect(mic.streams.flatMap((stream)=>stream.getTracks()).every((t)=>t.readyState==="ended"),"all streaming tracks stopped").toBe(true);
 expect(s.ui.stores.voice.getState().mode,"dictation cancelled").toBe("idle");
 s.snapshot.finish(); await expect.poll(()=>s.ui.authLock.state.getState().phase).toBe("locked");
 expect(s.ui.stores.voice.getState().finalText).toBe("");
 expect(s.host.querySelector("textarea[data-composer]"),"protected views unmounted").toBeNull();
 expect(document.documentElement.outerHTML).not.toContain("Tie Odysseus to the mast");
 expect(s.net.requests.some((r)=>r.url.includes("/auth/login")),"expiry never signs in by itself").toBe(false);
});

test("transport drop keeps local capture and protected views mounted; auth expiry separately ends them",{timeout:20_000},async(ctx)=>{
 const mic=watchMicrophone(); ctx.onTestFinished(()=>mic.restore());
 const s=await mount(ctx,"deepgram",true); await settle();
 s.net.drop();
 await expect.poll(()=>s.ui.stores.connection.getState().wsStatus).toBe("disconnected");
 await settle();
 const local=()=>s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label="Record on this device"]');
 await expect.poll(local).not.toBeNull(); await userEvent.click(local()!);
 await expect.poll(()=>s.ui.stores.voice.getState().local).toBe("recording");
 expect(mic.streams.length).toBeGreaterThan(0);
 expect(s.host.querySelector("textarea[data-composer]"),"transport keeps protected views mounted").not.toBeNull();
 expect(mic.streams.flatMap((stream)=>stream.getTracks()).every((t)=>t.readyState==="live"),"transport keeps recording live").toBe(true);
 s.net.recover(); s.ui.connection.reconnectNow();
 await expect.poll(()=>s.ui.stores.connection.getState().wsStatus).toBe("connected");
 expect(s.ui.stores.voice.getState().local,"reconnect does not stop or restart capture").toBe("recording");
 expireHost(s);
 await expect.poll(()=>s.snapshot.entered).toBe(true);
 expect(s.host.querySelector("textarea[data-composer]"),"local capture stops before protected views unmount").not.toBeNull();
 expect(mic.streams.flatMap((stream)=>stream.getTracks()).every((t)=>t.readyState==="ended"),"auth stops every local track").toBe(true);
 s.snapshot.finish(); await expect.poll(()=>s.ui.authLock.state.getState().phase).toBe("locked");
 expect(s.host.querySelector("textarea[data-composer]"),"auth removes protected views").toBeNull();
});


test("auth expiry interrupts a Done already draining and closes its real microphone immediately",{timeout:20_000},async(ctx)=>{
 const mic=watchMicrophone(); ctx.onTestFinished(()=>mic.restore());
 const s=await mount(ctx,"deepgram"); await settle(); await startDictating(s);
 await expect.poll(()=>s.net.frames.filter(f=>f.url.startsWith(SPEECH)&&f.data instanceof Blob).length).toBeGreaterThan(0);
 s.net.socket(SPEECH)!.deliver({type:"Results",is_final:true,speech_final:false,channel:{alternatives:[{transcript:"Ask Nestor about the ships"}]}});
 await expect.poll(()=>s.ui.stores.voice.getState().finalText).toBe("Ask Nestor about the ships");
 const done=s.host.querySelector<HTMLElement>('[aria-label="Done"]') ?? [...s.host.querySelectorAll<HTMLElement>('button,[role="button"]')].find(el=>el.textContent?.trim()==="Done");
 expect(done,"dictation has Done").toBeDefined(); await userEvent.click(done!);
 await expect.poll(()=>s.ui.stores.voice.getState().draining,{message:"Done is awaiting provider tail"}).toBe(true);
 expect(mic.streams.length).toBeGreaterThan(0);
 expireHost(s); await expect.poll(()=>s.snapshot.entered).toBe(true);
 expect(s.host.querySelector("textarea[data-composer]"),"draining capture closes before protected views unmount").not.toBeNull();
 expect(mic.streams.flatMap(stream=>stream.getTracks()).every(t=>t.readyState==="ended"),"auth closes the draining microphone before lock").toBe(true);
 s.snapshot.finish(); await expect.poll(()=>s.ui.authLock.state.getState().phase).toBe("locked");
 expect(s.ui.stores.voice.getState().draining).toBe(false);
 expect(s.ui.stores.voice.getState().reviewText,"cancelled drain never reaches review").toBe("");
 s.net.socket(SPEECH)?.onmessage?.(new MessageEvent("message",{data:JSON.stringify({type:"Metadata"})}));
 await new Promise(yes=>setTimeout(yes,100));
 expect(s.ui.stores.voice.getState().reviewText,"late drain completion cannot repopulate locked review").toBe("");
});
