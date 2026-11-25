import axe from "axe-core";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { StorageTab } from "../../src/components/settings/storage-tab.js";
import { StorageIndicator } from "../../src/components/layout/storage-indicator.js";
import { useHashRoutes } from "../../src/hooks/use-hash-routes.js";
import { storageVolumes } from "../../src/components/settings/storage/storage-volumes.js";
import {
  storageGuidanceFixture,
  guidanceTime,
} from "../fixtures/storage-guidance.js";
import { paneTime, storagePaneFixture, type ChartState } from "../fixtures/storage-pane.js";
let ui: BrainUiRoot, renderer: Root, host: HTMLElement, style: HTMLElement;
const original = {
  width: innerWidth,
  height: innerHeight,
  theme: document.documentElement.dataset.theme,
  zoom: document.documentElement.style.zoom,
  hash: location.hash,
};
afterEach(async () => {
  if (renderer) flushSync(() => renderer.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.body.dataset.buttonGallery;
  document.documentElement.style.zoom = original.zoom;
  if (original.theme === undefined)
    delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = original.theme;
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${original.hash}`
  );
  await page.viewport(original.width, original.height);
});
function Routes() {
  useHashRoutes();
  return <StorageIndicator />;
}
async function scene({
  width = 320,
  theme = "dark",
  zoom = 1,
  route = false,
  fixture = storageGuidanceFixture(),
  now = guidanceTime,
} = {}) {
  await page.viewport(width * zoom, 900 * zoom);
  document.documentElement.style.zoom = String(zoom);
  document.documentElement.dataset.theme = theme;
  document.body.dataset.buttonGallery = "";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
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
        {route ? (
          <Routes />
        ) : (
          <>
            <StorageIndicator />
            <StorageTab active />
          </>
        )}
      </BrainUiProvider>
    )
  );
  await expect.poll(() => fixture.reads.length).toBeGreaterThan(0);
  return fixture;
}
const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
const refresh = () => window.dispatchEvent(new Event("focus"));
const warning = () => host.querySelector("[data-storage-indicator]");
async function settled() {
  await expect.poll(() => warning()?.textContent).toContain("Disk very low");
}
/** The exact endpoints sit behind "Measurements behind this chart" (#4537 D3). */
async function historyOpen() {
  await expect
    .element(page.getByRole("heading", { name: /^Available space · /, level: 3 }))
    .toBeVisible();
  await expect.poll(() => host.querySelector("[data-storage-history-section] svg")).not.toBeNull();
  if (!page.getByRole("table", { name: "Storage observation history" }).elements().length)
    await page.getByRole("button", { name: /Measurements behind this chart/ }).click();
}
const tier = (name: "Recent" | "Daily" | "Weekly") =>
  page.getByRole("radiogroup", { name: "History tier" }).getByRole("radio", { name, exact: true });
async function alerts() {
  await button("Change storage alerts").click();
}
for (const width of [320, 1280])
  for (const theme of ["dark", "light"])
    for (const zoom of [1, 2])
      test(`History evidence ${width} ${theme} ${zoom * 100}%`, async () => {
        const f = await scene({ width, theme, zoom });
        await settled();
        await commands.buttonCapture(
          `guidance-${width}-${theme}-${zoom}-overview`
        );
        await historyOpen();
        const table = page.getByRole("table", {
          name: "Storage observation history",
        });
        await expect
          .poll(() => table.element().textContent)
          .toContain("1 day since previous endpoint");
        expect(table.element().textContent).toContain(
          "Current bucket · provisional"
        );
        expect(table.element().textContent).toContain("Gap in this bucket");
        expect(table.element().textContent).toContain("on disk Unknown");
        expect(table.element().textContent).toContain(
          "Collection partial; capacity partial"
        );
        // D9: one dashed line per qualified window, each labelled; no range, no cone.
        const section = host.querySelector("[data-storage-history-section]")!;
        // The current six-hour bucket is a gap: no projection starts from an unmeasured now.
        expect(section.querySelectorAll('[data-part="scenario"]'), "STORAGE_NO_PROJECTION_FROM_A_GAP").toHaveLength(0);
        expect(host.querySelector("[data-storage-scenario-range]"), "STORAGE_NO_UNQUALIFIED_RANGE").toBeNull();
        // The trend and App usage read from the same evidence the old growth prose did.
        expect(host.querySelector("[data-volume-id]")?.textContent).toContain("−10 MB/day");
        expect(host.querySelector("[data-storage-summary]")?.textContent).toContain("0 bytes");
        await tier("Daily").click();
        await expect.poll(() => table.element().textContent).toContain(
          "3 days since previous endpoint"
        );
        // Measured now: one line per qualified window, each labelled.
        await expect.poll(() => section.querySelectorAll('[data-part="scenario"]').length, { message: "STORAGE_ONE_LINE_PER_WINDOW" }).toBe(2);
        expect(section.textContent, "STORAGE_DIVERGENT_SCENARIOS").toContain("empty ~16 Jul");
        expect(section.textContent).toContain("empty ~30 Sep");
        await tier("Weekly").click();
        await expect.poll(() => table.element().textContent).toContain(
          "14 days since previous endpoint"
        );
        if (width === 320)
          expect(
            getComputedStyle(table.element().querySelector("tbody tr")!)
              .display,
            "STORAGE_HISTORY_NARROW_STACKED_ROWS"
          ).toBe("block");
        expect(
          host.scrollWidth,
          "STORAGE_HISTORY_NO_OVERFLOW"
        ).toBeLessThanOrEqual(host.clientWidth + 1);
        for (const target of host.querySelectorAll<HTMLElement>(
          'select,[data-storage-indicator] [role="button"]'
        ))
          expect(
            target.getBoundingClientRect().height / zoom,
            "STORAGE_GUIDANCE_TARGET_HEIGHT"
          ).toBeGreaterThanOrEqual(44);
        const result = await axe.run(host, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        });
        expect(
          result.violations.map((row) => ({
            id: row.id,
            nodes: row.nodes.map((node) => node.target),
          })),
          "STORAGE_GUIDANCE_ACCESSIBLE"
        ).toEqual([]);
        // The tier switch is one tab stop; arrows move it.
        (tier("Weekly").element() as HTMLElement).focus();
        await userEvent.keyboard("{ArrowRight}");
        expect(document.activeElement).toBe(tier("Recent").element());
        expect(tier("Recent").element().getAttribute("aria-checked")).toBe("true");
        await commands.buttonCapture(`guidance-${width}-${theme}-${zoom}`);
        if (zoom === 1) {
          host.style.filter = "grayscale(1)";
          await commands.buttonCapture(`guidance-${width}-${theme}-grey`);
          host.style.filter = "";
        }
        expect(
          f.inventory.requests.filter((row) => row.method === "POST"),
          "STORAGE_GUIDANCE_NO_SCAN_OR_PERMISSION"
        ).toEqual([]);
      });
test("Missing scenarios never hide refusal pressure or invent a range", async () => {
  const f = storageGuidanceFixture(),
    capacity = f.guidance.capacities[0]!;
  capacity.causes.capacity = false;
  capacity.causes.forecast = false;
  capacity.causes.refusals[0]!.resource = "quota";
  capacity.evidence!.short = {
    state: "unavailable",
    reason: "incomplete",
    samples: 0,
    start: null,
    end: null,
    depletionPerDay: null,
    days: null,
  };
  capacity.evidence!.long = {
    ...capacity.evidence!.short,
    state: "non-depleting",
    reason: null,
  };
  await scene({ fixture: f });
  await settled();
  const section = () => host.querySelector("[data-storage-history-section]")!;
  await expect.poll(() => section().querySelector("svg")).not.toBeNull();
  await tier("Daily").click();
  await expect.poll(() => section().textContent, { message: "STORAGE_UNQUALIFIED_WINDOW_SAYS_WHY" }).toContain(
    "No projection · latest measurement is incomplete"
  );
  // A window with no start or end cannot be drawn: no line, never a stand-in.
  expect(section().querySelectorAll('[data-part="scenario"]')).toHaveLength(0);
  expect(
    host.querySelector("[data-storage-scenario-range]"),
    "STORAGE_NO_UNQUALIFIED_RANGE"
  ).toBeNull();
  expect(section().textContent).toContain("Owner refused a write: quota reached");
  expect(host.querySelector("[data-volume-id]")?.textContent).toContain("not running out");
  expect(host.textContent).not.toMatch(/Infinity|NaN/);
  f.guidance.state = "unknown";
  capacity.scopeChanged = true;
  capacity.state = "unknown";
  refresh();
  await expect.poll(() => host.querySelector("[data-volume-id]")?.textContent).toContain("scope changed");
  expect(section().querySelectorAll('[data-part="scenario"]'), "STORAGE_CHANGED_SCOPE_NO_PROJECTION").toHaveLength(0);
  expect(warning()?.textContent).toContain("Disk very low");
});
test("History clocks, changed scopes and nullable quantities stay explicit", async () => {
  const f = storageGuidanceFixture();
  f.history.observations[1]!.scope = "d".repeat(32);
  f.history.observations[1]!.at += 60_000;
  await scene({ fixture: f });
  await settled();
  await historyOpen();
  const text = page
    .getByRole("table", { name: "Storage observation history" })
    .element().textContent;
  expect(text).toContain("Changed scope · no comparable interval");
  expect(text).toContain("Clock ordering unknown");
  expect(text).toContain("Available 40 MB");
  expect(text).toContain("Object union: file size Unknown");
});
test("Permission is never requested on opening; receipts distinguish acceptance and uncertainty", async () => {
  const permission = vi.spyOn(Notification, "requestPermission");
  await scene();
  await settled();
  // One device has an unknown timezone, the other is in quiet hours: alerts stay on.
  await expect.poll(() => host.querySelector("[data-storage-alerts]")?.textContent).toContain("Alerts");
  expect(
    permission,
    "STORAGE_NO_AUTO_PERMISSION_PROMPT"
  ).not.toHaveBeenCalled();
  await alerts();
  expect(host.textContent).toContain("timezone unknown · delivery pending");
  expect(host.textContent).toContain("quiet hours · delivery deferred");
  await page.getByRole("button", { name: /Delivery receipts/ }).click();
  expect(host.textContent).toContain(
    "Accepted by push service; device display unconfirmed"
  );
  expect(host.textContent).toContain(
    "Unknown delivery outcome; no automatic retry"
  );
  expect(permission).not.toHaveBeenCalled();
  expect(host.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
});
test("Unavailable evidence retains an explicitly stale warning; forbidden removes it", async () => {
  const f = await scene();
  await settled();
  f.setStatus(503);
  refresh();
  await expect
    .poll(() => warning()?.textContent)
    .toContain("Disk very low · evidence unknown");
  await expect.poll(() => host.textContent).toContain("out of date; refresh");
  f.setStatus(403);
  refresh();
  await expect
    .poll(warning, { message: "STORAGE_FORBIDDEN_HIDES_INDICATOR" })
    .toBeNull();
  expect(host.textContent).not.toContain("App journal: 4");
});
test("A late response from the prior account cannot replace current evidence", async () => {
  const f = await scene({ route: true });
  await settled();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const before = f.reads.length;
  refresh();
  await expect.poll(() => f.reads.length).toBeGreaterThan(before);
  f.hold(null);
  f.guidance.severity = "low";
  f.guidance.capacities[0]!.severity = "low";
  ui.stores.connection.getState().setVpnStatus("connected", "athena");
  await expect.poll(() => warning()?.textContent).toContain("Disk low");
  const delivered = f.delivered();
  release();
  // The late response has been read; its ownership check has run.
  await expect.poll(f.delivered).toBeGreaterThan(delivered);
  expect(
    warning()?.textContent,
    "STORAGE_ACCOUNT_RESPONSE_OWNERSHIP"
  ).not.toContain("very low");
  await ui.authLock.expire("signed out", true);
  await expect
    .poll(warning, { message: "STORAGE_LOCK_HIDES_GUIDANCE" })
    .toBeNull();
});
test("Indicator and authenticated tap-through honor Settings leave guards and clean up the route", async () => {
  const f = await scene({ route: true });
  await settled();
  let leave: (() => void) | undefined;
  ui.stores.ui.getState().openSettings("modules");
  ui.stores.ui.getState().setSettingsNavigationGuard((next) => {
    leave = next;
  });
  await button("Open Storage: Disk very low").click();
  expect(
    ui.stores.ui.getState().settingsTab,
    "STORAGE_INDICATOR_LEAVE_GUARD"
  ).toBe("modules");
  leave!();
  expect(ui.stores.ui.getState().settingsTab).toBe("storage");
  ui.stores.ui.getState().setSettingsNavigationGuard(null);
  ui.stores.ui.getState().closeAllPanels();
  f.setStatus(403);
  refresh();
  await expect.poll(warning).toBeNull();
  history.replaceState(null, "", "#/settings/storage");
  const answered = f.answered();
  // Commit the route change and its effects synchronously: the open decision
  // has run when flushSync returns. Then wait for the read the route starts
  // to be answered (refused) and handled, so the next refresh is a new read.
  flushSync(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
  await expect.poll(f.answered).toBeGreaterThan(answered);
  expect(
    ui.stores.ui.getState().settingsPanelOpen,
    "STORAGE_TAP_REQUIRES_AUTHORITY"
  ).toBe(false);
  f.setStatus(200);
  refresh();
  await expect.poll(() => ui.stores.ui.getState().settingsPanelOpen).toBe(true);
  expect(ui.stores.ui.getState().settingsTab).toBe("storage");
  ui.stores.ui.getState().closeAllPanels();
  await expect
    .poll(() => location.hash, { message: "STORAGE_CLOSED_ROUTE_CLEARED" })
    .toBe("");
});
test("Refreshing guidance and measurement preserves selection, review and focus with one polite completion", async () => {
  const f = await scene({ width: 1280 });
  await settled();
  await button("Find large files").click();
  await button(/^Ithaca-harbor\.pdf, .*inspect$/).click();
  await expect
    .poll(() => button("Select file").element().getAttribute("aria-disabled"))
    .not.toBe("true");
  await button("Select file").click();
  const measure = button("Measure again");
  await measure.click();
  const changes: string[] = [];
  const live = host.querySelector('[aria-live="polite"]')!;
  const observer = new MutationObserver(() => {
    if (live.textContent?.includes("Storage measurement updated"))
      changes.push(live.textContent);
  });
  observer.observe(live, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  try {
    await expect
      .poll(() => live.textContent, { timeout: 5000 })
      .toContain("Storage measurement updated");
    expect(changes, "STORAGE_ONE_POLITE_REFRESH").toHaveLength(1);
    expect(document.activeElement).toBe(measure.element());
    expect(host.textContent).toContain("1 selected");
  } finally {
    observer.disconnect();
  }
  await button("Review removal").click();
  await expect.poll(() => button("Remove 1 file").elements().length).toBe(1);
  f.guidance.pending = true;
  refresh();
  await expect
    .poll(() => warning()?.textContent)
    .toContain("Disk very low · evidence unknown");
  expect(button("Remove 1 file").elements()).toHaveLength(1);
});

test("Browser-blocked push is labelled and the existing opt-in switch keeps its touch target", async () => {
  const permission = vi
    .spyOn(Notification, "permission", "get")
    .mockReturnValue("default");
  await scene();
  await settled();
  await alerts();
  const toggle = page.getByRole("switch", { name: "Push notifications" });
  await expect.poll(() => toggle.elements().length).toBe(1);
  const r = toggle.element().getBoundingClientRect(),
    pseudo = getComputedStyle(toggle.element(), "::before");
  expect(
    r.height - parseFloat(pseudo.top) - parseFloat(pseudo.bottom)
  ).toBeGreaterThanOrEqual(44);
  expect(
    r.width - parseFloat(pseudo.left) - parseFloat(pseudo.right)
  ).toBeGreaterThanOrEqual(44);
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  for (const node of host.querySelectorAll(
    "[data-storage-history-section] *, [data-volume-id], [data-storage-map-index]"
  )) {
    expect(
      getComputedStyle(node).animationName,
      "STORAGE_STATIC_HISTORY_REDUCED_MOTION"
    ).toBe("none");
  }
  permission.mockReturnValue("denied");
  const old = ui;
  ui = createBrainUiRoot({
    storage: null,
    request: storageGuidanceFixture().request,
  });
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  old.dispose();
  await expect.poll(() => host.querySelector("[data-storage-alerts]")).not.toBeNull();
  await alerts();
  await expect
    .poll(() => host.textContent)
    .toContain("Blocked in browser settings");
  expect(toggle.elements()).toHaveLength(0);
});
test("A replaced root cannot publish its late operational response", async () => {
  const oldFixture = storageGuidanceFixture();
  let release!: () => void;
  oldFixture.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  await scene({ route: true, fixture: oldFixture });
  const old = ui,
    next = storageGuidanceFixture();
  next.setStatus(403);
  ui = createBrainUiRoot({ storage: null, request: next.request });
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <Routes />
      </BrainUiProvider>
    )
  );
  await expect.poll(() => next.reads.length).toBeGreaterThan(0);
  const delivered = oldFixture.delivered();
  release();
  // The old root's late response has been read; its ownership check has run.
  await expect.poll(oldFixture.delivered).toBeGreaterThan(delivered);
  expect(warning(), "STORAGE_REPLACED_ROOT_HIDES_OLD_GUIDANCE").toBeNull();
  old.dispose();
});

// #4547: the indicator names the volume the pane's card names, and its
// accessible name carries the severity and any qualifier, at the narrowest width.
for (const variant of ["named", "stale", "unidentified"] as const)
  test(`Indicator accessible name names the volume at 320 (${variant})`, async () => {
    const f = storageGuidanceFixture(),
      capacity = f.guidance.capacities[0]!;
    if (variant === "stale") {
      const stale = { ...capacity.evidence!.short, state: "unavailable" as const, reason: "stale" as const, start: null, end: null, days: null, depletionPerDay: null };
      capacity.evidence = { ...capacity.evidence!, fresh: false, short: stale, long: stale };
    }
    if (variant === "unidentified") capacity.identity = "c".repeat(32);
    await scene({ width: 320, route: true, fixture: f });
    const card = storageVolumes({ guidance: f.guidance, inventory: f.inventory.snapshot })[0]!;
    const expected =
      variant === "named"
        ? `Open Storage: ${card.name} very low`
        : variant === "stale"
        ? `Open Storage: ${card.name} very low, out of date`
        : "Open Storage: Storage warning · very low";
    expect(card.name).toBe(variant === "unidentified" ? "Unidentified volume" : "Disk");
    const control = button(expected);
    await expect.poll(() => control.elements().length, { message: "STORAGE_INDICATOR_ACCESSIBLE_NAME" }).toBe(1);
    const element = control.element() as HTMLElement,
      box = element.getBoundingClientRect();
    expect(box.width, "STORAGE_INDICATOR_FITS_320").toBeLessThanOrEqual(320);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    expect(warning()?.textContent).toContain(expected.replace("Open Storage: ", "").replace(", out of date", " · out of date"));
  });

/** The name a rendered volume card's radio carries, read from the DOM. */
function cardName(volume: Element) {
  const radio = volume.querySelector('[role="radio"]')!;
  const label = radio.getAttribute("aria-labelledby")!.split(" ")[0]!;
  return document.getElementById(label)!.textContent!.trim();
}
// Deferred from #4547: the indicator's name equals the rendered VolumeCard
// name for the same fixture, read from the DOM rather than the model.
for (const state of ["low", "very-low"] as const)
  test(`Indicator and rendered volume card name the same volume (${state})`, async () => {
    const f = storagePaneFixture({ state });
    await scene({ width: 1280, fixture: f as never, now: paneTime });
    await expect.poll(() => host.querySelectorAll("[data-volume-id]").length).toBe(2);
    const worst = host.querySelector("[data-volume-id]")!;
    const name = cardName(worst);
    expect(name, "STORAGE_CARD_NAMED_BY_CONTENTS").toBe("Brain disk");
    const level = state === "low" ? "low" : "very low";
    await expect
      .poll(() => warning()?.querySelector('[role="button"]')?.getAttribute("aria-label"), { message: "STORAGE_INDICATOR_MATCHES_CARD" })
      .toBe(`Open Storage: ${name} ${level}`);
    expect(host.querySelector("[data-storage-banner]")?.textContent).toContain(`${name} is ${state === "low" ? "Low" : "Very low"}`);
  });

// The chart states (#4549): real-browser baselines of the history section.
const CHART_STATES: ChartState[] = ["full", "gap", "no-projection", "one-window", "two-windows", "scope-change"];
for (const chart of CHART_STATES)
  for (const width of [320, 1280])
    for (const theme of ["dark", "light"])
      test(`Chart state ${chart} ${width} ${theme}`, async () => {
        const f = storagePaneFixture({ state: "low", chart });
        await scene({ width, theme, fixture: f as never, now: paneTime });
        const section = () => host.querySelector<HTMLElement>("[data-storage-history-section]")!;
        await expect.poll(() => section()?.querySelector("svg")).not.toBeNull();
        const lines = section().querySelectorAll('[data-part="scenario"]').length;
        expect(lines, "STORAGE_ONE_LINE_PER_QUALIFIED_WINDOW").toBe(
          chart === "two-windows" || chart === "full" || chart === "gap" ? 2 : chart === "one-window" ? 1 : 0
        );
        expect(section().querySelectorAll('[data-part="gap"]').length > 0, "STORAGE_GAP_IS_DRAWN_AS_GAP").toBe(chart !== "full");
        if (chart === "scope-change") expect(section().textContent).toContain("scope changed");
        if (chart === "no-projection") expect(section().textContent).toContain("gap inside the 7-day window");
        if (chart === "one-window") expect(section().textContent).toContain("under 30 days of history");
        host.style.height = "auto";
        const pane = host.querySelector<HTMLElement>("[data-storage-pane]");
        if (pane) pane.style.overflow = "visible";
        await expect(page.elementLocator(section())).toMatchScreenshot(`storage-chart-${chart}-${width}-${theme}`);
      });
