/// <reference types="@vitest/browser-playwright" />
/**
 * Media hygiene review end to end in the browser (#2783, epic #1777): the
 * real consumer against the real review server, real offline CLI and an
 * Odysseus brain with a bare remote (`ui-server/tests/helpers/media-flow.ts`,
 * booted by the C5 fixture's `mediaFlow`). Each of the five actions runs from
 * the card; the fixture then reads the brain's actual bytes and holds the
 * server's count and selection to the CLI's and an ordinary `brain sync`'s.
 * Raw previews come from the flow's real files route. Offline and keyless.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { DesktopPalette } from "../../src/components/layout/desktop-palette.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { stopHygieneFixture } from "./hygiene-fixture-stop.ts";

type Bytes = Record<string, string | null>;
type Counts = { awaitingReview: number; setAside: number; kept: number };
type Flow = {
  url: string; bytes?: Bytes; texts?: Record<string, string | null>; remote?: string[];
  parity?: { sync: { pending: number; setAside: { dismissed: number; snoozed: number; kept: number }; report: string } | null;
    server: { media: Counts | null; findingId: string | null; status: string }; cli: { media: Counts; findingId: string | null }; eligible: boolean | null };
};
let fixture: { id: string; url: string } | undefined;
let renderer: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined, socket: WebSocket | undefined;
let styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme;
const viewport = { width: innerWidth, height: innerHeight };
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(async () => {
  styles.remove();
  await page.viewport(viewport.width, viewport.height);
});
afterEach(async () => {
  const r = renderer, u = ui, s = socket, h = host, f = fixture;
  renderer = ui = socket = host = fixture = undefined;
  if (r) flushSync(() => r.unmount());
  u?.dispose();
  s?.close();
  h?.remove();
  if (f) await stopHygieneFixture(f.id);
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});

const LOOM = "photos/penelope-loom.png", SHIELD = "photos/achilles-shield.png", SKETCH = "inbox/cyclops-sketch.png", ARGUS = "photos/argus-waiting.png";
const HARBOUR = ".brain/scratch/2026-07-12/harbour-dawn.png";
const NOTE = "notes/the-return.md", CONFIG = "brain.config.json", PINS = ".brain/scratch-pins/pins.json", KEPT = "context/hygiene/kept.md";
const TRACK_PLACES = '{ "media": { "ignore": [".brain/scratch/**"], "track": ["places/**"] } }\n';

/** An applied effect captures, runs the CLI and selects again before its receipt replicates; the test's own limit still bounds it. */
const RECEIPT_MS = 10_000;
/** A selection, preview or reconnect waits on the real CLI and server, not on a frame. */
const SERVER_MS = 5_000;
const set = async (patch: Record<string, unknown>) => ((await commands.hygieneServer({ op: "set", id: fixture!.id, patch })) as { flow: Flow }).flow;

/** Open a socket to the flow's server and route the root's decisions over it, as the app's connection does. */
async function connect(root: BrainUiRoot, url: string) {
  const ws = socket = new WebSocket(`${url.replace("http:", "ws:")}/ws?as=owner`);
  root.connection.send = (msg) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };
  ws.onmessage = (e) => {
    const p = parseServerMessage(e.data);
    if (!p.ok) throw new Error(p.error);
    root.connection.handleServerMessage(p.message);
  };
  ws.onclose = () => root.stores.inbox.getState().connectionLost();
  await expect.poll(() => root.stores.inbox.getState().online, { timeout: SERVER_MS }).toBe(true);
}

async function scene(mediaFlow: { media: string[]; config?: string }, width: number, theme: string) {
  await page.viewport(width, 1000);
  document.documentElement.dataset.theme = theme;
  fixture = (await commands.hygieneServer({ op: "start" })) as NonNullable<typeof fixture>;
  const flow = await set({ mediaFlow });
  const root = ui = createBrainUiRoot({
    storage: null,
    // Raw media bytes come from the flow's real files route, as an `<img>` does from the host.
    config: { backendUrl: flow.url },
    request: async (url, init) => {
      const target = new URL(url, location.origin);
      // JSON goes through the page's same-origin hygiene route, which forwards it to the flow.
      if (target.pathname.includes("/hygiene/")) return fetch(`${target.pathname}${target.search}`, init);
      if (target.pathname.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
      if (target.pathname.endsWith("/activity/inbox")) return Response.json({ intents: [] });
      return new Response("{}", { status: 404 });
    },
  });
  await connect(root, flow.url);
  const h = host = document.createElement("div");
  h.style.height = "1000px";
  h.style.display = "flex";
  h.className = "bg-background text-foreground";
  document.body.append(h);
  const r = renderer = createRoot(h);
  flushSync(() => r.render(<BrainUiProvider root={root}><ActivityPage /><DesktopPalette /></BrainUiProvider>));
  await expect.poll(() => h.querySelector("[data-hygiene-id]"), { timeout: SERVER_MS }).not.toBeNull();
  if (width >= 1280) await page.getByRole("button", { name: /^Open finding:/ }).click();
  await expect.poll(() => h.querySelector("[data-hygiene-media]"), { timeout: SERVER_MS }).not.toBeNull();
  return flow;
}
const card = () => host!.querySelector<HTMLElement>("[data-hygiene-media]");
const title = () => card()?.querySelector<HTMLElement>("[data-hygiene-title]")?.textContent ?? null;
const region = () => card()?.querySelector<HTMLElement>('[role="region"][aria-label="Preview"]');
const status = () => card()?.querySelector<HTMLElement>('[role="status"][data-media-status]')?.textContent;
const commit = () => card()!.querySelectorAll<HTMLElement>("[data-bk-button]")[0]!;
const receipt = () => host!.querySelector<HTMLElement>("[data-media-receipt]")?.textContent ?? "";
const countLine = () => host!.querySelector("[data-hygiene-media-count]")?.textContent ?? null;
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
async function ready() {
  await expect.poll(() => status(), { timeout: SERVER_MS }).toBe("Preview ready");
  await expect.poll(() => region()?.dataset.mediaPreviewRegion, { timeout: SERVER_MS }).toBe("ready");
}
async function destination(value: string) {
  await page.getByRole("textbox", { name: /Destination/ }).fill(value);
  await userEvent.keyboard("{Enter}");
}
/** Leave pending, from the card, every finding before the one at `path`. */
async function reach(path: string) {
  for (let i = 0; i < 4 && title() !== name(path); i++) {
    const from = title();
    await page.getByRole("button", { name: "Leave pending", exact: true }).click();
    await expect.poll(() => title() !== null && title() !== from, { timeout: SERVER_MS }).toBe(true);
  }
  expect(title(), "MEDIA_FLOW_BROWSER_CARD").toBe(name(path));
}
/** The server and the CLI agree on count and selection; with a sync, so does `brain sync`, and the card's count line. */
async function agree(pending: number, options: { sync?: boolean; selected?: boolean } = {}) {
  // An Undo's receipt replicates before its request returns; the server's count settles with the request.
  await expect.poll(async () => ((await set({ flowRead: true })) as Flow & { flowRead: { review: { media?: Counts } } }).flowRead.review.media?.awaitingReview, { timeout: SERVER_MS }).toBe(pending);
  const { parity } = await set({ flowParity: options.sync === false ? "cli" : "sync", flowEligibility: options.selected === false });
  expect(parity!.server.media, "MEDIA_FLOW_BROWSER_SERVER_COUNT").toEqual({ awaitingReview: pending, setAside: 0, kept: 0 });
  expect(parity!.cli.media, "MEDIA_FLOW_BROWSER_CLI_COUNT").toEqual(parity!.server.media);
  if (options.selected !== false) expect(parity!.cli.findingId, "MEDIA_FLOW_BROWSER_SELECTION").toBe(parity!.server.findingId);
  else if (parity!.server.findingId) expect(parity!.eligible, "MEDIA_FLOW_BROWSER_SELECTION_ELIGIBLE").toBe(true);
  // A requested sync must answer: a missing one would skip every check below.
  expect(parity!.sync === null, "MEDIA_FLOW_BROWSER_SYNC_RAN").toBe(options.sync === false);
  if (parity!.sync) {
    expect(parity!.sync.pending, "MEDIA_FLOW_BROWSER_SYNC_COUNT").toBe(pending);
    expect(parity!.sync.report).toContain(`Media awaiting review: ${pending}`);
    for (const path of [LOOM, SHIELD, SKETCH, ARGUS, HARBOUR]) expect(parity!.sync.report).not.toContain(path);
  }
  await expect.poll(() => countLine(), { timeout: SERVER_MS }).toBe(`Media awaiting review: ${pending}`);
}
async function undo(prefix: RegExp, path: string) {
  await page.getByRole("button", { name: prefix }).click();
  await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect.poll(() => receipt(), { timeout: RECEIPT_MS }).toContain(`Undone · ${name(path)} is awaiting review again`);
}

test("dark 320: Persist here from the card tracks exactly the file; Undo from the receipt restores the config's bytes", async () => {
  const flow = await scene({ media: [SHIELD, ARGUS] }, 320, "dark");
  const before = (await set({ flowBytes: true })).bytes!;
  await reach(SHIELD);
  await page.getByRole("radio", { name: "Persist here" }).click();
  await ready();
  expect(commit().textContent).toBe(`Persist ${name(SHIELD)}`);
  commit().click();
  await expect.poll(() => receipt(), { timeout: RECEIPT_MS }).toContain(`Persisted · ${SHIELD}`);
  const applied = await set({ flowBytes: [CONFIG] });
  expect(applied.texts![CONFIG], "MEDIA_FLOW_BROWSER_PERSIST_CONFIG").toBe('{ "media": { "ignore": [".brain/scratch/**"], "track": ["photos/achilles-shield.png"] } }\n');
  expect(applied.bytes![SHIELD]).toBe(before[SHIELD]);
  await agree(1, { sync: false });
  await undo(/^Undo: Persisted/, SHIELD);
  expect((await set({ flowBytes: true })).bytes, "MEDIA_FLOW_BROWSER_PERSIST_UNDO").toEqual(before);
  await agree(2, { selected: false });
  expect(flow.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
});

test("light 1280: Move… with its destination moves the file and rewrites its reference; the next sync commits both", async () => {
  await scene({ media: [LOOM, ARGUS], config: TRACK_PLACES }, 1280, "light");
  await reach(LOOM);
  // The preview loads the file's real bytes from the files route.
  await expect.poll(() => card()!.querySelector<HTMLImageElement>("[data-media-frame] img")?.naturalWidth ?? 0, { timeout: SERVER_MS }).toBe(24);
  await page.getByRole("radio", { name: "Move to a final location" }).click();
  await destination("places/ithaca/penelope-loom.png");
  await ready();
  expect(region()!.textContent).toContain(NOTE);
  commit().click();
  await expect.poll(() => receipt(), { timeout: RECEIPT_MS }).toContain("Moved");
  const moved = await set({ flowBytes: [NOTE] });
  expect(moved.bytes![LOOM], "MEDIA_FLOW_BROWSER_MOVE_SOURCE").toBeNull();
  expect(moved.bytes!["places/ithaca/penelope-loom.png"], "MEDIA_FLOW_BROWSER_MOVE_DESTINATION").not.toBeNull();
  expect(moved.texts![NOTE], "MEDIA_FLOW_BROWSER_MOVE_REFERENCE").toContain("![loom](../places/ithaca/penelope-loom.png)");
  await agree(1);
  expect((await set({ flowRemote: true })).remote, "MEDIA_FLOW_BROWSER_MOVE_COMMITTED").toEqual(expect.arrayContaining(["places/ithaca/penelope-loom.png", NOTE]));
});

test("dark 1280: Delete… removes exactly the file, and Undo from the receipt restores its bytes", async () => {
  await scene({ media: [SKETCH, ARGUS] }, 1280, "dark");
  const before = (await set({ flowBytes: true })).bytes!;
  await reach(SKETCH);
  await page.getByRole("radio", { name: "Delete" }).click();
  await ready();
  expect(commit().textContent).toBe(`Delete ${name(SKETCH)}`);
  commit().click();
  await expect.poll(() => receipt(), { timeout: RECEIPT_MS }).toContain(`Deleted · ${SKETCH}`);
  expect((await set({ flowBytes: true })).bytes, "MEDIA_FLOW_BROWSER_DELETED").toEqual({ ...before, [SKETCH]: null });
  await agree(1, { sync: false });
  await undo(/^Undo: Deleted/, SKETCH);
  expect((await set({ flowBytes: true })).bytes, "MEDIA_FLOW_BROWSER_DELETE_UNDO").toEqual(before);
  await agree(2, { selected: false });
});

test("light 320: Keep a permanent copy… of linked scratch copies it and leaves the original and its pins; the next sync commits only the copy", async () => {
  await scene({ media: [HARBOUR, ARGUS] }, 320, "light");
  const before = (await set({ flowBytes: true })).bytes!;
  await reach(HARBOUR);
  await page.getByRole("radio", { name: "Keep a permanent copy" }).click();
  await destination("places/ithaca/harbour-dawn.png");
  await ready();
  commit().click();
  await expect.poll(() => receipt(), { timeout: RECEIPT_MS }).toContain("Kept a permanent copy at places/ithaca/harbour-dawn.png · the original stays linked to its conversation");
  const kept = await set({ flowBytes: [CONFIG, KEPT] });
  expect(kept.bytes!["places/ithaca/harbour-dawn.png"], "MEDIA_FLOW_BROWSER_KEEP_COPY").toBe(before[HARBOUR]);
  expect(kept.bytes![HARBOUR], "MEDIA_FLOW_BROWSER_KEEP_ORIGINAL").toBe(before[HARBOUR]);
  expect(kept.bytes![PINS], "MEDIA_FLOW_BROWSER_KEEP_PINS").toBe(before[PINS]);
  expect(kept.texts![CONFIG]).toBe('{ "media": { "ignore": [".brain/scratch/**"], "track": ["places/ithaca/harbour-dawn.png"] } }\n');
  expect(kept.texts![KEPT], "MEDIA_FLOW_BROWSER_KEEP_ENTRY").toContain("- copy: `places/ithaca/harbour-dawn.png`");
  // Pinned scratch is review-only: the routine count is the content file's alone.
  await agree(1);
  const remote = (await set({ flowRemote: true })).remote!;
  expect(remote, "MEDIA_FLOW_BROWSER_KEEP_COMMITTED").toContain("places/ithaca/harbour-dawn.png");
  expect(remote.filter((p) => p.startsWith(".brain/"))).toEqual([]);
});

test("dark 320: Leave pending, then the host restarts mid-pass and the device reconnects to the same card, deferral and count", async () => {
  const flow = await scene({ media: [SHIELD, ARGUS] }, 320, "dark");
  const first = title();
  await page.getByRole("button", { name: "Leave pending", exact: true }).click();
  await expect.poll(() => title() !== null && title() !== first, { timeout: SERVER_MS }).toBe(true);
  const second = title();
  await agree(2, { sync: false });
  // The host dies; the socket drops. The same state boots again on the same port.
  await set({ flowRestart: true });
  await expect.poll(() => ui!.stores.inbox.getState().online, { timeout: SERVER_MS }).toBe(false);
  await connect(ui!, flow.url);
  await expect.poll(() => title(), { timeout: SERVER_MS }).toBe(second);
  expect((await set({ flowRead: true }) as Flow & { flowRead: { review: { deferred: unknown[] } } }).flowRead.review.deferred, "MEDIA_FLOW_BROWSER_RESTART_DEFERRAL").toHaveLength(1);
  await agree(2);
  await page.getByRole("button", { name: "Leave pending", exact: true }).click();
  await expect.poll(() => card(), { timeout: SERVER_MS }).toBeNull();
  await expect.poll(() => countLine(), { timeout: SERVER_MS }).toBe("Media awaiting review: 2");
  expect((await set({ flowBytes: true })).bytes![SHIELD]).not.toBeNull();
});
