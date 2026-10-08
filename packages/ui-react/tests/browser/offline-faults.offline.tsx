/// <reference types="@vitest/browser-playwright" />
/**
 * The offline fault harness proves itself against today's app (#1016).
 *
 * Every primitive in `./offline/` is exercised here against behaviour that
 * exists now, so a feature test that uses one can trust it does what it says:
 * the fake microphone feeds today's dictation client, a drop produces today's
 * reconnect pill, an auth expiry today's login screen, and so on. Each test
 * fails when its primitive is made a no-op; the mutations are recorded in the
 * PR that added them.
 *
 * Runs in the `ui-react-layout` project: real Chromium in the pinned image,
 * no network beyond the in-container Vite server, no provider key. Every test
 * owns its root, its mount and its fixtures, and removes them when it ends.
 */
import { expect, test, type TestContext } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { DeepgramClient } from "../../src/voice/asr-deepgram.js";
import { createIndexedDbAnswerStorage } from "../../src/lib/answer-delivery/storage.js";
import type { QueuedAnswer } from "../../src/lib/answer-delivery/types.js";
import { AUDIO_FIXTURES, FIXTURE_TONE_HZ, generateWav } from "./offline/audio-fixtures.ts";
import { installFaultNetwork, type FaultNetwork, type FaultNetworkOptions } from "./offline/fault-network.ts";
import { dominantFrequency, hidePage, installWavMicrophone, watchMicrophone } from "./offline/fake-microphone.ts";
import { failIndexedDbWrites } from "./offline/indexeddb-faults.ts";
import { openScene } from "./offline/scene.ts";

const HELLO = { type: "server_hello", protocolRev: 5, capabilities: {} };
/** The FFT resolution at 48 kHz is about 12 Hz. */
const TONE_TOLERANCE_HZ = 25;
const RAW_AUDIO = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };

function network(ctx: TestContext, options: FaultNetworkOptions = {}): FaultNetwork {
  const net = installFaultNetwork(options);
  ctx.onTestFinished(() => net.restore());
  return net;
}

const stopAll = (stream: MediaStream) => { for (const track of stream.getTracks()) track.stop(); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const probes = (net: FaultNetwork) => net.requests.filter((r) => r.url.endsWith("/api/vpn-check")).length;

/** The real gate over a stand-in for the app, connected through the fault network. */
async function mountGate(ctx: TestContext, net: FaultNetwork) {
  const host = document.createElement("div");
  document.body.append(host);
  const ui = createBrainUiRoot({ storage: null, request: net.request });
  const renderer = createRoot(host);
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <ConnectionGate>
          <main>The way home to Ithaca</main>
        </ConnectionGate>
      </BrainUiProvider>,
    ),
  );
  ui.connection.connect();
  await expect.poll(() => host.querySelector("main"), { timeout: 5_000 }).toBeTruthy();
  await expect.poll(() => net.socket()?.readyState, { timeout: 5_000 }).toBe(1);
  return { host, ui, transcript: host.querySelector("main")! };
}

const pill = (host: HTMLElement) => host.querySelector('[role="status"]')?.textContent ?? null;
const loginField = (host: HTMLElement) => host.querySelector('input[type="password"]');

test("the fake microphone plays the fixture: its tone, encoded by today's dictation client", async (ctx) => {
  // Chromium's own fake device, fed the generated file by the project's launch flags.
  const raw = await navigator.mediaDevices.getUserMedia(RAW_AUDIO);
  ctx.onTestFinished(() => stopAll(raw));
  expect(Math.abs((await dominantFrequency(raw)) - FIXTURE_TONE_HZ)).toBeLessThan(TONE_TOLERANCE_HZ);

  const net = network(ctx);
  const client = new DeepgramClient({ url: "wss://speech.invalid/v1/listen", token: "odysseus", onEvent: () => {} });
  ctx.onTestFinished(() => client.stop());
  await client.start();
  const speech = () => net.frames.filter((f) => f.url.startsWith("wss://speech.invalid/") && f.data instanceof Blob);
  await expect.poll(() => speech().length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  const bytes = speech().reduce((sum, f) => sum + f.bytes, 0);
  expect(bytes).toBeGreaterThan(0);
  // The recorder's container: WebM starts with the EBML magic.
  const head = new Uint8Array(await (speech()[0]!.data as Blob).slice(0, 4).arrayBuffer());
  expect([...head]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
});

test("the injected microphone plays a WAV through AudioContext, for engines without the fake-file flag", async (ctx) => {
  // Another tone than the launch fixture's, so the device cannot pass for it.
  const injected = installWavMicrophone(generateWav({ ...AUDIO_FIXTURES.note10s, toneHz: 750 }));
  ctx.onTestFinished(() => injected.restore());
  const stream = await navigator.mediaDevices.getUserMedia(RAW_AUDIO);
  ctx.onTestFinished(() => stopAll(stream));
  expect(Math.abs((await dominantFrequency(stream)) - 750)).toBeLessThan(TONE_TOLERANCE_HZ);
});

test("the network spy catches a fetch, an XHR, a beacon and a socket frame that bypass the root", async (ctx) => {
  const net = network(ctx);
  await fetch("/odysseus/raft-lashing.json").catch(() => {});
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/odysseus/xhr");
  xhr.send("oar");
  xhr.abort();
  navigator.sendBeacon("/odysseus/beacon", "sail");
  const socket = new WebSocket("wss://ithaca.invalid/ws");
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "chat_message", text: "Which way is home?" }));

  expect(net.requests.map((r) => [r.via, r.method, new URL(r.url).pathname])).toEqual([
    ["fetch", "GET", "/odysseus/raft-lashing.json"],
    ["xhr", "POST", "/odysseus/xhr"],
    ["beacon", "POST", "/odysseus/beacon"],
  ]);
  expect(net.frames.map((f) => [f.url, f.data])).toEqual([["wss://ithaca.invalid/ws", JSON.stringify({ type: "chat_message", text: "Which way is home?" })]]);
});

test("a transport drop produces today's reconnect pill, and recovery clears it", { timeout: 30_000 }, async (ctx) => {
  const net = network(ctx, { onOpen: (s) => s.deliver(HELLO) });
  const { host, transcript } = await mountGate(ctx, net);
  expect(pill(host)).toBeNull();
  const opened = net.sockets.length;

  net.drop({ announce: true });
  // Three failed handshakes (1 s, 2 s, 4 s) ask the probe, which fails too.
  await expect.poll(() => pill(host), { timeout: 12_000, interval: 100 }).toBe("Connection lost — reconnecting…");
  expect(host.querySelector("main"), "the app stays mounted through a drop").toBe(transcript);

  net.recover();
  await expect.poll(() => pill(host), { timeout: 8_000, interval: 100 }).toBeNull();
  expect(net.socket()!.readyState).toBe(1);
  expect(net.sockets.length).toBeGreaterThan(opened);
  expect(host.querySelector("main")).toBe(transcript);
});

test("an auth expiry produces today's login screen", { timeout: 30_000 }, async (ctx) => {
  const net = network(ctx, { onOpen: (s) => s.deliver(HELLO) });
  const { host } = await mountGate(ctx, net);
  expect(loginField(host)).toBeNull();
  const socket = net.socket()!;
  const closes: number[] = [];
  socket.addEventListener("close", (e) => closes.push((e as CloseEvent).code));

  net.expireAuth();
  // The 1008 close starts reconnects that fail their handshake; after three,
  // the gate asks the probe, which answers 401. The probe's own 15 s poll
  // would come too late for this window.
  await expect.poll(() => loginField(host), { timeout: 10_000, interval: 100 }).toBeTruthy();
  expect(host.querySelector("main"), "protected content is unmounted").toBeNull();
  expect(closes).toEqual([1008]);
});

test("a hidden page shown again asks the probe at once, as today's poller does", async (ctx) => {
  const net = network(ctx, { onOpen: (s) => s.deliver(HELLO) });
  await mountGate(ctx, net);
  await expect.poll(() => probes(net)).toBeGreaterThanOrEqual(1);
  await wait(200);
  const before = probes(net);
  const seen: string[] = [];
  const observe = () => seen.push(document.visibilityState);
  document.addEventListener("visibilitychange", observe);
  ctx.onTestFinished(() => document.removeEventListener("visibilitychange", observe));

  const hidden = hidePage();
  ctx.onTestFinished(() => hidden.show());
  hidden.show();
  await expect.poll(() => probes(net), { timeout: 2_000 }).toBe(before + 1);
  // What every handler in the app read, in order.
  expect(seen).toEqual(["hidden", "visible"]);
});

test("a microphone interruption ends the track and today's recorder stops sending", async (ctx) => {
  const mic = watchMicrophone();
  ctx.onTestFinished(() => mic.restore());
  const net = network(ctx);
  const client = new DeepgramClient({ url: "wss://speech.invalid/v1/listen", token: "odysseus", onEvent: () => {} });
  ctx.onTestFinished(() => client.stop());
  await client.start();
  const speech = () => net.frames.filter((f) => f.url.startsWith("wss://speech.invalid/") && f.data instanceof Blob).length;
  await expect.poll(speech, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  const [track] = mic.streams[0]!.getAudioTracks();
  const ended: string[] = [];
  track!.addEventListener("ended", () => ended.push(track!.readyState));

  mic.interrupt();
  // The recorder flushes its last chunk, then nothing more arrives.
  await wait(500);
  const settled = speech();
  await wait(1_000);
  expect(speech()).toBe(settled);
  expect(ended).toEqual(["ended"]);
});

const answer = (submissionId: string, note = "Sail west") =>
  ({ v: 1, submissionId, principalKey: "odysseus", requestId: `ask-${submissionId}`, sessionId: "odysseus-ithaca", turnId: null, submittedAt: Date.UTC(2026, 6, 12, 9, 41), sent: false, payload: { kind: "ask_user", answer: note } }) as unknown as QueuedAnswer;

async function answerStore(ctx: TestContext) {
  const name = `odysseus-answers-${crypto.randomUUID()}`;
  ctx.onTestFinished(() => void indexedDB.deleteDatabase(name));
  return createIndexedDbAnswerStorage(name);
}
const ids = async (store: Awaited<ReturnType<typeof answerStore>>) => ((await store.load()) as QueuedAnswer[]).map((a) => a.submissionId).sort();

test("a quota failure on the next write fails today's answer store, and keeps what committed", async (ctx) => {
  const store = await answerStore(ctx);
  await store.put(answer("troy"));
  const quota = failIndexedDbWrites({ next: true });
  ctx.onTestFinished(() => quota.restore());

  await expect(store.put(answer("aeolia"))).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(await ids(store)).toEqual(["troy"]);
  // Only the next write: the one after it commits.
  await store.put(answer("ithaca"));
  expect(await ids(store)).toEqual(["ithaca", "troy"]);
});

test("a quota failure after a byte threshold fails every later write", async (ctx) => {
  const store = await answerStore(ctx);
  const quota = failIndexedDbWrites({ afterBytes: 600 });
  ctx.onTestFinished(() => quota.restore());

  await store.put(answer("troy"));
  await expect(store.put(answer("aeolia", "x".repeat(400)))).rejects.toMatchObject({ name: "QuotaExceededError" });
  // Smaller than the write that crossed it, and still refused: the origin is full.
  await expect(store.put(answer("ithaca", ""))).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(await ids(store)).toEqual(["troy"]);
  expect(quota.failures).toBe(2);
  expect(quota.bytesWritten).toBeGreaterThan(0);
});

/** A raw database with one `notes` store keyed by `id`, removed when the test ends. */
async function notesDb(ctx: TestContext): Promise<IDBDatabase> {
  const name = `odysseus-notes-${crypto.randomUUID()}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("notes", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  ctx.onTestFinished(() => { db.close(); void indexedDB.deleteDatabase(name); });
  return db;
}
/** One readwrite transaction; resolves with how it ended. */
function transact(db: IDBDatabase, op: (store: IDBObjectStore) => void): Promise<string> {
  return new Promise((resolve) => {
    const tx = db.transaction("notes", "readwrite");
    tx.oncomplete = () => resolve("complete");
    tx.onabort = () => resolve(`abort:${tx.error?.name}`);
    op(tx.objectStore("notes"));
  });
}
const notes = (db: IDBDatabase) =>
  new Promise<string[]>((resolve) => {
    const req = db.transaction("notes").objectStore("notes").getAllKeys();
    req.onsuccess = () => resolve((req.result as string[]).sort());
  });

test("a quota failure lets a transaction queue all its writes, then aborts it whole", async (ctx) => {
  const db = await notesDb(ctx);
  const quota = failIndexedDbWrites({ next: true });
  ctx.onTestFinished(() => quota.restore());
  const thrown: string[] = [];

  const ended = await transact(db, (store) => {
    for (const id of ["chunk-1", "chunk-2", "index"]) {
      try { store.put({ id }); } catch (error) { thrown.push((error as DOMException).name); }
    }
  });
  expect(ended).toBe("abort:QuotaExceededError");
  expect(thrown, "a real full disk refuses at commit, not at the second put").toEqual([]);
  expect(await notes(db)).toEqual([]);
});

test("a write that never commits gives its bytes back to the threshold", async (ctx) => {
  const db = await notesDb(ctx);
  // About 214 estimated bytes each: two fit under 500, three do not.
  const note = (id: string) => ({ id, text: "x".repeat(100) });
  const quota = failIndexedDbWrites({ afterBytes: 500 });
  ctx.onTestFinished(() => quota.restore());

  expect(await transact(db, (s) => s.add(note("a")))).toBe("complete");
  // A duplicate key: the transaction aborts and stores nothing.
  expect(await transact(db, (s) => s.add(note("a")))).toBe("abort:ConstraintError");
  // A duplicate key whose error is handled: the transaction completes without it.
  expect(await transact(db, (s) => { s.add(note("a")).onerror = (e) => e.preventDefault(); })).toBe("complete");
  // A write the store refuses outright, larger than the whole budget: no key.
  expect(await transact(db, (s) => { expect(() => s.add({ text: "x".repeat(400) })).toThrow(); })).toBe("complete");
  // The caller aborts, and writes again before any abort event.
  const aborted = db.transaction("notes", "readwrite");
  aborted.objectStore("notes").add(note("c"));
  aborted.abort();
  const retry = transact(db, (s) => s.add(note("b")));
  expect(await retry).toBe("complete");
  expect(await notes(db)).toEqual(["a", "b"]);
  expect(quota.failures).toBe(0);
});

const scene = new URL("./offline/scenes/answer-store.scene.ts", import.meta.url);

test("a reload relaunches the page after its unload handlers ran, and committed storage survives", { timeout: 30_000 }, async (ctx) => {
  const s = await openScene(scene);
  ctx.onTestFinished(() => s.close());
  await s.call("save", "troy");
  await s.call("keepSaving", "sea");

  await s.reload();
  expect(await s.call("launches")).toBe(2);
  expect(await s.call("pagehides")).toEqual([1]);
  expect(await s.call<string[]>("saved")).toContain("troy");
});

test("a termination relaunches the page with no unload handler run, mid-write, and committed storage survives", { timeout: 30_000 }, async (ctx) => {
  const s = await openScene(scene);
  ctx.onTestFinished(() => s.close());
  await s.call("save", "troy");
  await s.call("keepSaving", "sea");

  await s.terminate();
  expect(await s.call("launches")).toBe(2);
  expect(await s.call("pagehides"), "no pagehide ran").toEqual([]);
  expect(await s.call<string[]>("saved")).toContain("troy");
});
