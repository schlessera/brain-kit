/// <reference types="@vitest/browser-playwright" />
/**
 * The composer's draft indicator in Chromium (#3155, design brief rev 4 §1
 * cases 17 and 18, rev 5 §1 cases 20 and 21). The real Composer and the real
 * draft client run against the fixture host in `../snapshot-host.ts`, which
 * keeps the host's If-Match, idempotent-save and file-reference rules in
 * memory. A "reload" is a new root against the same host and the same
 * device-local partition. No key, no network. Odysseus fixtures only.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../../src/components/chat/composer.js";
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
let themeBefore: string | undefined;
let outer: { width: number; height: number } | undefined;
/** The page's motion preference as this file found it: later files in the shard rely on it. */
let motionBefore: "reduce" | "no-preference";
beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  motionBefore = matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference";
  themeBefore = document.documentElement.dataset.theme;
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
afterEach(async () => {
  for (const s of scenes.splice(0)) if (!s.disposed) { flushSync(() => s.renderer.unmount()); s.root.dispose(); s.host.remove(); }
  vi.unstubAllGlobals();
  restoreOnline();
  document.documentElement.dataset.theme = themeBefore;
  // Put back the preference this file found, not a fixed one: the pinned runner
  // starts with reduced motion, and later files measure layouts with it.
  await commands.dictationMotion(motionBefore);
  if (outer) { await commands.formViewport(outer.width - 100, outer.height - 120); outer = undefined; }
});
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });

const HELLO = {
  type: "server_hello", protocolRev: 5,
  capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true, sessionRecovery: true },
  attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 },
  sessionDraftLimits: { maxTextBytes: 65_536, maxDraftBytes: 8_388_608, maxDrafts: 100, maxTotalBytes: 268_435_456, maxOutgoingSnapshots: 10 },
};

/** A device-local partition that survives the "reload": the same prefix and account. */
type Device = { prefix: string };
const device = (): Device => ({ prefix: `odysseus-3155-${crypto.randomUUID()}` });

async function mount(fixture: SnapshotHost, options: { width?: number; height?: number; device?: Device } = {}) {
  const width = options.width ?? 1280;
  const height = options.height ?? 900;
  await page.viewport(width, height);
  emulateOnline();
  const root = options.device
    ? createBrainUiRoot({ storagePrefix: options.device.prefix, request: fixture.request })
    : createBrainUiRoot({ storage: null, request: fixture.request });
  vi.stubGlobal("WebSocket", FixtureSocket);
  root.stores.chat.getState().setActiveSession(SESSION);
  // The account this device's work is kept under (#1014): a reload restores it.
  if (options.device) root.stores.connection.getState().setVpnStatus("connected", "odysseus");
  root.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver(HELLO);
  socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false });
  socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] });
  socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  if (options.device) await root.localWork!.restoring();
  const host = document.createElement("div");
  host.style.cssText = `width:${Math.min(width, 900)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  const renderer = createRoot(host);
  const scene = { host, renderer, root, disposed: false };
  scenes.push(scene);
  flushSync(() => renderer.render(<BrainUiProvider root={root}>
    <Composer send={(msg) => root.connection.send(msg)} />
  </BrainUiProvider>));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const field = () => host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  const wrapper = () => host.querySelector<HTMLElement>("[data-draft-indicator]")!;
  const trigger = () => host.querySelector<HTMLButtonElement>("[data-draft-indicator] .bk-status-indicator-btn");
  /** The kit's own state attribute: what the glyph shows. */
  const shown = () => host.querySelector("[data-draft-indicator] [data-status-indicator]")?.getAttribute("data-status-indicator") ?? null;
  const key = () => wrapper().getAttribute("data-draft-save");
  const summary = () => wrapper().getAttribute("data-draft-summary");
  const draft = () => { const s = root.stores.drafts.getState(); return s.drafts[s.idFor(SESSION)]; };
  const reload = () => { flushSync(() => renderer.unmount()); root.dispose(); host.remove(); scene.disposed = true; };
  return { root, host, socket, field, wrapper, trigger, shown, key, summary, draft, reload };
}
type Scene = Awaited<ReturnType<typeof mount>>;

const details = () => document.querySelector<HTMLElement>("[data-status-details]");
/** A kit Button inside a `data-draft-action` wrapper. */
const detailAction = (name: string) => document.querySelector<HTMLElement>(`[data-draft-action="${name}"] [data-bk-button]`);
const typed = async (s: Scene, text: string) => { await userEvent.fill(s.field(), text); };
const puts = (fixture: SnapshotHost) => fixture.calls.filter((c) => c.startsWith("PUT ")).length;
const gets = (fixture: SnapshotHost, id: string) => fixture.calls.filter((c) => c === `GET /api/drafts/${id}`).length;
const pickFiles = (s: Scene, files: File[]) => {
  const input = s.host.querySelector<HTMLInputElement>("input[data-files-input]")!;
  const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
};
const opacitySamples = async (el: Element, n = 8) => {
  const values: number[] = [];
  for (let i = 0; i < n; i++) { values.push(Number(getComputedStyle(el).opacity)); await new Promise((resolve) => setTimeout(resolve, 130)); }
  return values;
};
/** Samples of what the indicator showed, every animation frame, while `during` runs. */
async function watching<T>(s: Scene, during: () => Promise<T>): Promise<{ seen: string[]; result: T }> {
  const seen: string[] = [];
  let on = true;
  const tick = () => { if (!on) return; const now = `${s.shown()}:${s.key()}`; if (seen.at(-1) !== now) seen.push(now); requestAnimationFrame(tick); };
  tick();
  try { return { seen, result: await during() }; } finally { on = false; }
}

test("case 17: success only once the host acknowledged this revision; an edit is active, then success; an older acknowledgement is never success", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  expect(s.key(), "an empty draft: hidden").toBe("none");
  expect(s.trigger(), "no control while hidden").toBeNull();
  expect(s.host.querySelector("[data-draft-indicator] .bk-status-indicator-slot"), "its slot is reserved").not.toBeNull();

  let release = fixture.holdSaves();
  await typed(s, "Ask Aeolus which wind takes us home to Ithaca.");
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("active");
  expect(s.summary()).toBe("Saving draft…");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(s.shown(), "unanswered: never success").toBe("active");
  release();
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
  expect(fixture.saves.at(-1)!.body.text, "the acknowledged save is this text").toBe(s.field().value);
  expect(s.summary()).toMatch(/^Draft saved \d\d:\d\d: this text\.$/);

  // An edit after the acknowledgement: active, then success again.
  release = fixture.holdSaves();
  const { seen } = await watching(s, async () => {
    await typed(s, "Ask Aeolus which wind takes us home to Ithaca, and how long.");
    await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("active");
    release();
    await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
  });
  expect(seen[0], "acknowledged before the edit").toBe("success:saved");
  expect(seen[1], "the edit leaves success at once, for active").toMatch(/^active:/);
  // Sampled each frame until the poll saw success: at most the final sample is success.
  const early = seen.slice(1).findIndex((x) => x.startsWith("success"));
  expect(early === -1 || early === seen.length - 2, `no success until the new acknowledgement: ${seen.join(" → ")}`).toBe(true);
  expect(fixture.saves.at(-1)!.body.text).toBe("Ask Aeolus which wind takes us home to Ithaca, and how long.");

  // An acknowledgement of an older revision while this one is newer.
  release = fixture.holdSaves();
  await typed(s, "Older words for the wind.");
  await expect.poll(() => fixture.calls.filter((c) => c.startsWith("PUT ")).length, { timeout: 5_000 }).toBe(3);
  await typed(s, "Newer words: bind me to the mast.");
  const second = fixture.holdSaves.bind(fixture);
  release();
  const releaseNewer = second();
  await expect.poll(() => fixture.saves.at(-1)?.body.text, { timeout: 5_000 }).toBe("Older words for the wind.");
  await expect.poll(() => s.draft()?.host?.revision, { timeout: 5_000 }).toBe(fixture.rows.get(s.draft()!.draftId)!.revision);
  expect(s.draft()!.host!.edit, "the host acknowledged an older edit").toBeLessThan(s.draft()!.edit);
  expect(s.shown(), "an older acknowledgement is not success").not.toBe("success");
  expect(s.key()).toBe("saving");
  releaseNewer();
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
  expect(fixture.saves.at(-1)!.body.text).toBe("Newer words: bind me to the mast.");
});

test("case 18: opening details makes no request; Check again makes one read; focus returns to the indicator; reduced motion is a static glyph", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  await typed(s, "Count the oars before we row past the Sirens.");
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");

  // Opening and closing details is not a request of any kind.
  const before = fixture.calls.length;
  s.trigger()!.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => details() !== null).toBe(true);
  expect(details()!.textContent).toContain(s.summary()!);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement).toBe(s.trigger());
  expect(fixture.calls.length, "details read and write nothing").toBe(before);

  // An answer lost: Check again is one read, and focus comes back to the indicator.
  fixture.loseSaveAnswers();
  await typed(s, "Count the oars twice before we row past the Sirens.");
  await expect.poll(() => s.key(), { timeout: 5_000 }).toBe("unconfirmed");
  expect(s.shown()).toBe("unknown");
  fixture.loseSaveAnswers(false);
  const id = s.draft()!.draftId;
  const reads = gets(fixture, id);
  await userEvent.click(s.trigger()!);
  await expect.poll(() => detailAction("check") !== null).toBe(true);
  expect(gets(fixture, id), "opening details: no read").toBe(reads);
  await userEvent.click(detailAction("check")!);
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
  expect(gets(fixture, id), "Check again: one read").toBe(reads + 1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement, { message: "focus returns to the indicator" }).toBe(s.trigger());

  // Motion: only active work moves, and reduced motion keeps it still with the same glyph and name.
  // The pinned runner may start with reduced motion; this case sets each preference itself.
  await commands.dictationMotion("no-preference");
  const glyph = () => s.host.querySelector("[data-draft-indicator] .bk-status-glyph")!;
  expect(glyph().getAnimations(), "success is static").toEqual([]);
  const release = fixture.holdSaves();
  await typed(s, "Count the oars three times.");
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("active");
  await expect.poll(() => glyph().getAnimations().length, { message: "active breathes" }).toBeGreaterThan(0);
  expect(new Set(await opacitySamples(glyph())).size, "active visibly breathes").toBeGreaterThan(1);
  const name = s.trigger()!.getAttribute("aria-label");
  const shape = glyph().querySelector("svg")!.getAttribute("class");
  await commands.dictationMotion("reduce");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  expect(new Set(await opacitySamples(glyph())), "reduced motion: a static glyph").toEqual(new Set([1]));
  expect(s.trigger()!.getAttribute("aria-label")).toBe(name);
  expect(glyph().querySelector("svg")!.getAttribute("class")).toBe(shape);
  release();
});

test("case 21: an acknowledgement lost, then Check again: one GET, no PUT, and the matching revision shows success", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  await typed(s, "Leave the cattle of Helios alone.");
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
  fixture.loseSaveAnswers();
  await typed(s, "Leave the cattle of Helios alone, whatever the hunger.");
  await expect.poll(() => s.key(), { timeout: 5_000 }).toBe("unconfirmed");
  const id = s.draft()!.draftId;
  expect(s.summary()).toBe("Couldn't confirm the draft was saved.");
  expect(fixture.rows.get(id)!.text, "the host stored it").toBe("Leave the cattle of Helios alone, whatever the hunger.");

  await userEvent.click(s.trigger()!);
  await expect.poll(() => detailAction("check") !== null).toBe(true);
  expect(details()!.textContent).toContain("earlier revision");
  const readsBefore = gets(fixture, id);
  const putsBefore = puts(fixture);
  await userEvent.click(detailAction("check")!);
  await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
  expect(gets(fixture, id) - readsBefore, "exactly one GET").toBe(1);
  expect(puts(fixture) - putsBefore, "no PUT").toBe(0);
  expect(s.draft()!.host!.revision, "the revision the lost save made").toBe(fixture.rows.get(id)!.revision);
  expect(s.draft()!.host!.edit).toBe(s.draft()!.edit);
});

test("case 20: a file still uploading when the page closed is not restored; the notice names it and claims nothing about cleanup", async () => {
  const fixture = snapshotHost();
  const here = device();
  const first = await mount(fixture, { device: here });
  await typed(first, "Bring the harbour permit to the council.");
  await expect.poll(() => first.shown(), { timeout: 5_000 }).toBe("success");
  const releaseUpload = fixture.holdUploads();
  pickFiles(first, [new File(["%PDF-1.4 harbour permit\n"], "harbor-permit-2026.pdf", { type: "application/pdf" })]);
  await expect.poll(() => fixture.uploads.length, { timeout: 5_000 }).toBe(1);
  expect(first.host.querySelectorAll("[data-file-chip]")).toHaveLength(1);
  await expect.poll(() => first.shown()).toBe("queued");
  expect(first.summary()).toBe("Not saved yet: harbor-permit-2026.pdf is still uploading. Your text is kept in this tab.");
  await first.root.localWork!.snapshotNow();
  first.reload();

  const second = await mount(fixture, { device: here });
  await expect.poll(() => second.field().value, { timeout: 5_000 }).toBe("Bring the harbour permit to the council.");
  const notice = () => second.host.querySelector<HTMLElement>("[data-upload-notice]");
  await expect.poll(() => notice()?.querySelector("[data-upload-notice-text]")?.textContent ?? null, { timeout: 5_000 })
    .toBe("harbor-permit-2026.pdf was still uploading when the page closed. It isn't attached. Choose it again to attach it.");
  expect(second.host.querySelectorAll("[data-file-chip]"), "its chip is gone").toHaveLength(0);
  expect(notice()!.textContent, "no claim about storage or cleanup").not.toMatch(/stored|removed|deleted|clean|hour|day/i);

  // The host finishes storing the bytes it received. Its own references,
  // not the copy, decide the cleanup: the file was never bound, so 1 hour.
  releaseUpload();
  await expect.poll(() => fixture.files.size, { timeout: 5_000 }).toBe(1);
  const [fileId] = [...fixture.files.keys()];
  expect(fixture.refs.get(fileId!)?.size ?? 0, "no draft, snapshot or message names it").toBe(0);
  expect(fixture.cleanupRule(fileId!), "never bound: the host's 1-hour rule").toBe("1 hour");
  expect(fixture.rows.get(second.draft()!.draftId)?.files ?? [], "the restored draft binds nothing").toEqual([]);

  await userEvent.click(notice()!.querySelector<HTMLElement>("[data-bk-button]")!);
  await expect.poll(() => notice()).toBeNull();
});

for (const width of [320, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`${theme} ${width}: attach · indicator · send are 44px-separated boxes that never overlap, and an empty draft keeps the slot`, async () => {
    outer = await commands.formViewport(width, 600);
    document.documentElement.dataset.theme = theme;
    const fixture = snapshotHost();
    const s = await mount(fixture, { width, height: 600 });
    const field = () => s.host.querySelector<HTMLElement>("[data-composer] .bk-field")!;
    const emptyHeight = field().getBoundingClientRect().height;
    const slot = s.host.querySelector<HTMLElement>("[data-composer-status]")!;
    expect(slot.getBoundingClientRect().width).toBe(44);
    expect(slot.getBoundingClientRect().height).toBe(44);
    await typed(s, "Ask Aeolus.");
    await expect.poll(() => s.shown(), { timeout: 5_000 }).toBe("success");
    expect(field().getBoundingClientRect().height, "no layout shift when the indicator appears").toBe(emptyHeight);
    const box = (el: Element) => el.getBoundingClientRect();
    const attach = box(s.host.querySelector('[data-composer] [role="button"][aria-label^="Attach"]')!);
    const indicator = box(s.trigger()!);
    const text = box(s.field());
    const send = box(s.host.querySelector('[data-composer] [aria-label^="Send"]')!);
    expect(indicator.width).toBe(44);
    expect(indicator.height).toBe(44);
    expect(indicator.left, "after attach, touching or apart").toBeGreaterThanOrEqual(attach.right - 0.5);
    expect(indicator.right, "before the field").toBeLessThanOrEqual(text.left + 0.5);
    expect(send.left).toBeGreaterThanOrEqual(indicator.right);
    expect(indicator.left).toBeGreaterThanOrEqual(0);
    expect(indicator.right).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(width);
    expect(getComputedStyle(s.trigger()!).color, "the glyph has its own tone").not.toBe(getComputedStyle(s.field()).color);
    s.trigger()!.focus();
    await page.screenshot({ element: s.host, path: `../../.vitest-attachments/draft-indicator/${theme}-${width}.png` });
  });
}
