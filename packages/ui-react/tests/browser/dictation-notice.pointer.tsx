/// <reference types="@vitest/browser-playwright" />
/**
 * A dictation that fails (#1189, #1222), in real Chromium, as the voice
 * field's notices draw it (#3694): D7 when the microphone is the reason, D8
 * otherwise, quoting the words kept.
 *
 * The real ChatPage dictates through the shipped clients. For Deepgram:
 * Chromium's fake microphone, the real recorder, and #1016's fault network
 * standing in for both the host and the speech socket, which the test closes
 * the ways a provider and a network do. For Web Speech: a scripted recognizer
 * in place of the browser's, which would need Google's servers. Either way
 * the words heard must be in the draft once the voice field is gone, not
 * lost with it, and nothing is sent.
 *
 * Every test owns its root, mount and network, removed when it ends.
 */
import { inject, afterAll, afterEach, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { contrast, over, parse, type Rgb } from "../../../ui-kit/tests/_contrast.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork, type FaultNetwork } from "./offline/fault-network.ts";
import { primeDictation } from "../fixtures/dictation-discovery.js";

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

async function mount(ctx: TestContext, providerId: "deepgram" | "webspeech", startupFailure = false): Promise<Scene> {
  const net = installFaultNetwork({
    routes: (url) => {
      if (url.pathname.endsWith("/voice/session")) {
        if (startupFailure) throw new TypeError("https://speech.invalid/?token=odysseus-untrusted");
        return Response.json(session(providerId));
      }
      if (url.pathname.endsWith("/voice/overrides")) return Response.json({ overrides: [] });
      if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] });
      return undefined;
    },
    // The host says hello on its own socket; the speech socket hears nothing until the test speaks.
    onOpen: (socket) => { if (!socket.url.startsWith(SPEECH)) for (const frame of HELLO) socket.deliver(frame); },
  });
  ctx.onTestFinished(() => net.restore());
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bk-color-canvas)";
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: net.request, localCapture: { sink: () => ({ chunk: async () => {} }) } });
  primeDictation(ui, providerId);
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

const dictate = (s: Scene) => s.host.querySelector<HTMLElement>('[data-composer] :is(button,[role="button"])[aria-label^="Dictate"]');

/** Taps Dictate and waits for the provider's client to be listening. */
async function startDictating(s: Scene) {
  await expect.poll(() => dictate(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(dictate(s)!);
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "the voice field is open" }).toBe("dictate");
  await expect.poll(() => s.ui.stores.voice.getState().connecting, { message: "the microphone is live", timeout: 5_000 }).toBe(false);
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


const words = "Ask Nestor about the ships";
/** The failure notice (D7 or D8) above the composer. */
const notice = (s: Scene) => s.host.querySelector<HTMLElement>("[data-dictation-notice]");
const action = (s: Scene, label: string) => [...notice(s)?.querySelectorAll<HTMLElement>("button") ?? []].find(el => el.textContent?.trim() === label) ?? null;
const draft = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")?.value ?? null;
const frame = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));

async function viewport(ctx: TestContext, width: number, theme: string) {
  const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
  const outer = await commands.formViewport(width, 800);
  await page.viewport(width, 800);
  document.documentElement.dataset.theme = theme;
  ctx.onTestFinished(async () => {
    document.documentElement.dataset.theme = before.theme;
    await page.viewport(before.width, before.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
}

async function failedCapture(s: Scene, provider: "deepgram" | "webspeech", retained: boolean, code = "network") {
  await startDictating(s);
  if (provider === "deepgram") {
    await expect.poll(() => s.net.socket(SPEECH)?.readyState).toBe(1);
    await expect.poll(() => s.net.frames.filter(f => f.url.startsWith(SPEECH) && f.data instanceof Blob).length).toBeGreaterThan(0);
    if (retained) s.net.socket(SPEECH)!.deliver({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: words }] } });
  } else if (retained) ScriptedRecognition.last!.hear(words, true);
  if (retained) await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe(words);
  if (provider === "deepgram") s.net.socket(SPEECH)!.finish(1006, "odysseus-untrusted", false);
  else { ScriptedRecognition.last!.onerror?.({ error: code }); ScriptedRecognition.last!.onend?.(); }
  await expect.poll(() => notice(s), { message: "the failure notice replaces the voice field" }).not.toBe(null);
  await frame();
}

function readable(element: HTMLElement) {
  const ancestors: HTMLElement[] = [];
  for (let at: HTMLElement | null = element; at; at = at.parentElement) ancestors.unshift(at);
  let background: Rgb = [255, 255, 255];
  for (const at of ancestors) background = over(parse(getComputedStyle(at).backgroundColor), background);
  return contrast(over(parse(getComputedStyle(element).color), background), background);
}

for (const theme of ["dark", "light"]) for (const width of [320, 1280]) for (const provider of ["deepgram", "webspeech"] as const) for (const retained of [true, false]) {
  test(`${width} ${theme} ${provider} ${retained ? "kept" : "empty"}: D8 quotes the kept words, which are in the draft; one polite announcement; no focus theft`, async ctx => {
    expect(matchMedia("(any-pointer: fine)").matches).toBe(inject("railPointer") !== "coarse");
    expect(matchMedia("(any-pointer: coarse)").matches).toBe(inject("railPointer") !== "fine");
    await viewport(ctx, width, theme);
    vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
    vi.stubGlobal("webkitSpeechRecognition", ScriptedRecognition);
    const s = await mount(ctx, provider);
    const announced: string[] = [];
    const seen = new Map<Element, string>();
    const observer = new MutationObserver(() => {
      const regions = [...s.host.querySelectorAll('[role="status"], [aria-live="polite"]')].filter(el => el.textContent?.includes("Dictation stopped"));
      for (const region of regions) if (seen.get(region) !== region.textContent) {
        announced.push(region.textContent!); seen.set(region, region.textContent!);
      }
    });
    observer.observe(s.host, { subtree: true, childList: true, characterData: true });
    ctx.onTestFinished(() => observer.disconnect());
    await failedCapture(s, provider, retained);
    expect(notice(s)!.dataset.dictationNotice).toBe("D8");
    const body = retained ? `Kept so far: \u201c${words}\u201d` : "Dictation stopped: a connection problem occurred.";
    expect(notice(s)!.querySelector(".bk-voice-notice-title")!.textContent).toBe("Dictation stopped");
    expect(notice(s)!.querySelector(".bk-voice-notice-body")!.textContent).toBe(body);
    expect([...notice(s)!.querySelectorAll("button")].map(b => b.textContent), "D8's actions").toEqual(["Dismiss", "Try again"]);
    expect(draft(s), "the words heard are in the draft, never lost").toBe(retained ? words : "");
    expect(announced, "one polite announcement, without a mirrored region").toEqual([`Dictation stopped${body}`]);
    const box = notice(s)!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
    expect(s.host.scrollWidth).toBeLessThanOrEqual(width);
    expect(readable(notice(s)!.querySelector<HTMLElement>(".bk-voice-notice-body")!), "computed explanation contrast reaches 4.5:1").toBeGreaterThanOrEqual(4.5);
    expect(readable(action(s, "Dismiss")!), "computed Dismiss contrast reaches 4.5:1").toBeGreaterThanOrEqual(4.5);
    // The take ended with focus in the field: it returns to the composer, never to the notice.
    await expect.poll(() => document.activeElement).toBe(retained ? s.host.querySelector("textarea[data-composer]") : dictate(s));
    expect(notice(s)!.contains(document.activeElement)).toBe(false);
    if (retained) expect(dictate(s)?.getAttribute("aria-label"), "D6: the mic adds to the kept words").toBe("Dictate more");
    action(s, "Dismiss")!.focus(); await userEvent.keyboard("{Enter}");
    await expect.poll(() => notice(s)).toBeNull();
    expect(document.activeElement).toBe(dictate(s));
    expect(draft(s), "Dismiss keeps the words in the draft").toBe(retained ? words : "");
    expect(s.net.frames.filter(f => !f.url.startsWith(SPEECH) && typeof f.data === "string" && f.data.includes("chat_message")), "nothing is sent").toEqual([]);
  });
}

test("Try again starts a new take whose words follow the kept ones", async ctx => {
  await viewport(ctx, 1280, "dark");
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  const s = await mount(ctx, "webspeech");
  await failedCapture(s, "webspeech", true);
  const first = ScriptedRecognition.last;
  await userEvent.click(action(s, "Try again")!);
  await expect.poll(() => notice(s), { message: "Try again clears the notice" }).toBeNull();
  await expect.poll(() => ScriptedRecognition.last !== first && ScriptedRecognition.last?.started, { message: "a new take started" }).toBe(true);
  ScriptedRecognition.last!.hear("and the harbour", true);
  await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe("and the harbour");
  await userEvent.click(s.host.querySelector<HTMLElement>('[aria-label="Finish dictation"]')!);
  ScriptedRecognition.last!.onend?.();
  await expect.poll(() => draft(s)).toBe(`${words} and the harbour`);
});

test("typing and switching sessions retain the notice; a stacked local refusal has its own dismissal", async ctx => {
  await viewport(ctx, 320, "light");
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  const s = await mount(ctx, "webspeech");
  await failedCapture(s, "webspeech", true);
  const field = s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  await userEvent.fill(field, "Ask Penelope about the loom");
  flushSync(() => s.ui.stores.chat.getState().setActiveSession("odysseus-pylos"));
  await frame(); expect(notice(s)).not.toBeNull();
  // Time does not dismiss the notice; no timer is installed by its surface.
  await new Promise(done => setTimeout(done, 1100)); expect(notice(s)).not.toBeNull();
  s.net.drop({ announce: true });
  flushSync(() => s.ui.stores.voice.getState().setLocalNotice("denied"));
  await expect.poll(() => s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  expect(notice(s)!.getBoundingClientRect().right).toBeLessThanOrEqual(320);
  const localDismiss = s.host.querySelector<HTMLElement>('[aria-label="Dismiss capture notice"]')!;
  await userEvent.click(localDismiss);
  await expect.poll(() => s.host.querySelector('[data-capture-notice="local"]')).toBeNull();
  expect(notice(s), "clearing the local cause keeps the dictation cause").not.toBeNull();
  await userEvent.click(action(s, "Dismiss")!);
  await expect.poll(() => notice(s)).toBeNull();
  flushSync(() => s.ui.stores.chat.getState().setActiveSession(ITHACA));
  await expect.poll(() => draft(s), { message: "the kept words, edited, stay in their session's draft" }).toBe("Ask Penelope about the loom");
});

for (const code of ["not-allowed", "no-speech", "https://speech.invalid/?token=odysseus-untrusted"]) {
  test(`Web Speech ${code}: exact safe copy in Chromium`, async ctx => {
    await viewport(ctx, 320, "light"); vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
    const s = await mount(ctx, "webspeech");
    await failedCapture(s, "webspeech", false, code);
    const [form, title, body] = code === "not-allowed" ? ["D7", "Microphone is blocked", "Allow it in this site\u2019s browser settings, then tap the mic again."]
      : code === "no-speech" ? ["D8", "Dictation stopped", "Dictation stopped: no speech heard."] : ["D8", "Dictation stopped", "Dictation stopped unexpectedly."];
    expect(notice(s)!.dataset.dictationNotice).toBe(form);
    expect(notice(s)!.querySelector(".bk-voice-notice-title")!.textContent).toBe(title);
    expect(notice(s)!.querySelector(".bk-voice-notice-body")!.textContent).toBe(body);
    expect(s.host.textContent).not.toContain("odysseus-untrusted");
  });
}

for (const failure of ["fetch", "mic"] as const) {
  test(`${failure} startup fails through the actual path with the draft intact and no restart`, async ctx => {
    await viewport(ctx, 1280, "dark");
    const s = await mount(ctx, "deepgram", failure === "fetch");
    const field = s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
    await userEvent.fill(field, "Ask Penelope about the loom");
    let activations = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(async constraints => {
      activations++;
      if (failure === "mic") throw new DOMException("https://speech.invalid/?token=odysseus-untrusted", "NotAllowedError");
      return original(constraints);
    });
    ctx.onTestFinished(() => { vi.restoreAllMocks(); });
    await userEvent.click(dictate(s)!);
    await expect.poll(() => notice(s)?.dataset.dictationNotice).toBe(failure === "fetch" ? "D8" : "D7");
    expect(notice(s)!.querySelector(".bk-voice-notice-body")!.textContent).toBe(failure === "fetch"
      ? "Dictation couldn't start: a connection problem occurred." : "Allow it in this site\u2019s browser settings, then tap the mic again.");
    expect(s.host.textContent).not.toContain("odysseus-untrusted");
    expect(draft(s)).toBe("Ask Penelope about the loom");
    expect(s.ui.stores.voice.getState().mode).toBe("idle");
    expect(activations).toBe(failure === "mic" ? 1 : 0);
    await new Promise(done => setTimeout(done, 400));
    expect(activations, "no automatic microphone retry").toBe(failure === "mic" ? 1 : 0);
    if (failure === "mic") {
      await userEvent.click(action(s, "OK")!);
      await expect.poll(() => notice(s)).toBeNull();
      expect(document.activeElement).toBe(dictate(s));
    }
  });
}

for (const ending of ["Finish", "clean", "malformed-Finish"] as const) {
  test(`${ending} creates no failure notice in Chromium`, async ctx => {
    await viewport(ctx, 1280, "dark");
    const s = await mount(ctx, "deepgram"); await startDictating(s);
    const socket = s.net.socket(SPEECH)!;
    await expect.poll(() => socket.readyState).toBe(1);
    socket.deliver({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: words }] } });
    if (ending === "malformed-Finish") {
      socket.deliver("https://speech.invalid/?token=odysseus-untrusted");
      await expect.poll(() => s.ui.stores.voice.getState().error).toBe("A dictation problem occurred.");
      expect(s.host.textContent).not.toContain("odysseus-untrusted");
      expect(notice(s)).toBeNull();
    }
    if (ending === "clean") socket.finish(1000, "", true);
    else {
      // The provider flushes and closes in response to Finish.
      const original = socket.send.bind(socket);
      socket.send = data => { original(data); if (data === '{"type":"CloseStream"}') { socket.deliver({ type: "Metadata" }); socket.finish(1000, "", true); } };
      await userEvent.click(s.host.querySelector<HTMLElement>('[aria-label="Finish dictation"]')!);
    }
    await expect.poll(() => s.ui.stores.voice.getState().mode).toBe("idle");
    expect(notice(s), "user actions and non-ending errors are not failures").toBeNull();
    await expect.poll(() => draft(s)).toBe(words);
  });
}

test("keyboard Dismiss falls back to the field when the microphone is unavailable", async ctx => {
  await viewport(ctx, 320, "light");
  // Recognition still works; local recording is unsupported in this browser.
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  vi.stubGlobal("MediaRecorder", undefined);
  const s = await mount(ctx, "webspeech"); await failedCapture(s, "webspeech", true);
  // The take's end has handed focus to the field before the keyboard moves it.
  await expect.poll(() => document.activeElement).toBe(s.host.querySelector("textarea[data-composer]"));
  s.net.drop({ announce: true });
  await expect.poll(() => dictate(s)).toBeNull();
  await expect.poll(() => s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  action(s, "Dismiss")!.focus();
  expect(document.activeElement, "Dismiss holds focus").toBe(action(s, "Dismiss"));
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => notice(s)).toBeNull();
  await expect.poll(() => document.activeElement).toBe(s.host.querySelector("textarea[data-composer]"));
  expect(s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  expect(draft(s)).toBe(words);
});

test("Escape cancels a listening take, while a finishing one refuses it", async ctx => {
  await viewport(ctx, 1280, "dark");
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  const s = await mount(ctx, "webspeech");
  await startDictating(s);
  ScriptedRecognition.last!.hear(words, true);
  await expect.poll(() => s.ui.stores.voice.getState().finalText).toBe(words);
  flushSync(() => s.ui.stores.voice.setState({ draining: true }));
  await userEvent.keyboard("{Escape}");
  await frame();
  expect(s.ui.stores.voice.getState().mode, "finishing refuses Escape").toBe("dictate");
  flushSync(() => s.ui.stores.voice.setState({ draining: false }));
  await frame();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "Escape cancels the take" }).toBe("idle");
  expect(draft(s), "a cancelled take adds nothing").toBe("");
  await expect.poll(() => document.activeElement).toBe(dictate(s));
});
