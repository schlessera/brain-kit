/// <reference types="@vitest/browser-playwright" />
/**
 * Recording on the device without a server voice session (#1012, #578 T1),
 * in real Chromium with its fake microphone.
 *
 * The real ChatPage renders against a real client root with "Record on this
 * device" turned on and a test sink. Only the transports are fixtures: #1016's
 * fault network, which drops and recovers the host and records every request
 * and socket frame, and answers the voice session while the host is up.
 * Playwright's own request log, which sits on the browser's network stack,
 * also proves the capture path asks for nothing.
 *
 * Every test owns its scene: a fresh root and mount per cell, removed when it
 * ends, and nothing is pressed before entrances settle (#992).
 */
import { afterEach, beforeAll, afterAll, expect, test, vi, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { installFaultNetwork, type FaultNetwork } from "./offline/fault-network.ts";
import { createRoot, type Root } from "react-dom/client";
import type { AsrClient, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { detectLocalCaptureSupport, startLocalCapture, type LocalCaptureChunk, type LocalCaptureSink } from "../../src/voice/local-capture.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    startRequestLog: () => Promise<void>;
    requestLog: () => Promise<string[]>;
    grantMicrophone: () => Promise<void>;
  }
}

const ITHACA = "odysseus-ithaca";

/** The sink a test reads: every chunk, in the order the engine handed them over. */
class TestSink implements LocalCaptureSink {
  chunks: LocalCaptureChunk[] = [];
  ended: string[] = [];
  mimeType = "";
  begin(info: { mimeType: string }) { this.mimeType = info.mimeType; }
  chunk(chunk: LocalCaptureChunk) { this.chunks.push(chunk); }
  end(reason: string) { this.ended.push(reason); }
}

/** A streaming provider that only records that the existing path started it. */
class FixtureAsr implements AsrClient {
  static started = 0;
  async start() { FixtureAsr.started++; }
  stop() {}
  async drainAndStop() {}
}

type Scene = {
  ui: BrainUiRoot;
  host: HTMLDivElement;
  sink: TestSink;
  net: FaultNetwork;
  /** Requests through the root's transport, as paths. */
  requests: () => { path: string; method: string }[];
  gum: { calls: number; streams: MediaStream[] };
  signal: AbortSignal;
  /** Tears the app down, as a reload does. */
  close: () => void;
};

let realGetUserMedia: MediaDevices["getUserMedia"];
let styles: HTMLStyleElement | undefined;
beforeAll(async () => {
  realGetUserMedia = navigator.mediaDevices.getUserMedia;
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => {
  navigator.mediaDevices.getUserMedia = realGetUserMedia;
  styles?.remove();
});
afterEach(() => {
  navigator.mediaDevices.getUserMedia = realGetUserMedia;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FixtureAsr.started = 0;
});

/** Every getUserMedia call the page makes, counted over the real function. */
function spyMicrophone(gum: Scene["gum"], impl: MediaDevices["getUserMedia"] = realGetUserMedia) {
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    gum.calls++;
    const stream = await impl.call(navigator.mediaDevices, constraints);
    gum.streams.push(stream);
    return stream;
  };
}

const settle = async (s: { signal: AbortSignal }, n = 3) => {
  for (let i = 0; i < n; i++) {
    s.signal.throwIfAborted();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await expect.poll(() => document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity), { message: "entrances settled" }).toBe(false);
};

const HELLO = [
  { type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } },
  { type: "session_info", sessionId: ITHACA, isNew: false },
  { type: "session_history", sessionId: ITHACA, messages: [] },
  { type: "status", sessionId: ITHACA, status: "idle" },
];

const SESSION: VoiceSessionResponse = {
  providerId: "fixture", url: "", expiresAt: Date.now() + 60 * 60_000,
  capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
};

/** One fault network per test: the host's socket says hello; its voice routes answer while it is up. */
function network(ctx: TestContext): FaultNetwork {
  const net = installFaultNetwork({
    routes: (url) => {
      if (url.pathname.endsWith("/voice/session")) return Response.json(SESSION);
      if (url.pathname.endsWith("/voice/overrides")) return Response.json({ overrides: [] });
      if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] });
      return undefined;
    },
    onOpen: (socket) => { for (const frame of HELLO) socket.deliver(frame); },
  });
  ctx.onTestFinished(() => net.restore());
  return net;
}

const connected = (s: Scene) => s.ui.stores.connection.getState().wsStatus === "connected";

/** The host answers again, and the app reconnects to it. */
async function reconnect(s: Scene) {
  s.net.recover();
  s.ui.connection.reconnectNow();
  await expect.poll(() => connected(s), { message: "the host is reachable" }).toBe(true);
  await settle(s);
}

/** The host goes away. */
async function drop(s: Scene) {
  s.net.drop();
  await expect.poll(() => connected(s), { message: "the host is unreachable" }).toBe(false);
  await settle(s);
}

async function mount(ctx: TestContext, opts: { online?: boolean; gum?: MediaDevices["getUserMedia"]; counts?: Scene["gum"]; net?: FaultNetwork } = {}): Promise<Scene> {
  ctx.signal.throwIfAborted();
  const net = opts.net ?? network(ctx);
  net.recover();
  const gum = opts.counts ?? { calls: 0, streams: [] };
  if (!opts.counts) spyMicrophone(gum, opts.gum);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:390px;height:780px";
  document.body.append(host);
  const sink = new TestSink();
  const ui = createBrainUiRoot({ storage: null, localCapture: { sink: () => sink, timesliceMs: 200 }, request: net.request });
  ui.asr.register("fixture", () => new FixtureAsr());
  const renderer: Root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  };
  ctx.onTestFinished(close);
  ui.stores.chat.getState().setActiveSession(ITHACA);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  ui.connection.connect();
  const requests = () => net.requests.filter((r) => r.via === "request").map((r) => ({ path: new URL(r.url).pathname, method: r.method }));
  const s: Scene = { ui, host, sink, net, requests, gum, signal: ctx.signal, close };
  await expect.poll(() => connected(s), { message: "the app reached the host" }).toBe(true);
  // "No host": the socket the app had is gone, and so are its routes.
  if (!opts.online) await drop(s);
  await document.fonts.ready;
  await settle(s, 4);
  return s;
}

const mic = (s: Scene) => s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label="Record on this device"], [data-composer] [role="button"][aria-label="Stop and save"], [data-composer] [role="button"][aria-label="Dictate"], [data-composer] [role="button"][aria-label="Stop dictation"]');
const field = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const notice = (s: Scene) => s.host.querySelector<HTMLElement>("[data-capture-notice]");
const phase = (s: Scene) => s.ui.stores.voice.getState().local;

/** Taps the mic, whatever it is called, and waits for recorded audio. */
async function recordOffline(s: Scene) {
  await expect.poll(() => mic(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(mic(s)!);
  await expect.poll(() => s.sink.chunks.length, { message: "chunks arrive from the fake microphone", timeout: 5000 }).toBeGreaterThanOrEqual(1);
}

test("offline, a tap records on the device: the sink gets ordered chunks and the network sees nothing", async (ctx) => {
  const s = await mount(ctx);
  await commands.startRequestLog();
  const before = { requests: s.net.requests.length, frames: s.net.frames.length, sockets: s.net.sockets.length };
  await recordOffline(s);
  await expect.poll(() => s.sink.chunks.length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  expect(mic(s)?.getAttribute("aria-label"), "the mic is the recording's stop").toBe("Stop and save");
  await userEvent.click(mic(s)!);
  await expect.poll(() => phase(s)).toBe("idle");
  expect(s.gum.calls, "the tap opened the microphone once").toBe(1);
  expect(s.sink.mimeType).toBe("audio/webm;codecs=opus");
  const ends = s.sink.chunks.map((c) => c.endMs);
  for (let i = 1; i < ends.length; i++) expect(ends[i], `chunk ${i} ends after chunk ${i - 1}`).toBeGreaterThan(ends[i - 1]!);
  expect(s.sink.chunks.every((c) => c.data.size > 0), "every chunk holds audio").toBe(true);
  expect(s.sink.chunks.map((c) => c.startMs).slice(1)).toEqual(ends.slice(0, -1));
  expect(s.sink.ended).toEqual(["user"]);
  expect(s.net.requests.slice(before.requests), "no request: the app's transport, fetch, XHR or beacon").toEqual([]);
  expect(s.net.frames.slice(before.frames), "no socket frame").toEqual([]);
  // The app keeps retrying its own socket while the host is away; nothing else opens one.
  expect(s.net.sockets.slice(before.sockets).filter((socket) => socket.url !== s.ui.wsUrl()), "no socket but the app's own retries").toEqual([]);
  expect(await commands.requestLog(), "no request on the browser's network").toEqual([]);
  // The log could see one: a request now shows up in it.
  await fetch("/__local-capture-probe").catch(() => undefined);
  expect((await commands.requestLog()).some((url) => url.endsWith("/__local-capture-probe")), "the request log observes the page").toBe(true);
  expect(s.net.requests.at(-1)?.url, "and so does the in-page spy").toMatch(/\/__local-capture-probe$/);
  new WebSocket("ws://local-capture.invalid/");
  expect(s.net.sockets.slice(before.sockets).filter((socket) => socket.url !== s.ui.wsUrl()).length, "and a socket of anyone else's").toBe(1);
});

test("offline, the mic is labelled for a recording on the device", async (ctx) => {
  const s = await mount(ctx);
  await expect.poll(() => mic(s)?.getAttribute("aria-label"), { message: "the mic's accessible name" }).toBe("Record on this device");
  expect(s.gum.calls).toBe(0);
});

test("with the host reachable, the mic still runs the streaming dictation through POST /api/voice/session", async (ctx) => {
  const s = await mount(ctx, { online: true });
  await expect.poll(() => mic(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(mic(s)!);
  await expect.poll(() => FixtureAsr.started, { message: "the existing dictation client started" }).toBe(1);
  expect(mic(s)?.getAttribute("aria-label")).toBe("Stop dictation");
  expect(s.requests().filter((r) => r.path.endsWith("/voice/session")), "the voice session was requested").toEqual([{ path: "/api/voice/session", method: "POST" }]);
  expect(s.ui.stores.voice.getState().mode).toBe("dictate");
  expect(phase(s)).toBe("idle");
  expect(s.sink.chunks).toEqual([]);
  expect(s.gum.calls, "the dictation fixture opens no microphone; local capture opened none").toBe(0);
});

test("nothing opens the microphone without a tap: load, reconnect, reload and a permission grant", async (ctx) => {
  const counts = { calls: 0, streams: [] as MediaStream[] };
  spyMicrophone(counts);
  const s = await mount(ctx, { counts });
  expect(counts.calls, "loading the app").toBe(0);
  await reconnect(s);
  await drop(s);
  expect(counts.calls, "reconnecting and dropping again").toBe(0);
  // A reload: the page's app is torn down and a fresh root mounts.
  s.close();
  const reloaded = await mount(ctx, { counts, net: s.net });
  expect(counts.calls, "reloading").toBe(0);
  await commands.grantMicrophone();
  await settle(reloaded);
  expect((await navigator.permissions.query({ name: "microphone" as PermissionName })).state, "the grant took effect").toBe("granted");
  expect(counts.calls, "granting permission").toBe(0);
  // The spy sees a call when there is one: a tap makes it.
  await userEvent.click(mic(reloaded)!);
  await expect.poll(() => counts.calls, { message: "the spy counts the tap's call" }).toBe(1);
  await expect.poll(() => phase(reloaded)).toBe("recording");
  await userEvent.click(mic(reloaded)!);
  await expect.poll(() => phase(reloaded)).toBe("idle");
});

test("a recording on the device survives losing and regaining the host, and a dictation never turns into one", async (ctx) => {
  const s = await mount(ctx);
  await recordOffline(s);
  await reconnect(s);
  const atReconnect = s.sink.chunks.length;
  expect(mic(s)?.getAttribute("aria-label"), "the mic still stops the recording").toBe("Stop and save");
  await expect.poll(() => s.sink.chunks.length, { message: "recording continues after the host returns", timeout: 5000 }).toBeGreaterThan(atReconnect + 1);
  await drop(s);
  const atDrop = s.sink.chunks.length;
  await expect.poll(() => s.sink.chunks.length, { message: "and after it goes again", timeout: 5000 }).toBeGreaterThan(atDrop + 1);
  expect(phase(s)).toBe("recording");
  expect(s.ui.stores.voice.getState().mode, "never switched to streaming").toBe("idle");
  expect(s.requests().filter((r) => r.path.includes("/voice/")), "no voice session asked for").toEqual([]);
  expect(s.gum.calls, "never restarted").toBe(1);
  expect(s.sink.ended, "never stopped").toEqual([]);
  await userEvent.click(mic(s)!);
  await expect.poll(() => s.sink.ended).toEqual(["user"]);

  // A dictation, online: losing the host and getting it back records nothing.
  await reconnect(s);
  await expect.poll(() => mic(s)?.getAttribute("aria-label")).toBe("Dictate");
  await userEvent.click(mic(s)!);
  await expect.poll(() => FixtureAsr.started).toBe(1);
  await drop(s);
  await reconnect(s);
  expect(phase(s), "no local recording started").toBe("idle");
  expect(s.gum.calls, "no microphone opened for one").toBe(1);
  expect(s.ui.stores.voice.getState().mode).toBe("dictate");
});

test("a refused microphone shows the denial, keeps focus on the mic and leaves the draft editable", async (ctx) => {
  const s = await mount(ctx, { gum: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } });
  await expect.poll(() => mic(s), { message: "the composer has a mic" }).not.toBe(null);
  const button = mic(s)!;
  await userEvent.click(button);
  await expect.poll(() => notice(s)?.querySelector("[data-capture-message]")?.textContent, { message: "the denial copy" })
    .toBe("Brain can't use the microphone. Allow it in your browser's site settings, then tap Record again.");
  expect(notice(s)?.querySelector('[aria-label="Dismiss capture notice"]')?.textContent).toBe("Dismiss");
  expect(s.gum.calls, "one request, no retry loop").toBe(1);
  expect(document.activeElement, "focus stays on the mic").toBe(button);
  expect(phase(s)).toBe("idle");
  expect(field(s).readOnly, "the composer stays editable").toBe(false);
  await userEvent.click(field(s));
  await userEvent.keyboard("Ithaca");
  expect(field(s).value).toBe("Ithaca");
  await settle(s);
  expect(s.gum.calls, "no second prompt").toBe(1);
});

test("a browser that cannot record on the device says so, with no mic claiming to", async (ctx) => {
  vi.spyOn(MediaRecorder, "isTypeSupported").mockReturnValue(false);
  const s = await mount(ctx);
  await expect.poll(() => notice(s)?.querySelector("[data-capture-message]")?.textContent, { message: "the unsupported copy" })
    .toBe("This browser can't save recordings on the device. You can type a note and send it when you're back online.");
  expect(notice(s)?.querySelector('[aria-label="Dismiss capture notice"]')?.textContent).toBe("Dismiss");
  expect(mic(s), "no mic control").toBe(null);
  expect(s.host.querySelector('[data-composer] [aria-label="Record on this device"]')).toBe(null);
  expect(s.gum.calls).toBe(0);
});

test("stop(reason) hands over the final chunk and releases every track before it resolves", async (ctx) => {
  const gum = { calls: 0, streams: [] as MediaStream[] };
  spyMicrophone(gum);
  const order: string[] = [];
  const sink: LocalCaptureSink = {
    chunk: async (c) => { order.push(`chunk ${c.index}`); await new Promise((r) => setTimeout(r, 30)); order.push(`saved ${c.index}`); },
    end: (reason) => { order.push(`end ${reason}`); },
  };
  // A long interval: the only chunk is the one stop() flushes.
  const capture = await startLocalCapture({ sink, timesliceMs: 60_000 });
  await new Promise((r) => setTimeout(r, 400));
  ctx.signal.throwIfAborted();
  expect(order, "nothing handed over before stop").toEqual([]);
  const tracks = gum.streams[0]!.getTracks();
  expect(tracks.length).toBeGreaterThan(0);
  expect(tracks.every((t) => t.readyState === "live")).toBe(true);
  const reason = await capture.stop("limit");
  order.push("resolved");
  expect(reason).toBe("limit");
  expect(order, "the final chunk was saved before stop resolved").toEqual(["chunk 0", "saved 0", "end limit", "resolved"]);
  expect(tracks.map((t) => t.readyState), "every track ended").toEqual(tracks.map(() => "ended"));
  expect(await capture.stop("user"), "a second stop keeps the first reason").toBe("limit");
});

test("support needs a recorder container, a Blob write to IndexedDB and a secure context, and never the microphone", async () => {
  const gum = { calls: 0, streams: [] as MediaStream[] };
  spyMicrophone(gum);
  expect(await detectLocalCaptureSupport()).toEqual({ supported: true, mimeType: "audio/webm;codecs=opus", missing: [] });
  expect((await indexedDB.databases()).map((d) => d.name), "the probe database is gone again").not.toContain("brain-ui:local-capture-probe");
  expect((await detectLocalCaptureSupport({ isSecureContext: false })).missing).toEqual(["secure-context"]);
  const refusing = { open() { throw new DOMException("The user denied permission to access the database.", "InvalidStateError"); } } as unknown as IDBFactory;
  expect((await detectLocalCaptureSupport({ indexedDB: refusing })).missing, "a storage-blocked page").toEqual(["indexeddb"]);
  const noContainers = Object.assign(function () {}, { isTypeSupported: () => false }) as unknown as typeof MediaRecorder;
  expect(await detectLocalCaptureSupport({ MediaRecorder: noContainers })).toEqual({ supported: false, mimeType: null, missing: ["media-recorder"] });
  expect(gum.calls).toBe(0);
});

test("a tap while the microphone is still opening cancels it: nothing records once the browser answers", async (ctx) => {
  let answer!: () => void;
  const opened: MediaStream[] = [];
  const s = await mount(ctx, {
    gum: async (constraints) => {
      await new Promise<void>((resolve) => { answer = resolve; });
      const stream = await realGetUserMedia.call(navigator.mediaDevices, constraints);
      opened.push(stream);
      return stream;
    },
  });
  await expect.poll(() => mic(s), { message: "the composer has a mic" }).not.toBe(null);
  await userEvent.click(mic(s)!);
  await expect.poll(() => phase(s), { message: "waiting on the microphone" }).toBe("opening");
  await userEvent.click(mic(s)!);
  await expect.poll(() => phase(s), { message: "the second tap cancelled" }).toBe("idle");
  answer();
  await expect.poll(() => opened.length).toBe(1);
  await expect.poll(() => opened[0]!.getTracks().map((t) => t.readyState), { message: "the late stream is released" }).toEqual(["ended"]);
  await settle(s);
  expect(phase(s), "no recording started").toBe("idle");
  expect(s.sink.mimeType, "the sink never heard of it").toBe("");
  expect(s.sink.chunks).toEqual([]);
  expect(s.sink.ended).toEqual([]);
});

test("a recorder the browser stops on its own ends the recording as interrupted", async (ctx) => {
  const gum = { calls: 0, streams: [] as MediaStream[] };
  spyMicrophone(gum);
  const sink = new TestSink();
  const capture = await startLocalCapture({ sink, timesliceMs: 200 });
  await expect.poll(() => sink.chunks.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  ctx.signal.throwIfAborted();
  // Stopped by whoever else holds the stream: no `ended` event fires.
  for (const track of gum.streams[0]!.getTracks()) track.stop();
  const outcome = await Promise.race([capture.ended, new Promise<string>((resolve) => setTimeout(() => resolve("still recording"), 3000))]);
  expect(outcome, "the recording ended").toBe("interrupted");
  expect(sink.ended).toEqual(["interrupted"]);
});

test("Add on a dictated review never starts dictation beside a recording on the device", async (ctx) => {
  const s = await mount(ctx);
  s.ui.stores.voice.getState().setReviewText("Ask Penelope about the loom.");
  await settle(s);
  await recordOffline(s);
  await reconnect(s);
  const add = s.host.querySelector<HTMLButtonElement>('button[title="Append more voice"]');
  expect(add, "the review card offers Add").toBeTruthy();
  await userEvent.click(add!);
  await settle(s);
  expect(s.requests().filter((r) => r.path.includes("/voice/")), "no voice session").toEqual([]);
  expect(s.ui.stores.voice.getState().mode, "no dictation").toBe("idle");
  expect(phase(s)).toBe("recording");
  await userEvent.click(mic(s)!);
  await expect.poll(() => s.sink.ended).toEqual(["user"]);
});

test("a recorder that fails to start reaches no sink and leaves no microphone open", async () => {
  const gum = { calls: 0, streams: [] as MediaStream[] };
  spyMicrophone(gum);
  const sink = new TestSink();
  class Refusing extends MediaRecorder {
    override start(): void { throw new DOMException("The recorder could not start.", "NotSupportedError"); }
  }
  await expect(startLocalCapture({ sink, MediaRecorder: Refusing })).rejects.toThrow("could not start");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sink.mimeType, "begin never ran").toBe("");
  expect(gum.streams[0]!.getTracks().map((t) => t.readyState), "the stream was released").toEqual(["ended"]);
});
