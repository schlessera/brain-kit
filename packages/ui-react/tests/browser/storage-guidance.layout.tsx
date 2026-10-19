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
import {
  storageGuidanceFixture,
  guidanceTime,
} from "../fixtures/storage-guidance.js";
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
} = {}) {
  await page.viewport(width * zoom, 900 * zoom);
  document.documentElement.style.zoom = String(zoom);
  document.documentElement.dataset.theme = theme;
  document.body.dataset.buttonGallery = "";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(guidanceTime);
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
  await expect.poll(() => warning()?.textContent).toContain("Very low space");
}
async function historyOpen() {
  await page
    .getByText("View observations · Recent, Daily and Weekly", { exact: true })
    .click();
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
        expect(host.textContent, "STORAGE_DIVERGENT_SCENARIOS").toContain(
          "4–80 days if observed rates continue"
        );
        expect(host.textContent).toContain("Measured App stores: 0 bytes/day");
        expect(host.textContent).toContain(
          "Capacity available change: -10 MB/day"
        );
        await page
          .getByRole("combobox", { name: "History tier" })
          .selectOptions("daily");
        expect(table.element().textContent).toContain(
          "3 days since previous endpoint"
        );
        await page
          .getByRole("combobox", { name: "History tier" })
          .selectOptions("weekly");
        expect(table.element().textContent).toContain(
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
          'summary,select,[data-storage-indicator] [role="button"]'
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
        const tier = page
          .getByRole("combobox", { name: "History tier" })
          .element() as HTMLElement;
        tier.focus();
        await userEvent.keyboard("{Tab}");
        expect(document.activeElement).toBe(
          page.getByRole("combobox", { name: "Capacity scope" }).element()
        );
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
  expect(
    host.querySelector("[data-storage-scenario-range]"),
    "STORAGE_NO_UNQUALIFIED_RANGE"
  ).toBeNull();
  expect(host.textContent).toContain("Owner refused a write · quota");
  expect(host.textContent).toContain("Short window: Unavailable");
  expect(host.textContent).toContain("No depletion observed");
  expect(host.textContent).not.toMatch(/Infinity|NaN/);
  f.guidance.state = "unknown";
  capacity.scopeChanged = true;
  capacity.state = "unknown";
  refresh();
  await expect.poll(() => host.textContent).toContain("Earlier capacity scope");
  expect(host.textContent).toContain(
    "measurements do not describe the new scope"
  );
  expect(host.textContent).not.toContain("4–80");
  expect(warning()?.textContent).toContain("Very low space");
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
  await page.getByText("Critical notifications", { exact: true }).click();
  expect(
    permission,
    "STORAGE_NO_AUTO_PERMISSION_PROMPT"
  ).not.toHaveBeenCalled();
  expect(host.textContent).toContain("timezone unknown · delivery pending");
  expect(host.textContent).toContain("quiet hours · delivery deferred");
  expect(host.textContent).toContain(
    "Accepted by push service; device display unconfirmed"
  );
  expect(host.textContent).toContain(
    "Unknown delivery outcome; no automatic retry"
  );
  expect(host.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
});
test("Unavailable evidence retains an explicitly stale warning; forbidden removes it", async () => {
  const f = await scene();
  await settled();
  f.setStatus(503);
  refresh();
  await expect
    .poll(() => warning()?.textContent)
    .toContain("Check current evidence");
  expect(host.textContent).toContain("out of date; refresh");
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
  await expect.poll(() => warning()?.textContent).toContain("Low space");
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    warning()?.textContent,
    "STORAGE_ACCOUNT_RESPONSE_OWNERSHIP"
  ).not.toContain("Very low space");
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
  await button("Open Storage: Very low space").click();
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
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  await button("Inspect Ithaca-harbor.pdf").click();
  await expect
    .poll(() => button("Select file").element().getAttribute("aria-disabled"))
    .not.toBe("true");
  await button("Select file").click();
  const measure = button("Refresh");
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
  await button("Review selected files").click();
  await expect.poll(() => button("Remove 1 file").elements().length).toBe(1);
  f.guidance.pending = true;
  refresh();
  await expect
    .poll(() => warning()?.textContent)
    .toContain("Check current evidence");
  expect(button("Remove 1 file").elements()).toHaveLength(1);
});

test("Browser-blocked push is labelled and the existing opt-in switch keeps its touch target", async () => {
  const permission = vi
    .spyOn(Notification, "permission", "get")
    .mockReturnValue("default");
  await scene();
  await settled();
  await page.getByText("Critical notifications", { exact: true }).click();
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
    "[data-storage-history], [data-storage-pressure], [data-storage-map-index]"
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
  await page.getByText("Critical notifications", { exact: true }).click();
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
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(warning(), "STORAGE_REPLACED_ROOT_HIDES_OLD_GUIDANCE").toBeNull();
  old.dispose();
});
