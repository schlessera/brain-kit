/// <reference types="@vitest/browser-playwright" />
/**
 * Media findings in hygiene review (#2782), in the real consumer against the
 * offline C5 fixture: real routes, review coordinator, SQLite and stream, a
 * deterministic CLI and journal stand-in, and a logged raw files route.
 * Design: #1777 rev 4 §8, rev 5 §8.1/§11, rev 6 §5.
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

type Fixture = { calls: string[][]; files: string[]; read: { review: { status: string; media?: unknown } } };
let fixture: { id: string; url: string } | undefined;
let renderer: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined, socket: WebSocket | undefined;
let styles: HTMLStyleElement;
const frames: Array<{ type: string; optionId?: string }> = [];
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
  frames.length = 0;
  if (r) flushSync(() => r.unmount());
  u?.dispose();
  s?.close();
  h?.remove();
  if (f) await stopHygieneFixture(f.id);
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
});
// Kept real time: a second media request, or one before Load, would come from
// Chromium's native loader for an element a later render mounts. No page event
// marks a request that is never made, so these cases read the fixture's file
// log after a window in which such a render and its request would arrive.
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = async (patch: Record<string, unknown>) => (await commands.hygieneServer({ op: "set", id: fixture!.id, patch })) as Fixture;

const HARBOUR = ".brain/scratch/2026-07-11/harbour-dawn.jpg";
const MAP = "inbox/ithaca-map.png";
const ITHACA_ONLY = [{ id: "media-ithaca-map", path: MAP, source: "content", classes: ["MEDIA"], bytes: 2_516_582,
  links: { state: "complete", conversations: 0 }, refs: 2, probe: { width: 2048, height: 1536, durationMs: null } }];

async function scene(patch: Record<string, unknown> = {}, width = 320, theme = "dark") {
  await page.viewport(width, 1000);
  document.documentElement.dataset.theme = theme;
  const f = fixture = (await commands.hygieneServer({ op: "start" })) as NonNullable<typeof fixture>;
  await set({ category: "media", mediaFiles: "default", ...patch, start: true });
  const root = ui = createBrainUiRoot({
    storage: null,
    // Raw media bytes come from the fixture's own origin, as an `<img>` does from the host.
    config: { backendUrl: f.url },
    request: async (url, init) => {
      const target = new URL(url, location.origin);
      // JSON goes through the page's same-origin hygiene route, as in the C5 scenes.
      if (target.pathname.includes("/hygiene/")) return fetch(`${target.pathname}${target.search}`, init);
      if (target.pathname.endsWith("/activity/runs")) return Response.json({ live: [], history: [] });
      if (target.pathname.endsWith("/activity/inbox")) return Response.json({ intents: [] });
      return new Response("{}", { status: 404 });
    },
  });
  const ws = socket = new WebSocket(f.url.replace("http:", "ws:") + "/ws");
  root.connection.send = (msg) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    frames.push(msg as { type: string; optionId?: string });
    ws.send(JSON.stringify(msg));
    return true;
  };
  ws.onmessage = (e) => {
    const p = parseServerMessage(e.data);
    if (!p.ok) throw new Error(p.error);
    root.connection.handleServerMessage(p.message);
  };
  ws.onclose = () => root.stores.inbox.getState().connectionLost();
  await expect.poll(() => root.stores.inbox.getState().online).toBe(true);
  const h = host = document.createElement("div");
  h.style.height = "1000px";
  h.style.display = "flex";
  h.className = "bg-background text-foreground";
  document.body.append(h);
  const r = renderer = createRoot(h);
  flushSync(() => r.render(<BrainUiProvider root={root}><ActivityPage /><DesktopPalette /></BrainUiProvider>));
  await expect.poll(() => h.querySelector("[data-hygiene-id]")).not.toBeNull();
  if (width >= 1280) await page.getByRole("button", { name: /^Open finding:/ }).click();
  await expect.poll(() => h.querySelector("[data-hygiene-media]")).not.toBeNull();
  return h;
}
const card = () => host!.querySelector<HTMLElement>("[data-hygiene-media]")!;
const title = () => card().querySelector<HTMLElement>("[data-hygiene-title]")!;
const region = () => card().querySelector<HTMLElement>('[role="region"][aria-label="Preview"]');
const status = () => card().querySelector<HTMLElement>('[role="status"][data-media-status]')!.textContent;
const alertText = () => card().querySelector<HTMLElement>("[data-media-alert]")!.textContent;
const commit = () => card().querySelectorAll<HTMLElement>("[data-bk-button]")[0]!;
const disabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";
const radio = (name: string | RegExp) => page.getByRole("radio", { name });
async function destination(value: string, enter = true) {
  const input = page.getByRole("textbox", { name: /Destination|Rule/ });
  await input.fill(value);
  if (enter) await userEvent.keyboard("{Enter}");
}
async function ready(text: string) {
  await expect.poll(() => status()).toBe(text);
  await expect.poll(() => region()?.dataset.mediaPreviewRegion).toBe("ready");
}
const requests = async (path: string) => (await set({})).files.filter((f) => f === path).length;

const MATRIX = [["dark", 320], ["dark", 1280], ["light", 320], ["light", 1280]] as const;

for (const [theme, width] of MATRIX) {
  test(`${theme} ${width}: K1 linked scratch — five rows, two unavailable with reasons, nothing chosen, one image request`, async () => {
    await scene({}, width, theme);
    expect(title().textContent).toBe("harbour-dawn.jpg");
    expect(card().textContent).toContain(HARBOUR);
    // Persist and Move stay in order, named with their reasons; nothing is preselected.
    const names = [...card().querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual([
      "Persist here, unavailable: scratch is temporary. Keep a copy instead",
      "Move to a final location, unavailable: linked from 2 conversations",
      "Keep a permanent copy",
      "Delete",
    ]);
    expect([...card().querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) => r.checked)).toHaveLength(0);
    expect(card().querySelectorAll('input[aria-disabled="true"]')).toHaveLength(2);
    expect(commit().textContent).toBe("Apply");
    expect(disabled(commit())).toBe(true);
    expect(status()).toBe("Choose what should happen to this file.");
    // Facts and the probed size come from the host, not guessed.
    expect(card().textContent).toContain("4032 × 3024");
    expect(card().textContent).toContain("JPEG image · 3.1 MB");
    expect(card().textContent).toContain("2 conversations (scratch pins)");
    // 44px: rows are their own target; buttons reach through `.bk-hit`, never a painted box.
    for (const row of card().querySelectorAll<HTMLElement>("[data-media-row]")) expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    for (const b of card().querySelectorAll<HTMLElement>("[data-bk-button]")) expect(b.classList.contains("bk-hit")).toBe(true);
    // A scratch image is one full-snapshot request, made once.
    await expect.poll(() => card().querySelector<HTMLImageElement>("[data-media-frame] img")?.complete).toBe(true);
    await settle(400);
    expect(await requests(HARBOUR)).toBe(1);
    await commands.hygieneServer({ op: "capture", name: `media-k1-${theme}-${width}.png`, selector: ".bg-background.text-foreground" });
  });

  test(`${theme} ${width}: K2 → K3 Keep a permanent copy previews, applies, hands focus on and Undo restores`, async () => {
    await scene({}, width, theme);
    await radio("Keep a permanent copy").click();
    expect(status()).toBe("Enter a destination to see what changes.");
    await destination("places/ithaca/harbour-dawn.jpg");
    await ready("Preview ready");
    const text = region()!.textContent!;
    expect(text).toContain("KEEP A PERMANENT COPY · PREVIEW");
    expect(text).toContain("→ places/ithaca/harbour-dawn.jpg · new file · destination free");
    expect(text).toContain('media.track: + "places/ithaca/harbour-dawn.jpg" (exact file)');
    expect(text).toContain("two copies remain · +3.1 MB on disk");
    expect(text).toContain("original stays in scratch while 2 conversations link it");
    expect(commit().textContent).toBe("Keep a copy of harbour-dawn.jpg");
    expect(disabled(commit())).toBe(false);
    // Focus never moves when a preview arrives.
    expect(document.activeElement?.getAttribute("type")).toBe("text");
    await commands.hygieneServer({ op: "capture", name: `media-k2-${theme}-${width}.png`, selector: ".bg-background.text-foreground" });
    commit().click();
    const receipt = () => host!.querySelector<HTMLElement>("[data-media-receipt]");
    await expect.poll(() => receipt()?.textContent ?? "").toContain("Kept a permanent copy at places/ithaca/harbour-dawn.jpg · the original stays linked to its conversation");
    expect(receipt()!.textContent).toContain("original unchanged in scratch, still linked");
    await expect.poll(() => title()?.textContent).toBe("ithaca-map.png");
    await expect.poll(() => document.activeElement === title()).toBe(true);
    await expect.poll(() => host!.querySelector("[data-hygiene-media-count]")?.textContent).toBe("Media awaiting review: 1 · 1 kept as a copy");
    await commands.hygieneServer({ op: "capture", name: `media-k3-${theme}-${width}.png`, selector: ".bg-background.text-foreground" });
    await page.getByRole("button", { name: /^Undo: Kept a permanent copy/ }).click();
    await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
    await expect.poll(() => receipt()?.textContent ?? "").toContain("Undone · harbour-dawn.jpg is awaiting review again");
    expect((await set({})).calls.filter((c) => c[0] === "media-undo")).toHaveLength(1);
  });

  test(`${theme} ${width}: Move rewrites links; a refused destination names its reason; Delete names the file`, async () => {
    await scene({ mediaFiles: ITHACA_ONLY }, width, theme);
    expect([...card().querySelectorAll('input[type="radio"]')].map((r) => r.getAttribute("aria-label"))).toEqual([
      "Persist here", "Persist with a broader rule", "Move to a final location", "Delete",
    ]);
    await set({ planRefusals: { "places/ithaca/taken.png": [{ code: "exists" }] } });
    await radio("Move to a final location").click();
    await destination("places/ithaca/taken.png");
    await expect.poll(() => alertText()).toBe("Something is already at that path. Nothing is overwritten.");
    expect(region()!.dataset.mediaPreviewRegion).toBe("refused");
    expect(commit().textContent).toBe("Move unavailable");
    expect(disabled(commit())).toBe(true);
    // Typing waits 400 ms, then previews without Enter.
    await destination("places/ithaca/map.png", false);
    await ready("Preview ready");
    expect(region()!.textContent).toContain("journeys/return-to-ithaca.md:14");
    expect(region()!.textContent).toContain("+ ![[places/ithaca/map.png]]");
    expect(region()!.textContent).toContain("Links from outside this brain (sites, other apps, chat history) can't be updated.");
    expect(commit().textContent).toBe("Move and update 2 links");
    await radio("Delete").click();
    await ready("Preview ready");
    expect(region()!.textContent).toContain("2 references will point to a missing file");
    expect(commit().textContent).toBe("Delete ithaca-map.png");
    await commands.hygieneServer({ op: "capture", name: `media-delete-${theme}-${width}.png`, selector: ".bg-background.text-foreground" });
    commit().click();
    await expect.poll(() => host!.querySelector("[data-media-receipt]")?.textContent ?? "").toContain(`Deleted · ${MAP}`);
    expect((await set({})).calls.filter((c) => c[0] === "media-apply")).toEqual([["media-apply", "delete", ""]]);
  });

  test(`${theme} ${width}: stale at apply re-previews with a focused banner; the commit waits for the current preview`, async () => {
    await scene({}, width, theme);
    await radio("Keep a permanent copy").click();
    await destination("places/ithaca/harbour-dawn.jpg");
    await ready("Preview ready");
    await set({ applyMode: "stale", holdPlans: true });
    commit().click();
    await expect.poll(() => host!.querySelector("[data-media-banner]")?.textContent).toBe("Changed since the preview. Updated below. Check it before applying.");
    await expect.poll(() => document.activeElement === host!.querySelector("[data-media-banner]")).toBe(true);
    await expect.poll(() => region()?.dataset.mediaPreviewRegion).toBe("checking");
    expect(disabled(commit())).toBe(true);
    await set({ releasePlans: true, applyMode: "" });
    await ready("Preview ready");
    expect(disabled(commit())).toBe(false);
  });

  test(`${theme} ${width}: partial focuses Show files; an interrupted copy (K4) focuses Check again and says nothing was kept`, async () => {
    await scene({}, width, theme);
    await radio("Keep a permanent copy").click();
    await destination("places/ithaca/harbour-dawn.jpg");
    await ready("Preview ready");
    await set({ applyMode: "partial" });
    commit().click();
    await expect.poll(() => card().querySelector("[data-media-outcome]")?.textContent ?? "").toContain("Copy kept with problems: 1 item couldn't be put back.");
    await expect.poll(() => document.activeElement?.textContent).toBe("Show files ▾");
    (document.activeElement as HTMLButtonElement).click();
    await expect.poll(() => card().textContent).toContain("places/ithaca.md · conflict, edited after the change, left as is");
    await set({ applyMode: "compensated" });
    await radio("Delete").click();
    await radio("Keep a permanent copy").click();
    await ready("Preview ready");
    commit().click();
    await expect.poll(() => card().querySelector("[data-media-outcome]")?.textContent ?? "").toContain("KEEP A PERMANENT COPY · NOT DONE");
    expect(card().textContent).toContain("copy stopped at 1.9 of 3.1 MB (server restarted)");
    expect(card().textContent).toContain("The copy didn't finish, so nothing was kept. This file is still awaiting review.");
    await expect.poll(() => document.activeElement?.textContent).toBe("Check again");
    await commands.hygieneServer({ op: "capture", name: `media-k4-${theme}-${width}.png`, selector: ".bg-background.text-foreground" });
  });
}

for (const [theme, width] of MATRIX)
test(`${theme} ${width}: Persist here — a refused apply alerts with its reason and Check again; the next apply leaves a receipt`, async () => {
  await scene({ mediaFiles: ITHACA_ONLY }, width, theme);
  await radio("Persist here").click();
  await ready("Preview ready");
  expect(commit().textContent).toBe("Persist ithaca-map.png");
  await set({ applyMode: "capacity" });
  commit().click();
  await expect.poll(() => card().querySelector('[data-media-outcome] [role="alert"], [data-media-outcome]')?.textContent ?? "").toContain("Not enough room to keep Undo data. Nothing was changed.");
  await expect.poll(() => document.activeElement?.textContent).toBe("Check again");
  expect(title().textContent).toBe("ithaca-map.png");
  await set({ applyMode: "" });
  (document.activeElement as HTMLButtonElement).click();
  await ready("Preview ready");
  commit().click();
  await expect.poll(() => host!.querySelector("[data-media-receipt]")?.textContent ?? "").toContain(`Persisted · ${MAP}`);
  expect(host!.querySelector("[data-media-receipt]")!.textContent).toContain("media.track + exact file");
});

for (const [theme, width] of MATRIX)
test(`${theme} ${width}: a broader rule lists its matches and future scope and needs approval`, async () => {
  await scene({ mediaFiles: ITHACA_ONLY }, width, theme);
  await radio("Persist with a broader rule").click();
  await destination("map.png");
  await ready("Approval is tied to the config version you saw.");
  const text = region()!.textContent!;
  expect(text).toContain("needs your approval");
  expect(text).toContain("Matches in any folder: inbox/ithaca-map.png 2.4 MB · places/map.png 1.1 MB · trips/map.png 819 KB");
  expect(text).toContain("Future files named map.png anywhere will be committed by sync.");
  expect(commit().textContent).toBe("Approve rule for 3 files and future matches");
  await commands.hygieneServer({ op: "capture", name: `media-rule-${theme}-${width}.png`, selector: ".bg-background.text-foreground" });
});

test("dark 320: only the latest preview renders; `a` does nothing while checking; the server aborts the superseded scan", async () => {
  await scene();
  await set({ holdPlans: true });
  await radio("Keep a permanent copy").click();
  await destination("places/ithaca/first.jpg");
  await expect.poll(() => region()?.dataset.mediaPreviewRegion).toBe("checking");
  await destination("places/ithaca/second.jpg");
  title().focus();
  // The key handler sends synchronously: when the dispatched key returns, a frame would already be recorded.
  await userEvent.keyboard("a");
  expect(status()).toBe("Preview in progress. You can change your choice.");
  expect(frames.filter((f) => f.type === "inbox_resolve"), "`a` sends nothing while checking").toEqual([]);
  await set({ releasePlans: true });
  await ready("Preview ready");
  expect(region()!.textContent).toContain("→ places/ithaca/second.jpg");
  expect(region()!.textContent).not.toContain("first.jpg");
  const calls = (await set({})).calls;
  expect(calls.filter((c) => c[0] === "media-apply")).toHaveLength(0);
  expect(calls.filter((c) => c[0] === "media" && c.includes("places/ithaca/first.jpg"))).toHaveLength(1);
});

test("dark 320: another device's running preview answers preview-busy as an alert with Try again", async () => {
  await scene({ mediaFiles: ITHACA_ONLY });
  await set({ foreignPreview: true });
  await radio("Persist here").click();
  await expect.poll(() => alertText()).toBe("Another device is checking a file. Try again in a moment.");
  // Answered once the other device's preview has finished and freed the scan.
  await set({ releasePlans: true });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await ready("Preview ready");
});

test("dark 320: a preview that throws is a 409 the card states, and nothing was changed", async () => {
  await scene({ mediaFiles: ITHACA_ONLY, planRefusals: {} });
  await radio("Move to a final location").click();
  await destination("places/throw.png");
  // A 409 with no newer Action states its failure only after the card's one-second wait for a
  // newer version (`newerThan`, packages/ui-react/src/components/activity/hygiene-media.tsx:343-350),
  // so the default one-second poll races that window. Allow the wait plus the request.
  await expect.poll(() => alertText(), { timeout: 5000 }).toBe("Couldn't prepare a preview. Nothing was changed.");
  expect(page.getByRole("button", { name: "Try again", exact: true }).query()).not.toBeNull();
});

test("dark 320: Leave pending by `l` hands focus to the next finding; an all-deferred pass ends with truthful counts", async () => {
  await scene();
  title().focus();
  await userEvent.keyboard("l");
  await expect.poll(() => title()?.textContent).toBe("ithaca-map.png");
  await expect.poll(() => document.activeElement === title()).toBe(true);
  await page.getByRole("button", { name: "Leave pending", exact: true }).click();
  // Complete: nothing pending, nothing applied, and both files still counted as awaiting review.
  await expect.poll(() => host!.querySelector("[data-hygiene-media]")).toBeNull();
  await expect.poll(() => host!.querySelector("[data-hygiene-media-count]")?.textContent).toBe("Media awaiting review: 2");
  expect(host!.textContent).not.toContain("Resolved on another device");
  // Each Leave pending settled its own flight: none is left to lock that file when a new pass selects it.
  expect(ui!.stores.inbox.getState().inFlight).toEqual({});
  expect(Object.values(ui!.stores.inbox.getState().outcomes).map((o) => o.kind === "receipt" && o.status)).toEqual(["snoozed", "snoozed"]);
  expect(host!.querySelector("[data-hygiene-media]")).toBeNull();
  expect((await set({})).calls.filter((c) => c[0] === "media-apply")).toHaveLength(0);
});

test("dark 320: a scratch MP4 makes no request until Load; over the raw cap there is no Load at all", async () => {
  const sirens = ".brain/scratch/2026-07-09/sirens-passage.mp4", storm = "inbox/storm-off-scheria.mp4";
  await scene({ mediaFiles: [
    { id: "media-sirens", path: sirens, source: "scratch", classes: ["MEDIA"], bytes: 4_404_019, links: { state: "complete", conversations: 1 }, refs: 0, probe: { width: 1920, height: 1080, durationMs: 83_000 } },
    { id: "media-storm", path: storm, source: "content", classes: ["MEDIA", "LARGE"], bytes: 43_830_476, links: { state: "complete", conversations: 0 }, refs: 0 },
  ] });
  expect(card().querySelector("[data-media-tile]")!.textContent).toContain("MP4 video · 4.2 MB · scratch");
  expect(card().querySelector("video")).toBeNull();
  expect(card().textContent).toContain("1920 × 1080 · 1:23");
  await settle(400);
  expect(await requests(sirens)).toBe(0);
  await page.getByRole("button", { name: "Load preview of sirens-passage.mp4", exact: true }).click();
  await expect.poll(() => card().querySelector("video")?.getAttribute("preload")).toBe("metadata");
  expect(card().querySelector("video")!.autoplay).toBe(false);
  await expect.poll(() => requests(sirens)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Leave pending", exact: true }).click();
  await expect.poll(() => title()?.textContent).toBe("storm-off-scheria.mp4");
  expect(card().querySelector("[data-media-tile]")!.textContent).toContain("Too large to preview here");
  expect(card().querySelector("[data-media-tile] button")).toBeNull();
  await settle(400);
  expect(await requests(storm)).toBe(0);
});

test("dark 320: an image error shows the fallback tile after exactly one request", async () => {
  await scene({ mediaFiles: [{ ...ITHACA_ONLY[0], serve: "404" }] });
  await expect.poll(() => card().querySelector("[data-media-tile]")?.textContent).toBe("Couldn't load preview");
  await settle(600);
  expect(await requests(MAP)).toBe(1);
});

test("dark 320: the viewer opens on the image, and Escape returns focus to the frame button", async () => {
  await scene({ mediaFiles: ITHACA_ONLY });
  const frame = () => card().querySelector<HTMLButtonElement>("[data-media-preview]")!;
  expect(frame().getAttribute("aria-label")).toBe("Preview ithaca-map.png, PNG image, 2048 × 1536");
  frame().click();
  await expect.poll(() => document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? "").toContain("Image viewer: ithaca-map.png");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => document.activeElement === frame()).toBe(true);
});

test("dark 320: a kept copy that is gone brings the original back with its reason (R1)", async () => {
  await scene({ mediaFiles: [{ id: "media-harbour-dawn", path: HARBOUR, source: "scratch", classes: ["MEDIA"], bytes: 3_250_586,
    links: { state: "complete", conversations: 2 }, refs: 0, invalidation: { disposition: "kept", dispositionOn: "2026-07-12", changed: ["copy-missing"] } }] });
  expect(card().textContent).toContain("Your permanent copy is gone (kept on 2026-07-12). This file is awaiting review again.");
});

test("dark 320: an Undo refused for eviction says so and writes nothing", async () => {
  await scene();
  await radio("Keep a permanent copy").click();
  await destination("places/ithaca/harbour-dawn.jpg");
  await ready("Preview ready");
  commit().click();
  await expect.poll(() => host!.querySelector("[data-media-receipt]")).not.toBeNull();
  await set({ undoMode: "evicted" });
  await page.getByRole("button", { name: /^Undo: Kept a permanent copy/ }).click();
  await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect.poll(() => host!.querySelector("[data-media-receipt]")?.textContent ?? "").toContain("Undo isn't available: rollback data was cleared to make room.");
});
