/// <reference types="@vitest/browser-playwright" />
/**
 * Generic composer files in Chromium (#3155, design §8): the Files source,
 * the neutral upload route, the §8.4 chip states, the draft binding of
 * stored originals and the send that names them.
 *
 * The real Composer and the real draft client run against a fixture host
 * that keeps #3153's rules in memory: one original per upload, minted for
 * one draft id (its lineage), the same `fileId` for a repeated
 * `Idempotency-Key`, and a save that binds only stored originals of its own
 * draft. Native File, DataTransfer, change and paste events throughout. No
 * key, no network. The real host routes are proved by ui-server's
 * attachment tests.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AttachmentFile, ClientMessage, Draft } from "@schlessera/brain-ui-sdk/protocol";
import { Composer } from "../../src/components/chat/composer.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { trackView } from "../track-fixtures.js";

const SESSION = "odysseus-ithaca";

/** The host's socket, driven by the test: hello and history arrive as the real client reads them. */
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
type Upload = { draftId: string; key: string; name: string; bytes: Uint8Array };

/** #3153's composer-file and draft rules, kept in memory. */
function fileHost() {
  const files = new Map<string, AttachmentFile & { draftId: string }>();
  const keys = new Map<string, string>();
  const rows = new Map<string, Draft>();
  const uploads: Upload[] = [];
  const saves: { draftId: string; fileIds?: string[] }[] = [];
  /** Paths requested, in order. */
  const calls: string[] = [];
  /** The next upload's answer is lost after the host stored it. */
  let dropNext = false;
  /** The next upload is refused for space. */
  let fullNext = false;
  let seq = 0;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  function detect(name: string, draftId: string, fileId: string, bytes: number): AttachmentFile & { draftId: string } {
    const path = `.brain-ui/attachments/${fileId}/${name}`;
    const base = { fileId, name, path, bytes, sha256: fileId.replace(/-/g, "").padEnd(64, "0"), draftId };
    if (name.endsWith(".pdf")) return { ...base, mediaType: "application/pdf", kind: "pdf", reader: "pdf" };
    if (name.endsWith(".txt")) return { ...base, mediaType: "text/plain", kind: "text", reader: "text" };
    if (name.endsWith(".geojson")) return { ...base, mediaType: "application/geo+json", kind: "track", reader: "track", track: { ...trackView().file, path } };
    return { ...base, mediaType: "application/octet-stream", kind: "binary", reader: "none" };
  }
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const path = new URL(url, "http://fixture.invalid").pathname;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const headers = new Headers(init.headers);
    const upload = /\/drafts\/([^/]+)\/files$/.exec(path);
    if (upload) {
      const draftId = decodeURIComponent(upload[1]!);
      const key = headers.get("idempotency-key")!;
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      const name = decodeURIComponent(headers.get("x-file-name") ?? "file");
      uploads.push({ draftId, key, name, bytes });
      if (fullNext) { fullNext = false; return json({ error: "ATTACHMENT_CAPACITY", message: "", limit: 1, bound: "pool" }, 507); }
      let fileId = keys.get(`${draftId}:${key}`);
      if (!fileId) {
        fileId = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        keys.set(`${draftId}:${key}`, fileId);
        files.set(fileId, detect(name, draftId, fileId, bytes.byteLength));
      }
      if (dropNext) { dropNext = false; throw new TypeError("Failed to fetch"); }
      const { draftId: _lineage, ...file } = files.get(fileId)!;
      return json(file, 201);
    }
    const draft = /\/drafts(?:\/([^/]+))?$/.exec(path);
    if (draft) {
      const id = draft[1] && decodeURIComponent(draft[1]);
      if (!id) return json({ drafts: [] });
      const row = rows.get(id);
      if ((init.method ?? "GET") === "GET") return row ? json(row) : json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
      if (init.method === "DELETE") { rows.delete(id); return new Response(null, { status: 204 }); }
      const body = JSON.parse(String(init.body)) as { sessionId: string | null; text: string; attachmentIds: string[]; fileIds?: string[] };
      saves.push({ draftId: id, fileIds: body.fileIds });
      if ((row?.revision ?? 0) !== Number(headers.get("if-match"))) return json({ error: "DRAFT_CONFLICT", message: "", current: row }, 409);
      for (const fileId of body.fileIds ?? []) {
        if (files.get(fileId)?.draftId !== id) return json({ error: "ATTACHMENT_INVALID", message: "A file is not stored for this draft; upload it again." }, 400);
      }
      const revision = (row?.revision ?? 0) + 1;
      rows.set(id, { draftId: id, sessionId: body.sessionId, revision, updatedAt: Date.now(), text: body.text, attachments: [],
        files: (body.fileIds ?? []).map((f) => { const { draftId: _l, ...file } = files.get(f)!; return file; }) });
      return json({ revision, updatedAt: Date.now() });
    }
    return json({ providers: [], backends: {} });
  }
  return { request, uploads, saves, calls, files, drop: () => { dropNext = true; }, fill: () => { fullNext = true; } };
}

const scenes: { host: HTMLDivElement; renderer: Root; root: BrainUiRoot }[] = [];
let styles: HTMLStyleElement;
let viewport: { width: number; height: number };
beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
/**
 * The offline lane's Chromium has no network, so `navigator.onLine` is false
 * there and the queue would rightly wait for a connection. The fixture host is
 * reachable, so each scene says online, and the complete own-property state of
 * `navigator.onLine` is restored afterwards.
 */
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
  for (const s of scenes.splice(0)) { flushSync(() => s.renderer.unmount()); s.root.dispose(); s.host.remove(); }
  vi.unstubAllGlobals();
  restoreOnline();
});
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });

async function mount(width = 1280, height = 800) {
  await page.viewport(width, height);
  emulateOnline();
  const files = fileHost();
  const root = createBrainUiRoot({ storage: null, request: files.request });
  const frames: ClientMessage[] = [];
  vi.stubGlobal("WebSocket", FixtureSocket);
  root.stores.chat.getState().setActiveSession(SESSION);
  root.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true },
    attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 } });
  socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false });
  socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] });
  socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  scenes.push({ host, renderer, root });
  flushSync(() => renderer.render(<BrainUiProvider root={root}><Composer send={(msg) => { frames.push(msg); return true; }} /></BrainUiProvider>));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const field = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
  const chips = () => [...host.querySelectorAll<HTMLElement>("[data-file-chip]")];
  const chip = (name: string) => chips().find((c) => c.getAttribute("aria-label")?.startsWith(`${name},`));
  const status = (name: string) => chip(name)?.querySelector("[data-file-status]")?.textContent ?? null;
  const send = () => host.querySelector<HTMLElement>('[data-composer] [aria-label="Send"]')!.click();
  const draft = () => { const s = root.stores.drafts.getState(); return s.drafts[s.idFor(SESSION)]; };
  const saved = () => { const d = draft(); return !!d && d.host !== null && d.host.edit === d.edit; };
  const messages = () => frames.filter((f): f is Extract<ClientMessage, { type: "chat_message" }> => f.type === "chat_message");
  return { root, host, files, frames, field, chips, chip, status, send, draft, saved, messages };
}
type Scene = Awaited<ReturnType<typeof mount>>;

const permit = () => new File(["%PDF-1.7\nIthaca harbour permit: mooring fee 3 obols, water levy 1 obol\n%%EOF\n"], "ithaca-permit.pdf", { type: "application/pdf" });
const sirens = () => new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])], "sirens.m4a", { type: "audio/mp4" });
const loop = () => new File([JSON.stringify({ type: "LineString", coordinates: [[20.7, 38.4], [20.71, 38.41]] })], "ithaca-loop.geojson", { type: "" });

function pickFiles(s: Scene, files: File[]) {
  const input = s.host.querySelector<HTMLInputElement>("input[data-files-input]")!;
  const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}

test("desktop offers one unrestricted Files action and paste-or-drop guidance, never Photo library, Camera or Track files", async () => {
  const s = await mount(1280);
  s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label^="Attach"]')!.click();
  await expect.poll(() => s.host.querySelector('[role="menu"][aria-label="Attach"]')).not.toBeNull();
  const menu = s.host.querySelector<HTMLElement>('[role="menu"][aria-label="Attach"]')!.textContent!;
  expect(menu).toContain("Files…");
  expect(menu).toContain("Images, PDFs, tracks, any file");
  expect(menu).toContain("Paste or drop");
  for (const absent of ["Photo library", "Camera", "Track files", "GPX, KML or GeoJSON"]) expect(menu).not.toContain(absent);
  const input = s.host.querySelector<HTMLInputElement>("input[data-files-input]")!;
  expect(input.hasAttribute("accept"), "Files has no format allowlist").toBe(false);
  expect(input.multiple).toBe(true);
});

test("a phone keeps Photo library and Camera beside unrestricted Files", async () => {
  const s = await mount(320, 640);
  s.host.querySelector<HTMLElement>('[data-composer] [role="button"][aria-label^="Attach"]')!.click();
  await expect.poll(() => document.querySelector('[data-overlay-site="attach"]')?.textContent ?? "").toContain("Files");
  const sheet = document.querySelector<HTMLElement>('[data-overlay-site="attach"]')!.textContent!;
  for (const row of ["Photo library", "Camera", "Files", "Images, PDFs, tracks, any file", "Paste"]) expect(sheet).toContain(row);
  expect(sheet).not.toContain("Track files");
  expect(sheet).not.toContain("Paste or drop");
});

test("PDF, unknown binary and track go to the neutral route as their own bytes, show honest chips, and send as references of the saved revision", async () => {
  const s = await mount();
  await userEvent.fill(s.field(), "Which harbour fees does the permit list?");
  const picked = [permit(), sirens(), loop()];
  const input = pickFiles(s, picked);
  await expect.poll(() => input.value, { message: "the picker resets for the same file again" }).toBe("");
  await expect.poll(() => s.files.uploads.length, { timeout: 5_000 }).toBe(3);
  for (const file of picked) {
    const up = s.files.uploads.find((u) => u.name === file.name)!;
    expect([...up.bytes], `${file.name} arrives byte for byte`).toEqual([...new Uint8Array(await file.arrayBuffer())]);
    expect(up.draftId).toBe(s.draft()?.draftId ?? s.root.stores.drafts.getState().idFor(SESSION));
  }
  expect(s.files.calls.some((c) => c.endsWith("/track-upload")), "no file goes through the track-only route").toBe(false);
  await expect.poll(() => s.status("ithaca-permit.pdf")).toMatch(/^PDF · \d+ B · not read yet$/);
  expect(s.chip("ithaca-permit.pdf")!.textContent).toContain("Your agent opens it when it needs the contents.");
  await expect.poll(() => s.status("sirens.m4a")).toBe("12 B · no reader here");
  await expect.poll(() => s.status("ithaca-loop.geojson")).toMatch(/^Track · \d+ B · /);
  for (const c of s.chips()) expect(c.textContent ?? "").not.toMatch(/\b(readable|processed|decoded|saved)\b/i);
  // Saved means the host acknowledged this revision with all three bindings.
  await expect.poll(() => s.saved(), { timeout: 5_000 }).toBe(true);
  const bound = s.files.saves.at(-1)!.fileIds!;
  expect(bound).toHaveLength(3);
  s.send();
  expect(s.messages()).toHaveLength(1);
  const frame = s.messages()[0]!;
  expect(frame.attachmentRefs, "every stored original, the unreadable one included").toEqual(bound.map((fileId) => ({ kind: "attachment", fileId })));
  expect(frame.draftRef).toEqual({ draftId: s.files.saves.at(-1)!.draftId, revision: 1 });
  expect(frame.files, "no track-only staged reference").toBeUndefined();
  await expect.poll(() => s.chips().length).toBe(0);
});

test("Send pressed while a file uploads holds once, then sends that file after the save binds it", async () => {
  const s = await mount();
  await userEvent.fill(s.field(), "Read the crew list before we sail.");
  pickFiles(s, [new File(["Eurylochus\nPolites\nElpenor\n"], "crew-list.txt", { type: "text/plain" })]);
  s.send();
  expect(s.messages(), "not sent before its file is stored and saved").toHaveLength(0);
  await expect.poll(() => s.host.textContent ?? "").toMatch(/sends when (1 file finishes|the draft with its files is saved)/);
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  expect(s.messages()[0]!.attachmentRefs).toHaveLength(1);
  // The host resolves references against the revision the message names:
  // the hold waits for the save that binds the file, never sends ahead of it.
  expect(s.files.saves.length, "a save bound the file before the send").toBeGreaterThan(0);
  expect(s.messages()[0]!.draftRef, "sent from the acknowledged revision that binds it").toEqual({ draftId: s.files.saves.at(-1)!.draftId, revision: s.files.saves.length });
  expect(s.files.saves.at(-1)!.fileIds).toEqual(s.messages()[0]!.attachmentRefs!.map((r) => r.fileId));
  // The host's acceptance is the only later input to the hold: it lifts the
  // pending send's wait and consumes the draft. `deliver` commits it in
  // `flushSync`, so the hold's effect has run again with both changes.
  const requestId = s.messages()[0]!.requestId!;
  FixtureSocket.last!.deliver({ type: "session_info", sessionId: SESSION, isNew: false, requestId });
  expect(s.root.stores.drafts.getState().sends[requestId]?.state, "the host accepted the send").toBe("accepted");
  expect(s.messages(), "the hold sends once").toHaveLength(1);
});

test("a lost upload answer reads as unconfirmed, and reconnecting uploads it again once under the same key, storing one file", async () => {
  const s = await mount();
  s.files.drop();
  pickFiles(s, [permit()]);
  await expect.poll(() => s.status("ithaca-permit.pdf")).toBe("checking upload…");
  const again = s.chip("ithaca-permit.pdf")!.querySelector<HTMLElement>('[aria-label="Upload again ithaca-permit.pdf"]');
  expect(again, "the action is an upload, never 'Check'").not.toBeNull();
  expect(again!.classList.contains("bk-hit"), "44px reach on a coarse pointer without a painted box").toBe(true);
  expect(s.chip("ithaca-permit.pdf")!.textContent).not.toMatch(/not stored|nothing was stored|\bCheck\b/);
  s.root.stores.connection.setState({ wsStatus: "disconnected" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  s.root.stores.connection.setState({ wsStatus: "connected" });
  await expect.poll(() => s.status("ithaca-permit.pdf"), { timeout: 5_000 }).toMatch(/not read yet$/);
  expect(s.files.uploads).toHaveLength(2);
  expect(s.files.uploads[1]!.key).toBe(s.files.uploads[0]!.key);
  expect(s.files.files.size, "one stored original").toBe(1);
});

test("a refused file blocks Send with a reason until removed; Remove moves focus to the next chip, and the rest sends", async () => {
  const s = await mount();
  await userEvent.fill(s.field(), "Permit and crew list");
  s.files.fill();
  pickFiles(s, [permit(), new File(["Eurylochus\n"], "crew-list.txt", { type: "text/plain" })]);
  await expect.poll(() => s.status("ithaca-permit.pdf")).toBe("not stored · no space");
  expect(s.chip("ithaca-permit.pdf")!.textContent).toContain("This host's attachment space is full. Nothing was removed to make room.");
  await expect.poll(() => s.status("crew-list.txt")).toMatch(/not read yet$/);
  s.send();
  expect(s.messages()).toHaveLength(0);
  await expect.poll(() => s.host.textContent ?? "").toContain("Retry or remove the file that wasn't stored before sending.");
  const remove = s.chip("ithaca-permit.pdf")!.querySelector<HTMLElement>('[aria-label="Remove ithaca-permit.pdf"]')!;
  remove.focus();
  remove.click();
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Remove crew-list.txt");
  await expect.poll(() => s.saved(), { timeout: 5_000 }).toBe(true);
  s.send();
  expect(s.messages()).toHaveLength(1);
  expect(s.messages()[0]!.attachmentRefs).toHaveLength(1);
});

test("pasted and dropped files take the same route as picked ones", async () => {
  const s = await mount();
  const pasted = new DataTransfer(); pasted.items.add(permit());
  s.field().dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: pasted }));
  const dropped = new DataTransfer(); dropped.items.add(sirens());
  s.host.querySelector("[data-composer]")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dropped }));
  await expect.poll(() => s.files.uploads.map((u) => u.name).sort(), { timeout: 5_000 }).toEqual(["ithaca-permit.pdf", "sirens.m4a"]);
  expect(s.files.calls.some((c) => c.endsWith("/track-upload"))).toBe(false);
});
