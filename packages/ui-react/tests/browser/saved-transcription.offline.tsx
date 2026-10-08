/// <reference types="@vitest/browser-playwright" />
import { beforeAll, afterAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import axe from "axe-core";
import { createBrainUiRoot } from "../../src/root.js";
import { createLocalPartitions } from "../../src/lib/local-partitions.js";
import { createLocalWork } from "../../src/lib/local-work.js";
import { createRecordingStore } from "../../src/lib/recordings.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { RecordingsTray, SAVED_AUDIO_UNAVAILABLE } from "../../src/components/voice/recordings-tray.js";
import { installFaultNetwork } from "./offline/fault-network.ts";
import { failIndexedDbWrites } from "./offline/indexeddb-faults.ts";

import { openScene } from "./offline/scene.ts";
import type { RecordingTranscription } from "@schlessera/brain-ui-sdk/protocol";
import type { ProgressRequestInit } from "../../src/lib/upload-request.js";

const TEXT = "Odysseus asks Penelope about the loom order.";
const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
async function settled() {
  await expect.poll(() => document.getAnimations().some(a => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity)).toBe(false);
}
async function tap(el: Element) { el.scrollIntoView({ block: "nearest" }); await settled(); await userEvent.click(el); }
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLElement>('button,[role="button"]')].find(el => el.getClientRects().length && (el.getAttribute("aria-label") ?? el.textContent ?? "").includes(label))!;
function fixture(ctx: TestContext, backendUrl?: string) {
  let available = true, drop = false, hold = false, fail = false, reject = false;
  let release: (() => void) | undefined;
  let stored: RecordingTranscription | null = null;
  const uploads: Blob[] = [];
  const net = installFaultNetwork({ routes: async (url, raw) => {
    const init = raw as ProgressRequestInit;
    if (url.pathname.endsWith("/voice/capabilities")) return Response.json({ providerId: "deepgram", capabilities: { savedAudio: available } });
    if (url.pathname.endsWith("/transcription")) {
      if ((init.method ?? "GET") === "GET") return stored ? Response.json(stored) : new Response("{}", { status: 404 });
      if (init.method === "DELETE") { stored = { ...stored!, status: "consumed", text: undefined }; return Response.json(stored); }
      const body = init.body as Blob; uploads.push(body);
      if (reject) return Response.json({ error: "recording_too_large", message: "The recording exceeds the upload byte budget." }, { status: 413 });
      init.onUploadProgress?.(40);
      await new Promise(r => setTimeout(r, 40));
      if (drop) throw new TypeError("Connection lost at 40%");
      init.onUploadProgress?.(100);
      stored = { recordingId: url.pathname.split("/").at(-2)!, sha256: new Headers(init.headers).get("content-sha256")!, providerId: "deepgram", status: "transcribing", attemptId: crypto.randomUUID(), retryCount: url.searchParams.has("retry") ? (stored?.retryCount ?? 0) + 1 : 0, failures: [] };
      if (hold) await new Promise<void>(r => { release = r; });
      stored = fail ? { ...stored, status: "failed", failure: { reason: "rate_limit", retryable: true }, failures: [{ reason: "rate_limit", retryable: true, attemptId: stored.attemptId }] } : { ...stored, status: "done", text: TEXT };
      return Response.json(stored);
    }
    return Response.json({ sessions: [] });
  } });
  const root = createBrainUiRoot({ storage: null, ...(backendUrl ? { config: { backendUrl } } : { request: net.request }) });
  root.stores.connection.getState().setVpnStatus("connected", "odysseus");
  root.stores.connection.getState().setWsStatus("connected");
  const partitions = createLocalPartitions({ name: `odysseus-transcription-${crypto.randomUUID()}`, heldAccountKey: () => root.stores.connection.getState().accountKey });
  root.partitions = partitions;
  root.localWork = createLocalWork({ stores: root.stores, partitions, scope: "root:ithaca", onAccountSwitch() {}, tracks: () => [], watchTracks: () => () => {} });
  root.recordings = createRecordingStore({ root, partitions, heldAccountKey: () => root.stores.connection.getState().accountKey });
  const host = document.createElement("div"); host.style.cssText = "background:var(--bk-color-canvas);color:var(--bk-color-ink);height:800px"; document.body.append(host);
  const react = createRoot(host);
  const mount = () => flushSync(() => react.render(<BrainUiProvider root={root}><RecordingsTray /></BrainUiProvider>));
  const seed = async (unassigned = false, payload = bytes) => {
    await root.localWork!.restoring(); await root.localWork!.snapshotNow();
    if (unassigned) root.stores.connection.getState().setVpnStatus("unauthorized");
    const sink = root.recordings!.sink(); await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
    await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([payload]) }); await sink.end!("user");
    if (unassigned) root.stores.connection.getState().setVpnStatus("connected", "odysseus");
    return (await root.recordings!.list(unassigned ? "unassigned" : "account:odysseus"))[0]!;
  };
  ctx.onTestFinished(async () => { release?.(); flushSync(() => react.unmount()); host.remove(); root.dispose(); net.restore(); vi.restoreAllMocks(); });
  return { root, host, net, uploads, seed, mount, available: (v: boolean) => { available = v; }, drop: (v: boolean) => { drop = v; }, hold: () => { hold = true; }, fail: (v: boolean) => { fail = v; }, reject: () => { reject = true; }, release: () => release?.() };
}
async function expand(c: ReturnType<typeof fixture>) { await expect.poll(() => c.host.querySelector("[data-recordings-tray] button")).toBeTruthy(); await tap(c.host.querySelector("[data-recordings-tray] button")!); }
async function confirm(c: ReturnType<typeof fixture>, retry = false) {
  await expect.poll(() => button(c.host, retry ? "Retry transcription" : "Transcribe recording")).toBeTruthy();
  await tap(button(c.host, retry ? "Retry transcription" : "Transcribe recording"));
  expect(c.host.textContent).toContain("to your server for transcription? Your server sends it to Deepgram.");
}
for (const theme of ["dark", "light"]) for (const width of [320, 1280]) test(`consent, progress, durable review and account boundary at ${width}px ${theme}`, async ctx => {
  await commands.formViewport(width, 900); await page.viewport(width, 900); document.documentElement.dataset.theme = theme;
  const c = fixture(ctx); const row = await c.seed(); c.mount(); await expand(c); await confirm(c);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(c.net.requests.filter(r => r.method === "PUT"), "no HTTP upload before consent").toHaveLength(0);
  expect(c.uploads, "no audio request before explicit upload consent").toHaveLength(0);
  await tap(button(c.host, "Cancel")); expect(c.uploads).toHaveLength(0);
  c.net.drop(); c.root.stores.connection.getState().setWsStatus("disconnected"); c.net.recover(); c.root.stores.connection.getState().setWsStatus("connected");
  await confirm(c); await new Promise(resolve => setTimeout(resolve, 100));
  expect(c.net.requests.filter(r => r.method === "PUT"), "reconnect carries no audio").toHaveLength(0);
  expect(c.uploads, "reconnect never uploads audio").toHaveLength(0);
  c.hold(); await tap(button(c.host, "Upload and transcribe"));
  await expect.poll(() => c.host.textContent).toContain("Transcribing…");
  expect(c.uploads).toHaveLength(1); expect(new Uint8Array(await c.uploads[0]!.arrayBuffer())).toEqual(bytes);
  expect(c.host.querySelector("textarea"), "not ready before durable completion").toBeNull();
  c.release(); await expect.poll(() => c.host.querySelector("textarea")?.value).toBe(TEXT);
  expect((await c.root.recordings!.get(row.partition, row.id))!.transcript, "saved locally before review").toBe(TEXT);
  expect((await c.root.recordings!.get(row.partition, row.id))!.bytes).toBe(bytes.length);
  const violations = (await axe.run(c.host, { rules: { region: { enabled: false } } })).violations;
  expect(violations.map(v => v.id)).toEqual([]);
  flushSync(() => c.root.stores.connection.getState().setVpnStatus("connected", "telemachus"));
  expect(c.host.textContent, "another account never reads the transcript").not.toContain(TEXT);
  await expect(c.root.recordings!.transcribe(row.partition, row.id, () => {})).rejects.toThrow();
  expect(c.uploads).toHaveLength(1);
});

test("disconnect at forty percent retains identical bytes/hash and requires fresh confirmation", async ctx => {
  const c = fixture(ctx); const row = await c.seed(); c.mount(); await expand(c); await confirm(c); c.drop(true);
  await tap(button(c.host, "Upload and transcribe"));
  await expect.poll(() => c.host.textContent).toContain("Not sent — tap Transcribe again");
  const after = await c.root.recordings!.get(row.partition, row.id); expect(after!.bytes).toBe(row.bytes); expect(after!.contentHash).toBe(row.contentHash);
  expect(new Uint8Array(await c.uploads[0]!.arrayBuffer())).toEqual(bytes);
  c.drop(false); c.root.stores.connection.getState().setWsStatus("disconnected"); c.root.stores.connection.getState().setWsStatus("connected");
  await confirm(c); expect(c.uploads, "reconnection still waits for consent").toHaveLength(1);
  await tap(button(c.host, "Upload and transcribe")); await expect.poll(() => c.host.querySelector("textarea")?.value).toBe(TEXT);
});

test("provider failure retains audio, retry asks consent and exhausted retries stop", async ctx => {
  const c = fixture(ctx); const row = await c.seed(); c.fail(true); c.mount(); await expand(c); await confirm(c);
  await tap(button(c.host, "Upload and transcribe")); await expect.poll(() => c.host.textContent).toContain("Transcription failed (rate_limit)");
  for (let n = 1; n <= 3; n++) {
    await confirm(c, true); expect(c.uploads).toHaveLength(n);
    await tap(button(c.host, "Upload and transcribe")); await expect.poll(async () => (await c.root.recordings!.get(row.partition, row.id))!.transcription!.retryCount).toBe(n);
  }
  await expect.poll(() => c.host.textContent).toContain("All three retries have been used"); expect(button(c.host, "Retry transcription")).toBeUndefined();
  expect((await c.root.recordings!.get(row.partition, row.id))!.bytes).toBe(bytes.length);
});

test("failed local transcript commit never exposes ready text or deletes audio", async ctx => {
  const c = fixture(ctx); const row = await c.seed(); c.hold(); c.mount(); await expand(c); await confirm(c); await tap(button(c.host, "Upload and transcribe"));
  await expect.poll(() => c.host.textContent).toContain("Transcribing…");
  const fault = failIndexedDbWrites({ next: true }); ctx.onTestFinished(() => fault.restore()); c.release();
  await expect.poll(() => fault.failures).toBeGreaterThan(0);
  expect(c.host.querySelector("textarea")).toBeNull(); expect((await c.root.recordings!.get(row.partition, row.id))!.bytes).toBe(bytes.length);
});

for (const unassigned of [false, true]) test(`absent capability or unassigned audio cannot upload (${unassigned})`, async ctx => {
  const c = fixture(ctx); c.available(false); await c.seed(unassigned); c.mount(); await expand(c);
  await expect.poll(() => c.host.textContent).toContain(unassigned ? "Add to my account…" : SAVED_AUDIO_UNAVAILABLE);
  expect(button(c.host, "Transcribe recording")).toBeUndefined(); expect(c.uploads).toHaveLength(0);
  if (unassigned) await expect(c.root.recordings!.transcribe("unassigned", (await c.root.recordings!.list("unassigned"))[0]!.id, () => {})).rejects.toThrow("Sign in");
});

test("real two tabs upload once and a whole-page reload only queries status", async ctx => {
  const first = await openScene(new URL("./offline/scenes/transcription.scene.tsx", import.meta.url)); ctx.onTestFinished(() => first.close());
  const id = await first.call<string>("seed"); const second = await first.sibling(); ctx.onTestFinished(() => second.close());
  await Promise.all([first.call("prepare", id), second.call("prepare", id)]);
  await Promise.all([first.call("upload"), second.call("upload")]);
  await expect.poll(() => first.call<number>("uploadLockCount", id), { message: "the native recording-id Web Lock is held" }).toBe(1);
  await expect.poll(() => first.call<number>("uploads")).toBe(1);
  const owner = await first.call<boolean>("ownsUpload") ? first : second;
  await owner.reload();
  await expect.poll(() => owner.call<number>("statusQueries")).toBeGreaterThan(0);
  expect(await first.call("uploads")).toBe(1); expect(await second.call("uploads")).toBe(1);
});

for (const drop of [false, true]) test(`real XHR upload ${drop ? "drops at forty percent" : "completes with progress"}`, async ctx => {
  const server = await commands.transcriptionHttp({ op: "start", drop }) as { id: string; url: string };
  ctx.onTestFinished(async () => { await commands.transcriptionHttp({ op: "close", id: server.id }); });
  const c = fixture(ctx, server.url);
  const payload = new Uint8Array(1_000_000); payload.fill(23);
  const row = await c.seed(false, payload); c.mount(); await expand(c); await confirm(c);
  expect((await commands.transcriptionHttp({ op: "stats", id: server.id }) as { uploads: number }).uploads, "real HTTP receives no audio before consent").toBe(0);
  await tap(button(c.host, "Upload and transcribe"));
  await expect.poll(() => c.host.textContent, { timeout: 10000 }).toMatch(/Uploading… (?!0%)[0-9]+%/);
  await expect.poll(() => c.host.textContent, { timeout: 10000 }).toContain(drop ? "Not sent — tap Transcribe again" : TEXT);
  const stats = await commands.transcriptionHttp({ op: "stats", id: server.id }) as { uploads: number; bytes: number; progress: number[] };
  expect(stats.uploads).toBe(1);
  if (drop) { expect(stats.progress.at(-1)).toBeGreaterThanOrEqual(40); expect(stats.progress.at(-1)).toBeLessThan(50); }
  const after = await c.root.recordings!.get(row.partition, row.id);
  expect(after!.bytes).toBe(payload.byteLength); expect(after!.contentHash).toBe(row.contentHash);
  const audio = await c.root.recordings!.playback(row.partition, row.id);
  try { expect(new Uint8Array(await (await fetch(audio.url)).arrayBuffer()), "retained bytes unchanged").toEqual(payload); } finally { audio.revoke(); }
}, 30000);


test("a definitive upload rejection restores playback and discard with unchanged audio", async ctx => {
  const c = fixture(ctx); const row = await c.seed(); c.reject(); c.mount(); await expand(c); await confirm(c);
  await tap(button(c.host, "Upload and transcribe"));
  await expect.poll(() => c.host.textContent).toContain("The recording exceeds the upload byte budget.");
  await expect.poll(() => button(c.host, "Play recording")?.getAttribute("aria-disabled"), { message: "definitive rejection restores playback" }).not.toBe("true");
  const play = button(c.host, "Play recording"), discard = button(c.host, "Discard recording");
  expect(play, "playback is present after rejection").toBeTruthy(); expect(play.getAttribute("aria-disabled"), "playback is enabled after rejection").not.toBe("true");
  expect(discard, "discard is present after rejection").toBeTruthy(); expect(discard.getAttribute("aria-disabled"), "discard is enabled after rejection").not.toBe("true");
  await tap(play); await expect.poll(() => c.host.querySelector("audio")).toBeTruthy();
  await tap(discard); await expect.poll(() => button(c.host, "Delete recording")).toBeTruthy();
  const after = await c.root.recordings!.get(row.partition, row.id); expect(after!.bytes).toBe(row.bytes); expect(after!.contentHash).toBe(row.contentHash); expect(c.uploads).toHaveLength(1);
});


for (const stage of ["prepared", "dispatch"] as const) test(`authentication loss after native IndexedDB ${stage} commit recovers without upload`, async ctx => {
  const c = fixture(ctx), row = await c.seed(); const partitions = c.root.partitions!;
  const realOpen = partitions.open.bind(partitions); let interrupted = false;
  vi.spyOn(partitions, "open").mockImplementation(partition => {
    const handle = realOpen(partition);
    return { ...handle, async put(key, value) {
      await handle.put(key, value);
      const index = value as { state?: string; transcribeRequestId?: string };
      if (!interrupted && key === `recording:index:${row.id}` && index.state === "transcribing" && index.transcribeRequestId?.startsWith("pending:") === (stage === "prepared")) {
        interrupted = true; c.root.stores.connection.getState().setVpnStatus("unauthorized");
      }
    } };
  });
  c.mount(); await expand(c); await confirm(c); await tap(button(c.host, "Upload and transcribe"));
  await expect.poll(() => interrupted).toBe(true);
  await expect.poll(async () => (await navigator.locks.query()).held?.some(lock => lock.name === `brain-ui:transcription:${row.id}`), { message: "the interrupted attempt settles before sign-in" }).toBe(false);
  expect(c.uploads).toHaveLength(0);
  if (stage === "prepared") {
    c.root.recordings!.dispose();
    c.root.recordings = createRecordingStore({ root: c.root, partitions, heldAccountKey: () => c.root.stores.connection.getState().accountKey });
  }
  c.root.stores.connection.getState().setVpnStatus("connected", "odysseus");
  await c.root.recordings!.syncTranscriptions();
  await expect.poll(async () => (await c.root.recordings!.get(row.partition, row.id))!.state, { timeout: 5000, message: "native committed cancellation recovers after reauthentication" }).toBe("failed");
  const after = (await c.root.recordings!.get(row.partition, row.id))!;
  expect(after.bytes).toBe(row.bytes); expect(after.contentHash).toBe(row.contentHash); expect(c.uploads).toHaveLength(0);
});
