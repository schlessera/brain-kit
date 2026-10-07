/// <reference types="@vitest/browser-playwright" />
import { beforeAll, afterAll, expect, test, vi, type TestContext } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import axe from "axe-core";
import { createBrainUiRoot } from "../../src/root.js";
import { createLocalPartitions } from "../../src/lib/local-partitions.js";
import { createLocalWork } from "../../src/lib/local-work.js";
import { createRecordingStore, type Recording } from "../../src/lib/recordings.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { RecordingsTray, ACCEPT_FAILED, SAVED_AUDIO_UNAVAILABLE } from "../../src/components/voice/recordings-tray.js";
import { LocalRecordingSheet } from "../../src/components/voice/local-recording-sheet.js";
import { failIndexedDbWrites, holdIndexedDbWrite } from "./offline/indexeddb-faults.ts";
import { installFaultNetwork } from "./offline/fault-network.ts";
import { installWavMicrophone } from "./offline/fake-microphone.ts";
import { generateWav, AUDIO_FIXTURES } from "./offline/audio-fixtures.ts";

const TEXT = "Ask Penelope whether the loom order arrived.";
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
async function settled() {
  await expect.poll(() => document.getAnimations().some(a => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity), { message: "entrances settled" }).toBe(false);
  await wait(50);
}
function fixture(ctx: TestContext) {
  const net = installFaultNetwork({ routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : Response.json({}) });
  const root = createBrainUiRoot({ storage: null, request: net.request });
  root.stores.connection.getState().setVpnStatus("connected", "odysseus");
  const partitions = createLocalPartitions({ name: `odysseus-tray-${crypto.randomUUID()}`, heldAccountKey: () => root.stores.connection.getState().accountKey });
  root.partitions = partitions;
  root.localWork = createLocalWork({ stores: root.stores, partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
  root.recordings = createRecordingStore({ root, partitions, heldAccountKey: () => root.stores.connection.getState().accountKey });
  root.localCapture = { durable: true, sink: () => root.recordings!.sink() };
  const host = document.createElement("div");
  host.style.cssText = "height:800px;display:flex;flex-direction:column;overflow:hidden;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  const react = createRoot(host);
  const field = document.createElement("div");
  field.innerHTML = "<textarea data-composer aria-label=Draft></textarea>";
  const ref = { current: field };
  const renderTray = () => { flushSync(() => react.render(<BrainUiProvider root={root}><RecordingsTray composerRef={ref} /></BrainUiProvider>)); host.append(field); };
  const mountChat = () => flushSync(() => react.render(<BrainUiProvider root={root}><ChatPage /></BrainUiProvider>));
  ctx.onTestFinished(async () => { flushSync(() => react.unmount()); host.remove(); await root.recordings!.stop("interrupted"); root.dispose(); net.restore(); vi.restoreAllMocks(); });
  const ready = async () => { await root.localWork!.restoring(); await root.localWork!.snapshotNow(); };
  const seed = async (state: Recording["state"] = "transcript-ready", transcript = TEXT) => {
    const sink = root.recordings!.sink();
    const previous = new Set((await root.recordings!.list("account:odysseus")).map(r => r.id));
    const clock = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-12T09:12:00").getTime());
    await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
    clock.mockRestore();
    await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array(generateWav(AUDIO_FIXTURES.note10s))], { type: "audio/wav" }) });
    await sink.end!(state === "interrupted" ? "interrupted" : "user");
    const row = (await root.recordings!.list("account:odysseus")).find(r => !previous.has(r.id))!;
    const { partition: _, ...index } = row;
    await partitions.open(row.partition).put(`recording:index:${row.id}`, { ...index, state, transcript, mime: "audio/wav", createdAt: new Date("2026-07-12T09:12:00").getTime() });
    if (state === "transcript-ready") await root.recordings!.saveTranscript(row.partition, row.id, transcript);
    return { ...row, state, transcript, mime: "audio/wav" };
  };
  return { root, partitions, host, react, net, ref, ready, seed, renderTray, mountChat };
}
async function tap(el: Element) {
  if (matchMedia("(any-pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches) {
    const rect = el.getBoundingClientRect();
    await commands.rankTap({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  } else await userEvent.click(el);
}
function button(host: HTMLElement, name: string) { return [...host.querySelectorAll<HTMLElement>("button,[role=button]")].find(el => (el.getAttribute("aria-label") ?? el.textContent ?? "").includes(name))!; }
async function expand(c: ReturnType<typeof fixture>) { await expect.poll(() => c.host.querySelector("[data-recordings-tray] button")).toBeTruthy(); await settled(); if (c.host.querySelector("[data-recordings-tray] button")!.getAttribute("aria-expanded") !== "true") await tap(c.host.querySelector("[data-recordings-tray] button")!); await settled(); }

for (const theme of ["dark", "light"]) for (const width of [320, 390, 900, 1280]) {
  test(`tray anchors messages, isolates accounts, keeps actions local and accessible at ${width}px ${theme}`, async ctx => {
    await commands.formViewport(width, 900);
    document.documentElement.dataset.theme = theme;
    const c = fixture(ctx);
    await c.ready();
    const chat = c.root.stores.chat.getState();
    chat.setActiveSession("ithaca");
    for (let i = 0; i < 24; i++) chat.addUserMessage("ithaca", `The fleet is crossing the harbour. Voyage note ${i}.`);
    c.mountChat(); await settled();
    const scroll = c.host.querySelector<HTMLElement>("[data-transcript-anchor]")!.parentElement!;
    const scroller = scroll.parentElement!;
    scroller.scrollTop = 220;
    scroller.dispatchEvent(new Event("scroll")); await wait(50);
    const anchor = [...c.host.querySelectorAll<HTMLElement>("[data-transcript-anchor]")].find(el => el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top)!;
    const top = anchor.getBoundingClientRect().top;
    const requestsBefore = c.net.requests.length; const framesBefore = c.net.frames.length;
    const row = await c.seed("interrupted");
    await expect.poll(() => c.host.querySelector("[data-recordings-tray]")).toBeTruthy();
    await settled();
    expect(Math.abs(anchor.getBoundingClientRect().top - top), "tray appearance preserves first visible message").toBeLessThanOrEqual(1);
    await expand(c);
    expect(Math.abs(anchor.getBoundingClientRect().top - top), "tray expansion preserves first visible message").toBeLessThanOrEqual(1);
    expect(c.host.textContent).toContain("interrupted"); expect(c.host.textContent).toContain("saved up to 0:01 — the end may be missing");
    expect(c.host.textContent).toContain("Kept in this browser. Not protected from someone who can use this device.");
    flushSync(() => c.root.stores.connection.getState().setWsStatus("disconnected"));
    expect(c.host.textContent).toContain("needs the host");
    flushSync(() => c.root.stores.connection.getState().setWsStatus("connected")); await settled();
    expect(c.host.textContent).toContain(SAVED_AUDIO_UNAVAILABLE);
    expect([...c.host.querySelectorAll("button,[role=button]")].some(el => el.textContent?.includes("Transcribe")), "no actionable saved-audio transcription").toBe(false);
    await tap(button(c.host, "Play recording"));
    await expect.poll(() => c.host.querySelector("audio")?.getAttribute("src")).toMatch(/^blob:/);
    await tap(button(c.host, "Discard recording")); await settled();
    expect(document.activeElement?.textContent).toBe("Keep");
    expect(c.host.textContent).toContain("Delete the recording and its transcript from this device?");
    const violations = (await axe.run(c.host.querySelector<HTMLElement>("[data-recordings-tray]")!, { rules: { region: { enabled: false } } })).violations;
    expect(violations.map(v => [v.id, v.nodes.map(n => n.failureSummary)]), "tray axe violations").toEqual([]);
    for (const el of c.host.querySelectorAll<HTMLElement>("[data-recordings-tray] button,[data-recordings-tray] [role=button]")) {
      const rect = el.getBoundingClientRect(); expect(rect.height, "44px control height").toBeGreaterThanOrEqual(44); expect(rect.width).toBeGreaterThanOrEqual(44);
    }
    await tap(button(c.host, "Delete recording"));
    await expect.poll(() => c.host.querySelector("[data-recordings-tray]")).toBeNull();
    await expect.poll(() => document.activeElement?.matches("textarea[data-composer]")).toBe(true);
    expect(c.net.requests.slice(requestsBefore), "local actions send no HTTP requests").toEqual([]); expect(c.net.frames.slice(framesBefore), "local actions send no socket frames").toEqual([]);
    expect(await c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
    const a = await c.seed();
    await expect.poll(() => c.host.querySelector("[data-recordings-tray]")).toBeTruthy();
    flushSync(() => c.root.stores.connection.getState().setVpnStatus("unauthorized"));
    expect(c.host.querySelector("[data-recordings-tray]"), "auth loss hides stale inventory synchronously").toBeNull();
    flushSync(() => c.root.stores.connection.getState().setVpnStatus("connected", "penelope"));
    await settled(); expect(c.host.textContent).not.toContain(TEXT); expect(c.host.querySelector("[data-recordings-tray]")).toBeNull();
    await expect(c.root.recordings!.get(a.partition, a.id)).rejects.toThrow("does not hold");
  });
}

test("draft commit stays ahead of audio deletion; failure keeps audio and retry never duplicates text", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const drafts = c.root.stores.drafts.getState(); const id = drafts.idFor(null);
  drafts.edit(id, null, { text: "Odysseus checks the harbour." }); await c.root.localWork!.snapshotNow();
  c.renderTray(); await expand(c);
  const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).includes("/draft/")); ctx.onTestFinished(() => hold.restore());
  const deletes = vi.spyOn(IDBObjectStore.prototype, "delete");
  const accepts = vi.spyOn(IDBObjectStore.prototype, "put");
  await tap(button(c.host, "Add transcript")); await hold.started;
  // A separate readonly transaction queues behind the held writer. Observe
  // the writer itself: no audio delete and no accepted index before commit.
  expect(deletes.mock.calls.filter(([key]) => Array.isArray(key) && String(key[1]).startsWith("recording:")), "audio exists while draft transaction is open").toEqual([]);
  expect(accepts.mock.calls.some(([v]) => (v as Recording)?.state === "accepted"), "no accepted marker before draft commit").toBe(false);
  const recordInside = c.partitions.open(row.partition).get(`recording:index:${row.id}`);
  hold.release(); await expect(recordInside).resolves.toMatchObject({ id: row.id, transcript: TEXT });
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  expect(c.root.stores.drafts.getState().drafts[id]?.text).toBe(`Odysseus checks the harbour.\n${TEXT}`);
  expect((await c.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string }).text).toBe(`Odysseus checks the harbour.\n${TEXT}`);
  expect(c.host.textContent).toContain("Added to your draft. The recording was deleted from this device.");
  hold.restore(); deletes.mockRestore(); accepts.mockRestore();
  const failed = await c.seed(); await expand(c);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.host.textContent).toContain(ACCEPT_FAILED);
  expect(fault.failures).toBeGreaterThan(0);
  expect(await c.root.recordings!.get(failed.partition, failed.id)).toMatchObject({ state: "transcript-ready", transcript: TEXT });
  expect((await c.partitions.open(failed.partition).list(`recording:chunk:${failed.id}:`)).length, "audio survives failed draft write").toBeGreaterThan(0);
  fault.restore();
  await tap(button(c.host, "Add transcript"));
  await expect.poll(async () => c.root.recordings!.get(failed.partition, failed.id)).toBeUndefined();
  expect(c.root.stores.drafts.getState().drafts[id]?.text?.split(TEXT)).toHaveLength(3); // exactly two distinct recordings
});

test("acceptance receipt prevents duplicate append after accepted-index failure and a new root", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const id = c.root.stores.drafts.getState().idFor(null);
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
    if ((value as Recording)?.state === "accepted") throw new DOMException("Full", "QuotaExceededError");
    return original.call(this, value, key);
  });
  await expect(c.root.recordings!.accept(row.partition, row.id, id, null)).rejects.toThrow("Full");
  spy.mockRestore();
  expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ transcript: TEXT });
  c.root.localWork!.dispose(); c.root.stores.drafts.setState({ drafts: {} });
  c.root.localWork = createLocalWork({ stores: c.root.stores, partitions: c.partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
  await c.root.localWork.restoring();
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  expect(c.root.stores.drafts.getState().drafts[id]?.text, "receipt prevents replay append").toBe(TEXT);
  expect(await c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
});

test("editing a transcript commits input; unaccepted transcript holds updates when tray unmounts", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); c.renderTray(); await expand(c);
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea:not([data-composer])")!;
  await userEvent.fill(field, "Penelope confirms the loom order.");
  await expect.poll(async () => (await c.root.recordings!.get(row.partition, row.id))?.transcript).toBe("Penelope confirms the loom order.");
  const { updateHeld } = await import("../../src/lib/update-holds.js");
  flushSync(() => c.react.render(null));
  expect(updateHeld(c.root), "unaccepted transcript keeps a root reload held without Chat").toBe(true);
});

test("local sheet has honest copy, a silent timer and Keep focus; Stop calls its local handler", async ctx => {
  const c = fixture(ctx); await c.ready();
  c.host.style.cssText += ";position:relative;overflow:visible;margin-top:500px;height:0";
  c.root.stores.voice.getState().setLocal("recording");
  let stopped = 0;
  flushSync(() => c.react.render(<BrainUiProvider root={c.root}><LocalRecordingSheet open onStop={async () => { stopped++; }} onDiscard={async () => {}} /></BrainUiProvider>));
  await settled();
  expect(c.host.textContent).toContain("Recording on this device"); expect(c.host.textContent).toContain("Stays on this device. Nothing is uploaded until you tap Transcribe.");
  expect(c.host.textContent).toContain("left");
  expect((await axe.run(c.host, { rules: { region: { enabled: false } } })).violations.map(v => v.id)).toEqual([]);
  const status = c.host.querySelector("[role=status]")!.textContent;
  await wait(1100); expect(c.host.querySelector("[role=status]")!.textContent, "timer never changes live text").toBe(status);
  await tap(button(c.host, "Discard")); await settled();
  expect(c.host.textContent).toContain("Discard this recording? This can\u0027t be undone."); expect(document.activeElement?.textContent).toBe("Keep recording");
  await tap(button(c.host, "Keep recording")); await tap(button(c.host, "Stop and save")); expect(stopped).toBe(1);
});


test("real local capture sheet Stop restores mic focus and Discard keeps its explicit confirm", async ctx => {
  await commands.formViewport(390, 900);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s)); ctx.onTestFinished(() => mic.restore());
  const c = fixture(ctx); await c.ready(); c.net.drop(); c.mountChat(); await settled();
  await expect.poll(() => button(c.host, "Record on this device")).toBeTruthy();
  await tap(button(c.host, "Record on this device"));
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy();
  await expect.poll(() => c.root.stores.voice.getState().audioLevel, { message: "real microphone level reaches the sheet" }).toBeGreaterThan(0);
  await wait(1100); await settled();
  await tap(button(c.host, "Stop and save"));
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeNull();
  await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "Stop returns focus to mic" }).toBe("Record on this device");
  expect((await c.root.recordings!.list("account:odysseus"))).toHaveLength(1);
  await tap(button(c.host, "Record on this device")); await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy();
  await wait(1100); await settled();
  await tap(button(c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!, "Discard"));
  await expect.poll(() => document.activeElement?.textContent).toBe("Keep recording");
  await tap(button(c.host, "Discard recording"));
  await expect.poll(() => c.root.stores.voice.getState().local).toBe("idle");
  await expect.poll(async () => (await c.root.recordings!.list("account:odysseus")).length, { message: "discard only removes current capture" }).toBe(1);
});


test("accept focuses the composer at the end without sending or answering a tool approval", async ctx => {
  await commands.formViewport(390, 900);
  const c = fixture(ctx); await c.ready(); c.net.drop();
  const drafts = c.root.stores.drafts.getState(); const id = drafts.idFor(null);
  drafts.edit(id, null, { text: "Check the harbour." }); await c.root.localWork!.snapshotNow();
  const row = await c.seed(); c.mountChat(); await expand(c);
  const requests = c.net.requests.length, frames = c.net.frames.length;
  await tap(button(c.host, "Add transcript"));
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  await expect.poll(() => document.activeElement, { message: "accept focuses editable composer" }).toBe(field);
  expect(field.value, "accepted text remains an unsent draft").toBe(`Check the harbour.\n${TEXT}`);
  expect(field.selectionStart, "caret follows accepted text").toBe(field.value.length);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(c.net.requests.slice(requests), "accept sends no HTTP").toEqual([]);
  expect(c.net.frames.slice(frames), "accept sends no socket action or approval").toEqual([]);
});

test("retry after deleting the uncommitted append saves the transcript again before audio deletion", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const drafts = c.root.stores.drafts.getState(), id = drafts.idFor(null);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await expect(c.root.recordings!.accept(row.partition, row.id, id, null)).rejects.toThrow();
  drafts.edit(id, null, { text: "Review the fleet." });
  fault.restore();
  await c.root.localWork!.snapshotNow();
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  expect((await c.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string }).text, "removed uncommitted text has no acceptance receipt").toBe(`Review the fleet.\n${TEXT}`);
});


test("discard focuses the next row or the header while another recording remains", async ctx => {
  const c = fixture(ctx); await c.ready(); const first = await c.seed("saved"); const second = await c.seed("saved"); const third = await c.seed("saved");
  c.renderTray(); await expand(c);
  const discard = async (id: string) => {
    const row = c.host.querySelector<HTMLElement>(`[data-recording-focus="${id}"]`)!;
    await tap(button(row, "Discard recording")); await settled(); await tap(button(row, "Delete recording"));
    await expect.poll(async () => c.root.recordings!.get("account:odysseus", id)).toBeUndefined();
  };
  await discard(first.id);
  await expect.poll(() => (document.activeElement as HTMLElement)?.dataset.recordingFocus, { message: "discard focuses the next row" }).toBe(second.id);
  await discard(third.id);
  await expect.poll(() => document.activeElement?.getAttribute("aria-expanded"), { message: "last row discard focuses tray header" }).toBe("true");
});
