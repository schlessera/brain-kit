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
 *
 * The mic has two timings: a press held 0.6 s opens Start, and after a
 * cancelled hold the release's click is swallowed for one second. A completed
 * hold stays guarded until its release, however long the press remains down.
 * Both run on a clock this file controls (`stopClock`). Input stays native;
 * time passes only when a test advances it, so a slow runner cannot stretch a
 * dwell between two inputs (#4170, #4184).
 */
import { afterAll, beforeAll, expect, inject, onTestFinished, test, vi, type TestContext } from "vitest";
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

/** The real timer, kept from before any test stops the clock. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const wait = (ms: number) => new Promise(done => realSetTimeout(done, ms));

/** The mic's own timings (`HOLD_MS` and `SWALLOW_MS` in `composer-mic.tsx`), stated here so that changing either fails. */
const HOLD = 600;
const GUARD = 1000;
/** The stopped clock draws an animation frame every 16 ms. */
const FRAME = 16;

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
type Scene = Awaited<ReturnType<typeof scene>>;
type Point = { x: number; y: number };

const CLOCK = ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"] as const;
/**
 * Stops the clock the mic reads: its hold timer, its click guard, the ring's
 * animation frames and `performance.now`. From here time passes only in
 * `advance`, however long the runner takes between two inputs. The scene's
 * start-up runs before this, on the real clock, and timers set before the
 * stop keep running in real time. `restore` hands the clock back for what a
 * case does after its gesture; the test's end restores it otherwise.
 *
 * While the clock is stopped, wait with `reached`, never `expect.poll`: a
 * poll that is not yet true advances a faked clock by its interval.
 */
function stopClock(ctx: TestContext) {
  const own = CLOCK.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let stopped = true;
  const restore = () => {
    if (!stopped) return;
    stopped = false;
    vi.useRealTimers();
    // The faked `performance` comes back as a plain value where the window had an accessor.
    for (const [key, descriptor] of own) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  };
  vi.useFakeTimers({ toFake: [...CLOCK], shouldClearNativeTimers: true });
  ctx.onTestFinished(restore);
  return { restore };
}
/** Moves the stopped clock on, and commits what the mic's timers and frames drew. */
const advance = (ms: number) => flushSync(() => { vi.advanceTimersByTime(ms); });

/**
 * Waits for the page to act on an input it has been sent. This is real time,
 * but it is a completion, not a dwell: the clock the mic reads is stopped, so
 * the wait cannot let a hold complete or a click guard end.
 */
async function reached(read: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error(message);
    await wait(5);
  }
}

function centre(el: Element) {
  const box = el.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
const phase = (s: Scene) => s.mic()?.dataset.phase ?? "no mic";
const ring = (s: Scene) => Number(s.mic()?.querySelector(".bk-voice-ring")?.getAttribute("data-progress"));
const hint = (s: Scene) => s.host.querySelector(".bk-voice-hint")?.textContent ?? null;

/**
 * Presses the mic and leaves it down. `t` on every later input of the gesture
 * is the event's time since this press, and matches the stopped clock. A
 * press that a failed assertion leaves down is lifted when its test ends.
 */
async function press(s: Scene, kind: Kind, at: Point) {
  onTestFinished(() => commands.sheetInput(kind, [{ type: "up", ...at, t: 0 }]));
  await commands.sheetInput(kind, [{ type: "down", ...at, t: 0 }]);
  await reached(() => phase(s) === "pressed", `${kind}: the press reaches the mic`);
}
const move = (kind: Kind, at: Point, t: number) => commands.sheetInput(kind, [{ type: "move", ...at, t }]);

let markers = 0;
/**
 * Everything the browser made of the inputs sent so far has reached the page:
 * the events themselves and the click a release produces, which for a touch
 * the browser sends as a separate tap after the release. A later native
 * input is the barrier: Chromium hands input to the page in the order it was
 * sent, so once the page has seen this mouse move, whatever an earlier input
 * caused has been handled. The mic ignores the move: it is not a press, a
 * click or a key, and no press is down.
 */
async function delivered(t: number) {
  const at = { x: 3 + markers++ % 5, y: 3 };
  let seen = false;
  const mark = (event: PointerEvent) => { if (event.pointerType === "mouse" && Math.abs(event.clientX - at.x) < 1 && Math.abs(event.clientY - at.y) < 1) seen = true; };
  window.addEventListener("pointermove", mark, true);
  try {
    await commands.sheetInput("mouse", [{ type: "move", ...at, t }]);
    await reached(() => seen, "the marker input reaches the page");
  } finally { window.removeEventListener("pointermove", mark, true); }
}
/** Lifts the press at `at`, `t` ms after it, and returns once the page has handled the release and any click it made. */
async function release(kind: Kind, at: Point, t: number) {
  await commands.sheetInput(kind, [{ type: "up", ...at, t }]);
  await delivered(t);
}

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
    const clock = stopClock(ctx);
    await press(s, kind, at);
    // Mid-hold: the ring fills and the hint explains, and nothing has started.
    advance(FRAME);
    expect(phase(s), `${kind}: the ring fills`).toBe("holding");
    expect(hint(s)).toBe("Keep holding to talk live");
    advance(250 - FRAME);
    // The ring was last drawn at most one frame ago.
    expect(ring(s), `${kind}: progress follows elapsed time`).toBeGreaterThan((250 - FRAME) / HOLD);
    expect(ring(s), `${kind}: progress follows elapsed time`).toBeLessThanOrEqual(250 / HOLD);
    expect(s.client.state.getState().disclosureOpen, `${kind}: 0.6 s has not passed`).toBe(false);
    expect(s.traffic(), `${kind}: HOLD_CAPTURES_NOTHING`).toEqual(before);
    advance(HOLD - 250 - 1);
    expect(s.client.state.getState().disclosureOpen, `${kind}: one millisecond short of 0.6 s, Start has not opened`).toBe(false);
    expect(s.haptics, `${kind}: no haptic before the hold completes`).toEqual([]);
    expect(s.traffic(), `${kind}: HOLD_CAPTURES_NOTHING`).toEqual(before);
    // Still held, and no release has been sent: at 0.6 s Start opens, with a light haptic.
    advance(1);
    expect(s.client.state.getState().disclosureOpen, `${kind}: the hold opens Start while the mic is still held`).toBe(true);
    expect(s.haptics, `${kind}: one light haptic while the mic is still held`).toEqual([10]);
    // Released after 999 ms; the completed hold is still guarded.
    advance(GUARD - 1);
    await release(kind, at, HOLD + GUARD - 1);
    // The release is not a tap: Start stays, and no dictation began.
    expect(s.client.state.getState().disclosureOpen, `${kind}: the release does not dismiss Start`).toBe(true);
    expect(s.ui.stores.voice.getState().mode).toBe("conversation");
    expect(s.microphone, `${kind}: Start is not Start pressed`).toEqual([]);
    expect(s.traffic().frames.filter(type => type !== "conversation_enter"), `${kind}: no provider bytes before Start`).toEqual(before.frames);
    expect(s.network.socket()!.frames("conversation_start"), `${kind}: the release inside the click guard does not press Start`).toHaveLength(0);
    clock.restore();
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(s.client.state.getState().active).toBe(false);
  }
});

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`five seconds after Start opens the original release never presses Start ${kind} ${width}`, async ctx => {
  premise();
  const s = await scene(ctx, width);
  const at = centre(s.mic()!);
  const clock = stopClock(ctx);
  await press(s, kind, at);
  advance(HOLD);
  expect(s.client.state.getState().disclosureOpen, "the hold opens Start before release").toBe(true);
  advance(5_000);
  await release(kind, at, HOLD + 5_000);
  expect(s.network.socket()!.frames("conversation_start"), "the original release must not press Start").toHaveLength(0);
  expect(s.client.state.getState().disclosureOpen, "Start stays open and unpressed").toBe(true);
  expect(s.microphone, "the original release captures nothing").toEqual([]);
  // A fresh native press is deliberate consent, even immediately after release.
  const start = centre(page.getByRole("button", { name: "Start", exact: true }).element());
  clock.restore();
  await commands.sheetInput(kind, [{ type: "down", ...start, t: 0 }, { type: "up", ...start, t: 100 }]);
  await delivered(100);
  await expect.poll(() => s.network.socket()!.frames("conversation_start").length, { message: "a deliberate tap presses Start" }).toBe(1);
});

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`an early release dictates, and never opens Start ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    const at = centre(s.mic()!);
    const clock = stopClock(ctx);
    await press(s, kind, at);
    // Released part-way through the hold, with the ring drawn that far.
    advance(250);
    expect(phase(s), `${kind}: the tap is released part-way through the hold`).toBe("holding");
    expect(ring(s), `${kind}: the ring is part-way round at the release`).toBeGreaterThan((250 - FRAME) / HOLD);
    expect(ring(s), `${kind}: the ring is part-way round at the release`).toBeLessThanOrEqual(250 / HOLD);
    await release(kind, at, 250);
    expect(s.ui.stores.voice.getState().mode, `${kind}: the tap dictates`).toBe("dictate");
    // Past the 0.6 s the press would have needed: the release ended the hold.
    advance(HOLD);
    expect(s.client.state.getState().disclosureOpen, `${kind}: EARLY_RELEASE_NEVER_OPENS_START`).toBe(false);
    expect(s.client.state.getState().active).toBe(false);
    expect(s.haptics).toEqual([]);
    clock.restore();
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
    stopClock(ctx);
    await press(s, kind, at);
    advance(150);
    expect(phase(s)).toBe("holding");
    expect(hint(s)).toBe("Keep holding to talk live");
    // The pointer leaves, still down. The clock is stopped, so only leaving can end the hold here.
    const away = { x: at.x - 120, y: at.y - 160 };
    await move(kind, away, 150);
    await reached(() => phase(s) !== "holding", `${kind}: leaving cancels`);
    expect(phase(s), `${kind}: leaving cancels`).toBe("idle");
    expect(hint(s), `${kind}: the hint goes with the hold`).toBe(null);
    // Away and still down until one millisecond before the click guard ends:
    // 1,149 ms after the press, well past the 0.6 s a running hold needs.
    advance(GUARD - 1);
    expect(s.client.state.getState().disclosureOpen, `${kind}: a cancelled hold never opens Start`).toBe(false);
    expect(s.haptics, `${kind}: a cancelled hold never completes`).toEqual([]);
    expect(phase(s), `${kind}: a cancelled hold never completes`).toBe("idle");
    // Back over the mic and released there: still not a tap, and not a hold.
    await move(kind, at, 150 + GUARD - 1);
    await release(kind, at, 150 + GUARD - 1);
    expect(s.client.state.getState().disclosureOpen, `${kind}: a cancelled hold never opens Start`).toBe(false);
    expect(s.ui.stores.voice.getState().mode, `${kind}: a cancelled hold does not dictate`).toBe("idle");
    expect(s.haptics).toEqual([]);
    expect(s.traffic(), `${kind}: CANCELLED_HOLD_CAPTURES_NOTHING`).toEqual(before);
    // The next tap is still a tap.
    await press(s, kind, at);
    await release(kind, at, 100);
    expect(s.ui.stores.voice.getState().mode, `${kind}: the next tap dictates`).toBe("dictate");
  }
});

// A touch that slid away and back is not a tap to the browser, so only a mouse clicks here.
for (const kind of KINDS.filter(kind => kind === "mouse")) for (const width of [320, 1280] as const) test(`one second after a cancelled hold the release is a tap again ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    const at = centre(s.mic()!);
    stopClock(ctx);
    await press(s, kind, at);
    advance(150);
    await move(kind, { x: at.x - 120, y: at.y - 160 }, 150);
    await reached(() => phase(s) !== "holding", `${kind}: leaving cancels`);
    expect(phase(s), `${kind}: leaving cancels`).toBe("idle");
    // The case above releases one millisecond earlier, and is swallowed.
    advance(GUARD);
    await move(kind, at, 150 + GUARD);
    await release(kind, at, 150 + GUARD);
    expect(s.ui.stores.voice.getState().mode, `${kind}: the click guard has ended, so the release dictates`).toBe("dictate");
    expect(s.client.state.getState().disclosureOpen, `${kind}: a cancelled hold never opens Start`).toBe(false);
    expect(s.haptics).toEqual([]);
  }
});

for (const kind of KINDS) for (const width of [320, 1280] as const) test(`without live conversation the ring fills, then S4 explains ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    flushSync(() => s.client.state.setState({ available: false }));
    const at = centre(s.mic()!);
    const before = s.traffic();
    const clock = stopClock(ctx);
    await press(s, kind, at);
    advance(FRAME);
    expect(phase(s), `${kind}: the ring still fills (V4)`).toBe("holding");
    advance(HOLD - FRAME - 1);
    expect(s.host.textContent, `${kind}: one millisecond short of 0.6 s, no notice`).not.toContain(S4);
    expect(s.haptics, `${kind}: no haptic before the hold completes`).toEqual([]);
    // Still held, and no release has been sent.
    advance(1);
    expect(s.host.textContent, `${kind}: S4 replaces Start while the mic is still held`).toContain(S4);
    expect(s.haptics, `${kind}: one light haptic while the mic is still held`).toEqual([10]);
    const ok = page.getByRole("button", { name: "OK", exact: true });
    expect(document.activeElement, `${kind}: the notice takes focus`).toBe(ok.element());
    // Released after 999 ms; the completed hold is still guarded.
    advance(GUARD - 1);
    await release(kind, at, HOLD + GUARD - 1);
    expect(s.client.state.getState().active, `${kind}: Start does not open`).toBe(false);
    expect(s.ui.stores.voice.getState().mode, `${kind}: the release is not a tap`).toBe("idle");
    expect(s.traffic(), `${kind}: S4 captures nothing`).toEqual(before);
    expect(document.activeElement, `${kind}: the release leaves focus on the notice`).toBe(ok.element());
    clock.restore();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => s.host.textContent).not.toContain(S4);
    await expect.poll(() => document.activeElement, { message: `${kind}: OK hands focus back to the mic` }).toBe(s.mic());
  }
});

// The mic stays in place under S4, so the release's click lands on it for a mouse and for a touch.
for (const kind of KINDS) for (const width of [320, 1280] as const) test(`five seconds after S4 opens the original release is still swallowed ${kind} ${width}`, async ctx => {
  premise();
  {
    const s = await scene(ctx, width);
    flushSync(() => s.client.state.setState({ available: false }));
    const at = centre(s.mic()!);
    stopClock(ctx);
    await press(s, kind, at);
    advance(HOLD);
    expect(s.host.textContent, `${kind}: S4 replaces Start while the mic is still held`).toContain(S4);
    advance(5_000);
    await release(kind, at, HOLD + 5_000);
    expect(s.ui.stores.voice.getState().mode, `${kind}: the original release does not dictate`).toBe("idle");
    expect(s.host.textContent, "the release leaves S4 open").toContain(S4);
    // The mic remains in place, and a new native tap still dictates.
    await press(s, kind, at);
    await release(kind, at, 100);
    expect(s.ui.stores.voice.getState().mode, "a deliberate tap dictates").toBe("dictate");
    expect(s.client.state.getState().active, `${kind}: Start does not open`).toBe(false);
    expect(s.haptics).toEqual([10]);
  }
});

// Start replaces the mic, so a mouse release produces no click. Exercise each
// way to end that surviving guard without letting its fallback timer expire.
for (const ending of ["press", "key", "click"] as const) test(`after a completed hold with no release click a new ${ending} ends the guard`, async ctx => {
  premise();
  const s = await scene(ctx, 1280);
  stopClock(ctx);
  await press(s, "mouse", centre(s.mic()!));
  advance(HOLD);
  expect(s.client.state.getState().disclosureOpen).toBe(true);
  const start = page.getByRole("button", { name: "Start", exact: true }).element() as HTMLButtonElement;
  const at = centre(start);
  await release("mouse", at, HOLD);
  expect(s.network.socket()!.frames("conversation_start"), "a mouse release after replacement makes no click").toHaveLength(0);
  if (ending === "press") {
    await commands.sheetInput("mouse", [{ type: "down", ...at, t: 0 }, { type: "up", ...at, t: 100 }]);
    await delivered(100);
  } else if (ending === "key") {
    start.focus();
    await userEvent.keyboard("{Enter}");
  } else {
    // A click with no preceding press (assistive activation) consumes the guard.
    start.click();
    expect(s.network.socket()!.frames("conversation_start"), "the first unpaired click is swallowed").toHaveLength(0);
    start.click();
  }
  await reached(() => s.network.socket()!.frames("conversation_start").length === 1, `a fresh ${ending} allows Start`);
  expect(s.network.socket()!.frames("conversation_start"), "a later deliberate activation is never lost").toHaveLength(1);
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
