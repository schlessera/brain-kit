/// <reference types="@vitest/browser-playwright" />
/**
 * Image originals in Chromium (#3155, design §6.1, §8.4 and §10). On a host
 * with composer files an image is uploaded as its exact original through the
 * neutral route, like every other file, and the inline frame the model sees
 * is derived from it and names it (`ChatImageAttachment.fileId`).
 *
 * The real Composer, snapshot bubbles and draft client run against the
 * fixture host in `../snapshot-host.ts` (#3153's and #3588's rules in
 * memory; PNG and JPEG signatures detect as images). `hostRefuses` restates
 * the rules ui-server's `resolveAttachmentRefs` and `chat-message` handler
 * apply to the frame, so a message the real host would refuse fails here.
 * Real canvas PNGs, native File, DataTransfer and change events. No key, no
 * network.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, type ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { Composer } from "../../src/components/chat/composer.js";
import { OutgoingSnapshots } from "../../src/components/chat/outgoing-snapshots.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { SESSION, snapshotHost, type SnapshotHost } from "../snapshot-host.js";

class FixtureSocket {
  static last: FixtureSocket | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { FixtureSocket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
}

const scenes: { host: HTMLDivElement; renderer: Root; root: BrainUiRoot; disposed: boolean }[] = [];
let styles: HTMLStyleElement;
let viewport: { width: number; height: number };
beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
/** The offline lane has no network, so `navigator.onLine` is false; the fixture host is reachable. Restored whole. */
let onLine: PropertyDescriptor | undefined | null = null;
function emulateOnline() {
  if (onLine === null) onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
}
function restoreOnline() {
  if (onLine === null) return;
  if (onLine) Object.defineProperty(navigator, "onLine", onLine);
  else Reflect.deleteProperty(navigator, "onLine");
  onLine = null;
}
afterEach(() => {
  for (const s of scenes.splice(0)) if (!s.disposed) { flushSync(() => s.renderer.unmount()); s.root.dispose(); s.host.remove(); }
  vi.unstubAllGlobals();
  restoreOnline();
});
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });

const LIMITS = { maxTextBytes: 65_536, maxDraftBytes: 8_388_608, maxDrafts: 100, maxTotalBytes: 268_435_456 };

/** `snapshots: false` is a host without the snapshot list: the composer's tab-local send. */
async function mount(fixture: SnapshotHost, { snapshots = true } = {}) {
  await page.viewport(1280, 900);
  emulateOnline();
  const root = createBrainUiRoot({ storage: null, request: fixture.request });
  vi.stubGlobal("WebSocket", FixtureSocket);
  root.stores.chat.getState().setActiveSession(SESSION);
  root.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver({
    type: "server_hello", protocolRev: 5,
    capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true, sessionRecovery: true },
    attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 },
    sessionDraftLimits: snapshots ? { ...LIMITS, maxOutgoingSnapshots: 10 } : LIMITS,
  });
  socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false });
  socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] });
  socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  const scene = { host, renderer, root, disposed: false };
  scenes.push(scene);
  flushSync(() => renderer.render(<BrainUiProvider root={root}>
    <div data-transcript=""><OutgoingSnapshots /></div>
    <Composer send={(msg) => root.connection.send(msg)} />
  </BrainUiProvider>));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const field = () => host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  const sendButton = () => host.querySelector<HTMLElement>('[data-composer] [aria-label^="Send"]')!;
  const chips = () => [...host.querySelectorAll<HTMLElement>("[data-file-chip]")];
  const chip = (name: string) => chips().find((c) => c.getAttribute("aria-label")?.startsWith(`${name},`));
  const status = (name: string) => chip(name)?.querySelector("[data-file-status]")?.textContent ?? null;
  const thumbnail = (name: string) => chip(name)?.querySelector<HTMLImageElement>("img[data-file-thumbnail]") ?? null;
  const bubbles = () => [...host.querySelectorAll<HTMLElement>("[data-outgoing-snapshot]")];
  const messages = () => socket.sent.map((raw) => JSON.parse(raw) as ClientMessage).filter((f): f is Extract<ClientMessage, { type: "chat_message" }> => f.type === "chat_message");
  const draft = () => { const s = root.stores.drafts.getState(); return s.drafts[s.idFor(SESSION)]; };
  const saved = () => { const d = draft(); return !!d && d.host !== null && d.host.edit === d.edit; };
  const reload = () => { flushSync(() => renderer.unmount()); root.dispose(); host.remove(); scene.disposed = true; };
  return { root, host, socket, field, sendButton, chips, chip, status, thumbnail, bubbles, messages, draft, saved, reload };
}
type Scene = Awaited<ReturnType<typeof mount>>;

function pickFiles(s: Scene, files: File[]) {
  const input = s.host.querySelector<HTMLInputElement>("input[data-files-input]")!;
  const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** A real PNG drawn on a canvas, with a little noise so each one is distinct. */
async function png(name: string, color: string, edge = 96) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = edge;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, edge, edge);
  ctx.fillStyle = "#fff"; ctx.fillRect(edge / 4, edge / 4, edge / 8, edge / 8);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}
const bytesOf = async (file: Blob) => [...new Uint8Array(await file.arrayBuffer())];
const decoded = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/**
 * What ui-server refuses before a backend runs (`resolveAttachmentRefs`,
 * `packages/ui-server/src/attachments/resolve.ts`; `handleChatMessageFrame`,
 * `packages/ui-server/src/ws/handlers/chat-message.ts`; `validateAttachments`,
 * `packages/ui-server/src/ws/attachments.ts`), or null when it would run it.
 */
function hostRefuses(fixture: SnapshotHost, msg: Extract<ClientMessage, { type: "chat_message" }>): string | null {
  const frames = msg.attachments ?? [];
  if (frames.length > MAX_IMAGES_PER_MESSAGE) return "Too many images attached";
  let frameBytes = 0;
  for (const f of frames) { const n = decoded(f.data); if (n > MAX_IMAGE_BYTES) return "Image is too large"; frameBytes += n; }
  if (frameBytes > MAX_TOTAL_IMAGE_BYTES) return "Attached images are too large";
  const refs = (msg.attachmentRefs ?? []).map((r) => r.fileId);
  if (refs.length && !msg.draftRef) return "Attached files need the saved draft they were uploaded to.";
  for (const id of frames.flatMap((f) => f.fileId ? [f.fileId] : [])) {
    if (!refs.includes(id) || fixture.files.get(id)?.kind !== "image") return "An image names an original the message does not attach.";
  }
  for (const id of refs) if (fixture.files.get(id)?.draftId !== msg.draftRef!.draftId) return "An attached file does not belong to this draft.";
  const unlinked = frames.filter((f) => !f.fileId);
  const bytes = refs.reduce((n, id) => n + fixture.files.get(id)!.bytes, 0) + unlinked.reduce((n, f) => n + decoded(f.data), 0);
  if (refs.length + unlinked.length > 10 || bytes > 50_000_000) return "Attached files exceed the message limits.";
  return null;
}

test("a picked image uploads its exact original to the neutral route, and the send carries the original and a frame that names it", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  await userEvent.fill(s.field(), "Is this the harbour at Ithaca?");
  const harbour = await png("harbour.png", "#2a6f97");
  pickFiles(s, [harbour]);
  await expect.poll(() => fixture.uploads.length, { timeout: 5_000 }).toBe(1);
  expect(fixture.uploads[0]!.name).toBe("harbour.png");
  expect(fixture.calls.some((c) => /\/drafts\/[^/]+\/attachments/.test(c)), "no legacy draft image upload").toBe(false);
  await expect.poll(() => s.thumbnail("harbour.png")?.src ?? null, { timeout: 5_000 }).toMatch(/^blob:/);
  const fileId = s.draft()!.files![0]!.file.fileId;
  expect(await bytesOf(new Blob([fixture.storedBytes(fileId)! as Uint8Array<ArrayBuffer>])), "stored byte for byte").toEqual(await bytesOf(harbour));
  expect(s.status("harbour.png")).toMatch(/^Image · \d+(\.\d+)? (B|KB) *$/);
  for (const c of s.chips()) expect(c.textContent ?? "").not.toMatch(/\b(readable|processed|decoded|saved|not read yet)\b/i);
  expect(s.draft()!.attachments, "no legacy inline image in the draft").toHaveLength(0);
  await expect.poll(() => s.saved(), { timeout: 5_000 }).toBe(true);
  expect(fixture.saves.at(-1)!.body.fileIds).toEqual([fileId]);
  s.sendButton().click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const msg = s.messages()[0]!;
  expect(msg.attachmentRefs).toEqual([{ kind: "attachment", fileId }]);
  expect(msg.attachments, "one frame, linked to its original").toHaveLength(1);
  expect(msg.attachments![0]!.fileId).toBe(fileId);
  expect(msg.attachments![0]!.mediaType).toBe("image/jpeg");
  expect(hostRefuses(fixture, msg)).toBeNull();
  // The snapshot that sent it held the original, not a frame.
  expect(fixture.saves.some((x) => x.body.snapshots?.some((snap) => snap.fileIds.includes(fileId))), "the snapshot holds the image").toBe(true);
  fixture.accept(msg);
  s.socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false, requestId: msg.requestId });
  const sent = s.root.stores.chat.getState().buffers[SESSION]!.messages.find((m) => m.role === "user")!;
  expect(sent.attachments?.map((a) => a.previewUrl.slice(0, 16)), "the sent row keeps its picture").toEqual(["data:image/jpeg;"]);
  expect(sent.attachmentFiles?.map((f) => f.fileId)).toEqual([fileId]);
});

test("past the frame budget an image is sent as its original only, with the §8.4 copy", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  await userEvent.fill(s.field(), "Five views of the strait.");
  const views = await Promise.all(["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"].map((c, i) => png(`strait-${i + 1}.png`, c)));
  pickFiles(s, views);
  await expect.poll(() => s.draft()?.files?.length ?? 0, { timeout: 5_000 }).toBe(5);
  await expect.poll(() => s.chips().filter((c) => c.querySelector("img[data-file-thumbnail]")).length, { timeout: 5_000 }).toBe(MAX_IMAGES_PER_MESSAGE);
  const order = s.draft()!.files!.map((f) => f.file);
  const last = order.at(-1)!;
  const name = last.incomingName || last.name;
  expect(s.status(name)).toMatch(/^Image · .+ · not shown inline$/);
  expect(s.chip(name)!.querySelector("[data-file-detail]")!.textContent).toBe("Your agent gets the file but not a preview.");
  expect(s.chip(name)!.getAttribute("aria-label")).toMatch(/, Image, .+, Image · .+ · not shown inline$/);
  await expect.poll(() => s.saved(), { timeout: 5_000 }).toBe(true);
  s.sendButton().click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const msg = s.messages()[0]!;
  expect(msg.attachmentRefs!.map((r) => r.fileId), "every original is sent").toEqual(order.map((f) => f.fileId));
  expect(msg.attachments!.map((a) => a.fileId), "four frames, in order, the fifth left out").toEqual(order.slice(0, MAX_IMAGES_PER_MESSAGE).map((f) => f.fileId));
  expect(hostRefuses(fixture, msg)).toBeNull();
});

test("Send while an image uploads holds a snapshot, and once stored it sends once with its frame", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  const release = fixture.holdUploads();
  await userEvent.fill(s.field(), "The view from the headland.");
  pickFiles(s, [await png("headland.png", "#6d597a")]);
  await expect.poll(() => fixture.uploads.length).toBe(1);
  await expect.poll(() => s.status("headland.png")).toBe("uploading…");
  s.sendButton().click();
  await expect.poll(() => s.bubbles().length).toBe(1);
  expect(s.chips(), "the upload is the snapshot's now").toHaveLength(0);
  const id = s.draft()!.draftId;
  await expect.poll(() => fixture.snapshotsOf(id)[0]?.state, { timeout: 5_000 }).toBe("held");
  expect(s.messages(), "nothing sent while the original uploads").toHaveLength(0);
  release();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const msg = s.messages()[0]!;
  const held = fixture.snapshotsOf(id)[0]!;
  expect(msg.requestId).toBe(held.requestId);
  expect(held.fileIds).toHaveLength(1);
  expect(msg.attachmentRefs).toEqual([{ kind: "attachment", fileId: held.fileIds[0] }]);
  expect(msg.attachments?.map((a) => a.fileId), "its frame names the held original").toEqual(held.fileIds);
  expect(hostRefuses(fixture, msg)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(s.messages(), "sent once").toHaveLength(1);
});

test("a refused image blocks Send until removed, and a failed one retries under its key", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  await userEvent.fill(s.field(), "Two sketches of the Cyclops' cave.");
  fixture.refuseNextUpload();
  pickFiles(s, [await png("cave-1.png", "#3d405b")]);
  await expect.poll(() => s.status("cave-1.png"), { timeout: 5_000 }).toBe("not stored · no space");
  expect(s.chip("cave-1.png")!.textContent).toContain("This host's attachment space is full. Nothing was removed to make room.");
  s.sendButton().click();
  await expect.poll(() => s.host.textContent ?? "").toContain("Retry or remove the file that wasn't stored before sending.");
  expect(s.messages()).toHaveLength(0);
  s.chip("cave-1.png")!.querySelector<HTMLElement>('[aria-label="Remove cave-1.png"]')!.click();
  fixture.failNextUpload();
  pickFiles(s, [await png("cave-2.png", "#81b29a")]);
  await expect.poll(() => s.status("cave-2.png"), { timeout: 5_000 }).toBe("upload failed");
  const retry = s.chip("cave-2.png")!.querySelector<HTMLElement>('[aria-label="Retry cave-2.png"]')!;
  retry.click();
  await expect.poll(() => s.thumbnail("cave-2.png")?.src ?? null, { timeout: 5_000 }).toMatch(/^blob:/);
  const tries = fixture.uploads.filter((u) => u.name === "cave-2.png");
  expect(tries).toHaveLength(2);
  expect(tries[1]!.key, "the retry is the same upload").toBe(tries[0]!.key);
  await expect.poll(() => s.saved(), { timeout: 5_000 }).toBe(true);
  s.sendButton().click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const msg = s.messages()[0]!;
  expect(msg.attachmentRefs).toHaveLength(1);
  expect(msg.attachments?.map((a) => a.fileId)).toEqual(msg.attachmentRefs!.map((r) => r.fileId));
  expect(hostRefuses(fixture, msg)).toBeNull();
});

test("after a reload an acknowledged image is restored from its original, with its thumbnail, and sends with its frame", async () => {
  const fixture = snapshotHost();
  const first = await mount(fixture);
  await userEvent.fill(first.field(), "Penelope's loom, as I left it.");
  const loom = await png("loom.png", "#9c6644");
  pickFiles(first, [loom]);
  await expect.poll(() => first.thumbnail("loom.png")?.src ?? null, { timeout: 5_000 }).toMatch(/^blob:/);
  await expect.poll(() => first.saved(), { timeout: 5_000 }).toBe(true);
  const fileId = first.draft()!.files![0]!.file.fileId;
  first.reload();
  const s = await mount(fixture);
  await expect.poll(() => s.field()?.value, { timeout: 5_000 }).toBe("Penelope's loom, as I left it.");
  await expect.poll(() => s.thumbnail("loom.png")?.src ?? null, { timeout: 5_000 }).toMatch(/^blob:/);
  expect(fixture.calls, "the frame was made from the original the host keeps").toContain(`GET /api/attachments/${fileId}`);
  s.sendButton().click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const msg = s.messages()[0]!;
  expect(msg.attachmentRefs).toEqual([{ kind: "attachment", fileId }]);
  expect(msg.attachments?.map((a) => a.fileId)).toEqual([fileId]);
  expect(hostRefuses(fixture, msg)).toBeNull();
});

test("on a host without the snapshot list the composer's own send carries the original and its frame", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture, { snapshots: false });
  await userEvent.fill(s.field(), "The ram I rode out of the cave.");
  const ram = await png("ram.png", "#bc6c25");
  pickFiles(s, [ram]);
  s.sendButton().click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const msg = s.messages()[0]!;
  const fileId = msg.attachmentRefs![0]!.fileId;
  expect(await bytesOf(new Blob([fixture.storedBytes(fileId)! as Uint8Array<ArrayBuffer>]))).toEqual(await bytesOf(ram));
  expect(msg.attachments?.map((a) => a.fileId)).toEqual([fileId]);
  expect(fixture.saves.every((x) => !x.body.snapshots?.length), "no snapshot on this host").toBe(true);
  expect(hostRefuses(fixture, msg)).toBeNull();
});
