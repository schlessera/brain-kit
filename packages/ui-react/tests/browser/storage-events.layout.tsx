import { afterEach, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { StorageTab } from "../../src/components/settings/storage-tab.js";
import { storageFormat } from "../../src/components/settings/storage/storage-volumes.js";
import { paneTime, storagePaneFixture, type TimelineState } from "../fixtures/storage-pane.js";

// #4548: the server's events timeline on the "Available space over time" chart.
let ui: BrainUiRoot, renderer: Root, host: HTMLElement, style: HTMLElement, outer: { width: number; height: number } | undefined;
const original = {
  width: innerWidth,
  height: innerHeight,
  theme: document.documentElement.dataset.theme,
};
afterEach(async () => {
  if (renderer) flushSync(() => renderer.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  vi.useRealTimers();
  if (original.theme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = original.theme;
  await page.viewport(original.width, original.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});

async function scene({ width = 320, theme = "dark", timeline = "events" as TimelineState } = {}) {
  const fixture = storagePaneFixture({ state: "recovered", chart: "full", timeline });
  outer ??= await commands.formViewport(width, 900);
  await page.viewport(width, 900);
  document.documentElement.dataset.theme = theme;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(paneTime);
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `width:${width}px;height:900px;display:flex;flex-direction:column;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null, request: fixture.request });
  renderer = createRoot(host);
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  await expect.poll(() => section()?.querySelector('[data-part="history-svg"]')).toBeTruthy();
  return fixture;
}
const section = () => host.querySelector<HTMLElement>("[data-storage-history-section]");
const legend = () => [...(section()?.querySelectorAll<HTMLElement>('[data-part="event-list"] li') ?? [])];
const rows = () => legend().map((row) => `${row.dataset.event} ${row.textContent!.replace(/^\d+Event \d+: /, "")}`);
/** Every number the chart's boxes carry, and the first number of each box from left to right. */
function boxes() {
  const all = [...section()!.querySelectorAll<SVGGElement>('[data-part="event-box"]')].map((box) => ({
    x: box.querySelector("rect")!.x.baseVal.value,
    events: box.dataset.events!.split(",").map(Number),
  }));
  return {
    numbers: all.flatMap((box) => box.events).sort((a, b) => a - b),
    leftToRight: all.sort((a, b) => a.x - b.x).map((box) => box.events[0]),
  };
}
/** Grow the runner's frame and the viewport to the content: no scaling, no clipping. */
async function unclip(width: number) {
  host.style.height = "auto";
  const pane = host.querySelector<HTMLElement>("[data-storage-pane]");
  if (pane) pane.style.overflow = "visible";
  const tall = Math.ceil(host.getBoundingClientRect().height) + 16;
  outer = await commands.formViewport(width, tall);
  await page.viewport(width, tall);
  await document.fonts.ready;
}

for (const width of [320, 1280])
  for (const theme of ["dark", "light"])
    test(`Timeline markers ${width} ${theme}`, async () => {
      const f = await scene({ width, theme });
      const time = storageFormat().time;
      const [start, step, back, end, , finished] = f.events;
      const prune = f.operations[1]!.latest!;
      await expect
        .poll(() => rows().some((row) => row.endsWith("Warning ended · back to OK")), { message: "STORAGE_TIMELINE_MARKERS" })
        .toBe(true);
      // The Pack run is in the latest receipt and the timeline; it is drawn once.
      expect(legend().filter((row) => row.textContent!.includes("Pack Git history")), "STORAGE_DUAL_REPORTED_RUN_ONCE").toHaveLength(1);
      // Four warning markers at the server's times, then the two runs, numbered in time order.
      expect(rows(), "STORAGE_TIMELINE_AT_SERVER_TIMES").toEqual([
        `1 ${time(start!.at)} · Low warning started`,
        `2 ${time(step!.at)} · Warning changed to Very low`,
        `3 ${time(back!.at)} · Warning changed to Low`,
        `4 ${time(end!.at)} · Warning ended · back to OK`,
        `5 ${time(prune.completedAt!)} · Prune scratch answers · done`,
        `6 ${time(finished!.at)} · Pack Git history · done`,
      ]);
      // The legend's numbers are the chart's, and the chart numbers them left to right.
      const chart = boxes();
      expect(chart.numbers, "STORAGE_LEGEND_MATCHES_CHART").toEqual([1, 2, 3, 4, 5, 6]);
      expect(chart.leftToRight, "STORAGE_CHART_NUMBERED_IN_TIME_ORDER").toEqual([...chart.leftToRight].sort((a, b) => a! - b!));
      // Read with since until a page is empty.
      expect(f.eventReads, "STORAGE_TIMELINE_SINCE_PAGING").toEqual([0, 6]);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await unclip(width);
      await expect(page.elementLocator(section()!)).toMatchScreenshot(`storage-events-${width}-${theme}`);
    });

test("Another volume draws none of the Brain disk's warning, and not its run", async () => {
  await scene({ width: 1280 });
  await expect.poll(() => legend().length).toBe(6);
  const other = host.querySelectorAll("[data-volume-id]")[1]!;
  (other.querySelector('[role="radio"]') as HTMLElement).click();
  await expect.poll(() => section()?.querySelector("h3")?.textContent).not.toContain("Brain disk");
  expect(legend(), "STORAGE_TIMELINE_PER_VOLUME").toHaveLength(0);
});

test("A paused kind is a note under the chart, not an error", async () => {
  await scene({ timeline: "paused" });
  await expect
    .poll(() => section()?.textContent, { message: "STORAGE_TIMELINE_PAUSED_NOTE" })
    .toContain("Event timeline paused for warnings · earlier events kept; later ones are not marked");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  // What was recorded before the pause is still drawn.
  expect(legend()).toHaveLength(6);
});

for (const timeline of ["missing", "error"] as const)
  test(`A ${timeline === "missing" ? "404 from an older host" : "failed timeline"} falls back to the chart's own markers`, async () => {
    const f = await scene({ timeline });
    const time = storageFormat().time;
    const [pack, prune] = f.operations.map((row) => row.latest!);
    await expect.poll(() => legend().length, { message: "STORAGE_TIMELINE_DEGRADES" }).toBe(2);
    expect(rows()).toEqual([
      `1 ${time(prune!.completedAt!)} · Prune scratch answers · done`,
      `2 ${time(pack!.completedAt!)} · Pack Git history · done`,
    ]);
    if (timeline === "error") expect(f.eventReads.length).toBeGreaterThan(0);
    expect(host.querySelector('[role="alert"]'), "STORAGE_TIMELINE_NO_ERROR_BANNER").toBeNull();
    expect(section()!.textContent, "STORAGE_TIMELINE_NO_ERROR_NOTE").not.toMatch(/could not|unavailable|timeline/i);
  });
