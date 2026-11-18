import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../../ui-react/src/root.js";
import { Composer } from "../../../ui-react/src/components/chat/composer.js";
import { acknowledge } from "../../../ui-react/src/voice/dictation-providers.js";
import { SILENCE_STOP_MS } from "../../../ui-react/src/voice/use-dictation.js";
import type { AsrClient, AsrClientOptions } from "../../../ui-sdk/src/client/asr.js";
import { DESTINATION, dictation, type DictationId } from "../../stories/voice/_voice.js";
import { composerWithMic } from "../../stories/chrome/_composer-mic.js";

/*
 * Dictation in the voice field (#3694), through the real Composer and
 * useDictation. The speech provider is a keyless local double: its start()
 * opens the (spied) microphone and waits for the test, its drain waits too,
 * so every state from D0 to D8 can be held and inspected. Each state is
 * compared with the signed-off kit story it draws (#3738), structurally:
 * the same kit elements, tones, shapes, meters, words and controls.
 */
type Provider = "gemini" | "deepgram" | "webspeech";

class FixtureClient implements AsrClient {
  stopped = 0;
  drained = 0;
  open!: () => void;
  finish!: () => void;
  constructor(readonly options: AsrClientOptions, private readonly microphone: () => Promise<unknown>) {}
  async start() {
    // The double opens the microphone as the shipped clients do, so the
    // order of disclosure, session and microphone is observable.
    await this.microphone();
    await new Promise<void>(resolve => { this.open = resolve; });
  }
  stop() { this.stopped++; }
  drainAndStop() { this.drained++; return new Promise<void>(resolve => { this.finish = resolve; }); }
  hear(text: string, final = true) {
    flushSync(() => this.options.onEvent(final ? { type: "final", text, endsTurn: false } : { type: "partial", text }));
  }
}

const capabilities = { streaming: true, interimResults: true, keyterms: false, endpointing: false, savedAudio: false };
function discovery(provider: Provider | null, o: { saved?: string | null; several?: boolean } = {}): VoiceProvidersResponse {
  const providers = (o.several ? ["gemini", "deepgram"] : provider ? [provider] : ["gemini"]).map(id => ({ id, label: id, capabilities }));
  if (provider === null) {
    const saved = o.saved ?? null;
    return { providers, dictation: { saved, savedUsable: false, host: null, effective: null, source: saved ? "unavailable" : "none", smart: false, revision: "0" } };
  }
  return { providers, dictation: { saved: null, savedUsable: false, host: provider, effective: provider, source: "host", smart: false, revision: "0" } };
}

/** A device whose storage refuses the acknowledgement write, and only that. */
function refusingStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => { items.delete(key); },
    setItem: (key: string, value: string) => {
      if (key.includes("dictation-acknowledged")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      items.set(key, value);
    },
  };
}

let renderer: Root | undefined;
let storyRenderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLElement | undefined;
let storyHost: HTMLElement | undefined;
let style: HTMLStyleElement | undefined;
let previousTheme: string | undefined;
let previousMotion: "reduce" | "no-preference";
let touchEnabled = false;
let frameBefore: { width: number; height: number } | undefined;
let outerBefore: { width: number; height: number } | undefined;
beforeEach(() => {
  frameBefore = { width: innerWidth, height: innerHeight };
  previousTheme = document.documentElement.dataset.theme;
  previousMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference";
});

async function cleanup() {
  try {
    if (renderer) flushSync(() => renderer!.unmount());
    if (storyRenderer) flushSync(() => storyRenderer!.unmount());
  } finally {
    try { ui?.dispose(); }
    finally {
      host?.remove(); storyHost?.remove(); style?.remove();
      renderer = undefined; storyRenderer = undefined; ui = undefined; host = undefined; storyHost = undefined; style = undefined;
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      if (previousTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previousTheme;
      try { if (touchEnabled) await commands.dictationPointer(false); }
      finally {
        touchEnabled = false;
        try { await commands.dictationMotion(previousMotion); }
        finally {
          try { if (frameBefore) await page.viewport(frameBefore.width, frameBefore.height); }
          finally {
            try { if (outerBefore) await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120); }
            finally { frameBefore = undefined; outerBefore = undefined; }
          }
        }
      }
    }
  }
}
afterEach(cleanup);

interface MountOptions {
  width?: number; height?: number; theme?: string; cssEntry?: "precompiled" | "theme";
  provider?: Provider; snapshot?: VoiceProvidersResponse; acknowledged?: boolean;
  storage?: Storage | null; prompt?: PermissionState | null; draft?: string;
}

async function mount(o: MountOptions = {}) {
  const { width = 1280, height = 800, theme = "dark", provider = "gemini" } = o;
  outerBefore = await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  style = document.createElement("style");
  style.textContent = o.cssEntry === "theme" ? await commands.dictationThemeStyles() : await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);

  // Every outward step a take can make, in the order it makes them.
  const log: string[] = [];
  const send = vi.fn();
  const sessions: string[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/voice/session")) {
      const providerId = JSON.parse(String(init?.body ?? "{}")).providerId ?? provider;
      sessions.push(providerId); log.push("session");
      return Response.json({ providerId, url: "", expiresAt: Date.now() + 60_000, capabilities });
    }
    return Response.json({ overrides: [], providers: [], backends: {}, entries: [], slugs: {}, models: [], sessions: [] });
  });
  vi.stubGlobal("fetch", request);
  const microphone = vi.fn(async () => { log.push(`microphone:${fieldForm() ?? noticeForm() ?? "none"}`); });
  // Whether the browser will ask (D2). Default: access already granted.
  const permission = o.prompt === null ? undefined : o.prompt ?? "granted";
  if (navigator.permissions) vi.spyOn(navigator.permissions, "query").mockImplementation(async () => {
    log.push("permission");
    if (permission === undefined) throw new TypeError("microphone is not a known permission");
    return { state: permission } as PermissionStatus;
  });

  ui = createBrainUiRoot({ storage: o.storage ?? null, request });
  ui.stores.connection.getState().setWsStatus("connected");
  const snapshot = o.snapshot ?? discovery(provider);
  ui.stores.voice.setState({ discovery: { snapshot, at: Date.now() + 24 * 60 * 60_000 } });
  const effective = snapshot.providers.find(p => p.id === snapshot.dictation.effective);
  if (effective && o.acknowledged !== false) acknowledge(ui, effective);
  // The local speech double stands in for every provider's client.
  const clients: FixtureClient[] = [];
  ui.asr.create = (options) => { const client = new FixtureClient(options, microphone); clients.push(client); return client; };
  if (o.draft) { const drafts = ui.stores.drafts.getState(); drafts.edit(drafts.idFor(null), null, { text: o.draft }); }

  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}>
    <p data-conversation="" tabIndex={0} style={{ flex: 1 }}>Odysseus remembers the harbour crossing.</p>
    <Composer send={send} />
  </BrainUiProvider>));
  const frame = host.querySelector<HTMLElement>("[data-composer]")!;
  const mic = () => frame.querySelector<HTMLElement>('[aria-label^="Dictate"]');
  const field = () => frame.querySelector<HTMLTextAreaElement>("textarea");
  return {
    frame, mic, field, send, request, sessions, microphone, log, clients,
    client: () => clients.at(-1)!,
    /** Tap the composer's mic, as #3693 wires it. */
    async tap() { await userEvent.click(mic()!); },
    /** Tap, and wait until the microphone is open and the field listens (D3). */
    async listen() {
      await userEvent.click(mic()!);
      await expect.poll(() => clients.length, { message: "the take reached its client" }).toBe(1);
      await expect.poll(() => microphone.mock.calls.length).toBe(1);
      clients[0]!.open();
      await expect.poll(() => fieldForm()).toBe("D3");
      return clients[0]!;
    },
  };
}

const fieldForm = () => host?.querySelector<HTMLElement>("[data-dictation-field]")?.dataset.dictationField ?? null;
const noticeForm = () => host?.querySelector<HTMLElement>("[data-dictation-notice]")?.dataset.dictationNotice ?? null;
const voiceField = () => host!.querySelector<HTMLElement>("[data-dictation-field] .bk-voice-field, [data-dictation-notice] .bk-voice-field")!;
const button = (name: string) => [...host!.querySelectorAll<HTMLElement>('button, [role="button"]')].find(el => (el.getAttribute("aria-label") ?? el.textContent?.trim()) === name) ?? null;
const meta = () => host!.querySelector(".bk-voice-label-meta")?.textContent ?? null;
const word = () => host!.querySelector("[data-voice-word]")?.textContent ?? null;

/**
 * The kit's structure of a voice surface, without its live values: element,
 * classes, kit data attributes, roles and names, and the words a state is
 * named by (the label word, a notice's title and actions, a placeholder).
 * Spoken text, meta text, levels and inline sizes are compared separately.
 */
function signature(el: Element): string {
  // A notice's live role is the app's announcement choice (#3701), not its drawing.
  const attrs = [...el.attributes].filter(a => a.name === "class" || (a.name === "role" && !el.matches(".bk-voice-notice-head")) || a.name === "disabled"
    || a.name === "aria-busy" || a.name === "aria-pressed" || a.name === "aria-hidden"
    || (a.name.startsWith("data-") && a.name !== "data-motion"))
    .map(a => `${a.name}=${a.value}`).sort().join(" ");
  const named = el.matches("[data-voice-word], .bk-voice-notice-title, .bk-voice-action, .bk-voice-text-placeholder");
  const label = el.matches("button.bk-voice-ctl") ? ` "${el.getAttribute("aria-label")}"` : "";
  const text = named ? ` "${el.textContent}"` : "";
  const skip = el.matches(".bk-voice-text, .bk-voice-label-meta, .bk-voice-notice-body");
  const children = skip ? (el.matches(".bk-voice-text") ? `[${[...el.querySelectorAll(".bk-voice-text-placeholder")].map(signature).join(",")}]` : "")
    // The draft's save state beside Attach (#3776) is not part of any dictation story.
    : [...el.children].filter(child => !child.matches("[data-composer-status]")).map(signature).join(",");
  return `<${el.tagName.toLowerCase()} ${attrs}${label}${text}>${children}`;
}

/**
 * The signed-off story for a state, drawn off-screen beside the app, as its
 * signature. It is removed again at once, and focus (which D0's story moves
 * onto its own Start dictation) goes back where the app had it.
 */
function story(id: DictationId | ReactNode): string {
  const before = document.activeElement as HTMLElement | null;
  storyHost = document.createElement("div");
  storyHost.style.cssText = "position:fixed;left:-10000px;top:0;width:420px";
  document.body.append(storyHost);
  storyRenderer = createRoot(storyHost);
  const node = typeof id === "string" ? dictation(id as DictationId) : id;
  try {
    flushSync(() => storyRenderer!.render(<>{node}</>));
    return signature(storyHost.querySelector(".bk-voice-field, .bk-field") ?? storyHost.firstElementChild!);
  } finally {
    flushSync(() => storyRenderer!.unmount());
    storyHost.remove();
    storyRenderer = undefined; storyHost = undefined;
    before?.focus({ preventScroll: true });
  }
}

const focused = () => document.activeElement as HTMLElement | null;

/* ── D0: the first take, before any session or microphone ─────────────── */

for (const theme of ["dark", "light"]) for (const width of [320, 1280]) {
  test(`D0 ${width} ${theme}: names the destination before anything is requested, focuses Start dictation, matches its story`, async () => {
    const s = await mount({ width, theme, acknowledged: false });
    await s.tap();
    await expect.poll(() => noticeForm()).toBe("D0");
    expect(signature(voiceField()), "D0 draws the signed-off story").toBe(story("D0"));
    expect(host!.querySelector(".bk-voice-notice-body")!.textContent).toBe("Your words are sent to Google Gemini to be written down. The audio isn’t kept.");
    expect(focused()?.textContent, "K1: initial focus on Start dictation").toBe("Start dictation");
    expect(host!.querySelector('[data-dictation-notice] [role="status"]'), "the body is announced politely").not.toBeNull();
    expect(s.sessions, "no session before Start dictation").toEqual([]);
    expect(s.microphone, "no microphone before Start dictation").not.toHaveBeenCalled();
    expect(s.mic(), "the composer and its mic stay drawn").not.toBeNull();
    expect(host!.scrollWidth, "no overflow").toBeLessThanOrEqual(width);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => s.clients.length).toBe(1);
    expect(s.log.filter(step => step !== "permission")[0], "the session follows the acknowledgement").toBe("session");
    expect(s.log.find(step => step.startsWith("microphone")), "the microphone opens with the destination named").toBe("microphone:Dc");
    s.client().open();
    await expect.poll(() => fieldForm()).toBe("D3");
    expect(meta(), "the destination stays named while listening").toBe(DESTINATION.gemini);
  });
}

// Maintainer decision on #3694 (2026-11-09): only Gemini's audio is claimed
// as not kept; any other service is said to follow its own policy.
for (const [provider, body] of [
  ["gemini", "Your words are sent to Google Gemini to be written down. The audio isn\u2019t kept."],
  ["deepgram", "Your words are sent to Deepgram to be written down. Deepgram\u2019s retention policy applies."],
  ["webspeech", "Your words are sent to your browser\u2019s speech service to be written down. Your browser\u2019s speech service policy applies."],
] as const) {
  test(`D0 ${provider}: says what happens to the audio without claiming retention it can't verify, in the story's form`, async () => {
    const s = await mount({ provider, acknowledged: false });
    await s.tap();
    await expect.poll(() => noticeForm()).toBe("D0");
    expect(host!.querySelector(".bk-voice-notice-body")!.textContent).toBe(body);
    expect(signature(voiceField()), "the same VoiceNotice, only its body text differs").toBe(story("D0"));
    if (provider !== "gemini") expect(host!.textContent).not.toContain("isn\u2019t kept");
    expect(s.sessions).toEqual([]);
  });
}

for (const exit of ["Cancel", "Escape"] as const) {
  test(`D0 ${exit}: no take, nothing requested, focus back on the mic`, async () => {
    const s = await mount({ acknowledged: false });
    await s.tap();
    await expect.poll(() => noticeForm()).toBe("D0");
    if (exit === "Cancel") await userEvent.click(button("Cancel")!);
    else await userEvent.keyboard("{Escape}");
    await expect.poll(() => noticeForm()).toBe(null);
    await expect.poll(() => focused()).toBe(s.mic());
    expect(ui!.stores.voice.getState().mode).toBe("idle");
    expect(s.sessions).toEqual([]);
    expect(s.microphone).not.toHaveBeenCalled();
    // Not acknowledged: the next take asks again.
    await s.tap();
    await expect.poll(() => noticeForm()).toBe("D0");
  });
}

test("D0 acknowledged once is not shown again; a storage write that fails shows it again next take", async () => {
  for (const storage of [null, refusingStorage()]) {
    const s = await mount({ acknowledged: false, storage });
    await s.tap();
    await expect.poll(() => noticeForm()).toBe("D0");
    await userEvent.click(button("Start dictation")!);
    await expect.poll(() => s.clients.length).toBe(1);
    s.client().open();
    await expect.poll(() => fieldForm()).toBe("D3");
    await userEvent.click(button("Finish dictation")!);
    s.client().finish();
    await expect.poll(() => ui!.stores.voice.getState().mode).toBe("idle");
    await s.tap();
    if (storage === null) {
      await expect.poll(() => s.clients.length, { message: "a stored acknowledgement goes straight to the session" }).toBe(2);
      expect(noticeForm()).toBe(null);
    } else {
      await expect.poll(() => noticeForm(), { message: "an unstored acknowledgement is never treated as consent" }).toBe("D0");
      expect(s.sessions).toHaveLength(1);
    }
    await cleanup();
    frameBefore = { width: innerWidth, height: innerHeight };
  }
});

/* ── Dx: nowhere to send the words ────────────────────────────────────── */

for (const [id, snapshot, body] of [
  ["Dx1", discovery(null, { several: true }), "Dictation needs a service. Pick one in Settings."],
  ["Dx2", discovery(null, { saved: "deepgram" }), "Deepgram isn’t offered here any more. Choose another in Settings."],
] as const) {
  test(`${id}: no microphone and no session, Open Settings, matches its story`, async () => {
    const s = await mount({ snapshot });
    await s.tap();
    await expect.poll(() => noticeForm()).toBe(id);
    expect(signature(voiceField())).toBe(story(id));
    expect(host!.querySelector(".bk-voice-notice-body")!.textContent).toBe(body);
    expect(focused()?.textContent).toBe("Open Settings");
    expect(s.mic(), "the composer mic stays drawn").not.toBeNull();
    expect(host!.querySelector(".bk-voice-meter"), "no meter").toBeNull();
    expect(s.sessions).toEqual([]); expect(s.microphone).not.toHaveBeenCalled();
    await userEvent.click(button("Open Settings")!);
    expect(ui!.stores.ui.getState().settingsPanelOpen).toBe(true);
    expect(ui!.stores.voice.getState().mode).toBe("idle");
  });
}

/* ── Dc, D2: before the microphone is open ────────────────────────────── */

for (const theme of ["dark", "light"]) for (const width of [320, 1280]) {
  test(`Dc ${width} ${theme}: grey, "Not listening yet", destination named, Cancel dictation, matches its story`, async () => {
    const s = await mount({ width, theme });
    await s.tap();
    await expect.poll(() => fieldForm()).toBe("Dc");
    expect(signature(voiceField())).toBe(story("Dc"));
    expect(voiceField().dataset.tone, "grey: nothing is heard").toBe("idle");
    expect(meta()).toBe(DESTINATION.gemini);
    expect(host!.textContent, "never says Listening before the microphone is open").not.toContain("Listening");
    expect(host!.querySelector(".bk-voice-text-placeholder")!.textContent).toBe("Not listening yet");
    expect(voiceField().getBoundingClientRect().height).toBe(84);
    expect(host!.scrollWidth).toBeLessThanOrEqual(width);
    expect(focused(), "focus moves onto the field's control").toBe(button("Cancel dictation"));
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => ui!.stores.voice.getState().mode).toBe("idle");
    await expect.poll(() => focused()).toBe(s.mic());
  });
}

test("Dc: Escape cancels a take whose microphone is not open; nothing reaches the client", async () => {
  const s = await mount();
  await s.tap();
  await expect.poll(() => s.clients.length).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => ui!.stores.voice.getState().mode).toBe("idle");
  expect(s.client().stopped).toBeGreaterThanOrEqual(1);
  expect(s.client().drained).toBe(0);
});

for (const width of [320, 1280]) {
  test(`D2 ${width}: the browser is asking, after the destination is named; granted leads to D3; matches its story`, async () => {
    const s = await mount({ width, prompt: "prompt" });
    await s.tap();
    await expect.poll(() => fieldForm()).toBe("D2");
    expect(signature(voiceField())).toBe(story("D2"));
    expect(s.log.indexOf("session"), "the session was requested with the destination named").toBeGreaterThanOrEqual(0);
    expect(focused()?.textContent).toBe("Cancel");
    s.client().open();
    await expect.poll(() => fieldForm()).toBe("D3");
    expect(meta()).toBe(DESTINATION.gemini);
  });
}

test("D2 Cancel ends the take; a browser that cannot say whether it will ask stays on Dc", async () => {
  const s = await mount({ prompt: "prompt" });
  await s.tap();
  await expect.poll(() => fieldForm()).toBe("D2");
  await userEvent.click(button("Cancel")!);
  await expect.poll(() => ui!.stores.voice.getState().mode).toBe("idle");
  await cleanup();
  frameBefore = { width: innerWidth, height: innerHeight };
  const t = await mount({ prompt: null });
  await t.tap();
  await expect.poll(() => t.microphone.mock.calls.length).toBe(1);
  expect(fieldForm()).toBe("Dc");
});

/* ── D3–D5: listening, quiet, finishing ───────────────────────────────── */

for (const theme of ["dark", "light"]) for (const width of [320, 1280]) {
  test(`D3–D5 ${width} ${theme}: one fixed 84px field, the destination named throughout, matching the stories`, async () => {
    const s = await mount({ width, theme, draft: "Before the take:" });
    const client = await s.listen();
    client.hear("Ask Calypso about the axe"); client.hear("and the sail", false);
    flushSync(() => ui!.stores.voice.getState().setAudioLevel(0.8));
    expect(signature(voiceField())).toBe(story("D3"));
    expect(word()).toBe("Listening");
    expect(meta()).toBe(DESTINATION.gemini);
    expect(host!.querySelector(".bk-voice-text")!.textContent).toBe("Ask Calypso about the axe and the sail");
    expect(host!.querySelector("textarea"), "the voice field stands in for the composer").toBeNull();
    const rect = voiceField().getBoundingClientRect();
    expect(rect.height).toBe(84);
    expect(host!.scrollWidth).toBeLessThanOrEqual(width);
    expect(focused()).toBe(button("Finish dictation"));
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => fieldForm()).toBe("D5");
    expect(signature(voiceField())).toBe(story("D5"));
    expect(word()).toBe("Finishing");
    expect(meta(), "D5 keeps the destination").toBe(DESTINATION.gemini);
    expect(voiceField().getBoundingClientRect(), "D3 to D5 never moves the page").toEqual(rect);
    expect(client.drained).toBe(1);
    await userEvent.click(button("Finishing dictation")!);
    expect(client.drained, "a second Finish does not bypass the drain").toBe(1);
  });
}

test("D4: no speech for a moment is quiet; speech returns to D3; matches its story", async () => {
  const s = await mount({ provider: "deepgram" });
  const client = await s.listen();
  await expect.poll(() => fieldForm(), { timeout: 4_000 }).toBe("D4");
  expect(signature(voiceField())).toBe(story("D4"));
  expect(meta()).toBe(DESTINATION.deepgram);
  expect(host!.querySelector(".bk-voice-text-placeholder")!.textContent).toBe("Say something…");
  flushSync(() => ui!.stores.voice.getState().setAudioLevel(0.6));
  expect(fieldForm(), "speech returns to listening").toBe("D3");
  client.hear("Ask Calypso");
  expect(fieldForm()).toBe("D3");
});

test("browser speech names its destination without claiming Google outside Chrome (K2)", async () => {
  const s = await mount({ provider: "webspeech" });
  await s.tap();
  await expect.poll(() => fieldForm()).toBe("Dc");
  expect(meta()).toBe(DESTINATION.browser);
  s.client().open();
  await expect.poll(() => fieldForm()).toBe("D3");
  expect(meta()).toBe(DESTINATION.browser);
  s.client().hear("Ask Calypso about the axe"); s.client().hear("and the sail", false);
  expect(signature(voiceField())).toBe(story("D3b"));
});

/* ── V3: 30 s of silence ends the take ────────────────────────────────── */

for (const heard of [true, false]) {
  test(`V3 ${heard ? "words" : "empty"}: 30 s of silence stops the take, to D6 with the words or to D1`, async () => {
    const s = await mount();
    const client = await s.listen();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Speech (words, or only an input level) arms the silence clock on the fake timers.
    if (heard) client.hear("Ask Calypso about the axe");
    else flushSync(() => ui!.stores.voice.getState().setAudioLevel(0.5));
    vi.advanceTimersByTime(SILENCE_STOP_MS - 1);
    expect(client.drained, "29.999 s of silence keeps listening").toBe(0);
    await expect.poll(() => fieldForm(), { message: "quiet in the meantime" }).toBe("D4");
    // Speech re-arms the clock.
    flushSync(() => ui!.stores.voice.getState().setAudioLevel(0.7));
    vi.advanceTimersByTime(SILENCE_STOP_MS - 1);
    expect(client.drained, "the clock restarts on speech").toBe(0);
    vi.advanceTimersByTime(1);
    expect(client.drained, "30 s after the last speech the take stops as Finish would").toBe(1);
    vi.useRealTimers();
    client.finish();
    await expect.poll(() => ui!.stores.voice.getState().mode).toBe("idle");
    await expect.poll(() => s.field()?.value).toBe(heard ? "Ask Calypso about the axe" : "");
    expect(s.send, "nothing is sent").not.toHaveBeenCalled();
    expect(s.mic()?.getAttribute("aria-label")).toBe(heard ? "Dictate more \u00b7 Gemini" : "Dictate \u00b7 Gemini");
  });
}

/* ── D6: the words are the draft ──────────────────────────────────────── */

for (const theme of ["dark", "light"]) for (const width of [320, 1280]) {
  test(`D6 ${width} ${theme}: plain editable text after the draft, caret at the end, Dictate more and Send, nothing sent`, async () => {
    const s = await mount({ width, theme, draft: "Before the take:" });
    const client = await s.listen();
    client.hear("Ask Calypso about the axe and the sail cloth.");
    await userEvent.click(button("Finish dictation")!);
    client.finish();
    await expect.poll(() => s.field()?.value).toBe("Before the take: Ask Calypso about the axe and the sail cloth.");
    const field = s.field()!;
    await expect.poll(() => focused()).toBe(field);
    expect([field.selectionStart, field.selectionEnd], "caret at the end").toEqual([field.value.length, field.value.length]);
    expect(field.readOnly, "editable").toBe(false);
    expect(host!.querySelector(".bk-voice-uncertain, [data-uncertain]"), "no uncertain-word mark is invented").toBeNull();
    expect(s.mic()!.getAttribute("aria-label"), "D6 names the next take's service too").toBe("Dictate more \u00b7 Gemini");
    expect(s.send).not.toHaveBeenCalled();
    expect(signature(s.frame.querySelector(".bk-field")!), "the composer draws the D6 story")
      .toBe(story(composerWithMic("D6", field.value)));
    await userEvent.keyboard(" Today.");
    expect(field.value).toBe("Before the take: Ask Calypso about the axe and the sail cloth. Today.");
    await userEvent.click(button("Send")!);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]![0]).toMatchObject({ type: "chat_message", text: "Before the take: Ask Calypso about the axe and the sail cloth. Today.", source: "voice-dictate" });
  });
}

test("D6 Dictate more: the next take's words follow the first", async () => {
  const s = await mount();
  const first = await s.listen();
  first.hear("Ask Calypso");
  await userEvent.click(button("Finish dictation")!); first.finish();
  await expect.poll(() => s.mic()?.getAttribute("aria-label")).toBe("Dictate more \u00b7 Gemini");
  await userEvent.click(s.mic()!);
  await expect.poll(() => s.clients.length).toBe(2);
  s.client().open();
  await expect.poll(() => fieldForm()).toBe("D3");
  s.client().hear("about the axe");
  await userEvent.click(button("Finish dictation")!); s.client().finish();
  await expect.poll(() => s.field()?.value).toBe("Ask Calypso about the axe");
});

test("D1: an empty Finish returns to rest with focus on the mic", async () => {
  const s = await mount();
  const client = await s.listen();
  await userEvent.click(button("Finish dictation")!); client.finish();
  await expect.poll(() => ui!.stores.voice.getState().mode).toBe("idle");
  await expect.poll(() => focused()).toBe(s.mic());
  expect(s.field()!.value).toBe("");
  expect(s.mic()!.getAttribute("aria-label"), "the resting mic, naming the service").toBe("Dictate \u00b7 Gemini");
});

/* ── D7, D8: failures keep what was heard ─────────────────────────────── */

test("D7: a refused microphone is the blocked notice, the draft is intact, matches its story", async () => {
  const s = await mount({ draft: "Ask Penelope about the loom" });
  s.microphone.mockImplementationOnce(async () => { throw new DOMException("denied", "NotAllowedError"); });
  await s.tap();
  await expect.poll(() => noticeForm()).toBe("D7");
  expect(signature(voiceField())).toBe(story("D7"));
  expect(s.field()!.value).toBe("Ask Penelope about the loom");
  await userEvent.click(button("OK")!);
  await expect.poll(() => noticeForm()).toBe(null);
  await expect.poll(() => focused()).toBe(s.mic());
});

for (const when of ["listening", "finishing"] as const) {
  test(`D8 while ${when}: the words heard so far are in the draft and quoted, Try again adds to them, matches its story`, async () => {
    const s = await mount();
    const client = await s.listen();
    client.hear("Ask Calypso about the axe and the sail cloth");
    if (when === "finishing") {
      await userEvent.click(button("Finish dictation")!);
      flushSync(() => client.options.onError(Object.assign(new Error("closed"), { code: "network" })));
      client.finish();
    } else {
      flushSync(() => client.options.onError(Object.assign(new Error("closed"), { code: "network" })));
      // The provider closes on its own: the take ends with its failure.
      const { providerEnded } = await import("../../../ui-react/src/voice/dictation-capture.js");
      flushSync(() => providerEnded(ui!.stores, client));
    }
    await expect.poll(() => noticeForm()).toBe("D8");
    expect(signature(voiceField())).toBe(story("D8"));
    expect(host!.querySelector(".bk-voice-notice-body")!.textContent).toBe("Kept so far: “Ask Calypso about the axe and…”");
    expect(s.field()!.value, "the text heard is never lost").toBe("Ask Calypso about the axe and the sail cloth");
    expect(s.send).not.toHaveBeenCalled();
    await userEvent.click(button("Try again")!);
    await expect.poll(() => s.clients.length).toBe(2);
    expect(noticeForm()).toBe(null);
    s.client().open();
    await expect.poll(() => fieldForm()).toBe("D3");
    s.client().hear("before the tide");
    await userEvent.click(button("Finish dictation")!); s.client().finish();
    await expect.poll(() => s.field()?.value).toBe("Ask Calypso about the axe and the sail cloth before the tide");
  });
}

test("D8 Dismiss keeps the words in the draft", async () => {
  const s = await mount();
  const client = await s.listen();
  client.hear("Ask Calypso");
  flushSync(() => client.options.onError(Object.assign(new Error("closed"), { code: "network" })));
  const { providerEnded } = await import("../../../ui-react/src/voice/dictation-capture.js");
  flushSync(() => providerEnded(ui!.stores, client));
  await expect.poll(() => noticeForm()).toBe("D8");
  await userEvent.click(button("Dismiss")!);
  await expect.poll(() => noticeForm()).toBe(null);
  expect(s.field()!.value).toBe("Ask Calypso");
  await expect.poll(() => focused()).toBe(s.mic());
});

/* ── Lifetime ─────────────────────────────────────────────────────────── */

test("unmount while listening releases the client", async () => {
  const s = await mount();
  const client = await s.listen();
  flushSync(() => renderer!.unmount()); renderer = undefined;
  expect(client.stopped).toBe(1);
  expect(s.clients).toHaveLength(1);
});

for (const cssEntry of ["precompiled", "theme"] as const) for (const preference of ["no-preference", "reduce"] as const) {
  test(`${cssEntry} ${preference}: the field keeps its 84px through Dc and D3, and its notices fit 320px`, async () => {
    await commands.dictationMotion(preference);
    const s = await mount({ width: 320, cssEntry, acknowledged: false });
    await s.tap();
    await expect.poll(() => noticeForm()).toBe("D0");
    expect(voiceField().getBoundingClientRect().right).toBeLessThanOrEqual(320);
    await userEvent.click(button("Start dictation")!);
    await expect.poll(() => fieldForm()).toBe("Dc");
    expect(voiceField().getBoundingClientRect().height).toBe(84);
    s.client().open();
    await expect.poll(() => fieldForm()).toBe("D3");
    expect(voiceField().getBoundingClientRect().height).toBe(84);
    await page.screenshot({ element: host!, path: `../../.vitest-attachments/dictation/${cssEntry}-${preference}-listening.png` });
  });
}

// Chromium may leave pointer:none after touch is disabled. These cases stay
// last in the file, which the dictation-only project owns.
for (const control of ["Cancel dictation", "Finish dictation"] as const) {
  test(`touch: ${control} has a real 44px target`, async () => {
    touchEnabled = true;
    await commands.dictationPointer(true);
    const s = await mount({ width: 320 });
    if (control === "Finish dictation") await s.listen();
    else { await s.tap(); await expect.poll(() => fieldForm()).toBe("Dc"); }
    const rect = button(control)!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
  });
}
