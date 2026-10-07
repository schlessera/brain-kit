/// <reference types="@vitest/browser-playwright" />
/**
 * Recording on the device without a server voice session (#1012, #578 T1),
 * in real Chromium with its fake microphone.
 *
 * The real ChatPage renders against a real client root with "Record on this
 * device" turned on and a test sink. Only the transports are fixtures: a
 * socket the test opens and drops, and a `request` that records every call
 * and answers the voice session. Playwright's own request log, which sits on
 * the browser's network stack, proves the capture path asks for nothing.
 *
 * Every test owns its scene: a fresh root and mount per cell, removed when it
 * ends, and nothing is pressed before entrances settle (#992).
 */
import { afterEach, beforeAll, afterAll, expect, test, vi, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
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

class FixtureSocket {
  static all: FixtureSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  constructor() { FixtureSocket.all.push(this); }
  send() {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; flushSync(() => this.onopen?.()); }
  drop() { this.readyState = 3; flushSync(() => this.onclose?.({ code: 1006, reason: "" } as CloseEvent)); }
  deliver(frame: unknown) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
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
  requests: { path: string; method: string }[];
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
  FixtureSocket.all = [];
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

const socket = () => FixtureSocket.all.at(-1)!;

function hello() {
  socket().open();
  socket().deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } });
  socket().deliver({ type: "session_info", sessionId: ITHACA, isNew: false });
  socket().deliver({ type: "session_history", sessionId: ITHACA, messages: [] });
  socket().deliver({ type: "status", sessionId: ITHACA, status: "idle" });
}

/** The host answers again: the app's next socket opens and says hello. */
async function reconnect(s: Scene) {
  const n = FixtureSocket.all.length;
  s.ui.connection.reconnectNow();
  await expect.poll(() => FixtureSocket.all.length, { message: "the app opened a new socket" }).toBeGreaterThan(n);
  hello();
  await settle(s);
  expect(s.ui.stores.connection.getState().wsStatus, "the host is reachable").toBe("connected");
}

/** The host goes away. */
async function drop(s: Scene) {
  socket().drop();
  await settle(s);
  expect(s.ui.stores.connection.getState().wsStatus, "the host is unreachable").not.toBe("connected");
}

async function mount(ctx: TestContext, opts: { online?: boolean; gum?: MediaDevices["getUserMedia"]; counts?: Scene["gum"] } = {}): Promise<Scene> {
  ctx.signal.throwIfAborted();
  vi.stubGlobal("WebSocket", FixtureSocket);
  const gum = opts.counts ?? { calls: 0, streams: [] };
  if (!opts.counts) spyMicrophone(gum, opts.gum);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:390px;height:780px";
  document.body.append(host);
  const sink = new TestSink();
  const requests: Scene["requests"] = [];
  const session: VoiceSessionResponse = {
    providerId: "fixture", url: "", expiresAt: Date.now() + 60_000,
    capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
  };
  const ui = createBrainUiRoot({
    storage: null,
    localCapture: { sink: () => sink, timesliceMs: 200 },
    request: async (url, init = {}) => {
      const path = new URL(url, "http://fixture.invalid").pathname;
      requests.push({ path, method: init.method ?? "GET" });
      // The host's routes go away with its socket, as they do offline.
      if (ui.stores.connection.getState().wsStatus !== "connected") throw new TypeError("Failed to fetch");
      if (path.endsWith("/voice/session")) return Response.json(session);
      if (path.endsWith("/voice/overrides")) return Response.json({ overrides: [] });
      if (path.endsWith("/sessions")) return Response.json({ sessions: [] });
      return new Response("{}", { status: 404 });
    },
  });
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
  hello();
  // "No host": the socket the app had is gone; its reconnect is pending.
  if (!opts.online) socket().drop();
  const s: Scene = { ui, host, sink, requests, gum, signal: ctx.signal, close };
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
  const before = s.requests.length;
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
  expect(s.requests.slice(before), "no request through the app's transport").toEqual([]);
  expect(await commands.requestLog(), "no request on the browser's network").toEqual([]);
  // The log could see one: a request now shows up in it.
  await fetch("/__local-capture-probe").catch(() => undefined);
  expect((await commands.requestLog()).some((url) => url.endsWith("/__local-capture-probe")), "the request log observes the page").toBe(true);
});

test("offline, the mic is labelled for a recording on the device", async (ctx) => {
  const s = await mount(ctx);
  await expect.poll(() => mic(s)?.getAttribute("aria-label"), { message: "the mic's accessible name" }).toBe("Record on this device");
  expect(s.gum.calls).toBe(0);
});

test("with the host reachable, the mic still runs the streaming dictation through POST /api/voice/session", async (ctx) => {
  const s = await mount(ctx, { online: true });
  await expect.poll(() => mic(s)?.getAttribute("aria-label")).toBe("Dictate");
  await userEvent.click(mic(s)!);
  await expect.poll(() => FixtureAsr.started, { message: "the existing dictation client started" }).toBe(1);
  expect(s.requests.filter((r) => r.path.endsWith("/voice/session")), "the voice session was requested").toEqual([{ path: "/api/voice/session", method: "POST" }]);
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
  const reloaded = await mount(ctx, { counts });
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
  expect(s.requests.filter((r) => r.path.includes("/voice/")), "no voice session asked for").toEqual([]);
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
  await expect.poll(() => mic(s)?.getAttribute("aria-label")).toBe("Record on this device");
  const button = mic(s)!;
  await userEvent.click(button);
  await expect.poll(() => notice(s)?.textContent, { message: "the denial copy" })
    .toBe("Brain can't use the microphone. Allow it in your browser's site settings, then tap Record again.");
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
  await expect.poll(() => notice(s)?.textContent, { message: "the unsupported copy" })
    .toBe("This browser can't save recordings on the device. You can type a note and send it when you're back online.");
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
