import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../../ui-react/src/root.js";
import { Composer } from "../../../ui-react/src/components/chat/composer.js";
import type { AsrClient, AsrClientOptions } from "../../../ui-sdk/src/client/asr.js";

// Real composer + useDictation. The provider is a keyless scripted ASR client;
// its pending start/drain let the tests observe connecting and repeated stops.
class FixtureClient implements AsrClient {
  stopped = 0;
  drained = 0;
  open!: () => void;
  finish!: () => void;
  constructor(readonly options: AsrClientOptions) {}
  start() { return new Promise<void>(resolve => { this.open = resolve; }); }
  stop() { this.stopped++; }
  drainAndStop() { this.drained++; return new Promise<void>(resolve => { this.finish = resolve; }); }
}

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLElement | undefined;
let style: HTMLStyleElement | undefined;
let previousOverflow: string | undefined;
let previousTheme: string | undefined;
let touchEnabled = false;
let frameBefore: { width: number; height: number };
let outerBefore: { width: number; height: number };
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  renderer = undefined; ui = undefined; host = undefined; style = undefined;
  vi.unstubAllGlobals();
  if (previousOverflow !== undefined) document.body.style.overflow = previousOverflow;
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
  if (touchEnabled) await commands.dictationPointer(false);
  touchEnabled = false;
  await commands.dictationMotion("no-preference");
  if (frameBefore) await page.viewport(frameBefore.width, frameBefore.height);
  if (outerBefore) await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
});

async function mount(width = 1280, height = 800, theme = "dark", cssEntry: "precompiled" | "theme" = "precompiled") {
  frameBefore = { width: innerWidth, height: innerHeight };
  outerBefore = await commands.formViewport(width, height);
  await page.viewport(width, height);
  previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = theme;
  previousOverflow = document.body.style.overflow;
  style = document.createElement("style");
  style.textContent = cssEntry === "theme" ? await commands.dictationThemeStyles() : await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px;display:flex;flex-direction:column;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  const send = vi.fn();
  const clients: FixtureClient[] = [];
  const request = vi.fn(async (url: string) => Response.json(url.endsWith("/voice/session") ? {
    providerId: "fixture", url: "", expiresAt: Date.now() + 60_000,
    capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
  } : { overrides: [], providers: [], backends: {}, entries: [], slugs: {}, models: [], sessions: [] }));
  vi.stubGlobal("fetch", request);
  ui = createBrainUiRoot({ storage: null, request });
  ui.stores.connection.getState().setWsStatus("connected");
  ui.asr.register("fixture", options => { const client = new FixtureClient(options); clients.push(client); return client; });
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui}>
    <p data-conversation="" tabIndex={0} style={{ flex: 1 }}>Odysseus remembers the harbour crossing.</p>
    <Composer send={send} />
  </BrainUiProvider>));
  const frame = host.querySelector<HTMLElement>("[data-composer]")!;
  await userEvent.click(frame.querySelector("textarea")!);
  await userEvent.keyboard("Keep the existing draft");
  const mic = () => frame.querySelector<HTMLElement>('[aria-label="Dictate"], [aria-label="Stop dictation"]')!;
  await userEvent.click(mic());
  await expect.poll(() => clients.length).toBe(1);
  expect(ui.stores.voice.getState().connecting).toBe(true);
  const client = clients[0];
  return { frame, mic, client, send, request,
    async listen(text = "Remember the harbour") {
      client.open();
      await expect.poll(() => ui!.stores.voice.getState().connecting).toBe(false);
      flushSync(() => client.options.onEvent({ type: "final", text, endsTurn: false }));
    },
  };
}

const done = () => [...host!.querySelectorAll<HTMLButtonElement>("button")].find(el => /^(Done|Finalizing…)$/u.test(el.textContent?.trim() ?? ""))!;
const panel = () => done().parentElement!.parentElement!;

/** Entrance translation can round rect edges independently; measure the exact cap at rest. */
async function expectSettledHeightCap(maximum: number) {
  const sheet = panel();
  await expect.poll(() => sheet.getAnimations().every(animation => animation.playState === "finished")).toBe(true);
  expect(new DOMMatrix(getComputedStyle(sheet).transform).isIdentity, "height cap is measured without entrance translation").toBe(true);
  expect(sheet.getBoundingClientRect().height, "settled dictation sheet respects height cap").toBeLessThanOrEqual(maximum);
}

for (const theme of ["dark", "light"]) for (const [width, height] of [[1280, 800], [1920, 1080]]) {
  test(`dictation desktop ${width} ${theme}: bounded above composer with an 8px gap`, async () => {
    const { frame, listen } = await mount(width, height, theme);
    await listen();
    const rect = panel().getBoundingClientRect();
    const anchor = frame.getBoundingClientRect();
    expect(rect.width, "panel matches composer width").toBeCloseTo(anchor.width, 1);
    expect(rect.width).toBeLessThanOrEqual(768);
    expect(rect.bottom, "panel sits 8px above the composer").toBeCloseTo(anchor.top - 8, 1);
    expect(rect.height, "no viewport-fraction floor").toBeLessThan(height * 0.4);
    await expectSettledHeightCap(Math.min(height * 0.6, 512));
    const transcript = panel().querySelector<HTMLElement>("[data-dictation-transcript]")!;
    const css = getComputedStyle(transcript);
    const paragraph = transcript.querySelector("p")!;
    expect(transcript.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), "three transcript lines are reserved")
      .toBeGreaterThanOrEqual(3 * parseFloat(getComputedStyle(paragraph).lineHeight));
  });
}

test("dictation desktop: opening focuses Done; conversation selection and Enter elsewhere keep capture live", async () => {
  const { client, listen } = await mount();
  await listen();
  expect(document.activeElement, "Done receives opening focus").toBe(done());
  const conversation = host!.querySelector<HTMLElement>("[data-conversation]")!;
  await userEvent.click(conversation);
  const range = document.createRange(); range.selectNodeContents(conversation);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  expect(getSelection()!.toString()).toBe("Odysseus remembers the harbour crossing.");
  await userEvent.keyboard("{Enter}");
  expect(client.drained).toBe(0); expect(client.stopped).toBe(0);
  expect(ui!.stores.voice.getState().mode).toBe("dictate");
});

test("dictation desktop: the composer cannot type or Send past review", async () => {
  const { frame, send, listen } = await mount();
  await listen();
  const field = frame.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(field.readOnly, "typing is blocked during capture").toBe(true);
  await userEvent.click(field); await userEvent.keyboard("typed{Enter}");
  expect(field.value).toBe("Keep the existing draft"); expect(send).not.toHaveBeenCalled();
  const sendButton = frame.querySelector<HTMLElement>('[aria-label="Send — unavailable"]')!;
  expect(sendButton).not.toBeNull(); expect(sendButton.getAttribute("aria-disabled")).toBe("true");
});

for (const stop of ["Done", "mic", "Enter", "Space", "mic Enter", "mic Space"] as const) {
  test(`dictation desktop: ${stop} stops once, drains into review and restores mic focus`, async () => {
    const { mic, client, listen } = await mount();
    await listen("Keep the nonempty voyage transcript");
    if (stop === "mic") await userEvent.click(mic());
    else if (stop === "Done") await userEvent.click(done());
    else { (stop.startsWith("mic") ? mic() : done()).focus(); await userEvent.keyboard(stop.endsWith("Enter") ? "{Enter}" : " "); }
    expect(client.drained).toBe(1); expect(ui!.stores.voice.getState().draining).toBe(true);
    await userEvent.click(mic());
    expect(client.drained).toBe(1);
    expect(ui!.stores.voice.getState().mode, "duplicate stop does not bypass drain").toBe("dictate");
    client.finish();
    await expect.poll(() => ui!.stores.voice.getState().reviewText).toBe("Keep the nonempty voyage transcript");
    await expect.poll(() => document.activeElement).toBe(mic());
    expect(ui!.stores.voice.getState().mode).toBe("idle");
    expect(document.body.style.overflow).toBe(previousOverflow);
  });
}

test("dictation desktop: Enter on Cancel cancels rather than committing", async () => {
  const { client, listen } = await mount(); await listen();
  const cancel = host!.querySelector<HTMLButtonElement>('button[title="Cancel"]')!;
  cancel.focus(); await userEvent.keyboard("{Enter}");
  expect(client.stopped).toBe(1); expect(client.drained).toBe(0);
  expect(ui!.stores.voice.getState().reviewText).toBe("");
  expect(ui!.stores.voice.getState().mode).toBe("idle");
});

const transcript = () => panel().querySelector<HTMLElement>("[data-dictation-transcript], .flex-1.overflow-y-auto")!;
const backdrop = () => host!.querySelector<HTMLElement>(".backdrop-blur-sm")!;

for (const theme of ["dark", "light"]) {
  test(`dictation phone ${theme}: baseline sheet geometry, animation and backdrop-to-stop`, async () => {
    const { client, listen } = await mount(320, 800, theme);
    await listen("Keep the phone transcript");
    await expect.poll(() => panel().getBoundingClientRect().bottom).toBeCloseTo(800, 1);
    const rect = panel().getBoundingClientRect();
    expect(rect.width).toBe(320);
    expect(rect.height).toBeGreaterThanOrEqual(320);
    await expectSettledHeightCap(480);
    const css = getComputedStyle(panel());
    expect(css.position).toBe("fixed");
    expect(css.animationName, "phone entrance is supplied by shipped CSS").not.toBe("none");
    expect(css.animationDuration).toBe("0.2s");
    expect(backdrop().getBoundingClientRect().width).toBe(320);
    await userEvent.click(backdrop(), { position: { x: 12, y: 12 } });
    expect(client.drained).toBe(1);
    await userEvent.click(backdrop(), { position: { x: 12, y: 12 } });
    expect(client.drained).toBe(1);
    expect(ui!.stores.voice.getState().mode).toBe("dictate");
    client.finish();
    await expect.poll(() => ui!.stores.voice.getState().reviewText).toBe("Keep the phone transcript");
    expect(document.body.style.overflow).toBe(previousOverflow);
  });
}


// Exercise both supported CSS entry points on the real composer/ASR/review flow.
for (const cssEntry of ["precompiled", "theme"] as const) for (const theme of ["dark", "light"]) {
  for (const preference of ["no-preference", "reduce"] as const) for (const action of ["Done", "Cancel"] as const) {
    test(`dictation motion ${cssEntry} ${theme} ${preference} ${action}: phone entrance and controls`, async () => {
      await commands.dictationMotion(preference);
      const { client, listen } = await mount(320, 800, theme, cssEntry);
      const sheet = panel();
      const css = getComputedStyle(sheet);
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(preference === "reduce");
      if (preference === "no-preference") {
        expect(css.animationName, "real phone entrance animation").not.toBe("none");
        expect(css.animationDuration, "existing 200ms entrance").toBe("0.2s");
        const entrance = sheet.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === css.animationName);
        expect(entrance, "browser created the sheet's own animation").toBeDefined();
        entrance!.pause();
        entrance!.currentTime = 0;
        const start = sheet.getBoundingClientRect();
        expect(start.bottom, "starts one sheet height below rest").toBeCloseTo(800 + start.height, 1);
        entrance!.currentTime = 100;
        const midway = sheet.getBoundingClientRect();
        expect(midway.bottom, "moves upward before the end").toBeLessThan(start.bottom);
        expect(midway.bottom, "still approaching rest at 100ms").toBeGreaterThan(800);
        if (cssEntry === "precompiled" && action === "Done") await page.screenshot({ element: host!, path: `../../.vitest-attachments/dictation/motion-${theme}-midpoint.png` });
        entrance!.currentTime = 200;
        expect(sheet.getBoundingClientRect().bottom, "settles at the viewport bottom").toBeCloseTo(800, 1);
        expect(new DOMMatrix(getComputedStyle(sheet).transform).isIdentity, "no remaining translation at rest").toBe(true);
        entrance!.finish();
      } else {
        expect(css.animationName, "reduced motion has no sheet entrance").toBe("none");
        expect(sheet.getAnimations(), "no sheet animation is created").toHaveLength(0);
        expect(css.transform).toBe("none");
        expect(sheet.getBoundingClientRect().bottom).toBeCloseTo(800, 1);
      }
      expect(sheet.getBoundingClientRect().width).toBe(320);
      await listen("Keep the nonempty phone voyage transcript");
      if (cssEntry === "precompiled" && action === "Done") await page.screenshot({ element: host!, path: `../../.vitest-attachments/dictation/motion-${theme}-${preference}-rest.png` });
      if (action === "Done") {
        await userEvent.click(done());
        expect(client.drained).toBe(1);
        client.finish();
        await expect.poll(() => ui!.stores.voice.getState().reviewText).toBe("Keep the nonempty phone voyage transcript");
      } else {
        await userEvent.click(host!.querySelector<HTMLButtonElement>('button[title="Cancel"]')!);
        expect(client.stopped).toBe(1);
        expect(client.drained).toBe(0);
        expect(ui!.stores.voice.getState().reviewText).toBe("");
      }
      expect(ui!.stores.voice.getState().mode).toBe("idle");
      expect(document.body.style.overflow).toBe(previousOverflow);
    });
  }
  for (const preference of ["no-preference", "reduce"] as const) {
    test(`dictation motion ${cssEntry} ${theme} ${preference}: desktop stays stationary`, async () => {
      await commands.dictationMotion(preference);
      await mount(1280, 800, theme, cssEntry);
      expect(panel().getAttribute("role")).toBe("dialog");
      expect(getComputedStyle(panel()).animationName).toBe("none");
      expect(getComputedStyle(panel()).transform).toBe("none");
      expect(panel().getAnimations()).toHaveLength(0);
      expect(backdrop()).toBeNull();
    });
  }
}

for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
  test(`dictation disclosure ${width} ${theme}: unchanged browser-speech warning precedes transcript`, async () => {
    const { listen } = await mount(width, 800, theme); await listen();
    flushSync(() => ui!.stores.voice.getState().setProviderId("webspeech"));
    const note = [...panel().querySelectorAll<HTMLElement>("div")].find(el => el.textContent === "via browser speech · audio goes to Google")!;
    expect(note).not.toBeNull();
    expect(note.compareDocumentPosition(transcript()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const css = getComputedStyle(note);
    expect(css.fontSize).toBe("11px");
    expect(css.textAlign).toBe("center");
    expect(css.paddingTop).toBe("8px");
    // Approved warning ink at its existing 90% strength, resolved by the browser.
    const reference = document.createElement("span");
    reference.style.color = "color-mix(in oklab, var(--bk-color-amber) 90%, transparent)";
    panel().append(reference);
    expect(css.color).toBe(getComputedStyle(reference).color);
    reference.remove();
  });
}

test("dictation cap waits for translated entrance before exact rendered measurement", async () => {
  await commands.dictationMotion("no-preference");
  const { listen } = await mount(320, 800);
  await listen("Odysseus remembers the harbour. ".repeat(200));
  expect(transcript().scrollHeight).toBeGreaterThan(transcript().clientHeight);
  const sheet = panel();
  const animation = sheet.getAnimations()[0];
  expect(animation).toBeDefined();
  animation.pause();
  // Replay the translating frame measured in #973's pinned Chromium diagnosis.
  animation.currentTime = 99.98599999342117;
  expect(getComputedStyle(sheet).height).toBe("480px");
  expect(new DOMMatrix(getComputedStyle(sheet).transform).isIdentity).toBe(false);
  animation.play();
  await expectSettledHeightCap(480);
});

for (const [width, height] of [[320, 800], [1280, 600], [1920, 1080]]) {
  test(`dictation long transcript ${width}: capped, internally scrolled to newest words`, async () => {
    const { client, listen } = await mount(width, height);
    await listen("Odysseus remembers the harbour. ".repeat(200));
    expect(transcript().scrollHeight).toBeGreaterThan(transcript().clientHeight);
    await expectSettledHeightCap(width < 900 ? height * 0.6 : Math.min(height * 0.6, 512));
    await expect.poll(() => transcript().scrollHeight - transcript().scrollTop - transcript().clientHeight).toBeLessThanOrEqual(1);
    transcript().scrollTop = 0;
    flushSync(() => client.options.onEvent({ type: "partial", text: "Newest words at the end" }));
    expect(transcript().textContent).toContain("Newest words at the end");
    await expect.poll(() => transcript().scrollHeight - transcript().scrollTop - transcript().clientHeight).toBeLessThanOrEqual(1);
  });
}

for (const width of [320, 1280]) for (const phase of ["connecting", "listening", "draining"]) {
  test(`dictation Escape ${width} ${phase}: existing cancellation semantics and scroll restoration`, async () => {
    document.body.style.overflow = "auto";
    const { client, listen, mic } = await mount(width);
    if (phase !== "connecting") await listen();
    expect(panel().textContent).toContain(phase === "connecting" ? "Connecting…" : "Listening");
    expect(document.body.style.overflow).toBe("hidden");
    if (phase === "draining") {
      await userEvent.click(done());
      expect(panel().textContent).toContain("Finalizing…");
      expect(client.drained).toBe(1);
    }
    await userEvent.keyboard("{Escape}");
    expect(ui!.stores.voice.getState().mode).toBe("idle");
    expect(document.body.style.overflow).toBe("auto");
    expect(ui!.stores.voice.getState().reviewText).toBe("");
    if (phase !== "draining") expect(client.stopped).toBe(1);
    if (width >= 900) expect(document.activeElement).toBe(mic());
    // Finish the already-started promise, so no asynchronous drain escapes cleanup.
    if (phase === "draining") { client.finish(); await expect.poll(() => ui!.stores.voice.getState().draining).toBe(false); }
    if (phase === "connecting") { client.open(); await expect.poll(() => client.stopped).toBe(2); }
  });
}

for (const width of [320, 1280]) {
  test(`dictation unmount ${width}: body lock and live capture are released`, async () => {
    document.body.style.overflow = "scroll";
    const { client, listen } = await mount(width); await listen();
    expect(document.body.style.overflow).toBe("hidden");
    flushSync(() => renderer!.unmount()); renderer = undefined;
    expect(client.stopped).toBe(1);
    expect(document.body.style.overflow).toBe("scroll");
  });
}

test("dictation breakpoint: a live capture moves between 899 and 900 without stopping", async () => {
  const { frame, client, listen } = await mount(899); await listen();
  expect(backdrop()).not.toBeNull();
  await page.viewport(900, 800); await commands.formViewport(900, 800);
  host!.style.width = "900px";
  await expect.poll(() => panel().getAttribute("role")).toBe("dialog");
  expect(backdrop()).toBeNull();
  expect(panel().getBoundingClientRect().width).toBeCloseTo(frame.getBoundingClientRect().width, 1);
  expect(document.activeElement).toBe(done());
  await page.viewport(899, 800); await commands.formViewport(899, 800); host!.style.width = "899px";
  await expect.poll(() => backdrop()).not.toBeNull();
  expect(client.stopped).toBe(0); expect(client.drained).toBe(0);
  expect(ui!.stores.voice.getState().mode).toBe("dictate");
});

for (const theme of ["dark", "light"]) for (const width of [320, 1280, 1920]) {
  test(`dictation capture ${width} ${theme}: reviewable screenshot`, async () => {
    expect(matchMedia("(any-pointer: fine)").matches).toBe(true);
    const { listen } = await mount(width, width === 1920 ? 1080 : 800, theme);
    await listen("Remember the harbour crossing and the names of the winds.");
    flushSync(() => ui!.stores.voice.getState().setProviderId("webspeech"));
    if (width >= 900) expect(panel().textContent).toContain("Enter on Done");
    if (width === 320) await expect.poll(() => panel().getBoundingClientRect().bottom).toBeCloseTo(800, 1);
    await page.screenshot({ element: host!, path: `../../.vitest-attachments/dictation/${width}-${theme}.png` });
  });
}

test("dictation desktop error: existing error replaces disclosure and controls still drain to review", async () => {
  const { client, listen } = await mount(); await listen("Keep the words before the error");
  flushSync(() => {
    ui!.stores.voice.getState().setProviderId("webspeech");
    client.options.onError(new Error("Fixture speech error"));
  });
  expect(panel().textContent).toContain("Fixture speech error");
  expect(panel().textContent).not.toContain("audio goes to Google");
  await userEvent.click(done()); expect(client.drained).toBe(1);
  client.finish();
  await expect.poll(() => ui!.stores.voice.getState().reviewText).toBe("Keep the words before the error");
  expect(document.body.style.overflow).toBe(previousOverflow);
});

// Touch cases run last: Chromium changes its primary pointer to none when
// touch emulation is disabled. This test page/context is disposed by Vitest.
for (const action of ["Done", "mic", "Cancel"] as const) {
  test(`dictation wide touch-only: ${action} has a real 44px touch target`, async () => {
    await commands.dictationPointer(true); touchEnabled = true;
    const { client, listen, mic } = await mount(); await listen();
    expect(matchMedia("(any-pointer: fine)").matches).toBe(false);
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(backdrop()).toBeNull();
    expect(panel().textContent).toContain("Tap Done or the mic to stop");
    expect(panel().textContent).not.toContain("Enter");
    const target = action === "Done" ? done() : action === "mic" ? mic() : host!.querySelector<HTMLButtonElement>('button[title="Cancel"]')!;
    for (const control of [target, mic()]) {
      expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ element: host!, path: `../../.vitest-attachments/dictation/wide-touch-${action}.png` });
    const rect = target.getBoundingClientRect();
    await commands.rankTouch("touchStart", [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }]);
    await commands.rankTouch("touchEnd", []);
    if (action !== "Cancel") {
      await expect.poll(() => client.drained).toBe(1); client.finish();
      await expect.poll(() => ui!.stores.voice.getState().reviewText).toBe("Remember the harbour");
    } else { await expect.poll(() => client.stopped).toBe(1); expect(client.drained).toBe(0); }
  });
}
