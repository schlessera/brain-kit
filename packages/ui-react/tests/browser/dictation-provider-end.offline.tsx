/// <reference types="@vitest/browser-playwright" />
/**
 * A dictation the speech provider ends on its own (#1189), in real Chromium.
 *
 * The real ChatPage dictates through the shipped clients. For Deepgram:
 * Chromium's fake microphone, the real recorder, and #1016's fault network
 * standing in for both the host and the speech socket, which the test closes
 * the ways a provider and a network do. For Web Speech: a scripted recognizer
 * in place of the browser's, which would need Google's servers. Either way
 * the words heard must be on the review card once the dictation sheet is
 * gone, not lost with it.
 *
 * Every test owns its root, mount and network, removed when it ends.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
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

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; net: FaultNetwork };

async function mount(ctx: TestContext, providerId: "deepgram" | "webspeech"): Promise<Scene> {
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
  const ui = createBrainUiRoot({ storage: null, request: net.request });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  ui.stores.chat.getState().setActiveSession(ITHACA);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  ui.connection.connect();
  await expect.poll(() => ui.stores.connection.getState().wsStatus, { message: "the app reached the host" }).toBe("connected");
  return { ui, host, net };
}

const dictate = (s: Scene) => s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label="Dictate"]');

/** Taps Dictate and waits for the provider's client to be listening. */
async function startDictating(s: Scene) {
  await expect.poll(() => dictate(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(dictate(s)!);
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the dictation sheet is open" }).toBe("dictate");
  await expect.poll(() => s.ui.stores.voice.getState().connecting, { message: "the microphone is live", timeout: 5_000 }).toBe(false);
}

/** The review card's transcript, outside the dictation sheet. */
function reviewed(s: Scene): string | null {
  for (const p of s.host.querySelectorAll("p")) {
    if (p.closest("[data-dictation-transcript]")) continue;
    if (p.textContent === "Ask Nestor about the ships") return p.textContent;
  }
  return null;
}

async function expectReviewed(s: Scene) {
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the provider ended the dictation" }).toBe("idle");
  const voice = s.ui.stores.voice.getState();
  expect(voice.reviewText, "what was heard waits for review").toBe("Ask Nestor about the ships");
  expect(voice.finalText, "nothing is stranded in the capture").toBe("");
  await expect.poll(() => reviewed(s), { message: "the review card shows the words" }).toBe("Ask Nestor about the ships");
}

const deepgramEndings: { name: string; end: (net: FaultNetwork) => void }[] = [
  { name: "Deepgram closes the stream", end: (net) => net.socket(SPEECH)!.finish(1000, "", true) },
  { name: "Deepgram times the stream out", end: (net) => net.socket(SPEECH)!.finish(1011, "NET-0001", true) },
  { name: "the network drops", end: (net) => net.drop() },
  { name: "the speech grant expires", end: (net) => net.socket(SPEECH)!.finish(1008, "Grant expired", true) },
];

for (const ending of deepgramEndings) {
  test(`${ending.name} mid-dictation, and the words heard wait on the review card`, { timeout: 20_000 }, async (ctx) => {
    const s = await mount(ctx, "deepgram");
    await startDictating(s);
    await expect.poll(() => s.net.socket(SPEECH)?.readyState, { message: "the speech socket is open", timeout: 5_000 }).toBe(1);
    // The fake microphone's audio is on its way: the capture is real.
    await expect.poll(() => s.net.frames.filter((f) => f.url.startsWith(SPEECH) && f.data instanceof Blob).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    const speech = s.net.socket(SPEECH)!;
    speech.deliver({ type: "Results", is_final: true, speech_final: false, channel: { alternatives: [{ transcript: "Ask Nestor" }] } });
    speech.deliver({ type: "Results", is_final: false, speech_final: false, channel: { alternatives: [{ transcript: "about the ships" }] } });
    await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe("Ask Nestor");

    ending.end(s.net);
    await expectReviewed(s);
  });
}

/** A recognizer the test scripts, in place of the browser's. */
class ScriptedRecognition {
  static last: ScriptedRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() { ScriptedRecognition.last = this; }
  start() { this.started = true; }
  stop() {}
  abort() {}
  hear(text: string, isFinal: boolean) { this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] }); }
}

const webSpeechEndings: { name: string; end: (r: ScriptedRecognition) => void }[] = [
  { name: "the browser ends recognition", end: (r) => r.onend?.() },
  { name: "recognition fails", end: (r) => { r.onerror?.({ error: "network" }); r.onend?.(); } },
];

for (const ending of webSpeechEndings) {
  test(`${ending.name} mid-dictation, and the words heard wait on the review card`, { timeout: 20_000 }, async (ctx) => {
    ScriptedRecognition.last = null;
    vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
    vi.stubGlobal("webkitSpeechRecognition", ScriptedRecognition);
    const s = await mount(ctx, "webspeech");
    await startDictating(s);
    const recognition = ScriptedRecognition.last!;
    expect(recognition.started, "the shipped client started the recognizer").toBe(true);
    recognition.hear("Ask Nestor", true);
    recognition.hear("about the ships", false);
    await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe("Ask Nestor");

    ending.end(recognition);
    await expectReviewed(s);
  });
}
