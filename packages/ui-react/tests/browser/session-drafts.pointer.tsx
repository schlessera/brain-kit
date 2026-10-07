/// <reference types="@vitest/browser-playwright" />
/**
 * Per-session drafts in the real app (#951, D52 §5): every session keeps its
 * own composer draft, text and images, and New chat opens an empty one from
 * every entry point while the old draft stays where it was.
 *
 * The real AppShell, ChatPage and ActivityPage render in Chromium against a
 * real client root, inside the kit's `rail-fine`, `rail-coarse` and
 * `rail-mixed` projects, all with reduced motion. Only the transports are
 * fixtures: a socket the test delivers the host's frames over, and a
 * `request` that answers with Odysseus's sessions and keeps drafts by #979's
 * revision rules. No key, no network. The real host's draft routes are
 * proved by `tests/draft-runtime.test.ts`.
 *
 * Every test owns its scene: a fresh root and mount per cell, removed when
 * the cell ends, and nothing is pressed before entrances have settled
 * (#992). Presses are native mouse clicks or touch taps.
 */
import { afterAll, beforeAll, afterEach, expect, inject, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { trackerViews } from "../../src/stores/tracker-state.js";
import type { Draft } from "@schlessera/brain-ui-sdk/protocol";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

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
  drop() { this.readyState = 3; flushSync(() => this.onclose?.({ code: 1006, reason: "" } as CloseEvent)); }
  deliver(frame: unknown) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
  frames(type: string) { return this.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === type); }
}

const T0 = Date.UTC(2026, 6, 12, 9, 41);
const HOUR = 3_600_000;
const ITHACA = { id: "odysseus-ithaca", title: "The way home to Ithaca" };
const RAFT = { id: "odysseus-raft", title: "Raft lashing plan" };
const LISTED = [ITHACA, RAFT].map((s, i) => ({ ...s, createdAt: T0 - i * HOUR, lastActiveAt: Date.now() - i * HOUR, totalCostUsd: 0, numTurns: 1 }));

/** #979's rules, kept in memory: If-Match revisions, the host's version on a conflict, tombstones. */
function draftHost() {
  const rows = new Map<string, Draft & { deleted?: boolean }>();
  const images = new Map<string, { mime: string; bytes: string }>();
  let seq = 0;
  /** The next save of a draft meets another device's newer version. */
  let raceWith: string | null = null;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  async function handle(path: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const m = /\/drafts(?:\/([^/?]+))?(\/attachments|\/bind)?/.exec(path)!;
    const [, id, sub] = m;
    if (!id) return json({ drafts: [...rows.values()].filter((r) => !r.deleted).map((r) => ({ draftId: r.draftId, sessionId: r.sessionId, revision: r.revision, updatedAt: r.updatedAt, preview: r.text.split("\n")[0] ?? "", attachmentCount: r.attachments.length })) });
    const row = rows.get(id);
    const ifMatch = Number(headers.get("if-match"));
    if (sub === "/attachments") {
      const buf = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      let binary = "";
      for (const b of buf) binary += String.fromCharCode(b);
      const attachmentId = `att-${++seq}`;
      images.set(attachmentId, { mime: headers.get("content-type")!, bytes: btoa(binary) });
      return json({ attachmentId });
    }
    if (method === "GET") return row && !row.deleted ? json(row) : json({ error: "DRAFT_NOT_FOUND", message: "" }, 404);
    if (method === "DELETE") {
      if (!row || row.deleted) return new Response(null, { status: 204 });
      if (ifMatch !== row.revision) return json({ error: "DRAFT_CONFLICT", message: "", current: row }, 409);
      rows.set(id, { ...row, deleted: true, revision: row.revision + 1, text: "", attachments: [] });
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init.body)) as { sessionId: string | null; text: string; attachmentIds: string[] };
      if (row?.deleted) return json({ error: "DRAFT_DELETED", message: "", tombstoneRevision: row.revision }, 410);
      if (raceWith !== null && row) {
        rows.set(id, { ...row, revision: row.revision + 1, updatedAt: Date.now(), text: raceWith });
        raceWith = null;
      }
      const current = rows.get(id);
      if (current && ifMatch !== current.revision) return json({ error: "DRAFT_CONFLICT", message: "", current }, 409);
      const revision = (current?.revision ?? 0) + 1;
      rows.set(id, { draftId: id, sessionId: body.sessionId, revision, updatedAt: Date.now(), text: body.text,
        attachments: body.attachmentIds.map((a) => ({ attachmentId: a, mime: images.get(a)!.mime as "image/png", bytes: images.get(a)!.bytes, name: null })) });
      return json({ revision, updatedAt: Date.now() });
    }
    return json({ error: "DRAFT_INVALID", message: "" }, 400);
  }
  return { rows, handle, race: (text: string) => { raceWith = text; } };
}

function fixtureRequest(host: ReturnType<typeof draftHost>) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    if (path.includes("/drafts")) return host.handle(path, init);
    if (path.endsWith("/sessions")) return Response.json({ sessions: LISTED });
    if (path.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
    if (path.endsWith("/activity/inbox")) return Response.json({ intents: [] });
    return new Response("{}", { status: 404 });
  };
}

function Shell() {
  const view = useUIStore((s) => s.activeView);
  return <AppShell>{view === "activity" ? <ActivityPage /> : <ChatPage />}</AppShell>;
}

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; socket: FixtureSocket; drafts: ReturnType<typeof draftHost>; width: number; signal: AbortSignal };

let styles: HTMLStyleElement | undefined;
let viewport: { width: number; height: number };
let sized: string | undefined;

beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(async () => {
  styles?.remove();
  await page.viewport(viewport.width, viewport.height);
});
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  document.documentElement.dataset.theme = "dark";
  vi.unstubAllGlobals();
});

function pointer(): "fine" | "coarse" | "mixed" {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches, "reduced motion premise").toBe(true);
  return mode;
}

const settle = async (s: Scene, n = 3) => {
  for (let i = 0; i < n; i++) {
    s.signal.throwIfAborted();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  s.signal.throwIfAborted();
};

/** A finite animation or transition still running: a drawer entering, a sheet rising (#992). */
const moving = () => document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);

async function resize(width: number, height: number) {
  if (sized === `${width}x${height}`) return;
  sized = undefined;
  await page.viewport(width, height);
  await commands.formViewport(width, height);
  sized = `${width}x${height}`;
}

function history() {
  return Array.from({ length: 4 }, (_, i) => [
    { role: "user", content: `Day ${i + 1} out of Troy: which way is home?`, toolCalls: [] },
    { role: "assistant", content: "West, past the island of the Cyclopes.", toolCalls: [], turnId: `ithaca-turn-${i + 1}` },
  ]).flat();
}

async function mount(ctx: TestContext, width: number, height: number, theme: "dark" | "light", opts: { drafts?: boolean } = {}): Promise<Scene> {
  ctx.signal.throwIfAborted();
  vi.stubGlobal("WebSocket", FixtureSocket);
  await resize(width, height);
  ctx.signal.throwIfAborted();
  document.documentElement.dataset.theme = theme;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  const drafts = draftHost();
  const ui = createBrainUiRoot({ storage: null, request: fixtureRequest(drafts) });
  const renderer: Root = createRoot(host);
  ctx.onTestFinished(() => {
    flushSync(() => renderer.unmount());
    ui.dispose();
    host.remove();
  });
  ui.stores.ui.getState().setTheme(theme);
  ui.stores.chat.getState().setActiveSession(ITHACA.id);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Shell /></BrainUiProvider>));
  ui.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, followUpQueue: true, ...(opts.drafts === false ? {} : { sessionDrafts: true }) } });
  socket.deliver({ type: "session_info", sessionId: ITHACA.id, isNew: false });
  socket.deliver({ type: "session_history", sessionId: ITHACA.id, messages: history() });
  // The replay is over: nothing runs in A until a cell starts a turn.
  socket.deliver({ type: "status", sessionId: ITHACA.id, status: "idle" });
  const s: Scene = { ui, host, socket, drafts, width, signal: ctx.signal };
  await document.fonts.ready;
  await settle(s, 4);
  return s;
}

const rect = (el: Element) => el.getBoundingClientRect();
const composer = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const chips = (s: Scene) => [...s.host.querySelectorAll<HTMLImageElement>("[data-composer] img")];
const saveLine = (s: Scene) => s.host.querySelector<HTMLElement>("[data-draft-save]");

/** Counts alone also accept a broken image element: inspect what Chromium decoded. */
async function expectDraftImage(s: Scene) {
  await expect.poll(() => chips(s)[0]?.naturalWidth, { message: "the draft thumbnail decodes its PNG" }).toBe(64);
  const image = chips(s)[0]!;
  expect(image.naturalHeight).toBe(64);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0, 1, 1);
  expect([...context.getImageData(0, 0, 1, 1).data], "the saved blue image is painted").toEqual([30, 90, 160, 255]);
}

const views = (s: Scene) => trackerViews(s.ui.stores.trackers.getState(), s.ui.stores.chat.getState().queueNotes);

function find(name: string | RegExp, role?: string, within: ParentNode = document): HTMLElement | null {
  const all = [...within.querySelectorAll<HTMLElement>(role ? `[role="${role}"]` : 'button, [role="button"], [role="tab"]')];
  return all.find((el) => {
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const r = rect(el);
    return (typeof name === "string" ? label === name : name.test(label)) && r.width > 0 && r.height > 0;
  }) ?? null;
}
async function must(s: Scene, name: string | RegExp, role?: string): Promise<HTMLElement> {
  await expect.poll(() => find(name, role), { message: `a visible control ${name}` }).not.toBeNull();
  return find(name, role)!;
}

/** A native press: the mouse under a fine pointer, a touch tap otherwise. */
async function press(s: Scene, el: HTMLElement, mode: string) {
  await expect.poll(() => !moving(), { interval: 16, message: "entrances have settled" }).toBe(true);
  el.scrollIntoView({ block: "nearest" });
  await settle(s, 1);
  const r = rect(el);
  const point = { x: r.left + Math.min(12, r.width / 4), y: r.top + r.height / 2 };
  expect(el.contains(document.elementFromPoint(point.x, point.y)), "nothing covers the control").toBe(true);
  s.signal.throwIfAborted();
  if (mode === "fine") await commands.overlayMouse(point);
  else await commands.rankTap(point);
  await settle(s);
}

async function pngFile(name: string, color: string): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 64, 64);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}

/** The paperclip's library input, given a picked file as the system picker would. */
async function attach(s: Scene, file: File) {
  const input = s.host.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]:not([capture])')!;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function type(s: Scene, text: string) {
  await userEvent.fill(composer(s), text);
  await settle(s);
}

/** New chat at this width: the overlay disc below 1280, the pane's New conversation from 1280 (D52 §1). */
const newChatName = (width: number) => (width >= 1280 ? "New conversation" : "New chat");

/** Sessions at this width: the drawer below 1280, the pane from 1280. */
async function openSessions(s: Scene, mode: string) {
  if (s.width >= 1280) return;
  await press(s, await must(s, /^Sessions/, "tab"), mode);
  await expect.poll(() => s.ui.stores.ui.getState().sessionPanelOpen, { message: "Sessions is open" }).toBe(true);
}

const THEMES = ["dark", "light"] as const;

for (const width of [320, 390, 480, 900, 1280, 1440] as const) for (const theme of THEMES) {
  test(`${width} (${theme}): A's text and image survive New chat, B, Sessions and Actions; B is a Draft entry`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 800, theme);
    const wind = "Ask Aeolus for the west wind";
    await type(s, wind);
    await attach(s, await pngFile("bag-of-winds.png", "#1e5aa0"));
    await expect.poll(() => chips(s).length, { message: "A's image is in A's composer" }).toBe(1);
    await expect.poll(() => saveLine(s)?.dataset.draftSave, { message: "A's draft is saved on the host" }).toBe("saved");
    expect(saveLine(s)!.textContent).toBe("draft · saved");
    await expectDraftImage(s);

    // New chat: an empty composer, and nothing sent, cancelled or asked.
    const start = await must(s, newChatName(width));
    // A 44px touch reach (the disc's box, the pane button's height) under a coarse pointer.
    if (mode !== "fine") expect(rect(start).height, "New chat reaches 44px").toBeGreaterThanOrEqual(43.5);
    await press(s, start, mode);
    await expect.poll(() => s.ui.stores.chat.getState().activeSessionId, { message: "the new-chat view" }).toBeNull();
    expect(composer(s).value, "B starts empty").toBe("");
    expect(chips(s), "B shows none of A's images").toHaveLength(0);
    expect(saveLine(s), "no save line while there is no draft").toBeNull();
    expect(s.socket.frames("chat_message"), "nothing was sent").toHaveLength(0);
    expect(s.socket.frames("cancel"), "nothing was cancelled").toHaveLength(0);

    const letter = "Letter to Penelope";
    await type(s, letter);
    await expect.poll(() => saveLine(s)?.dataset.draftSave, { message: "B's draft is saved on the host" }).toBe("saved");

    // Sessions lists B as a Draft entry, and marks A's session as having one.
    await openSessions(s, mode);
    const entry = await must(s, `Draft: ${letter}, saved. Open draft.`);
    expect(entry.closest("[data-drafts-group]"), "under Drafts").not.toBeNull();
    const back = await must(s, `${ITHACA.title}, has a draft. Open session.`);
    expect(back.textContent, "the row prints its draft").toContain("draft · now");
    await press(s, back, mode);
    await expect.poll(() => s.ui.stores.chat.getState().activeSessionId, { message: "A is in view" }).toBe(ITHACA.id);
    await expect.poll(() => composer(s)?.value, { message: "A's exact text" }).toBe(wind);
    expect(chips(s), "A's image").toHaveLength(1);
    await expectDraftImage(s);

    // Actions unmounts the composer; coming back restores the draft by id.
    await press(s, await must(s, /^Actions/, "tab"), mode);
    await expect.poll(() => s.host.querySelector("[data-composer]"), { message: "the composer is gone" }).toBeNull();
    await press(s, await must(s, /^Chat/, "tab"), mode);
    await expect.poll(() => composer(s)?.value, { message: "A's text after the remount" }).toBe(wind);
    expect(chips(s), "A's image after the remount").toHaveLength(1);
    await expectDraftImage(s);

    // The Draft entry opens an empty Chat with B restored: no session, nothing sent.
    await openSessions(s, mode);
    await press(s, await must(s, `Draft: ${letter}, saved. Open draft.`), mode);
    await expect.poll(() => composer(s)?.value, { message: "B's text" }).toBe(letter);
    expect(s.ui.stores.chat.getState().activeSessionId).toBeNull();
    expect(chips(s)).toHaveLength(0);
    expect(s.socket.frames("chat_message")).toHaveLength(0);
  });
}

// New chat while A streams, from each entry point at its widths: no
// confirmation, no cancel, no send. A's work stays tracked, its draft kept.
const entries: Array<{ width: number; via: "disc" | "pane" | "palette" }> = [
  { width: 390, via: "disc" }, { width: 900, via: "disc" }, { width: 900, via: "palette" },
  { width: 1280, via: "pane" }, { width: 1440, via: "palette" },
];
for (const { width, via } of entries) for (const theme of THEMES) {
  test(`${width} (${theme}): New chat by the ${via} while A streams keeps A's work and draft`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 800, theme);
    s.socket.deliver({ type: "status", sessionId: ITHACA.id, status: "thinking", turnId: "ithaca-turn-5" });
    s.socket.deliver({ type: "text_delta", sessionId: ITHACA.id, turnId: "ithaca-turn-5", text: "Rowing past Scylla" });
    await type(s, "Keep the crew from the cattle of the sun");
    if (via === "palette") {
      await press(s, await must(s, /All commands/), mode);
      const palette = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Command palette"]');
      await expect.poll(palette, { message: "the palette is open" }).not.toBeNull();
      await expect.poll(() => find(/^New chat/, "option", palette()!), { message: "the palette's New chat row" }).not.toBeNull();
      await press(s, find(/^New chat/, "option", palette()!)!, mode);
    } else {
      await press(s, await must(s, newChatName(width)), mode);
    }
    await expect.poll(() => s.ui.stores.chat.getState().activeSessionId, { message: "the new-chat view" }).toBeNull();
    expect(find(/\bdiscard\b|\blose\b|are you sure/i), "no confirmation of any kind").toBeNull();
    expect(document.querySelector('[role="alertdialog"]'), "no confirmation dialog").toBeNull();
    expect(composer(s).value).toBe("");
    expect(s.socket.frames("cancel"), "the running turn is not cancelled").toHaveLength(0);
    expect(s.socket.frames("chat_message"), "nothing is sent").toHaveLength(0);
    await expect.poll(() => views(s).map((v) => [v.sessionId, v.state]), { message: "A is tracked" }).toEqual([[ITHACA.id, "running"]]);
    // A late frame for A does not select it or touch the new draft.
    await type(s, "Ask Hermes about moly");
    s.socket.deliver({ type: "text_delta", sessionId: ITHACA.id, turnId: "ithaca-turn-5", text: " and Charybdis" });
    await settle(s);
    expect(s.ui.stores.chat.getState().activeSessionId).toBeNull();
    expect(composer(s).value).toBe("Ask Hermes about moly");
    expect(s.ui.stores.drafts.getState().drafts[s.ui.stores.drafts.getState().idFor(ITHACA.id)]?.text).toBe("Keep the crew from the cattle of the sun");
  });
}

// Keyboard up (coarse pointers): the soft keyboard is supplied as a visual
// viewport 260px shorter, which is what `useSoftKeyboard` reads.
for (const width of [320, 390] as const) for (const theme of THEMES) {
  test(`${width} (${theme}): with the keyboard up, switching sessions mid-edit keeps each draft`, async (ctx) => {
    const mode = pointer();
    if (mode === "fine") ctx.skip();
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const fake = { get height() { return window.innerHeight - 260; }, width: window.innerWidth, scale: 1, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    ctx.onTestFinished(() => {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    });
    const s = await mount(ctx, width, 568, theme);
    await press(s, composer(s), mode);
    expect(document.activeElement, "the composer has focus").toBe(composer(s));
    await type(s, "Half a thought about the Phaeacians");
    await expect.poll(() => saveLine(s)?.dataset.draftSave, { message: "saved while typing" }).toBe("saved");
    expect(rect(saveLine(s)!).bottom, "the save line is on screen above the keyboard").toBeLessThanOrEqual(window.innerHeight);
    // Mid-edit, to another session and back.
    s.ui.stores.chat.getState().clearMessages();
    s.ui.stores.chat.getState().setActiveSession(RAFT.id);
    await settle(s);
    expect(composer(s).value, "the raft's own empty draft").toBe("");
    await type(s, "Twenty trees, felled");
    s.ui.stores.chat.getState().clearMessages();
    s.ui.stores.chat.getState().setActiveSession(ITHACA.id);
    await settle(s);
    expect(composer(s).value).toBe("Half a thought about the Phaeacians");
  });
}

// A send the host never confirmed, held for review (D52 §5).
for (const width of [390, 1280] as const) for (const theme of THEMES) {
  test(`${width} (${theme}): the socket closing after a send holds it for review; nothing is resent without Send again`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, width, 800, theme);
    const harbour = "Which harbour is safest on Ithaca?";
    await type(s, harbour);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => s.socket.frames("chat_message").length, { message: "sent once" }).toBe(1);
    expect(composer(s).value, "the field empties into the send").toBe("");
    s.socket.drop();
    await settle(s);
    const block = await expect.poll(() => s.host.querySelector<HTMLElement>("[data-unconfirmed-send]"), { message: "the review block" }).not.toBeNull()
      .then(() => s.host.querySelector<HTMLElement>("[data-unconfirmed-send]")!);
    expect(block.textContent).toContain("Didn't hear back");
    expect(block.textContent).toContain(harbour);
    for (const name of ["Check again", "Send again", "Edit"]) {
      const control = [...block.querySelectorAll<HTMLElement>('[role="button"]')].find((el) => el.textContent?.startsWith(name))!;
      expect(control, name).toBeTruthy();
      expect(rect(control).height, `${name} is 44px`).toBeGreaterThanOrEqual(mode === "fine" ? 30 : 43.5);
    }
    await settle(s, 6);
    expect(s.socket.frames("chat_message"), "no automatic resend").toHaveLength(1);

    // Back online: still nothing until Send again, which sends once, newly keyed.
    s.ui.connection.reconnectNow();
    const next = FixtureSocket.last!;
    flushSync(() => next.open());
    next.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, sessionDrafts: true } });
    await settle(s, 4);
    expect(next.frames("chat_message"), "a reconnect sends nothing").toHaveLength(0);
    const again = [...block.querySelectorAll<HTMLElement>('[role="button"]')].find((el) => el.textContent?.startsWith("Send again"))!;
    await press(s, again, mode);
    const resent = next.frames("chat_message");
    expect(resent, "Send again sends once").toHaveLength(1);
    expect(resent[0].text).toBe(harbour);
    expect(resent[0].requestId).not.toBe(s.socket.frames("chat_message")[0].requestId);

    // Silent again, then Edit: the words go back into this session's draft.
    next.drop();
    await expect.poll(() => s.host.querySelector("[data-unconfirmed-send]"), { message: "held again" }).not.toBeNull();
    const edit = [...s.host.querySelector<HTMLElement>("[data-unconfirmed-send]")!.querySelectorAll<HTMLElement>('[role="button"]')].find((el) => el.textContent?.startsWith("Edit"))!;
    await press(s, edit, mode);
    await expect.poll(() => composer(s).value, { message: "Edit restores the text" }).toBe(harbour);
    expect(s.host.querySelector("[data-unconfirmed-send]")).toBeNull();
  });
}

// Honest states the host cannot make true.
for (const width of [390, 1440] as const) for (const theme of THEMES) {
  test(`${width} (${theme}): a host without drafts keeps them here and says so; a conflict keeps both`, async (ctx) => {
    const mode = pointer();
    const local = await mount(ctx, width, 800, theme, { drafts: false });
    await type(local, "Ask Nausicaa about the washing place");
    await expect.poll(() => saveLine(local)?.textContent, { message: "the unavailable copy" }).toBe("draft · this host doesn't keep drafts · kept on this device");
    flushSync(() => local.host.remove());

    const s = await mount(ctx, width, 800, theme);
    await type(s, "Ask Eumaeus about the swineherd");
    await expect.poll(() => saveLine(s)?.dataset.draftSave).toBe("saved");
    s.drafts.race("Ask Eumaeus at dawn");
    await type(s, "Ask Eumaeus about the dog");
    await expect.poll(() => saveLine(s)?.dataset.draftSave, { message: "the conflict" }).toBe("conflict");
    expect(saveLine(s)!.textContent).toBe("draft changed on another device·Compare");
    expect(composer(s).value, "the visible words stay").toBe("Ask Eumaeus about the dog");
    const compare = await must(s, "Compare drafts");
    if (mode !== "fine") {
      // The button's reach, not its paint: 44px around the word.
      const r = rect(compare);
      const reach = document.elementFromPoint(r.left + r.width / 2, r.top - 12);
      expect(compare.contains(reach), "the reach above the word is the button's").toBe(true);
    }
    await press(s, compare, mode);
    const sheet = await expect.poll(() => document.querySelector<HTMLElement>("[data-compare-drafts]")).not.toBeNull().then(() => document.querySelector<HTMLElement>("[data-compare-drafts]")!);
    expect(sheet.querySelector('[data-compare-side="this"] p')!.textContent).toBe("Ask Eumaeus about the dog");
    expect(sheet.querySelector('[data-compare-side="other"] p')!.textContent).toBe("Ask Eumaeus at dawn");
    await press(s, await must(s, "Keep both"), mode);
    await expect.poll(() => saveLine(s)?.dataset.draftSave, { message: "this device's version saved" }).toBe("saved");
    await openSessions(s, mode);
    await must(s, /^Draft: Ask Eumaeus at dawn, /);
  });
}
