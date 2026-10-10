/// <reference types="@vitest/browser-playwright" />
import { beforeAll, afterAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { StrictMode } from "react";
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
import { installWavMicrophone, watchMicrophone } from "./offline/fake-microphone.ts";
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
  const storageName = `odysseus-tray-${crypto.randomUUID()}`;
  const partitions = createLocalPartitions({ name: storageName, heldAccountKey: () => root.stores.connection.getState().accountKey });
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
  const renderTray = (strict = false) => { const view = <BrainUiProvider root={root}><RecordingsTray composerRef={ref} /></BrainUiProvider>; flushSync(() => react.render(strict ? <StrictMode>{view}</StrictMode> : view)); host.append(field); };
  const mountChat = () => flushSync(() => react.render(<BrainUiProvider root={root}><ChatPage /></BrainUiProvider>));
  ctx.onTestFinished(async () => { flushSync(() => react.unmount()); host.remove(); await root.recordings!.stop("interrupted"); root.dispose(); net.restore(); vi.restoreAllMocks(); });
  const ready = async () => { await root.localWork!.restoring(); await root.localWork!.snapshotNow(); };
  const seed = async (state: Recording["state"] = "transcript-ready", transcript = TEXT, timestamp = "2026-07-12T09:12:00") => {
    // Await mount-time recovery before asking the ifAvailable recorder lock.
    await navigator.locks.request("brain-ui:recording", async () => {});
    const sink = root.recordings!.sink();
    const previous = new Set((await root.recordings!.list("account:odysseus")).map(r => r.id));
    const clock = vi.spyOn(Date, "now").mockReturnValue(new Date(timestamp).getTime());
    await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
    clock.mockRestore();
    await sink.chunk({ index: 0, startMs: 0, endMs: 1000, data: new Blob([new Uint8Array(generateWav(AUDIO_FIXTURES.note10s))], { type: "audio/wav" }) });
    await sink.end!(state === "interrupted" ? "interrupted" : "user");
    const row = (await root.recordings!.list("account:odysseus")).find(r => !previous.has(r.id))!;
    const { partition: _, ...index } = row;
    await partitions.open(row.partition).put(`recording:index:${row.id}`, { ...index, state, transcript, mime: "audio/wav", createdAt: new Date(timestamp).getTime() });
    if (state === "transcript-ready") await root.recordings!.saveTranscript(row.partition, row.id, transcript);
    return { ...row, state, transcript, mime: "audio/wav" };
  };
  // Subscribe before the tap: a visible sheet acknowledges start, not audio.
  // MediaRecorder's requested one-second timeslice includes native dispatch
  // latency, so it must not race expect.poll's one-second storage assertion.
  // A premature stop also releases the wait so the saved-boundary assertion
  // below reports missing audio instead of proceeding to a focus assertion.
  const nextAudioCommit = () => new Promise<void>(resolve => {
    const off = root.recordings!.onEvent(event => {
      if (event.kind !== "committed" && event.kind !== "stopped") return;
      off(); resolve();
    });
    ctx.onTestFinished(off);
  });
  return { root, partitions, storageName, host, react, net, ref, ready, seed, renderTray, mountChat, nextAudioCommit };
}
async function tap(el: Element) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  await settled();
  if (matchMedia("(any-pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches) {
    const rect = el.getBoundingClientRect();
    await commands.rankTap({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  } else await userEvent.click(el);
}
function button(host: HTMLElement, name: string) { return [...host.querySelectorAll<HTMLElement>("button,[role=button]")].find(el => el.getClientRects().length > 0 && (el.getAttribute("aria-label") ?? el.textContent ?? "").includes(name))!; }
async function expand(c: ReturnType<typeof fixture>) { await expect.poll(() => c.host.querySelector("[data-recordings-tray] button")).toBeTruthy(); await settled(); if (c.host.querySelector("[data-recordings-tray] button")!.getAttribute("aria-expanded") !== "true") await tap(c.host.querySelector("[data-recordings-tray] button")!); await settled(); }

for (const theme of ["dark", "light"]) for (const width of [320, 390, 900, 1280]) {
  test(`tray anchors messages, isolates accounts, keeps actions local and accessible at ${width}px ${theme}`, async ctx => {
    await commands.formViewport(width, 900); await page.viewport(width, 900);
    expect(window.innerWidth, "actual browser cell width").toBe(width);
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
    const card = await c.seed("transcript-ready", TEXT, "2026-07-12T09:00:00");
    await expect.poll(() => c.host.querySelector("[data-recordings-tray]")).toBeTruthy();
    await settled();
    expect(Math.abs(anchor.getBoundingClientRect().top - top), "tray appearance preserves first visible message").toBeLessThanOrEqual(1);
    await expand(c);
    expect(Math.abs(anchor.getBoundingClientRect().top - top), "tray expansion preserves first visible message").toBeLessThanOrEqual(1);
    const trayBox = c.host.querySelector<HTMLElement>("[data-recordings-tray]")!.getBoundingClientRect();
    expect(trayBox.height, "expanded tray fits forty percent of viewport").toBeLessThanOrEqual(window.innerHeight * 0.4 + 1);
    expect(trayBox.width, "desktop tray stays within the 720px measure").toBeLessThanOrEqual(Math.min(window.innerWidth, 720) + 1);
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
    await tap(button(c.host, "Keep"));
    await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "Keep restores row Discard focus" }).toContain("Discard recording");
    await tap(button(c.host, "Discard recording")); await settled();
    await tap(button(c.host, "Delete recording"));
    await expect.poll(() => (document.activeElement as HTMLElement)?.dataset.recordingFocus).toBe(card.id);
    const cardNode = c.host.querySelector<HTMLElement>(`[data-recording-focus="${card.id}"]`)!;
    await tap(button(cardNode, "Discard recording")); await settled(); await tap(button(cardNode, "Delete recording"));
    await expect.poll(() => c.host.querySelector("[data-recordings-tray]")).toBeNull();
    await expect.poll(() => document.activeElement?.matches("textarea[data-composer]")).toBe(true);
    expect(c.net.requests.slice(requestsBefore).filter(r => !(r.method === "GET" && r.url.endsWith("/voice/capabilities"))), "local actions send no HTTP beyond read-only speech discovery").toEqual([]); expect(c.net.frames.slice(framesBefore), "local actions send no socket frames").toEqual([]);
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

for (const theme of ["dark", "light"]) for (const width of [320, 390, 900, 1280]) {
  test(`local sheet has honest copy, a silent timer and Keep focus; Stop calls its local handler at ${width}px ${theme}`, async ctx => {
  await commands.formViewport(width, 900); await page.viewport(width, 900);
  document.documentElement.dataset.theme = theme;
  expect(window.innerWidth, "actual sheet cell width").toBe(width);
  const c = fixture(ctx); await c.ready();
  c.host.style.cssText += ";position:relative;overflow:visible;margin-top:500px;height:0;max-width:720px;margin-inline:auto";
  c.root.stores.voice.getState().setLocal("recording");
  let stopped = 0;
  flushSync(() => c.react.render(<BrainUiProvider root={c.root}><LocalRecordingSheet open onStop={async () => { stopped++; }} onDiscard={async () => {}} /></BrainUiProvider>));
  await settled();
  expect(c.host.textContent).toContain("Recording on this device"); expect(c.host.textContent).toContain("Stays on this device. Nothing is uploaded until you tap Transcribe.");
  expect(c.host.textContent).toContain("left");
  expect((await axe.run(c.host, { rules: { region: { enabled: false } } })).violations.map(v => v.id)).toEqual([]);
  const box = c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!.getBoundingClientRect();
  expect(box.left, "sheet stays inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box.right, "sheet stays inside the viewport").toBeLessThanOrEqual(width);
  for (const control of c.host.querySelectorAll<HTMLElement>("button,[role=button]")) {
    expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  }
  const status = c.host.querySelector("[role=status]")!.textContent;
  await wait(1100); expect(c.host.querySelector("[role=status]")!.textContent, "timer never changes live text").toBe(status);
  await tap(button(c.host, "Discard")); await settled();
  expect(c.host.textContent).toContain("Discard this recording? This can\u0027t be undone."); expect(document.activeElement?.textContent).toBe("Keep recording");
  await tap(button(c.host, "Keep recording"));
  await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "Keep restores sheet Discard focus" }).toBe("Discard");
  await tap(button(c.host, "Stop and save")); expect(stopped).toBe(1);
});
}


for (const theme of ["dark", "light"]) for (const width of [320, 390, 900, 1280]) {
  test(`real local capture sheet Stop restores mic focus and Discard keeps its explicit confirm at ${width}px ${theme}`, async ctx => {
  await commands.formViewport(width, 900); await page.viewport(width, 900);
  document.documentElement.dataset.theme = theme;
  expect(window.innerWidth, "actual sheet cell width").toBe(width);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s)); ctx.onTestFinished(() => mic.restore());
  const c = fixture(ctx); await c.ready(); c.net.drop(); c.mountChat(); await settled();
  await expect.poll(() => button(c.host, "Record on this device"), { message: "the asynchronous microphone support probe exposes the local recording action" }).toBeTruthy();
  const audioCommitted = c.nextAudioCommit();
  await tap(button(c.host, "Record on this device"));
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy();
  await expect.poll(() => Number(c.host.querySelector('[role="meter"][aria-label="Microphone level"]')?.getAttribute("aria-valuenow")), { message: "recorded audio reaches the rendered meter" }).toBeGreaterThan(0);
  await expect.poll(() => c.host.querySelector<HTMLElement>('[role="meter"] > div')?.getBoundingClientRect().width ?? 0, { message: "microphone activity paints a nonzero bar" }).toBeGreaterThan(0);
  await audioCommitted; await settled();
  await tap(button(c.host, "Stop and save"));
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeNull();
  await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "Stop returns focus to mic" }).toBe("Record on this device");
  expect((await c.root.recordings!.list("account:odysseus"))).toHaveLength(1);
  await expect.poll(() => button(c.host, "Record on this device"), { message: "the asynchronous microphone support probe exposes the local recording action" }).toBeTruthy();
  const secondAudioCommitted = c.nextAudioCommit();
  await tap(button(c.host, "Record on this device")); await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy();
  await secondAudioCommitted; await settled();
  await tap(button(c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!, "Discard"));
  await expect.poll(() => document.activeElement?.textContent).toBe("Keep recording");
  await tap(button(c.host, "Discard recording"));
  await expect.poll(() => c.root.stores.voice.getState().local).toBe("idle");
  await expect.poll(async () => (await c.root.recordings!.list("account:odysseus")).length, { message: "discard only removes current capture" }).toBe(1);
});
}


test("accept focuses the composer at the end without sending or answering a tool approval", async ctx => {
  await commands.formViewport(390, 900); await page.viewport(390, 900);
  const c = fixture(ctx); await c.ready();
  const drafts = c.root.stores.drafts.getState(); const id = drafts.idFor(null);
  drafts.edit(id, null, { text: "Check the harbour." }); await c.root.localWork!.snapshotNow();
  const row = await c.seed();
  c.root.stores.chat.getState().startAssistantMessage(null);
  c.root.stores.chat.getState().requestToolApproval(null, "loom-approval", "write_file", { path: "notes/loom.md" }, "Keep the loom order", "tool");
  expect(c.root.stores.chat.getState().draft?.messages.flatMap(m => m.toolCalls ?? []).find(t => t.id === "loom-approval")?.status).toBe("pending_approval");
  c.mountChat(); await expand(c);
  await expect.poll(() => c.root.stores.connection.getState().wsStatus, { message: "acceptance has a live fixture transport to observe" }).toBe("connected");
  const requests = c.net.requests.length, frames = c.net.frames.length;
  await tap(button(c.host, "Add transcript"));
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  await expect.poll(() => document.activeElement, { message: "accept focuses editable composer" }).toBe(field);
  expect(field.value, "accepted text remains an unsent draft").toBe(`Check the harbour.\n${TEXT}`);
  expect(field.selectionStart, "caret follows accepted text").toBe(field.value.length);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(c.net.requests.slice(requests).filter(r => !(r.method === "GET" && r.url.endsWith("/voice/capabilities"))), "accept sends no HTTP beyond read-only speech discovery").toEqual([]);
  expect(c.net.frames.slice(frames), "accept sends no socket action or approval").toEqual([]);
  expect(c.root.stores.chat.getState().draft?.messages.flatMap(m => m.toolCalls ?? []).find(t => t.id === "loom-approval")?.status, "pending approval stays unanswered").toBe("pending_approval");
});

test("retry after deleting the uncommitted append saves the transcript again before audio deletion", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const drafts = c.root.stores.drafts.getState(), id = drafts.idFor(null);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await expect(c.root.recordings!.accept(row.partition, row.id, id, null)).rejects.toThrow();
  expect(c.root.stores.drafts.getState().drafts[id]?.text ?? "", "failed commit publishes no pending append").toBe("");
  drafts.edit(id, null, { text: "Review the fleet." });
  fault.restore();
  await c.root.localWork!.snapshotNow();
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  expect((await c.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string }).text, "removed uncommitted text has no acceptance receipt").toBe(`Review the fleet.\n${TEXT}`);
});


test("discard focuses the next row or the header while another recording remains", async ctx => {
  const c = fixture(ctx); await c.ready(); await c.seed("saved"); await c.seed("saved"); await c.seed("saved");
  c.renderTray(); await expand(c);
  const [first, second, third] = [...c.host.querySelectorAll<HTMLElement>("[data-recording-focus]")].map(el => ({ id: el.dataset.recordingFocus! }));
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


test("Strict Mode replay keeps Play usable and releases its busy state", async ctx => {
  const c = fixture(ctx); await c.ready(); await c.seed("saved"); c.renderTray(true); await expand(c);
  await tap(button(c.host, "Play recording"));
  await expect.poll(() => c.host.querySelector("audio")?.getAttribute("src"), { message: "Strict Mode Play produces a local audio player" }).toMatch(/^blob:/);
  await expect.poll(() => button(c.host, "Play recording")?.getAttribute("aria-disabled"), { message: "Strict Mode Play releases busy state" }).not.toBe("true");
});

test("a failed transcript input still allows local playback and confirmed discard", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); c.renderTray(); await expand(c);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await userEvent.fill(c.host.querySelector<HTMLTextAreaElement>("textarea:not([data-composer])")!, "Ask Penelope about the fleet.");
  await expect.poll(() => c.host.textContent).toContain("Couldn't save the transcript");
  await tap(button(c.host, "Play recording"));
  await expect.poll(() => c.host.querySelector("audio")?.getAttribute("src"), { message: "input write failure cannot disable playback" }).toMatch(/^blob:/);
  expect(c.host.querySelector("[role=alert]")?.textContent, "playback cannot hide the unsaved transcript warning").toBe("Couldn\u0027t save the transcript on this device. The recording is kept.");
  fault.restore();
  const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]) === `recording:index:${row.id}`); ctx.onTestFinished(() => hold.restore());
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")!;
  await expect.poll(() => field.disabled).toBe(false);
  await userEvent.fill(field, "Penelope confirms the fleet."); await hold.started;
  expect(c.host.querySelector("[role=alert]")?.textContent, "an input retry preserves its warning until the correction commits").toBe("Couldn\u0027t save the transcript on this device. The recording is kept.");
  hold.release();
  await expect.poll(() => c.host.querySelector("[role=alert]"), { message: "a committed correction clears its save warning" }).toBeNull();
  expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ transcript: "Penelope confirms the fleet.", chunkCount: 1 });
  hold.restore();
  await tap(button(c.host, "Discard recording")); await settled(); await tap(button(c.host, "Delete recording"));
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id), { message: "input write failure cannot disable explicit discard" }).toBeUndefined();
});

test("Add keeps its activation draft when a pending transcript edit delays acceptance", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  c.root.stores.chat.getState().setActiveSession("ithaca");
  const id = c.root.stores.drafts.getState().idFor("ithaca");
  c.renderTray(); await expand(c);
  const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).startsWith("recording:index:")); ctx.onTestFinished(() => hold.restore());
  await userEvent.fill(c.host.querySelector<HTMLTextAreaElement>("textarea:not([data-composer])")!, "Penelope confirms the fleet."); await hold.started;
  await tap(button(c.host, "Add transcript"));
  c.root.stores.chat.getState().setActiveSession("fleet");
  hold.release();
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  expect(c.root.stores.drafts.getState().drafts[id]?.text, "acceptance stays in the draft activated by the user").toBe("Penelope confirms the fleet.");
  expect(c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor("fleet")]?.text ?? "").toBe("");
});

test("editing the transcript after a failed draft write accepts the current text", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const id = c.root.stores.drafts.getState().idFor(null);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await expect(c.root.recordings!.accept(row.partition, row.id, id, null)).rejects.toThrow();
  fault.restore();
  await c.root.recordings!.saveTranscript(row.partition, row.id, "Penelope confirms the fleet.");
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  expect((await c.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string }).text, "current edited transcript precedes deletion").toBe("Penelope confirms the fleet.");
});


test("audio loss preserves a surviving transcript for editing and acceptance", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const h = c.partitions.open(row.partition);
  await h.write((await h.list(`recording:chunk:${row.id}:`)).map(r => ({ delete: r.key })));
  const recovered = await c.root.recordings!.recover(row.partition);
  expect(recovered.recordings, "audio recovery cannot erase surviving transcript").toMatchObject([{ transcript: TEXT, chunkCount: 0 }]);
  c.renderTray(); await expand(c);
  expect(c.host.textContent).toContain("Audio is no longer available on this device. Your transcript is kept.");
  expect(button(c.host, "Play recording").getAttribute("aria-disabled")).toBe("true");
  await userEvent.fill(c.host.querySelector<HTMLTextAreaElement>("textarea:not([data-composer])")!, "Penelope confirms the fleet.");
  await tap(button(c.host, "Add transcript"));
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  const id = c.root.stores.drafts.getState().idFor(null);
  expect((await h.get(`root:ithaca/draft/${id}`) as { text: string }).text).toBe("Penelope confirms the fleet.");
});

test("a failed acceptance in one root cannot flush a duplicate after another root accepts", async ctx => {
  const a = fixture(ctx), b = fixture(ctx); await a.ready(); await b.ready();
  b.root.recordings!.dispose(); b.root.localWork!.dispose();
  b.root.partitions = a.partitions;
  b.root.localWork = createLocalWork({ stores: b.root.stores, partitions: a.partitions, scope: "root:fleet", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
  b.root.recordings = createRecordingStore({ root: b.root, partitions: a.partitions, heldAccountKey: () => b.root.stores.connection.getState().accountKey });
  await b.root.localWork.restoring();
  const row = await a.seed(), idA = a.root.stores.drafts.getState().idFor(null), idB = b.root.stores.drafts.getState().idFor(null);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await expect(a.root.recordings!.accept(row.partition, row.id, idA, null)).rejects.toThrow(); fault.restore();
  await b.root.recordings.accept(row.partition, row.id, idB, null);
  await a.root.localWork!.snapshotNow();
  expect((await a.partitions.open(row.partition).get(`root:ithaca/draft/${idA}`) as { text: string } | undefined)?.text ?? "", "failed root never leaves a deferred duplicate append").toBe("");
  expect((await a.partitions.open(row.partition).get(`root:fleet/draft/${idB}`) as { text: string }).text).toBe(TEXT);
});

test("accepted metadata failure makes the committed transcript read-only until cleanup", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); const id = c.root.stores.drafts.getState().idFor(null);
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) { if ((value as Recording)?.state === "accepted") throw new DOMException("Full", "QuotaExceededError"); return original.call(this, value, key); });
  await expect(c.root.recordings!.accept(row.partition, row.id, id, null)).rejects.toThrow(); spy.mockRestore();
  expect(await c.root.recordings!.get(row.partition, row.id), "committed receipt makes review immutable").toMatchObject({ state: "accepted", transcript: TEXT });
  await expect(c.root.recordings!.saveTranscript(row.partition, row.id, "A different transcript")).rejects.toThrow("not available for review");
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  expect((await c.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string }).text).toBe(TEXT);
  expect(await c.partitions.open(row.partition).get(`recording:accepted:${row.id}`), "cleanup removes receipt as well as recording").toBeUndefined();
});

test("accept stays on this device even when host draft autosave is supported", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const drafts = c.root.stores.drafts.getState(); drafts.setSupport(true);
  c.root.stores.connection.getState().setWsStatus("connected");
  const id = drafts.idFor(null); const before = c.net.requests.length;
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  await wait(800);
  expect(c.net.requests.slice(before).filter(r => !(r.method === "GET" && r.url.endsWith("/voice/capabilities"))), "acceptance never schedules an automatic host draft upload").toEqual([]);
  drafts.edit(id, null, { text: `${TEXT} Bring the wax tablet.` });
  await expect.poll(() => c.net.requests.slice(before).filter(r => r.method !== "GET").length, { message: "a later user edit resumes ordinary host draft save" }).toBeGreaterThan(0);
});


test("local sheet renders the store's warning, limit and storage outcomes", async ctx => {
  const c = fixture(ctx); await c.ready(); c.host.style.cssText += ";position:relative;overflow:visible;margin-top:500px;height:0";
  const timers = new Map<number, () => void>(); const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof fn === "function" && (ms === 540000 || ms === 600000)) timers.set(ms, () => fn(...args));
    return original(fn, ms, ...args);
  }) as typeof setTimeout);
  const sink = c.root.recordings!.sink(); await sink.begin!({ mimeType: "audio/webm;codecs=opus" });
  const audio = new Blob([new Uint8Array(generateWav(AUDIO_FIXTURES.note10s))], { type: "audio/wav" });
  await sink.chunk({ index: 0, startMs: 0, endMs: 10000, data: audio });
  c.root.stores.voice.getState().setLocal("recording");
  flushSync(() => c.react.render(<BrainUiProvider root={c.root}><LocalRecordingSheet open onStop={async () => {}} onDiscard={async () => {}} /></BrainUiProvider>)); await settled();
  expect(timers.get(540000), "store supplies the nine-minute warning timer").toBeTypeOf("function");
  timers.get(540000)!();
  await expect.poll(() => c.host.querySelector("[role=status]")?.textContent, { message: "store warning reaches local sheet" }).toBe("1 minute left in this recording");
  timers.get(600000)!();
  await expect.poll(() => c.host.querySelector("[role=status]")?.textContent, { message: "store limit outcome reaches local sheet" }).toBe("Stopped at the 10-minute limit. Your recording is saved.");
  await navigator.locks.request("brain-ui:recording", async () => {});
  const next = c.root.recordings!.sink(); await next.begin!({ mimeType: "audio/webm;codecs=opus" });
  await next.chunk({ index: 0, startMs: 0, endMs: 10000, data: audio });
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await expect(next.chunk({ index: 1, startMs: 10000, endMs: 20000, data: audio })).rejects.toThrow();
  fault.restore(); await next.end!("storage");
  await expect.poll(() => c.host.querySelector("[role=status]")?.textContent, { message: "write failure reports only the committed prefix" }).toBe("Stopped: this device couldn't save more audio. Saved up to 0:10; the end may be missing.");
  const full = c.root.recordings!.sink(); await full.begin!({ mimeType: "audio/webm;codecs=opus" });
  await full.chunk({ index: 0, startMs: 0, endMs: 10000, data: audio });
  vi.spyOn(navigator.storage, "estimate").mockResolvedValue({ quota: 1, usage: 1 });
  await expect(full.chunk({ index: 1, startMs: 10000, endMs: 20000, data: audio })).rejects.toThrow("storage is full");
  await full.end!("storage");
  await expect.poll(() => c.host.querySelector("[role=status]")?.textContent, { message: "budget outcome reports committed audio" }).toBe("Stopped: storage for recordings is full. Saved up to 0:10.");
});


test("auth expiry at draft commit preserves the accepted transcript through same-account recovery", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); const id = c.root.stores.drafts.getState().idFor(null);
  const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).startsWith("root:ithaca/draft/"));
  ctx.onTestFinished(() => hold.restore());
  const accepting = c.root.recordings!.accept(row.partition, row.id, id, null).then(() => null, error => error);
  await hold.started;
  c.root.stores.connection.getState().setVpnStatus("unauthorized");
  hold.release();
  expect(await accepting, "expired auth refuses audio cleanup").toBeInstanceOf(Error); hold.restore();
  c.root.stores.connection.getState().setVpnStatus("connected", "odysseus");
  await c.root.localWork!.snapshotNow();
  expect((await c.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string } | undefined)?.text, "same-account snapshot cannot erase the committed acceptance").toBe(TEXT);
  expect(c.root.stores.drafts.getState().drafts[id]?.text, "committed transcript reaches its original live draft").toBe(TEXT);
  expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ state: "accepted", transcript: TEXT });
  await c.root.recordings!.accept(row.partition, row.id, id, null);
  expect(c.root.stores.drafts.getState().drafts[id]?.text, "cleanup retry never appends again").toBe(TEXT);
  expect(await c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
});


test("partial audio loss keeps the surviving transcript editable and acceptable", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); const h = c.partitions.open(row.partition);
  const index = await h.get(`recording:index:${row.id}`) as Recording;
  await h.put(`recording:index:${row.id}`, { ...index, chunkCount: 2, durationMs: 2000, savedThroughMs: 2000 });
  const recovered = await c.root.recordings!.recover(row.partition);
  expect(recovered.recordings.find(r => r.id === row.id), "partial loss preserves transcript reviewability").toMatchObject({ state: "transcript-ready", transcript: TEXT, chunkCount: 1, savedThroughMs: 1000 });
  c.renderTray(); await expand(c);
  expect(c.host.textContent).toContain("saved up to 0:01 — the end may be missing");
  expect(c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")?.disabled).toBe(false);
  await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor(null)]?.text).toBe(TEXT);
});

function externalStore(c: ReturnType<typeof fixture>, ctx: TestContext) {
  const store = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" });
  ctx.onTestFinished(() => store.dispose()); return store;
}

test("external transcript edits update a clean visible review", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); const other = externalStore(c, ctx);
  c.renderTray(); await expand(c);
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")!;
  expect(field.value, "the visible initial review is non-empty").toBe(TEXT);
  await other.saveTranscript(row.partition, row.id, "Penelope confirms the loom order.");
  await expect.poll(() => field.value, { message: "external stored revision reaches the clean editor" }).toBe("Penelope confirms the loom order.");
});

test("a transcript changed in another tab during Add cannot silently replace the reviewed text", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); const other = externalStore(c, ctx);
  c.renderTray(); await expand(c); const original = c.root.recordings!.accept;
  vi.spyOn(c.root.recordings!, "accept").mockImplementation(async (...args) => {
    await other.saveTranscript(row.partition, row.id, "Telemachus changed the route."); return original(...args);
  });
  await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent, { message: "changed revision requires another review" }).toBe("Transcript changed in another tab. Review it before adding it to your draft.");
  expect(c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor(null)]?.text ?? "", "unreviewed revision is never appended").toBe("");
  expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ state: "transcript-ready", chunkCount: 1 });
});

test("a stale Add cannot announce acceptance after another root discarded the recording", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); c.renderTray(); await expand(c);
  const original = c.partitions.open.bind(c.partitions);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(c.partitions, "open").mockImplementation(partition => {
    const handle = original(partition);
    return { ...handle, async list(prefix) { if (prefix === "recording:index:") { entered(); await waiting; } return handle.list(prefix); } };
  });
  ctx.onTestFinished(() => { release(); spy.mockRestore(); });
  const peer = createRecordingStore({ root: c.root, partitions: c.partitions, heldAccountKey: () => "odysseus" }); ctx.onTestFinished(() => peer.dispose());
  await peer.discard(row.partition, row.id); await started;
  expect(button(c.host, "Add transcript"), "the real row remains stale while its inventory refresh is held").toBeTruthy();
  await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent, { message: "a missing recording cannot report a committed draft append" }).toBe("This recording is no longer available on this device.");
  expect(c.host.querySelector("[data-recording-live]")?.textContent).not.toContain("Added to your draft");
  expect(Object.values(c.root.stores.drafts.getState().drafts).map(d => d.text).filter(Boolean)).toEqual([]);
  release();
});

test("a committed acceptance with failed cleanup renders a read-only review", async ctx => {
  const c = fixture(ctx); await c.ready(); await c.seed(); c.renderTray(); await expand(c);
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) { if ((value as Recording)?.state === "accepted") throw new DOMException("Full", "QuotaExceededError"); return original.call(this, value, key); });
  await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent).toBe(ACCEPT_FAILED);
  await expect.poll(() => c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")?.disabled, { message: "durable acceptance makes the rendered review read-only" }).toBe(true);
  spy.mockRestore(); await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.host.querySelector("[data-recording-row]")).toBeNull();
});

for (const reason of ["limit", "storage", "interrupted"] as const) {
  test(`confirmed capture discard deletes its recording while an automatic ${reason} stop commits`, async ctx => {
    await commands.formViewport(390, 900); await page.viewport(390, 900);
    const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s)); ctx.onTestFinished(() => mic.restore());
    const c = fixture(ctx); await c.ready(); c.net.drop(); c.mountChat(); await settled();
    await expect.poll(() => button(c.host, "Record on this device"), { message: "the asynchronous microphone support probe exposes the local recording action" }).toBeTruthy();
    const audioCommitted = c.nextAudioCommit();
    await tap(button(c.host, "Record on this device"));
    await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy();
    await audioCommitted;
    await expect.poll(async () => (await c.root.recordings!.list("account:odysseus"))[0]?.savedThroughMs ?? 0, { message: "a real audio chunk commits before the automatic-stop race" }).toBeGreaterThanOrEqual(1000);
    const row = (await c.root.recordings!.list("account:odysseus"))[0]!;
    await tap(button(c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!, "Discard"));
    await expect.poll(() => document.activeElement?.textContent).toBe("Keep recording");
    const hold = holdIndexedDbWrite((key, value) => Array.isArray(key) && String(key[1]) === `recording:index:${row.id}` && (typeof value === "object" && value !== null && ["saved", "interrupted"].includes((value as { state: string }).state)));
    ctx.onTestFinished(() => hold.restore());
    // Hold only completion delivery after the real durable discard. Storage
    // absence alone cannot establish that the async UI handler has announced it.
    const discard = c.root.recordings!.discard.bind(c.root.recordings);
    let releaseNotice!: () => void;
    const noticeGate = new Promise<void>(resolve => { releaseNotice = resolve; });
    let deletionFinished!: () => void;
    const deleted = new Promise<void>(resolve => { deletionFinished = resolve; });
    vi.spyOn(c.root.recordings!, "discard").mockImplementation(async (partition, id) => {
      await discard(partition, id);
      deletionFinished();
      await noticeGate;
    });
    ctx.onTestFinished(() => releaseNotice());
    const automatic = c.root.recordings!.stop(reason);
    await hold.started;
    await tap(button(c.host, "Discard recording"));
    hold.release(); await automatic;
    await expect.poll(async () => c.root.recordings!.get(row.partition, row.id), { message: "confirmed discard deletes the same recording after automatic termination" }).toBeUndefined();
    await deleted;
    expect(c.host.textContent, "durable deletion precedes the held UI completion").not.toContain("Recording discarded from this device.");
    let sampled = false;
    await expect.poll(() => {
      const text = c.host.textContent;
      // The first real DOM sample observes the pending notice; release the
      // delivery and require the subsequent painted completion, without a sleep.
      if (!sampled) { sampled = true; releaseNotice(); }
      return text;
    }, { message: "confirmed discard announces its rendered completion" }).toContain("Recording discarded from this device.");
    await expect.poll(() => c.host.querySelector(`[data-recording-focus="${row.id}"]`), { message: "the discarded recording has no visible row" }).toBeNull();
    expect((await c.root.recordings!.list(row.partition)).map(saved => saved.id), "the deleted recording stays absent from inventory").not.toContain(row.id);
    await expect(c.root.recordings!.playback(row.partition, row.id), "discarded audio cannot be played").rejects.toThrow("Recording not found");
    // Recreate the store over a newly opened device database, as a reload does.
    const reopened = createLocalPartitions({ name: c.storageName, heldAccountKey: () => c.root.stores.connection.getState().accountKey });
    const reloaded = createRecordingStore({ root: c.root, partitions: reopened, heldAccountKey: () => c.root.stores.connection.getState().accountKey });
    try {
      expect(await reopened.open(row.partition).get(`recording:index:${row.id}`), "the original recording index is absent after reopening storage").toBeUndefined();
      expect((await reloaded.list(row.partition)).map(saved => saved.id), "recreated inventory cannot resurrect the discarded recording").not.toContain(row.id);
      await expect(reloaded.playback(row.partition, row.id), "recreated playback cannot recover discarded audio").rejects.toThrow("Recording not found");
    } finally { reloaded.dispose(); }
  });
}

test("failed capture discard stays visible after Stop and restores mic focus", async ctx => {
  await commands.formViewport(390, 900); await page.viewport(390, 900);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s)); ctx.onTestFinished(() => mic.restore());
  const c = fixture(ctx); await c.ready(); c.net.drop(); c.mountChat(); await settled();
  await expect.poll(() => button(c.host, "Record on this device"), { message: "the asynchronous microphone support probe exposes the local recording action" }).toBeTruthy();
  const audioCommitted = c.nextAudioCommit();
  await tap(button(c.host, "Record on this device"));
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy(); await audioCommitted;
  const original = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function(this: IDBObjectStore, key) {
    if (Array.isArray(key) && String(key[1]).startsWith("recording:index:")) throw new DOMException("Full", "QuotaExceededError"); return original.call(this, key);
  });
  await tap(button(c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!, "Discard"));
  await tap(button(c.host, "Discard recording"));
  await expect.poll(() => c.root.stores.voice.getState().local).toBe("idle");
  await expect.poll(() => [...c.host.querySelectorAll("[role=status]")].find(el => el.textContent?.includes("discard this recording"))?.textContent, { message: "discard failure survives the sheet closing" }).toBe("Couldn\u0027t discard this recording on this device. The recording is kept.");
  await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "failed discard restores mic focus" }).toBe("Record on this device");
  expect(await c.root.recordings!.list("account:odysseus")).toHaveLength(1);
});


test("stale same-scope tabs keep both accepted transcripts and continue ordinary snapshots on the branch", async ctx => {
  const a = fixture(ctx); await a.ready(); const draftId = a.root.stores.drafts.getState().idFor(null);
  a.root.stores.drafts.getState().edit(draftId, null, { text: "Inspect the fleet." }); await a.root.localWork!.snapshotNow();
  const first = await a.seed(), second = await a.seed("transcript-ready", "Telemachus confirms the route.");
  const b = fixture(ctx); await b.ready(); b.root.recordings!.dispose(); b.root.localWork!.dispose(); b.root.partitions = a.partitions;
  b.root.localWork = createLocalWork({ stores: b.root.stores, partitions: a.partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
  b.root.recordings = createRecordingStore({ root: b.root, partitions: a.partitions, heldAccountKey: () => b.root.stores.connection.getState().accountKey });
  await b.root.localWork.restoring();
  expect(b.root.stores.drafts.getState().drafts[draftId]?.text, "second tab restores the shared non-empty draft").toBe("Inspect the fleet.");
  await a.root.recordings!.accept(first.partition, first.id, draftId, null); await a.root.localWork!.snapshotNow();
  const outcome = await b.root.recordings.accept(second.partition, second.id, draftId, null).then(() => null, error => error);
  expect(outcome, "stale acceptance commits its unbound branch").toBeNull();
  const branch = b.root.stores.drafts.getState().resolveId(draftId);
  expect(branch).not.toBe(draftId);
  expect(await a.partitions.open(first.partition).get(`root:ithaca/draft/${branch}`)).toMatchObject({ sessionId: null, text: "Inspect the fleet.\nTelemachus confirms the route." });
  expect((await a.partitions.open(first.partition).get(`root:ithaca/draft/${draftId}`) as { text: string }).text, "first transcript stays durable after its audio is gone").toBe(`Inspect the fleet.\n${TEXT}`);
  expect(await b.root.recordings.get(second.partition, second.id), "audio is deleted only after the retained branch commits").toBeUndefined();
  b.root.stores.drafts.getState().edit(draftId, null, { text: "A stale tab's new plan." });
  await b.root.localWork.snapshotNow();
  expect(await a.partitions.open(first.partition).get(`root:ithaca/draft/${branch}`)).toMatchObject({text:"A stale tab's new plan."});
  expect((await a.partitions.open(first.partition).get(`root:ithaca/draft/${draftId}`) as { text: string }).text).toBe(`Inspect the fleet.\n${TEXT}`);
});

test("dismissing mixed audio-loss notices never discards a surviving transcript", async ctx => {
  const c = fixture(ctx); await c.ready(); const ready = await c.seed(), lost = await c.seed("saved", ""); const h = c.partitions.open(ready.partition);
  const { transcript: _transcript, ...lostIndex } = await h.get(`recording:index:${lost.id}`) as Recording;
  await h.put(`recording:index:${lost.id}`, lostIndex);
  for (const row of [ready, lost]) await h.write((await h.list(`recording:chunk:${row.id}:`)).map(r => ({ delete: r.key })));
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  const recovered = await c.root.recordings!.recover(ready.partition); fault.restore();
  expect(recovered.removedCount, "loss witness is present beside the surviving review").toBe(1);
  expect(recovered.recordings).toMatchObject([{ id: ready.id, transcript: TEXT }]);
  await c.root.recordings!.dismissRemoved(ready.partition);
  expect(await h.get(`recording:index:${ready.id}`), "dismissal cannot erase independently surviving text").toMatchObject({ transcript: TEXT });
  expect(await h.get(`recording:index:${lost.id}`)).toBeUndefined();
  await c.root.recordings!.accept(ready.partition, ready.id, c.root.stores.drafts.getState().idFor(null), null);
  expect(c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor(null)]?.text).toBe(TEXT);
});


test("a concurrent ordinary snapshot fences acceptance until its retained branch commits", async ctx => {
  const a = fixture(ctx); await a.ready(); const id = a.root.stores.drafts.getState().idFor(null);
  a.root.stores.drafts.getState().edit(id, null, { text: "Inspect the fleet." }); await a.root.localWork!.snapshotNow(); const row = await a.seed();
  const b = fixture(ctx); await b.ready(); b.root.recordings!.dispose(); b.root.localWork!.dispose();
  const hold = holdIndexedDbWrite((key, value) => Array.isArray(key) && String(key[1]) === `root:ithaca/draft/${id}` && (value as {text?:string}).text === "Penelope's newer plan.");
  ctx.onTestFinished(() => hold.restore());
  const partitions = a.partitions;
  b.root.localWork = createLocalWork({ stores: b.root.stores, partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
  await b.root.localWork.restoring(); b.root.stores.drafts.getState().edit(id, null, { text: "Penelope's newer plan." });
  const snapshot = b.root.localWork.snapshotNow(); await hold.started;
  let completed = false;
  const accepting = a.root.recordings!.accept(row.partition, row.id, id, null).then(() => { completed = true; return null; }, error => { completed = true; return error; });
  await wait(500);
  expect(completed, "acceptance waits for the competing draft commit").toBe(false);
  hold.release(); await snapshot;
  expect(await accepting, "stale acceptance retains a branch after the newer commit").toBeNull();
  expect((await a.partitions.open(row.partition).get(`root:ithaca/draft/${id}`) as { text: string }).text).toBe("Penelope's newer plan.");
  expect(await a.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  const branch = a.root.stores.drafts.getState().resolveId(id);
  expect(await a.partitions.open(row.partition).get(`root:ithaca/draft/${branch}`)).toMatchObject({sessionId:null,text:`Inspect the fleet.\n${TEXT}`});
});


for (const failure of ["quota", "pending"] as const) {
  test(`tray collapse preserves a ${failure} transcript correction and its retry protection`, async ctx => {
    const c = fixture(ctx); await c.ready(); const row = await c.seed(); c.renderTray(); await expand(c);
    const correction = "Penelope confirms the corrected loom order.";
    const fault = failure === "quota" ? failIndexedDbWrites({ afterBytes: 0 }) : null;
    const hold = failure === "pending" ? holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]) === `recording:index:${row.id}`) : null;
    ctx.onTestFinished(() => { fault?.restore(); hold?.restore(); });
    await userEvent.fill(c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")!, correction);
    if (hold) await hold.started;
    if (fault) await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent).toBe("Couldn\u0027t save the transcript on this device. The recording is kept.");
    await tap(c.host.querySelector("[data-recordings-tray] > button")!); await expand(c);
    expect(c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")!.value, "collapse never abandons the unsaved transcript correction").toBe(correction);
    if (fault) expect(c.host.querySelector("[role=alert]")?.textContent, "the unsaved correction keeps its failure warning").toBe("Couldn\u0027t save the transcript on this device. The recording is kept.");
    fault?.restore(); hold?.release();
    await tap(button(c.host, "Add transcript"));
    await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
    expect(c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor(null)]?.text, "reopened Add commits the corrected text before deleting audio").toBe(correction);
  });
}

test("Add retries a failed transcript input commit without another edit", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); c.renderTray(); await expand(c);
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")!;
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  await userEvent.fill(field, "Penelope confirms the new loom order.");
  await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent).toBe("Couldn\u0027t save the transcript on this device. The recording is kept."); fault.restore();
  expect(field.value, "the unsaved correction stays visible").toBe("Penelope confirms the new loom order.");
  expect((await c.root.recordings!.get(row.partition, row.id))?.transcript, "the failed input did not change storage").toBe(TEXT);
  await tap(button(c.host, "Add transcript"));
  await expect.poll(() => c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor(null)]?.text, { message: "Add retries the displayed correction before committing the draft" }).toBe("Penelope confirms the new loom order.");
  await expect.poll(async () => c.root.recordings!.get(row.partition, row.id), { message: "Add deletes audio after its acknowledged draft commit" }).toBeUndefined();
});

for (const reason of ["limit", "storage", "interrupted"] as const) {
  test(`automatic ${reason} capture termination restores focus from the sheet`, async ctx => {
    await commands.formViewport(390, 900); await page.viewport(390, 900);
    const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s));
    const watch = watchMicrophone(); ctx.onTestFinished(() => { watch.restore(); mic.restore(); });
    const c = fixture(ctx); await c.ready(); c.net.drop(); c.mountChat(); await settled();
    await expect.poll(() => button(c.host, "Record on this device"), { message: "the asynchronous microphone support probe exposes the local recording action" }).toBeTruthy();
    const audioCommitted = c.nextAudioCommit();
    await tap(button(c.host, "Record on this device"));
    await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy();
    await audioCommitted;
    await expect.poll(async () => (await c.root.recordings!.list("account:odysseus"))[0]?.savedThroughMs, { message: "the real microphone has committed an audio boundary" }).toBeGreaterThanOrEqual(1000);
    await expect.poll(() => button(c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!, "Discard"), { message: "the settled sheet offers Discard before confirmation" }).toBeTruthy();
    await tap(button(c.host.querySelector<HTMLElement>("[data-local-recording-sheet]")!, "Discard"));
    await expect.poll(() => document.activeElement?.textContent).toBe("Keep recording");
    if (reason === "interrupted") watch.interrupt(); else await c.root.recordings!.stop(reason);
    await expect.poll(() => document.activeElement?.getAttribute("aria-label"), { message: "automatic stop returns sheet focus to the mic" }).toBe("Record on this device");
    expect(c.host.querySelector("[data-local-recording-sheet]")).toBeNull();
    expect(await c.root.recordings!.list("account:odysseus")).toHaveLength(1);
  });
}

test("automatic capture termination leaves composer editing focus alone", async ctx => {
  await commands.formViewport(390, 900); await page.viewport(390, 900);
  const mic = installWavMicrophone(generateWav(AUDIO_FIXTURES.note10s));
  const watch = watchMicrophone(); ctx.onTestFinished(() => { watch.restore(); mic.restore(); });
  const c = fixture(ctx); await c.ready(); c.net.drop(); c.mountChat(); await settled();
  await expect.poll(() => button(c.host, "Record on this device"), { message: "the asynchronous microphone support probe exposes the local recording action" }).toBeTruthy();
  const audioCommitted = c.nextAudioCommit();
  await tap(button(c.host, "Record on this device"));
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeTruthy(); await audioCommitted;
  const field = c.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!; field.focus();
  expect(document.activeElement).toBe(field); watch.interrupt();
  await expect.poll(() => c.host.querySelector("[data-local-recording-sheet]")).toBeNull(); await wait(100);
  expect(document.activeElement, "automatic stop does not steal editing focus").toBe(field);
});

for (const operation of ["accept", "snapshot"] as const) {
  test(`fresh same-scope tabs retain ${operation} on a new unbound branch for an occupied session`, async ctx => {
    const a = fixture(ctx); await a.ready();
    const b = fixture(ctx); await b.ready(); b.root.recordings!.dispose(); b.root.localWork!.dispose(); b.root.partitions = a.partitions;
    b.root.localWork = createLocalWork({ stores: b.root.stores, partitions: a.partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
    b.root.recordings = createRecordingStore({ root: b.root, partitions: a.partitions, heldAccountKey: () => b.root.stores.connection.getState().accountKey });
    await b.root.localWork.restoring();
    const aId = a.root.stores.drafts.getState().idFor("ithaca"), bId = b.root.stores.drafts.getState().idFor("ithaca");
    expect(aId, "tabs independently mint their empty session identity").not.toBe(bId);
    const first = await a.seed(), second = await b.seed("transcript-ready", "Telemachus confirms the route.");
    await a.root.recordings!.accept(first.partition, first.id, aId, "ithaca");
    let attempt: Promise<unknown>;
    if (operation === "accept") attempt = b.root.recordings!.accept(second.partition, second.id, bId, "ithaca");
    else { b.root.stores.drafts.getState().edit(bId, "ithaca", { text: "The other tab's plan." }); attempt = b.root.localWork.snapshotNow(); }
    const outcome = await attempt.then(() => null, error => error);
    expect(outcome, "a different draft identity branches without replacing the accepted session transcript").toBeNull();
    const branch = b.root.stores.drafts.getState().resolveId(bId);
    expect(await a.partitions.open(first.partition).get(`root:ithaca/draft/${branch}`)).toMatchObject({sessionId:null,text:operation === "accept" ? "Telemachus confirms the route." : "The other tab's plan."});
    const c = fixture(ctx); await c.ready(); c.root.localWork!.dispose(); c.root.partitions = a.partitions;
    c.root.localWork = createLocalWork({ stores: c.root.stores, partitions: a.partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
    await c.root.localWork.restoring(); await c.root.localWork.snapshotNow();
    expect(c.root.stores.drafts.getState().drafts[c.root.stores.drafts.getState().idFor("ithaca")]?.text, "reload retains the accepted transcript after its audio was deleted").toBe(TEXT);
    if (operation === "accept") expect(await b.root.recordings!.get(second.partition, second.id)).toBeUndefined();
    else expect(await b.root.recordings!.get(second.partition, second.id)).toMatchObject({ transcript: "Telemachus confirms the route.", chunkCount: 1 });
  });
}

test("restoration never deletes a valid conflicting session draft it did not adopt", async ctx => {
  const a = fixture(ctx); await a.ready(); const row = await a.seed();
  const id = a.root.stores.drafts.getState().idFor("ithaca"); await a.root.recordings!.accept(row.partition, row.id, id, "ithaca");
  const h = a.partitions.open(row.partition); const saved = await h.get(`root:ithaca/draft/${id}`) as Record<string, unknown>;
  await h.put("root:ithaca/draft/legacy-route", { ...saved, draftId: "legacy-route", text: "Telemachus confirms the route." });
  const b = fixture(ctx); await b.ready(); b.root.localWork!.dispose(); b.root.partitions = a.partitions;
  b.root.localWork = createLocalWork({ stores: b.root.stores, partitions: a.partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
  await b.root.localWork.restoring(); await b.root.localWork.snapshotNow();
  expect((await h.list("root:ithaca/draft/")).map(r => (r.value as { text: string }).text).sort(), "restore preserves both independently committed session texts").toEqual([TEXT, "Telemachus confirms the route."].sort());
});

test("delayed Add follows a New chat draft's acknowledged session ownership durably", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const drafts = c.root.stores.drafts.getState(), id = drafts.idFor(null);
  drafts.edit(id, null, { text: "Inspect the harbour." }); await c.root.localWork!.snapshotNow();
  c.renderTray(); await expand(c);
  const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).startsWith("recording:index:")); ctx.onTestFinished(() => hold.restore());
  await userEvent.fill(c.host.querySelector<HTMLTextAreaElement>("textarea:not([data-composer])")!, "Penelope confirms the fleet."); await hold.started;
  await tap(button(c.host, "Add transcript"));
  c.root.stores.drafts.getState().beginSend({ requestId: "harbour-first", draftId: id, sessionId: null, text: "Inspect the harbour.", attachments: [], message: { type: "chat_message", text: "Inspect the harbour.", source: "typed" } }, "Inspect the harbour.");
  c.root.stores.drafts.getState().accepted("harbour-first", "ithaca");
  expect(c.root.stores.drafts.getState().drafts[id], "acknowledgement retires the emptied original identity").toBeUndefined();
  const target = c.root.stores.drafts.getState().resolveId(id); expect(target).not.toBe(id);
  hold.release(); await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
  expect(await c.partitions.open(row.partition).get(`root:ithaca/draft/${target}`), "acceptance commits the resolved draft with its acknowledged session").toMatchObject({ sessionId: "ithaca", text: "Penelope confirms the fleet." });
  expect(c.root.stores.drafts.getState().drafts[target]?.sessionId).toBe("ithaca");
});

for (const failRedirect of [false, true, "restart", "removed"] as const) {
  test(`session ownership changing inside the draft commit is durable before cleanup${failRedirect === "removed" ? " after the pending text is removed" : failRedirect === "restart" ? " across a restart" : failRedirect ? " after a retry" : ""}`, async ctx => {
    const c = fixture(ctx); await c.ready(); const row = await c.seed();
    const id = c.root.stores.drafts.getState().idFor(null);
    c.root.stores.drafts.getState().edit(id, null, { text: "Inspect the harbour." }); await c.root.localWork!.snapshotNow();
    c.renderTray(); await expand(c);
    const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).startsWith("root:ithaca/draft/")); ctx.onTestFinished(() => hold.restore());
    await tap(button(c.host, "Add transcript")); await hold.started;
    // Isolate acceptance/retry from the ordinary debounced snapshot.
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) => schedule(fn, ms === 250 ? 60000 : ms, ...args)) as typeof setTimeout);
    c.root.stores.drafts.getState().beginSend({ requestId: "harbour-first", draftId: id, sessionId: null, text: "Inspect the harbour.", attachments: [], message: { type: "chat_message", text: "Inspect the harbour.", source: "typed" } }, "Inspect the harbour.");
    c.root.stores.drafts.getState().accepted("harbour-first", "ithaca");
    const target = c.root.stores.drafts.getState().resolveId(id); expect(target).not.toBe(id);
    const fault = failRedirect ? failIndexedDbWrites({ afterBytes: 0 }) : null; ctx.onTestFinished(() => fault?.restore());
    hold.release();
    if (fault) {
      await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent).toBe(ACCEPT_FAILED);
      expect(await c.root.recordings!.get(row.partition, row.id), "failed redirected commit keeps audio").toMatchObject({ chunkCount: 1 });
      fault.restore();
      if (failRedirect === "removed") {
        c.root.stores.drafts.getState().edit(target, "ithaca", { text: "Telemachus revises the route." });
        const result = await c.root.recordings!.accept(row.partition, row.id, target, "ithaca").then(() => null, error => error);
        expect(result, "a provisional receipt cannot finalize a draft whose accepted text was removed").toBeInstanceOf(Error);
        expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ chunkCount: 1, transcript: TEXT });
        return;
      }
      if (failRedirect === "restart") {
        c.root.localWork!.dispose(); c.root.recordings!.dispose();
        const restored = fixture(ctx); await restored.ready(); restored.root.localWork!.dispose(); restored.root.recordings!.dispose(); restored.root.partitions = c.partitions;
        restored.root.localWork = createLocalWork({ stores: restored.root.stores, partitions: c.partitions, scope: "root:ithaca", onAccountSwitch: () => {}, tracks: () => [], watchTracks: () => () => {} });
        restored.root.recordings = createRecordingStore({ root: restored.root, partitions: c.partitions, heldAccountKey: () => restored.root.stores.connection.getState().accountKey });
        await restored.root.localWork.restoring();
        const restoredId = restored.root.stores.drafts.getState().idFor("ithaca");
        const result = await restored.root.recordings.accept(row.partition, row.id, restoredId, "ithaca").then(() => null, error => error);
        expect(result, "restart cannot finalize an acceptance whose draft owner was not committed").toBeInstanceOf(Error);
        expect(await restored.root.recordings.get(row.partition, row.id), "unresolved acceptance keeps the original audio after restart").toMatchObject({ chunkCount: 1, transcript: TEXT });
        return;
      }
      await tap(button(c.host, "Add transcript"));
    }
    await expect.poll(async () => c.root.recordings!.get(row.partition, row.id)).toBeUndefined();
    expect(await c.partitions.open(row.partition).get(`root:ithaca/draft/${target}`), "ownership changed during commit is saved before deleting audio").toMatchObject({ sessionId: "ithaca", text: TEXT });
  });
}

test("ownership rotation aborts the native finalization transaction before cleanup permission commits", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed();
  const id = c.root.stores.drafts.getState().idFor(null);
  c.root.stores.drafts.getState().edit(id, null, { text: "Inspect the harbour." }); await c.root.localWork!.snapshotNow();
  const hold = holdIndexedDbWrite((key, value) => Array.isArray(key) && String(key[1]) === `recording:accepted:${row.id}` && (value as { finalized?: boolean }).finalized === true);
  ctx.onTestFinished(() => hold.restore());
  const result = c.root.recordings!.accept(row.partition, row.id, id, null).then(() => null, error => error);
  await hold.started;
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) => schedule(fn, ms === 250 ? 60000 : ms, ...args)) as typeof setTimeout);
  const fault = failIndexedDbWrites({ afterBytes: 0 }); ctx.onTestFinished(() => fault.restore());
  c.root.stores.drafts.getState().beginSend({ requestId: "harbour-final", draftId: id, sessionId: null, text: "Inspect the harbour.", attachments: [], message: { type: "chat_message", text: "Inspect the harbour.", source: "typed" } }, "Inspect the harbour.");
  c.root.stores.drafts.getState().accepted("harbour-final", "ithaca");
  hold.release();
  expect(await result, "a failed repair cannot authorize audio cleanup").toBeInstanceOf(Error);
  expect(await c.partitions.open(row.partition).get(`recording:accepted:${row.id}`), "native abort leaves the receipt provisional").toMatchObject({ finalized: false });
  expect(await c.root.recordings!.get(row.partition, row.id), "audio remains available after the failed owner repair").toMatchObject({ chunkCount: 1 });
});

test("warm auth invalidates acceptance waiting for the shared draft write lock", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); const id = c.root.stores.drafts.getState().idFor(null);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const lock = navigator.locks.request("brain-ui:work:odysseus:root:ithaca", async () => { entered(); await gate; });
  ctx.onTestFinished(async () => { release(); await lock; }); await started;
  const acceptance = c.root.recordings!.accept(row.partition, row.id, id, null).then(() => null, error => error);
  await wait(50);
  c.root.localWork!.lock(); c.root.stores.drafts.getState().release();
  c.root.stores.drafts.setState(c.root.stores.drafts.getInitialState(), true);
  expect(await c.root.localWork!.resume(), "warm context actually restores before the old operation resumes").toBe(true);
  release(); await lock;
  expect(await acceptance, "an old auth generation cannot report acceptance committed").toBeInstanceOf(Error);
  expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ state: "transcript-ready", transcript: TEXT, chunkCount: 1 });
  expect(await c.partitions.open(row.partition).get(`recording:accepted:${row.id}`)).toBeUndefined();
});

test("auth expiry cancels an Add activation queued behind transcript input", async ctx => {
  const c = fixture(ctx); await c.ready(); const row = await c.seed(); c.renderTray(); await expand(c);
  const hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).startsWith("recording:index:")); ctx.onTestFinished(() => hold.restore());
  await userEvent.fill(c.host.querySelector<HTMLTextAreaElement>("textarea:not([data-composer])")!, "Penelope confirms the fleet."); await hold.started;
  await tap(button(c.host, "Add transcript"));
  const expiry = c.root.authLock.expire("session expired");
  expect(c.root.authLock.state.getState().phase).toBe("saving");
  hold.release(); await expiry;
  await expect.poll(() => c.host.querySelector("[role=alert]")?.textContent, { message: "auth expiry invalidates the queued Add activation" }).toBe(ACCEPT_FAILED);
  expect(await c.root.recordings!.get(row.partition, row.id)).toMatchObject({ state: "transcript-ready", transcript: "Penelope confirms the fleet.", chunkCount: 1 });
});


for (const phase of ["transcript input", "recording read"])
  test(`pending ${phase} keeps Add on its incoming branch across navigation`, async ctx => {
    const a = fixture(ctx); await a.ready();
    const id = a.root.stores.drafts.getState().idFor(null);
    a.root.stores.drafts.getState().edit(id, null, { text: "Inspect the fleet." });
    await a.root.localWork!.snapshotNow();
    const row = await a.seed();
    const b = fixture(ctx); await b.ready();
    b.root.recordings!.dispose(); b.root.localWork!.dispose(); b.root.partitions = a.partitions;
    b.root.localWork = createLocalWork({ stores: b.root.stores, partitions: a.partitions, scope: "root:ithaca", tracks: () => [], watchTracks: () => () => {} });
    b.root.recordings = createRecordingStore({ root: b.root, partitions: a.partitions, heldAccountKey: () => "odysseus" });
    await b.root.localWork.restoring();
    await b.root.localWork.snapshotNow();
    a.root.stores.drafts.getState().edit(id, null, { text: "Penelope keeps the loom order." });
    await a.root.localWork!.snapshotNow();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    ctx.onTestFinished(() => release());
    let accepting: Promise<unknown> | undefined;
    const added = phase === "transcript input" ? "Bring the oars." : TEXT;
    if (phase === "transcript input") {
      b.renderTray(); await expand(b);
      const save = b.root.recordings.saveTranscript;
      vi.spyOn(b.root.recordings, "saveTranscript").mockImplementation(async (...args) => { await save(...args); entered(); await gate; });
      await userEvent.fill(b.host.querySelector<HTMLTextAreaElement>("textarea[aria-label^=Transcript]")!, added);
      await started;
      await tap(button(b.host, "Add transcript"));
    } else {
      const open = a.partitions.open.bind(a.partitions);
      let armed = true;
      vi.spyOn(a.partitions, "open").mockImplementation(partition => {
        const handle = open(partition);
        return { ...handle, async get(key) {
          const value = await handle.get(key);
          if (armed && key === `recording:index:${row.id}`) { armed = false; entered(); await gate; }
          return value;
        } };
      });
      accepting = b.root.recordings.accept(row.partition, row.id, id, null);
      await started;
    }
    expect(b.root.stores.drafts.getState().resolveId(id), "Add starts before the native fork").toBe(id);
    b.root.stores.drafts.getState().edit(id, null, { text: "Telemachus checks the route." });
    await b.root.localWork.snapshotNow();
    const branch = b.root.stores.drafts.getState().resolveId(id);
    expect(branch).not.toBe(id);
    b.root.stores.drafts.getState().openUnbound(id);
    release();
    if (accepting) await accepting;
    await expect.poll(async () => (await b.root.recordings!.get(row.partition, row.id)) === undefined).toBe(true);
    await b.root.localWork.snapshotNow();
    expect(await a.partitions.open(row.partition).get(`root:ithaca/draft/${id}`),
      "pending Add leaves the committed original's text intact").toMatchObject({ text: "Penelope keeps the loom order." });
    expect(await a.partitions.open(row.partition).get(`root:ithaca/draft/${branch}`)).toMatchObject({ text: `Telemachus checks the route.\n${added}` });
  });


for (const theme of ["dark", "light"]) test(`batch5 recordings disclosure target and focus ${theme}`, async ctx => {
  const viewport = { width: innerWidth, height: innerHeight };
  const previousTheme = document.documentElement.dataset.theme;
  const outer = await commands.formViewport(320, 800);
  await page.viewport(320, 800); document.documentElement.dataset.theme = theme;
  ctx.onTestFinished(async () => {
    if (previousTheme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = previousTheme;
    await page.viewport(viewport.width, viewport.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  });
  const c = fixture(ctx); await c.ready(); await c.seed("interrupted");
  c.renderTray(); await expand(c);
  const named = page.elementLocator(c.host).getByRole("button", { name: /^On this device · 1 ·/ });
  const header = named.element() as HTMLElement;
  header.focus(); await userEvent.keyboard("{ArrowRight}");
  const css = getComputedStyle(header); const rect = header.getBoundingClientRect();
  expect([header.getAttribute("aria-expanded") === "true", rect.height >= 44,
    header.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2)),
    css.outlineStyle === "solid", css.outlineWidth === "2px"],
  "recordings disclosure has a name, 44px reach and visible row focus").toEqual([true, true, true, true, true]);
  await userEvent.keyboard(" ");
  expect(header.getAttribute("aria-expanded"), "recordings disclosure Space collapses the tray").toBe("false");
});
