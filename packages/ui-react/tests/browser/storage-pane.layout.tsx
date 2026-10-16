import axe from "axe-core";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { StorageTab } from "../../src/components/settings/storage-tab.js";
import {
  storageViewFixture,
  type StorageScene,
} from "../fixtures/storage-view.js";
let ui: BrainUiRoot,
  renderer: Root,
  host: HTMLDivElement,
  style: HTMLStyleElement;
const original = {
  width: innerWidth,
  height: innerHeight,
  theme: document.documentElement.dataset.theme,
  zoom: document.documentElement.style.zoom,
};
afterEach(async () => {
  if (renderer) flushSync(() => renderer.unmount());
  ui?.dispose();
  host?.remove();
  style?.remove();
  vi.useRealTimers();
  delete document.body.dataset.buttonGallery;
  document.documentElement.style.zoom = original.zoom;
  if (original.theme === undefined)
    delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = original.theme;
  await page.viewport(original.width, original.height);
});
async function scene(
  kind: StorageScene = "dense",
  width = 320,
  theme = "dark",
  zoom = 1
) {
  await page.viewport(width * zoom, 800 * zoom);
  document.documentElement.style.zoom = String(zoom);
  document.documentElement.dataset.theme = theme;
  document.body.dataset.buttonGallery = "";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 6, 12, 9, 41));
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `display:flex;width:${width}px;height:800px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  const fixture = storageViewFixture(kind);
  ui = createBrainUiRoot({ storage: null, request: fixture.request });
  renderer = createRoot(host);
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  await expect
    .poll(() =>
      fixture.requests.some((row) => row.path === "/api/storage/removals")
    )
    .toBe(true);
  if (kind !== "never")
    await expect
      .poll(
        () =>
          page.getByRole("table", { name: "Storage contents table" }).elements()
            .length
      )
      .toBe(1);
  return fixture;
}
const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
async function accessible(element: HTMLElement) {
  const result = await axe.run(element, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
  });
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
    "STORAGE_ACCESSIBLE"
  ).toEqual([]);
}
function targets(element: Element, zoom = 1) {
  for (const control of element.querySelectorAll<HTMLElement>(
    '[role="button"],button,select,input'
  )) {
    const target = control.matches('input[type="checkbox"],input[type="radio"]')
      ? control.closest("label") ?? control
      : control;
    const r = target.getBoundingClientRect();
    expect(
      r.height / zoom,
      "STORAGE_ACTION_TARGET_HEIGHT"
    ).toBeGreaterThanOrEqual(44);
    expect(
      r.width / zoom,
      "STORAGE_ACTION_TARGET_WIDTH"
    ).toBeGreaterThanOrEqual(44);
  }
}
const disabled = (element: Element) =>
  element.getAttribute("aria-disabled") === "true" ||
  (element as HTMLButtonElement).disabled === true;
async function files() {
  await button("Find large files").click();
  await expect
    .poll(() => page.getByRole("table").element().textContent)
    .toContain("Ithaca-harbor.pdf");
}
async function select(name: string) {
  await button(`Inspect ${name}`).click();
  await expect
    .poll(() => disabled(button("Select file").element()))
    .toBe(false);
  await button("Select file").click();
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
}
for (const width of [320, 1280])
  for (const theme of ["dark", "light"])
    for (const zoom of [1, 2])
      test(`Storage overview ${width} ${theme} ${zoom * 100}%`, async () => {
        const fixture = await scene("dense", width, theme, zoom);
        await expect
          .poll(() => host.querySelectorAll("[data-storage-map-index]").length)
          .toBeGreaterThan(0);
        expect(
          host.scrollWidth,
          "STORAGE_NO_HORIZONTAL_OVERFLOW"
        ).toBeLessThanOrEqual(host.clientWidth + 1);
        expect(
          (
            page
              .getByRole("combobox", { name: "Size basis" })
              .element() as HTMLSelectElement
          ).value
        ).toBe("allocated");
        expect(host.textContent).toContain("Unknown");
        expect(host.textContent).toContain("quota headroom unknown");
        const map = page.getByRole("group", { name: /Storage map/ }).element();
        expect(
          map.textContent,
          "STORAGE_UNKNOWN_ALLOCATION_HAS_NO_TILE"
        ).not.toContain("Native retained store");
        const tiles = Array.from(
          map.querySelectorAll<HTMLButtonElement>("button")
        ).sort(
          (a, b) =>
            Number(a.dataset.storageMapIndex) -
            Number(b.dataset.storageMapIndex)
        );
        expect(tiles.filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
        for (const tile of tiles) {
          const rect = tile.getBoundingClientRect();
          expect(rect.width / zoom).toBeGreaterThanOrEqual(44);
          expect(rect.height / zoom).toBeGreaterThanOrEqual(44);
        }
        if (width === 320)
          expect(map.querySelectorAll("button").length).toBeLessThanOrEqual(7);
        const first = tiles.find((tile) => tile.tabIndex === 0)!;
        first.focus();
        await userEvent.keyboard("{End}");
        expect(document.activeElement).toBe(tiles.at(-1));
        await userEvent.keyboard("{Home}");
        expect(document.activeElement).toBe(first);
        await accessible(host);
        targets(host, zoom);
        await commands.buttonCapture(
          `storage-${width}-${theme}-${zoom}-overview`
        );
        if (width === 1280 && zoom === 1) {
          host.style.filter = "grayscale(1)";
          await commands.buttonCapture(`storage-${theme}-greyscale`);
          host.style.filter = "";
        }
        expect(
          fixture.requests.filter((row) => row.method === "POST"),
          "STORAGE_OPEN_DOES_NOT_SCAN"
        ).toHaveLength(0);
      });
for (const kind of [
  "empty",
  "partial",
  "separate",
  "unsupported",
  "never",
] as const)
  test(`Storage explicit ${kind} state`, async () => {
    const fixture = await scene(kind);
    if (kind === "never") {
      await expect.poll(() => host.textContent).toContain("Not measured yet");
      await button("Measure").click();
      await expect.poll(() => host.textContent).toContain("Measuring…");
      await button("Cancel measurement").click();
      await expect
        .poll(() => host.textContent)
        .toContain("cancelled or revoked");
      expect(
        fixture.requests.filter((row) => row.method === "POST")
      ).toHaveLength(1);
    }
    if (kind === "empty") {
      expect(host.textContent).toContain("No known nonzero area");
      expect(host.textContent).not.toContain("NaN");
    }
    if (kind === "partial")
      expect(host.textContent).toContain("permission denied");
    if (kind === "separate")
      expect(
        host.querySelectorAll("[data-storage-capacity]"),
        "STORAGE_CAPACITY_ID_COUNTED_ONCE"
      ).toHaveLength(2);
    if (kind === "unsupported") {
      expect(host.textContent).toContain(
        "This host can't remove attachments yet"
      );
      await files();
      await button("Inspect Ithaca-harbor.pdf").click();
      await expect.poll(() => button("Preview").elements().length).toBe(1);
      await expect.poll(()=>page.getByRole("dialog").element().textContent).toContain("Eligibility: Not verified");
      expect(
        disabled(button("Select file").element()),
        "STORAGE_INELIGIBLE_SELECTION_DISABLED"
      ).toBe(true);
      expect(
        fixture.requests.some((row) => row.path.endsWith("/reviews"))
      ).toBe(false);
    }
    await commands.buttonCapture(`storage-${kind}`);
  });
test("invalid size filters remove the prior matching file list", async () => {
  await scene();
  await files();
  await page.getByRole("textbox", { name: "Larger than (MB)", exact: true }).fill("invalid");
  await expect.poll(() => page.getByRole("table").element().textContent,
    { message: "STORAGE_INVALID_FILTER_HAS_NO_OLD_ROWS" }).not.toContain("Troy-charts.PDF");
  expect(disabled(button("Copy visible file list").element())).toBe(true);
});
test("PDF boundary, file-entry sum and hard-link union remain distinct", async () => {
  await scene("alias", 1280);
  await files();
  const table = page.getByRole("table").element();
  expect(table.textContent).not.toContain("Calypso-notes.pdf");
  expect(table.textContent, "STORAGE_STRICT_PDF_BOUNDARY").not.toContain(
    "Aeaea-boundary.pdf"
  );
  expect(table.textContent).toContain("Troy-charts.PDF");
  expect(host.textContent).toContain("101,500,000 bytes");
  expect(host.textContent).toContain("Matching object union: 53.3 MB");
  await button("Inspect Troy-charts.PDF").click();
  await expect
    .poll(() => page.getByRole("dialog").element().textContent)
    .toContain("Eligibility: shared object");
  expect(
    disabled(button("Select file").element()),
    "STORAGE_INELIGIBLE_SELECTION_DISABLED"
  ).toBe(true);
});
for (const width of [320, 1280])
  test(`Mixed removal, original receipt and fresh Undo review at ${width}`, async () => {
    const fixture = await scene("dense", width);
    await files();
    await select("Ithaca-harbor.pdf");
    await select("Troy-charts.PDF");
    await button("Review selected files").click();
    await expect.poll(() => button("Remove 2 files").elements().length).toBe(1);
    expect(page.getByRole("dialog").element().textContent).toContain(
      "Links are not rewritten"
    );
    await accessible(page.getByRole("dialog").element() as HTMLElement);
    targets(page.getByRole("dialog").element());
    await commands.buttonCapture(`storage-${width}-review`);
    fixture.dropNextConfirmation();
    await button("Remove 2 files").click();
    await expect
      .poll(() => page.getByRole("dialog").element().textContent)
      .toContain("1 removed · 0 restored · 1 other outcomes");
    expect(fixture.confirms, "STORAGE_LOST_RESPONSE_NEVER_REPOSTS").toBe(1);
    expect(page.getByRole("dialog").element().textContent).toContain(
      "changed since review"
    );
    await button("Check original receipt").click();
    expect(fixture.confirms).toBe(1);
    await commands.buttonCapture(`storage-${width}-mixed`);
    await button("Undo removal of attachments/Ithaca-harbor.pdf").click();
    await expect.poll(() => button("Restore 1 file").elements().length).toBe(1);
    expect(
      fixture.requests.some((row) => row.path.endsWith("/undo-reviews"))
    ).toBe(true);
    await button("Restore 1 file").click();
    await expect
      .poll(() => page.getByRole("dialog").element().textContent)
      .toContain("1 restored");
    expect(fixture.confirms).toBe(2);
    await button("Return to filtered list").click();
    await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
    expect(document.activeElement).toBe(
      button("Review selected files").element()
    );
  });
test("Changed selected versions cannot inherit confirmation", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  fixture.changeVersion();
  await button("Review selected files").click();
  await expect
    .poll(() => page.getByRole("dialog").element().textContent)
    .toContain("A selected version changed");
  expect(
    disabled(button("Remove 1 file").element()),
    "STORAGE_CHANGED_REVIEW_DISABLED"
  ).toBe(true);
  expect(fixture.confirms).toBe(0);
});
test("List-only drill restores the parent row and retains D52", async () => {
  await scene();
  await page.getByRole("checkbox", { name: "Use list only" }).click();
  expect(
    page.getByRole("group", { name: /Storage map/ }).elements()
  ).toHaveLength(0);
  for (const name of ["Brain files", "attachments", "papers"]) {
    await button(`Open ${name}`).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  await button("attachments").click();
  await expect
    .poll(() => document.activeElement === button("Open papers").elements()[0])
    .toBe(true);
  expect(ui.stores.ui.getState().activeView).not.toBe("storage");
});
test("Account lock and root replacement discard selected versions", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  ui.stores.connection.getState().setVpnStatus("connected", "odysseus");
  await ui.authLock.expire("signed out", true);
  await expect.poll(() => host.querySelector("[data-storage-pane]")).toBeNull();
  const old = ui,
    next = storageViewFixture("never");
  ui = createBrainUiRoot({ storage: null, request: next.request });
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  old.dispose();
  await expect.poll(() => host.textContent).toContain("Not measured yet");
  expect(host.textContent).not.toContain("Ithaca-harbor");
  expect(host.textContent).not.toContain("1 selected");
  expect(fixture.confirms).toBe(0);
});

test("Dense folder pages preserve the full measured subtotal and query before paging", async () => {
  const fixture = await scene("paged", 320);
  await page.getByRole("checkbox", { name: "Use list only" }).click();
  for (const name of ["Brain files", "attachments", "papers"]) {
    await button(`Open ${name}`).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  const table = page.getByRole("table");
  expect(table.element().querySelectorAll("tbody tr")).toHaveLength(200);
  expect(host.textContent).toContain("205 children");
  expect(table.element().textContent).toContain("Ithaca-chart-204.pdf");
  await button("Next 200 items").click();
  await expect
    .poll(() => table.element().querySelectorAll("tbody tr").length)
    .toBe(5);
  expect(host.textContent).toContain("205 children");
  await page
    .getByRole("textbox", { name: "Search this folder" })
    .fill("chart-204");
  await expect
    .poll(() => table.element().querySelectorAll("tbody tr").length)
    .toBe(1);
  expect(table.element().textContent).toContain("Ithaca-chart-204.pdf");
  expect(fixture.requests.some((row) => row.path.endsWith("/tree"))).toBe(true);
});
test("Refresh preserves focused rows and requires explicit adoption before clearing selection", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  await button("Refresh").click();
  const row = button("Inspect Troy-charts.PDF").element() as HTMLElement;
  row.focus();
  await expect
    .poll(() => button("Show new measurement").elements().length, {
      timeout: 4000,
    })
    .toBe(1);
  expect(document.activeElement, "STORAGE_REFRESH_RETAINS_ROW_FOCUS").toBe(row);
  expect(host.textContent).toContain("1 selected");
  await button("Show new measurement").click();
  await expect.poll(() => host.textContent).not.toContain("1 selected");
  expect(
    fixture.requests.filter((row) => row.path.endsWith("/reviews")),
    "STORAGE_INSPECTION_DOES_NOT_CREATE_REVIEW"
  ).toHaveLength(0);
});
test("Maintenance lost response keeps its identity and cancellation reads the owner receipt", async () => {
  const fixture = await scene("maintenance");
  await page.getByRole("button", { name: /Pack Git objects/ }).click();
  await expect
    .poll(() => host.textContent)
    .toContain("Maintenance: response unconfirmed");
  const writes = () =>
    fixture.requests.filter(
      (row) => row.method === "POST" && row.path === "/api/storage/maintenance"
    );
  expect(writes()).toHaveLength(1);
  await button("Check maintenance receipt").click();
  await expect
    .poll(() => button("Cancel maintenance").elements().length)
    .toBe(1);
  await button("Cancel maintenance").click();
  await expect.poll(() => host.textContent).toContain("Maintenance: cancelled");
  expect(writes(), "STORAGE_MAINTENANCE_DOES_NOT_REPOST").toHaveLength(1);
  expect(host.textContent).toContain("Measured before → after");
});

test("Cancellation keeps acknowledged removal and stops the remaining selection", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  await select("Troy-charts.PDF");
  fixture.holdNextConfirmation();
  await button("Review selected files").click();
  await button("Remove 2 files").click();
  await expect
    .poll(() => button("Cancel remaining files").elements().length)
    .toBe(1);
  await button("Cancel remaining files").click();
  await expect
    .poll(() => page.getByRole("dialog").element().textContent)
    .toContain("Operation cancelled");
  expect(fixture.receipt?.items.map((item) => item.state)).toEqual([
    "removed",
    "not-started",
  ]);
  expect(fixture.confirms).toBe(1);
});
test("A late old-root inspection cannot populate the replacement root", async () => {
  const oldFixture = await scene();
  await files();
  await select("Troy-charts.PDF");
  const release = oldFixture.deferInspection();
  await button("Inspect Ithaca-harbor.pdf").click();
  await expect
    .poll(
      () =>
        oldFixture.requests.filter((row) => row.path.endsWith("/inspection"))
          .length
    )
    .toBe(2);
  const old = ui,
    next = storageViewFixture("never");
  ui = createBrainUiRoot({ storage: null, request: next.request });
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  old.dispose();
  release();
  await expect
    .poll(() => host.textContent, {
      message: "STORAGE_ROOT_REPLACEMENT_DROPS_OLD_SELECTION",
    })
    .toContain("Not measured yet");
  expect(host.textContent).not.toContain("Troy-charts");
  expect(page.getByRole("dialog").elements()).toHaveLength(0);
  expect(oldFixture.confirms).toBe(0);
});

test("Hard-link alias stays named in the list without acquiring map area", async () => {
  await scene("alias", 1280);
  for (const name of ["Brain files", "attachments", "papers"]) {
    await button(`Open ${name}`).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  await page
    .getByRole("combobox", { name: "Size basis" })
    .selectOptions("logical");
  await expect.poll(() => host.textContent).toContain("measured file size");
  const map = page.getByRole("group", { name: /Storage map/ }).element();
  expect(map.textContent, "STORAGE_ALIAS_NO_SECOND_AREA").not.toContain(
    "Troy-charts"
  );
  expect(page.getByRole("table").element().textContent).toContain(
    "Troy-charts.PDF"
  );
});
test("Unsupported removal still permits copying the visible filtered list", async () => {
  await scene("unsupported");
  await files();
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let copied = "";
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    });
    await button("Copy visible file list").click();
    await expect
      .poll(() => copied)
      .toContain("attachments/Troy-charts.PDF\t48200000 bytes");
    expect(copied).not.toContain("Aeaea-boundary");
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
