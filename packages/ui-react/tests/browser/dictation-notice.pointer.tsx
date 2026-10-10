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
const notice = (s: Scene) => s.host.querySelector<HTMLElement>('[data-capture-notice="dictation"]');
const dismiss = (s: Scene) => s.host.querySelector<HTMLElement>('[aria-label="Dismiss dictation notice"]')!;
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
  // Sheet entrance has settled before any interaction with its controls.
  await new Promise(done => setTimeout(done, 350));
  if (provider === "deepgram") {
    await expect.poll(() => s.net.socket(SPEECH)?.readyState).toBe(1);
    await expect.poll(() => s.net.frames.filter(f => f.url.startsWith(SPEECH) && f.data instanceof Blob).length).toBeGreaterThan(0);
    if (retained) s.net.socket(SPEECH)!.deliver({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: words }] } });
  } else if (retained) ScriptedRecognition.last!.hear(words, true);
  const field = s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  field.focus();
  if (innerWidth < 900) expect(document.activeElement, "modal capture keeps background field inert").not.toBe(field);
  if (provider === "deepgram") s.net.socket(SPEECH)!.finish(1006, "odysseus-untrusted", false);
  else { ScriptedRecognition.last!.onerror?.({ error: code }); ScriptedRecognition.last!.onend?.(); }
  await expect.poll(() => notice(s)?.textContent ?? "", { message: "visible explanation survives the sheet closing" }).toContain("Dictation stopped");
  await frame();
  // Both capture surfaces return to the mic. The modal phone sheet prevents
  // the old background-field focus attempt; the notice never takes focus.
  expect(document.activeElement, "capture close returns to the mic, not the notice").toBe(dictate(s));
}

for (const theme of ["dark", "light"]) for (const width of [320, 1280]) for (const provider of ["deepgram", "webspeech"] as const) for (const retained of [true, false]) {
  test(`${width} ${theme} ${provider} ${retained ? "kept" : "empty"}: one visible polite explanation, reachable Dismiss, no focus theft`, async ctx => {
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
    const expected = "Dictation stopped: a connection problem occurred. " + (retained ? "Your words are kept for review." : "Nothing was captured.");
    expect(notice(s)!.textContent).toBe(expected + "Dismiss");
    expect(s.ui.stores.voice.getState().reviewText).toBe(retained ? words : "");
    expect(s.host.querySelector('[aria-label="Dictation"]')).toBeNull();
    expect(announced, "one explanation insertion in a polite status, without a mirrored region").toEqual([expected + "Dismiss"]);
    expect(s.host.querySelectorAll('[role="status"], [aria-live="polite"]').length).toBeGreaterThan(0);
    expect([...s.host.querySelectorAll('[role="status"], [aria-live="polite"]')].filter(el => el.textContent?.includes("Dictation stopped"))).toHaveLength(1);
    const box = notice(s)!.getBoundingClientRect();
    const target = dismiss(s).getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
    expect(s.host.scrollWidth).toBeLessThanOrEqual(width);
    const text = notice(s)!.querySelector<HTMLElement>('div > div > span:last-child')!;
    expect(text.textContent, "visible Callout text exists").toContain("Dictation stopped");
    function readable(element: HTMLElement) {
      const ancestors: HTMLElement[] = [];
      for (let at: HTMLElement | null = element; at; at = at.parentElement) ancestors.unshift(at);
      let background: Rgb = [255, 255, 255];
      for (const at of ancestors) background = over(parse(getComputedStyle(at).backgroundColor), background);
      return contrast(over(parse(getComputedStyle(element).color), background), background);
    }
    expect(readable(text), "computed explanation contrast reaches 4.5:1").toBeGreaterThanOrEqual(4.5);
    expect(readable(dismiss(s)), "computed Dismiss contrast reaches 4.5:1").toBeGreaterThanOrEqual(4.5);
    expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
    expect(document.elementFromPoint(target.left + 1, target.top + target.height / 2)?.closest('[aria-label="Dismiss dictation notice"]')).toBe(dismiss(s));
    expect(document.elementFromPoint(target.right - 1, target.top + target.height / 2)?.closest('[aria-label="Dismiss dictation notice"]')).toBe(dismiss(s));
    expect(getComputedStyle(notice(s)!).animationName).toBe("none");
    expect(getComputedStyle(notice(s)!).transitionDuration).toBe("0s");
    const focusable = [...s.host.querySelectorAll<HTMLElement>('button, [role="button"], textarea')].filter(el => el.tabIndex >= 0);
    if (retained) {
      const discard = page.elementLocator(s.host).getByRole("button", { name: "Discard", exact: true }).query() as HTMLElement;
      expect(discard, "review action is nonempty").toBeTruthy();
      expect(focusable.indexOf(discard)).toBeGreaterThanOrEqual(0);
      expect(focusable.indexOf(discard)).toBeLessThan(focusable.indexOf(dismiss(s)));
    }
    dismiss(s).focus(); await userEvent.keyboard("{Enter}");
    await expect.poll(() => notice(s)).toBeNull();
    expect(document.activeElement).toBe(dictate(s));
    expect(s.ui.stores.voice.getState().reviewText, "dismiss keeps captured words in review").toBe(retained ? words : "");
  });
}

for (const action of ["Discard", "Edit", "Send", "Add", "Dictate", "local"] as const) {
  test(`${action} clears the dictation notice through the actual composer action`, async ctx => {
    await viewport(ctx, 1280, "dark");
    vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
    const s = await mount(ctx, "webspeech");
    await failedCapture(s, "webspeech", true);
    if (action === "local") {
      s.net.drop({ announce: true });
      await expect.poll(() => s.host.querySelector('[aria-label="Record on this device"]')).not.toBeNull();
      await userEvent.click(s.host.querySelector<HTMLElement>('[aria-label="Record on this device"]')!);
    } else {
      const control = action === "Dictate" ? dictate(s)! : [...s.host.querySelectorAll<HTMLElement>('button, [role="button"]')].find(el => el.textContent?.trim() === action)!;
      expect(control, "real review or microphone action is present").toBeTruthy();
      await userEvent.click(control);
    }
    await expect.poll(() => notice(s), { message: `${action} clears the explanation` }).toBeNull();
  });
}

test("typing and switching sessions retain the notice; stacked local refusal has independent dismissal and pointer dismissal preserves unrelated focus", async ctx => {
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
  const all = [...s.host.querySelectorAll('[data-capture-notice]')];
  expect(all.map(el => el.getAttribute("data-capture-notice"))).toEqual(["dictation", "local"]);
  expect(all.every(el => el.getBoundingClientRect().right <= 320)).toBe(true);
  const localDismiss = s.host.querySelector<HTMLElement>('[aria-label="Dismiss capture notice"]')!;
  field.focus(); await userEvent.click(localDismiss);
  await expect.poll(() => s.host.querySelector('[data-capture-notice="local"]')).toBeNull();
  expect(notice(s), "clearing local cause keeps dictation cause").not.toBeNull();
  flushSync(() => s.ui.stores.voice.getState().setLocalNotice("denied"));
  await expect.poll(() => s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  field.focus(); await userEvent.click(dismiss(s));
  await expect.poll(() => notice(s)).toBeNull();
  expect(document.activeElement, "pointer dismiss does not steal unrelated field focus").toBe(field);
  expect(s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  expect(s.ui.stores.voice.getState().reviewText).toBe(words);
});

for (const code of ["not-allowed", "no-speech", "https://speech.invalid/?token=odysseus-untrusted"]) {
  test(`Web Speech ${code}: exact safe ended copy in Chromium`, async ctx => {
    await viewport(ctx, 320, "light"); vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
    const s = await mount(ctx, "webspeech");
    await failedCapture(s, "webspeech", false, code);
    const expected = code === "not-allowed" ? "Dictation stopped: the microphone isn't available. Nothing was captured."
      : code === "no-speech" ? "Dictation stopped: no speech heard." : "Dictation stopped unexpectedly. Nothing was captured.";
    expect(notice(s)!.textContent).toBe(expected + "Dismiss");
    expect(notice(s)!.textContent).not.toContain("odysseus-untrusted");
  });
}

for (const failure of ["fetch", "mic"] as const) {
  test(`${failure} startup fails through the actual path with earlier review intact and no restart`, async ctx => {
    await viewport(ctx, 1280, "dark");
    const s = await mount(ctx, "deepgram", failure === "fetch");
    flushSync(() => s.ui.stores.voice.getState().setReviewText("Ask Penelope about the loom"));
    let activations = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(async constraints => {
      activations++;
      if (failure === "mic") throw new DOMException("https://speech.invalid/?token=odysseus-untrusted", "NotAllowedError");
      return original(constraints);
    });
    ctx.onTestFinished(() => { vi.restoreAllMocks(); });
    await userEvent.click(dictate(s)!);
    const expected = failure === "fetch" ? "Dictation couldn't start: a connection problem occurred. Nothing was captured."
      : "Dictation couldn't start: the microphone isn't available. Nothing was captured.";
    await expect.poll(() => notice(s)?.textContent).toBe(expected + "Dismiss");
    expect(s.ui.stores.voice.getState().reviewText).toBe("Ask Penelope about the loom");
    expect(s.ui.stores.voice.getState().mode).toBe("idle");
    expect(activations).toBe(failure === "mic" ? 1 : 0);
    await new Promise(done => setTimeout(done, 400));
    expect(activations, "no automatic microphone retry").toBe(failure === "mic" ? 1 : 0);
  });
}

for (const ending of ["Done", "Cancel", "clean", "malformed-Done"] as const) {
  test(`${ending} creates no terminal failure notice in Chromium`, async ctx => {
    await viewport(ctx, 1280, "dark");
    const s = await mount(ctx, "deepgram"); await startDictating(s); await new Promise(done => setTimeout(done, 350));
    const socket = s.net.socket(SPEECH)!;
    await expect.poll(() => socket.readyState).toBe(1);
    socket.deliver({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: words }] } });
    if (ending === "malformed-Done") {
      socket.deliver("https://speech.invalid/?token=odysseus-untrusted");
      await expect.poll(() => s.ui.stores.voice.getState().error).toBe("A dictation problem occurred.");
      expect(s.host.textContent).toContain("A dictation problem occurred.");
      expect(s.host.textContent).not.toContain("odysseus-untrusted");
      expect(notice(s)).toBeNull();
    }
    if (ending === "clean") socket.finish(1000, "", true);
    else if (ending === "Cancel") await userEvent.click(s.host.querySelector<HTMLElement>('[aria-label="Cancel dictation"]')!);
    else {
      // The provider flushes and closes in response to Done.
      const original = socket.send.bind(socket);
      socket.send = data => { original(data); if (data === '{"type":"CloseStream"}') { socket.deliver({ type: "Metadata" }); socket.finish(1000, "", true); } };
      await userEvent.click([...s.host.querySelectorAll<HTMLElement>("button")].find(el => el.textContent?.trim() === "Done")!);
    }
    await expect.poll(() => s.ui.stores.voice.getState().mode).toBe("idle");
    expect(notice(s), "user actions and non-ending errors are not terminal failures").toBeNull();
    expect(s.ui.stores.voice.getState().reviewText).toBe(ending === "Cancel" ? "" : words);
  });
}

test("default motion also has no notice entrance transition", async ctx => {
  await viewport(ctx, 320, "dark"); await commands.dictationMotion("no-preference");
  ctx.onTestFinished(() => commands.dictationMotion("reduce"));
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  const s = await mount(ctx, "webspeech"); await failedCapture(s, "webspeech", false);
  expect(getComputedStyle(notice(s)!).animationName).toBe("none");
  expect(getComputedStyle(notice(s)!).transitionDuration).toBe("0s");
});

test("keyboard Dismiss falls back to the field when the microphone is unavailable", async ctx => {
  await viewport(ctx, 320, "light");
  // Recognition still works; local recording is unsupported in this browser.
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  vi.stubGlobal("MediaRecorder", undefined);
  const s = await mount(ctx, "webspeech"); await failedCapture(s, "webspeech", true);
  s.net.drop({ announce: true });
  await expect.poll(() => dictate(s)).toBeNull();
  await expect.poll(() => s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  dismiss(s).focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => notice(s)).toBeNull();
  expect(document.activeElement).toBe(s.host.querySelector("textarea[data-composer]"));
  expect(s.host.querySelector('[data-capture-notice="local"]')).not.toBeNull();
  expect(s.ui.stores.voice.getState().reviewText).toBe(words);
});

test("desktop Escape from the composer cancels dictation, while draining refuses it", async ctx => {
  // Mutation: scope Escape to the popover instead of the document.
  await viewport(ctx, 1280, "dark");
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  const s = await mount(ctx, "webspeech");
  await startDictating(s);
  const composer = s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  expect(composer, "real composer exists").not.toBeNull();
  flushSync(() => s.ui.stores.voice.setState({ draining: true }));
  composer.focus(); await userEvent.keyboard("{Escape}");
  expect(s.ui.stores.voice.getState().mode, "draining refuses composer Escape").toBe("dictate");
  flushSync(() => s.ui.stores.voice.setState({ draining: false }));
  composer.focus(); await userEvent.keyboard("{Escape}");
  await expect.poll(() => s.ui.stores.voice.getState().mode, { message: "composer Escape cancels desktop dictation" }).toBe("idle");
  expect(s.host.querySelector('[aria-label="Dictation"]')).toBeNull();
  expect(s.ui.stores.voice.getState().reviewText).toBe("");
});
