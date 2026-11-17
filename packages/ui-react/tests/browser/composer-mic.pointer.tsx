/// <reference types="@vitest/browser-playwright" />
/**
 * The composer's one mic (#3693): tap to dictate, hold for 0.6 s to open
 * Start, in Chromium launched as a fine, coarse or mixed device (the `rail-*`
 * projects). Each scene presses the real mic with native input: a mouse under
 * a fine pointer, a touch under a coarse one, and both under a mixed one.
 *
 * Nothing is captured during a hold. The real browser APIs are instrumented:
 * `MediaDevices.prototype.getUserMedia`, and #1016's fault network for
 * `fetch`, XHR, beacons, every WebSocket and every frame sent, so a hold, or
 * a hold that was cancelled, is proven to have opened no microphone, no
 * provider connection and no history read. Each instrument is restored with
 * its complete property descriptor when the test ends.
 */
import { afterAll, beforeAll, expect, inject, onTestFinished, test, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { conversationProfileSchema, serverHelloSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";
import { primeDictation } from "../fixtures/dictation-discovery.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

const SESSION = "odysseus-ithaca";
const SPEECH = "wss://speech.invalid/v1/listen";
const PROFILE = conversationProfileSchema.parse({
  providerId: "gpt-live",
  capabilities: { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" },
  disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fictional fixture. Retention: unknown."] },
});
const HELLO = serverHelloSchema.parse({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true }, conversationProfile: PROFILE });
const SPEECH_SESSION: VoiceSessionResponse = { providerId: "deepgram", url: SPEECH, token: "odysseus-grant", expiresAt: Date.now() + 60 * 60_000, capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false } };
const S4 = "Live conversation isn’t set up here";

let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Replaces one property for the test and puts its complete descriptor back afterwards. */
function instrument<T extends object>(ctx: TestContext, target: T, key: PropertyKey, value: unknown) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  ctx.onTestFinished(() => { if (own) Object.defineProperty(target, key, own); else delete (target as Record<PropertyKey, unknown>)[key]; });
}

async function scene(ctx: TestContext, width: number) {
  const viewport = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, 720);
  await page.viewport(width, 720);
  const network = installFaultNetwork({
    routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] })
      : url.pathname.endsWith("/voice/session") ? Response.json(SPEECH_SESSION)
      : url.pathname.endsWith("/voice/overrides") ? Response.json({ overrides: [] }) : undefined,
    onOpen(socket) {
      if (socket.url.startsWith(SPEECH)) return;
      socket.deliver(HELLO); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
    },
  });
  // After the fault network, so its own restore runs last.
  const microphone: string[] = [];
  const realGetUserMedia = MediaDevices.prototype.getUserMedia;
  instrument(ctx, MediaDevices.prototype, "getUserMedia", function spiedGetUserMedia(this: MediaDevices, constraints?: MediaStreamConstraints) {
    microphone.push(JSON.stringify(constraints ?? {}));
    return realGetUserMedia.call(this, constraints);
  });
  const haptics: unknown[] = [];
  instrument(ctx, navigator, "vibrate", (pattern: VibratePattern) => { haptics.push(pattern); return true; });

  const ui = createBrainUiRoot({ storage: null, request: network.request });
  primeDictation(ui, "deepgram");
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:720px`;
  document.body.append(host);
  const renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(async () => { flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  await expect.poll(() => ui.connection.conversation.state.getState().available).toBe(true);
  const mic = () => host.querySelector<HTMLButtonElement>('[data-composer-mic] button.bk-voice-mic');
  await expect.poll(mic, { message: "the composer draws the hold-to-talk mic" }).not.toBe(null);
  expect(mic()!.getAttribute("aria-label")).toBe("Dictate · Deepgram");
  // A first press would focus the window, and focus refreshes the shell's
  // storage evidence. Focus it now, so the window below holds only the gesture.
  await userEvent.click(host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!);
  expect(document.hasFocus(), "the window has focus before the gesture").toBe(true);
  // Let start-up reads settle, so the window below holds only the gesture.
  // The shell's storage indicator reads its guidance once the session is
  // active; it is the last start-up read, and it is not the mic's.
  await expect.poll(() => network.requests.some(r => new URL(r.url).pathname.endsWith("/storage/guidance")), { timeout: 5_000 }).toBe(true);
  let settled = -1;
  await expect.poll(async () => { const now = network.requests.length + network.frames.length; const quiet = now === settled; settled = now; await wait(300); return quiet; }, { timeout: 5_000 }).toBe(true);
  /** Everything a hold must not start: a microphone, a request, a socket, a frame. */
  const traffic = () => ({
    microphone: [...microphone],
    requests: network.requests.map(r => `${r.via} ${r.method} ${new URL(r.url).pathname}`),
    sockets: network.sockets.map(socket => socket.url),
    frames: network.frames.map(frame => typeof frame.data === "string" ? String(JSON.parse(frame.data).type) : `binary ${frame.bytes}`),
  });
  return { ui, host, network, mic, traffic, microphone, haptics, client: ui.connection.conversation };
}

type Kind = "mouse" | "touch";

/**
 * What the page itself saw during a hold: when the press arrived, when Start
 * opened, and the mic on every frame in between. Mid-hold facts are read from
 * these, never from when a command happened to return: a sleep between
 * commands raced the 0.6 s hold on a loaded runner (#4170).
 */
function watchHold(s: Awaited<ReturnType<typeof scene>>) {
  const quiet = JSON.stringify(s.traffic());
  const seen = { pressed: null as number | null, opened: null as number | null,
    frames: [] as { at: number; phase: string | undefined; progress: number; hint: string | undefined; quiet: boolean }[] };
  const down = () => { seen.pressed ??= performance.now(); };
  window.addEventListener("pointerdown", down, true);
  const unsubscribe = s.client.state.subscribe(state => { if (state.disclosureOpen) seen.opened ??= performance.now(); });
  let live = true;
  const frame = () => {
    if (!live) return;
    const mic = s.mic();
    if (mic) seen.frames.push({ at: performance.now(), phase: mic.dataset.phase,
      progress: Number(mic.querySelector(".bk-voice-ring")?.getAttribute("data-progress")),
      hint: s.host.querySelector(".bk-voice-hint")?.textContent ?? undefined, quiet: JSON.stringify(s.traffic()) === quiet });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const stop = () => { live = false; window.removeEventListener("pointerdown", down, true); unsubscribe(); return seen; };
  onTestFinished(() => { stop(); });
  return { stop };
}

function centre(el: Element) {
  const box = el.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
/** A press that a failed assertion leaves down is lifted when its test ends. */
function press(kind: Kind, at: { x: number; y: number }) {
  onTestFinished(() => commands.sheetInput(kind, [{ type: "up", ...at, t: 0 }]));
  return commands.sheetInput(kind, [{ type: "down", ...at, t: 0 }]);
}
/**
 * A tap: the press and the release in one command, so the release cannot
 * arrive after the 0.6 s hold on a loaded runner. Two commands with a sleep
 * between them did (#4170).
 */
const tap = (kind: Kind, at: { x: number; y: number }, held: number) =>
  commands.sheetInput(kind, [{ type: "down", ...at, t: 0 }, { type: "up", ...at, t: held }]);
const move = (kind: Kind, at: { x: number; y: number }, t: number) => commands.sheetInput(kind, [{ type: "move", ...at, t }]);
const lift = (kind: Kind, at: { x: number; y: number }, t: number) => commands.sheetInput(kind, [{ type: "up", ...at, t }]);

const MODE = inject("railPointer");
/** A mouse under a fine pointer, a touch under a coarse one, both under a mixed one. */
const KINDS: Kind[] = MODE === "coarse" ? ["touch"] : MODE === "fine" ? ["mouse"] : ["mouse", "touch"];

function premise() {
  const mode = MODE;
  if (mode === "coarse") expect(matchMedia("(pointer: coarse)").matches, "coarse premise").toBe(true);
  if (mode === "fine") expect(matchMedia("(any-pointer: coarse)").matches, "fine premise").toBe(false);
}

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`a completed hold opens Start and captures nothing on the way ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    const at = centre(s.mic()!);
    const before = s.traffic();
    const watch = watchHold(s);
    await press(kind, at);
    // Still held: at 0.6 s Start opens, with a light haptic.
    await expect.poll(() => s.client.state.getState().disclosureOpen, { message: `${kind}: the hold opens Start` }).toBe(true);
    expect(s.haptics, `${kind}: one light haptic`).toEqual([10]);
    // Mid-hold, from the page's own frames before Start opened: the ring fills
    // and the hint explains, and nothing has started.
    const seen = watch.stop();
    const mid = seen.frames.filter(frame => frame.at < seen.opened! && frame.progress > 0 && frame.progress < 1);
    expect(mid.length, `${kind}: the ring fills: progress follows elapsed time`).toBeGreaterThan(0);
    expect(mid.every(frame => frame.phase === "holding"), `${kind}: the ring fills`).toBe(true);
    expect(mid.every(frame => frame.hint === "Keep holding to talk live"), `${kind}: the hint explains`).toBe(true);
    expect(mid.every(frame => frame.quiet), `${kind}: HOLD_CAPTURES_NOTHING`).toBe(true);
    expect(seen.opened! - seen.pressed!, `${kind}: Start opens no sooner than 0.6 s after the press`).toBeGreaterThanOrEqual(595);
    await lift(kind, at, 900);
    await wait(100);
    // The release is not a tap: Start stays, and no dictation began.
    expect(s.client.state.getState().disclosureOpen, `${kind}: the release does not dismiss Start`).toBe(true);
    expect(s.ui.stores.voice.getState().mode).toBe("conversation");
    expect(s.microphone, `${kind}: Start is not Start pressed`).toEqual([]);
    expect(s.traffic().frames.filter(type => type !== "conversation_enter"), `${kind}: no provider bytes before Start`).toEqual(before.frames);
    expect(s.network.socket()!.frames("conversation_start")).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(s.client.state.getState().active).toBe(false);
  }
});

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`an early release dictates, and never opens Start ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    const at = centre(s.mic()!);
    await tap(kind, at, 250);
    await expect.poll(() => s.ui.stores.voice.getState().mode, { message: `${kind}: the tap dictates` }).toBe("dictate");
    await wait(600);
    expect(s.client.state.getState().disclosureOpen, `${kind}: EARLY_RELEASE_NEVER_OPENS_START`).toBe(false);
    expect(s.client.state.getState().active).toBe(false);
    expect(s.haptics).toEqual([]);
    // The dictation path is the one that opens the microphone.
    await expect.poll(() => s.microphone.length, { message: `${kind}: dictation opens the microphone`, timeout: 5_000 }).toBeGreaterThan(0);
  }
});

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`leaving the mic cancels the hold, and nothing is captured after it ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    const at = centre(s.mic()!);
    const before = s.traffic();
    await press(kind, at);
    // Read after the press has reached the page: the hold's timer started no later than this.
    const pressed = performance.now();
    await expect.poll(() => s.mic()!.dataset.phase).toBe("holding");
    const away = { x: at.x - 120, y: at.y - 160 };
    await move(kind, away, 150);
    await expect.poll(() => s.mic()?.dataset.phase ?? "no mic: the hold completed", { message: `${kind}: leaving cancels` }).toBe("idle");
    expect(s.host.querySelector(".bk-voice-hint"), `${kind}: the hint goes with the hold`).toBe(null);
    // Back over the mic and released there: still not a tap, and not a hold. The
    // mic swallows the release's click for one second after the cancel, so the
    // return and the release go in one command, straight after it. A sleep and
    // two command round trips in between outlasted that second on a loaded
    // runner, and the click then counted as a tap (#4170).
    await commands.sheetInput(kind, [{ type: "move", ...at, t: 250 }, { type: "up", ...at, t: 300 }]);
    await wait(300);
    expect(s.ui.stores.voice.getState().mode, `${kind}: a cancelled hold does not dictate`).toBe("idle");
    // The cancelled hold never completes later either. The hold lasts 600 ms from
    // the press, which happened before `pressed` was read, so 900 ms after that
    // reading is past it however slow the runner is.
    await wait(Math.max(0, pressed + 900 - performance.now()));
    expect(s.client.state.getState().disclosureOpen, `${kind}: a cancelled hold never opens Start`).toBe(false);
    expect(s.ui.stores.voice.getState().mode, `${kind}: a cancelled hold still does not dictate`).toBe("idle");
    expect(s.haptics).toEqual([]);
    expect(s.traffic(), `${kind}: CANCELLED_HOLD_CAPTURES_NOTHING`).toEqual(before);
    // The next tap is still a tap.
    await tap(kind, at, 100);
    await expect.poll(() => s.ui.stores.voice.getState().mode, { message: `${kind}: the next tap dictates` }).toBe("dictate");
  }
});

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`without live conversation the ring fills, then S4 explains ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    flushSync(() => s.client.state.setState({ available: false }));
    const at = centre(s.mic()!);
    const before = s.traffic();
    await press(kind, at);
    await expect.poll(() => s.mic()!.dataset.phase, { message: `${kind}: the ring still fills (V4)` }).toBe("holding");
    await expect.poll(() => s.host.textContent, { message: `${kind}: S4 replaces Start` }).toContain(S4);
    expect(s.haptics).toEqual([10]);
    await lift(kind, at, 800);
    await wait(150);
    expect(s.client.state.getState().active, `${kind}: Start does not open`).toBe(false);
    expect(s.ui.stores.voice.getState().mode, `${kind}: the release is not a tap`).toBe("idle");
    expect(s.traffic(), `${kind}: S4 captures nothing`).toEqual(before);
    const ok = page.getByRole("button", { name: "OK", exact: true });
    expect(document.activeElement, `${kind}: the notice takes focus`).toBe(ok.element());
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => s.host.textContent).not.toContain(S4);
    await expect.poll(() => document.activeElement, { message: `${kind}: OK hands focus back to the mic` }).toBe(s.mic());
  }
});

test("the keyboard and a screen reader reach both modes", async ctx => {
  premise();
  const s = await scene(ctx, 1280);
  s.mic()!.focus();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await expect.poll(() => s.client.state.getState().disclosureOpen, { message: "Shift+Enter opens Start" }).toBe(true);
  expect(s.ui.stores.voice.getState().mode, "Shift+Enter does not dictate").toBe("conversation");
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  await expect.poll(s.mic).not.toBe(null);

  // "Talk live…": the screen reader's way, focusable and named.
  const talkLive = page.getByRole("button", { name: "Talk live…", exact: true }).element() as HTMLElement;
  talkLive.focus();
  expect(document.activeElement).toBe(talkLive);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => s.client.state.getState().disclosureOpen, { message: "Talk live… opens Start" }).toBe(true);
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  await expect.poll(s.mic).not.toBe(null);
  expect(s.microphone, "neither path opened the microphone").toEqual([]);

  for (const key of ["{Enter}", " "]) {
    s.mic()!.focus();
    await userEvent.keyboard(key);
    await expect.poll(() => s.ui.stores.voice.getState().mode, { message: `${key} dictates` }).toBe("dictate");
    expect(s.client.state.getState().disclosureOpen).toBe(false);
    await expect.poll(() => s.ui.stores.voice.getState().connecting, { timeout: 5_000 }).toBe(false);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => s.ui.stores.voice.getState().mode).toBe("idle");
    await expect.poll(s.mic).not.toBe(null);
  }
});
