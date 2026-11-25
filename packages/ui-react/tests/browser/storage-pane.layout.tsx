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
import { paneTime, storagePaneFixture } from "../fixtures/storage-pane.js";
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
type Fixture = ReturnType<typeof storageViewFixture>;
async function scene(
  kind: StorageScene = "dense",
  width = 320,
  theme = "dark",
  zoom = 1,
  options: { request?: Fixture["request"]; now?: number } = {}
) {
  await page.viewport(width * zoom, 800 * zoom);
  document.documentElement.style.zoom = String(zoom);
  document.documentElement.dataset.theme = theme;
  document.body.dataset.buttonGallery = "";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(options.now ?? Date.UTC(2026, 6, 12, 9, 41));
  style = document.createElement("style");
  style.textContent = await commands.formConsumerStyles();
  document.head.append(style);
  host = document.createElement("div");
  host.style.cssText = `display:flex;width:${width}px;height:800px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host);
  const fixture = storageViewFixture(kind);
  ui = createBrainUiRoot({ storage: null, request: options.request ?? fixture.request });
  renderer = createRoot(host);
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <StorageTab active />
      </BrainUiProvider>
    )
  );
  if (!options.request)
    await expect
      .poll(() =>
        fixture.requests.some((row) => row.path === "/api/storage/removals")
      )
      .toBe(true);
  if (kind !== "never")
    await expect
      .poll(() => page.getByRole("table", { name: /^Contents of / }).elements().length)
      .toBe(1);
  return fixture;
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
/** A breakdown row: the whole row is one button named after its entry. */
const row = (name: string) =>
  page.getByRole("table", { name: /^Contents of / }).getByRole("button", { name: new RegExp(`^${escape(name)}, `) });
/** A Find large files row's content half, which inspects its file. */
const inspect = (name: string) => button(new RegExp(`^${escape(name)}, .*inspect$`));
const matches = () => page.getByRole("table", { name: /^Matching PDFs/ });
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
/** Every control names itself: the accessible-name review, mechanised. */
function named(element: Element) {
  for (const control of element.querySelectorAll<HTMLElement>(
    '[role="button"],button,select,input,[role="radio"],[role="switch"]'
  )) {
    const labelledBy = control.getAttribute("aria-labelledby");
    const label =
      control.getAttribute("aria-label") ??
      (labelledBy ? labelledBy.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : null) ??
      (control.id ? document.querySelector(`label[for="${control.id}"]`)?.textContent : null) ??
      control.closest("label")?.textContent ??
      control.textContent;
    expect(label?.trim(), `STORAGE_CONTROL_NAMED ${control.outerHTML.slice(0, 120)}`).toBeTruthy();
  }
}
function targets(element: Element, zoom = 1) {
  for (const control of element.querySelectorAll<HTMLElement>(
    '[role="button"],button,select,input'
  )) {
    const target = control.matches('input[type="checkbox"],input[type="radio"]')
      ? control.closest("label") ?? control
      : control;
    const box = target.getBoundingClientRect();
    // An inline text action paints at text size and reaches 44px through an
    // absolutely positioned ::before; measure that reach, not the paint.
    const before = getComputedStyle(target, "::before");
    const reach = (side: string) => (before.position === "absolute" ? Math.max(0, -parseFloat(before.getPropertyValue(side)) || 0) : 0);
    const r = { height: box.height + (reach("top") + reach("bottom")) * zoom, width: box.width + (reach("left") + reach("right")) * zoom };
    // A reaching control (#3252) keeps its paint; its 44px coarse-pointer
    // target is probed edge by edge in hit-reach.settings.pointer.tsx. This
    // project runs under a fine pointer, which has no 44px floor.
    if (target.classList.contains("bk-hit")) {
      expect(target.style.minHeight, "STORAGE_ACTION_NOT_INFLATED").not.toBe("44px");
      continue;
    }
    const what = `${target.tagName} ${target.className} ${(target.getAttribute("aria-label") ?? target.textContent ?? "").slice(0, 40)}`;
    expect(
      r.height / zoom,
      `STORAGE_ACTION_TARGET_HEIGHT ${what}`
    ).toBeGreaterThanOrEqual(44);
    expect(
      r.width / zoom,
      `STORAGE_ACTION_TARGET_WIDTH ${what}`
    ).toBeGreaterThanOrEqual(44);
  }
}
/** Primary-tone buttons on screen: the kit paints primary with its own border token. */
const primaries = () =>
  Array.from(host.querySelectorAll<HTMLElement>("[data-bk-button]")).filter((el) =>
    (el.getAttribute("style") ?? "").includes("button-border-primary")
  );
const disabled = (element: Element) =>
  element.getAttribute("aria-disabled") === "true" ||
  (element as HTMLButtonElement).disabled === true;
const live = () => host.querySelector('[aria-live="polite"]')!.textContent;
async function files() {
  await button("Find large files").click();
  await expect
    .poll(() => matches().elements()[0]?.textContent ?? "")
    .toContain("Ithaca-harbor.pdf");
}
async function select(name: string) {
  await inspect(name).click();
  await expect
    .poll(() => disabled(button("Select file").element()))
    .toBe(false);
  await button("Select file").click();
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
}
async function about() {
  if (button("About these numbers").elements().length) await button("About these numbers").click();
  else await page.getByRole("button", { name: /About these numbers/ }).click();
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
        // An unknown size is a mark, never 0 and never an empty bar.
        const unknown = row("Native retained store").element();
        expect(unknown.textContent, "STORAGE_UNKNOWN_IS_A_MARK").toContain("? not measured");
        expect(unknown.textContent).not.toMatch(/\b0 (bytes|B)\b/);
        expect(unknown.querySelector(".bk-storage-bar"), "STORAGE_UNKNOWN_HAS_NO_BAR").toBeNull();
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
        named(host);
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
      expect(primaries().map((el) => el.textContent), "STORAGE_ONE_PRIMARY").toEqual(["Measure"]);
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
      expect(host.textContent).toContain("Nothing measurable to draw");
      expect(host.textContent).not.toContain("NaN");
    }
    if (kind === "partial") {
      expect(host.querySelector("[data-storage-status]")?.textContent).toContain("partial");
      await about();
      expect(host.textContent).toContain("permission denied");
    }
    if (kind === "separate")
      expect(
        host.querySelectorAll("[data-volume-id]"),
        "STORAGE_CAPACITY_ID_COUNTED_ONCE"
      ).toHaveLength(2);
    if (kind === "unsupported") {
      await files();
      expect(host.textContent).toContain(
        "Removal isn't available on this host"
      );
      expect(host.querySelectorAll('[data-storage-large-files] input[type="checkbox"]'), "STORAGE_UNSUPPORTED_HIDES_CHECKBOXES").toHaveLength(0);
      await inspect("Ithaca-harbor.pdf").click();
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
  await page.getByRole("combobox", { name: "Larger than", exact: true }).selectOptions("custom");
  await page.getByRole("textbox", { name: "Larger than (MB)", exact: true }).fill("invalid");
  await expect.poll(() => matches().element().textContent,
    { message: "STORAGE_INVALID_FILTER_HAS_NO_OLD_ROWS" }).not.toContain("Troy-charts.PDF");
  expect(disabled(button("Copy visible file list").element())).toBe(true);
});
test("PDF boundary, file-entry sum and hard-link union remain distinct", async () => {
  await scene("alias", 1280);
  await files();
  const table = matches().element();
  expect(table.textContent).not.toContain("Calypso-notes.pdf");
  expect(table.textContent, "STORAGE_STRICT_PDF_BOUNDARY").not.toContain(
    "Aeaea-boundary.pdf"
  );
  expect(table.textContent).toContain("Troy-charts.PDF");
  await about();
  expect(host.textContent).toContain("101,500,000 bytes");
  expect(host.textContent).toContain("Matching object union: 53.3 MB");
  await inspect("Troy-charts.PDF").click();
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
    await button("Review removal").click();
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
      button("Review removal").element()
    );
  });
test("Changed selected versions cannot inherit confirmation", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  fixture.changeVersion();
  await button("Review removal").click();
  await expect
    .poll(() => page.getByRole("dialog").element().textContent)
    .toContain("A selected version changed");
  expect(
    disabled(button("Remove 1 file").element()),
    "STORAGE_CHANGED_REVIEW_DISABLED"
  ).toBe(true);
  expect(fixture.confirms).toBe(0);
});
test("A verified row selects from its own checkbox as well as from its sheet", async () => {
  await scene();
  await files();
  const box = () => page.getByRole("checkbox", { name: /^Select Ithaca-harbor\.pdf, / });
  // Unverified: the checkbox opens the inspection that verifies it.
  await box().click();
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(1);
  await expect.poll(() => disabled(button("Select file").element())).toBe(false);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
  await box().click();
  await expect.poll(() => host.textContent, { message: "STORAGE_ROW_SELECTS" }).toContain("1 selected");
  await box().click();
  await expect.poll(() => host.textContent).not.toContain("1 selected");
});
test("Drill restores the parent row and retains D52", async () => {
  await scene();
  for (const name of ["Brain files", "attachments", "papers"]) {
    await row(name).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  await button("attachments").click();
  await expect
    .poll(() => document.activeElement === row("papers").elements()[0])
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
  for (const name of ["Brain files", "attachments", "papers"]) {
    await row(name).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  const table = page.getByRole("table", { name: /^Contents of / });
  const rows = () => table.element().querySelectorAll('.bk-storage-body > [role="row"]').length;
  expect(rows()).toBe(200);
  expect(host.textContent).toContain("205 items");
  expect(table.element().textContent).toContain("Ithaca-chart-204.pdf");
  await button("Next 200 items").click();
  await expect.poll(rows).toBe(5);
  expect(host.textContent).toContain("205 items");
  await page
    .getByRole("textbox", { name: "Search this folder" })
    .fill("chart-204");
  await expect.poll(rows).toBe(1);
  expect(table.element().textContent).toContain("Ithaca-chart-204.pdf");
  expect(fixture.requests.some((row) => row.path.endsWith("/tree"))).toBe(true);
});
test("Refresh preserves focused rows and requires explicit adoption before clearing selection", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  await button("Measure again").click();
  const focused = inspect("Troy-charts.PDF").element() as HTMLElement;
  focused.focus();
  await expect
    .poll(() => button("Show new measurement").elements().length, {
      timeout: 4000,
    })
    .toBe(1);
  expect(document.activeElement, "STORAGE_REFRESH_RETAINS_ROW_FOCUS").toBe(focused);
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
  await page.getByRole("button", { name: "Run Pack Git objects" }).click();
  await expect
    .poll(() => host.querySelector("[data-tool-list]")?.textContent)
    .toContain("response unconfirmed");
  const writes = () =>
    fixture.requests.filter(
      (row) => row.method === "POST" && row.path === "/api/storage/maintenance"
    );
  expect(writes()).toHaveLength(1);
  expect(button("Run Pack Git objects").elements(), "STORAGE_UNCONFIRMED_OFFERS_NO_RERUN").toHaveLength(0);
  await button("Check maintenance receipt").click();
  await expect
    .poll(() => button("Cancel Pack Git objects").elements().length)
    .toBe(1);
  await button("Cancel Pack Git objects").click();
  await expect.poll(() => host.querySelector("[data-tool-list]")?.textContent).toContain("Cancelled");
  expect(writes(), "STORAGE_MAINTENANCE_DOES_NOT_REPOST").toHaveLength(1);
  await page.getByRole("button", { name: /Measured before → after/ }).click();
  expect(host.textContent).toContain("Measured before → after");
  expect(host.textContent).toContain("Other writes may change these values");
});

test("Cancellation keeps acknowledged removal and stops the remaining selection", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  await select("Troy-charts.PDF");
  fixture.holdNextConfirmation();
  await button("Review removal").click();
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
  await inspect("Ithaca-harbor.pdf").click();
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
    await row(name).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  await page
    .getByRole("combobox", { name: "Size basis" })
    .selectOptions("logical");
  await expect.poll(() => host.querySelector("[data-storage-list-heading]")?.textContent).toMatch(/file size$/);
  const map = page.getByRole("group", { name: /Storage map/ }).element();
  expect(map.textContent, "STORAGE_ALIAS_NO_SECOND_AREA").not.toContain(
    "Troy-charts"
  );
  expect(page.getByRole("table", { name: /^Contents of / }).element().textContent).toContain(
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

// ── #4549: Find large files mode, its focus rules and the composed pane ──

for (const width of [320, 1280])
  test(`Find large files: entry focus, announcement and focus return at ${width}`, async () => {
    await scene("dense", width);
    // Drill first: Back restores the owner and the breadcrumb position.
    await page.getByRole("radio", { name: "Brain" }).click();
    await row("Brain files").click();
    await expect.poll(() => document.activeElement?.textContent).toBe("Brain files");
    await page.getByRole("textbox", { name: "Search this folder" }).fill("att");
    await button("Find large files").click();
    await expect
      .poll(() => document.activeElement, { message: "STORAGE_FIND_FOCUSES_HEADING" })
      .toBe(page.getByRole("heading", { name: "Find large files", exact: true }).element());
    await expect.poll(live, { message: "STORAGE_FIND_ANNOUNCED" }).toBe("Find large files. 3 matching PDFs.");
    // The mode replaces the owner switch, basis, legend, map and list.
    expect(page.getByRole("radiogroup", { name: "Ownership view" }).elements()).toHaveLength(0);
    expect(page.getByRole("combobox", { name: "Size basis" }).elements(), "STORAGE_FIND_HIDES_BASIS").toHaveLength(0);
    expect(page.getByRole("group", { name: /Storage map/ }).elements()).toHaveLength(0);
    expect((page.getByRole("textbox", { name: "Search matching filenames" }).element() as HTMLInputElement).value, "STORAGE_FIND_CLEARS_SEARCH").toBe("");
    // Changing a filter keeps focus on the control and announces the count.
    const larger = page.getByRole("combobox", { name: "Larger than", exact: true });
    (larger.element() as HTMLElement).focus();
    await larger.selectOptions("10");
    await expect.poll(live).toBe("2 matching PDFs");
    expect(document.activeElement).toBe(larger.element());
    expect(primaries(), "STORAGE_FIND_NO_PRIMARY_WITHOUT_SELECTION").toHaveLength(0);
    await accessible(host);
    named(host);
    targets(host);
    await button("Back to overview").click();
    await expect
      .poll(() => document.activeElement, { message: "STORAGE_BACK_FOCUSES_FIND" })
      .toBe(button("Find large files").element());
    await expect.poll(live).toMatch(/^Overview\./);
    expect(page.getByRole("radio", { name: "Brain" }).element().getAttribute("aria-checked"), "STORAGE_BACK_RESTORES_OWNER").toBe("true");
    await expect
      .poll(() => host.querySelector("[data-storage-crumb-current]")?.textContent, { message: "STORAGE_BACK_RESTORES_CRUMB" })
      .toBe("Brain files");
    expect((page.getByRole("textbox", { name: "Search this folder" }).element() as HTMLInputElement).value).toBe("");
  });
test("Back to overview with a selection asks before discarding it", async () => {
  await scene("dense", 1280);
  await files();
  await select("Ithaca-harbor.pdf");
  expect(primaries().map((el) => el.getAttribute("aria-label")), "STORAGE_SELECTION_ONE_PRIMARY").toEqual(["Review removal"]);
  await button("Back to overview").click();
  const group = page.getByRole("group", { name: "Discard selection" });
  await expect.poll(() => group.element().textContent).toContain("Discard 1 selected file?");
  expect(document.activeElement, "STORAGE_CONFIRM_FOCUSES_KEEP").toBe(button("Keep selection").element());
  await button("Keep selection").click();
  await expect.poll(() => document.activeElement).toBe(button("Back to overview").element());
  expect(host.textContent, "STORAGE_KEEP_RETAINS_SELECTION").toContain("1 selected");
  expect(page.getByRole("heading", { name: "Find large files", exact: true }).elements()).toHaveLength(1);
  await button("Back to overview").click();
  await button("Discard").click();
  await expect.poll(() => document.activeElement).toBe(button("Find large files").element());
  await button("Find large files").click();
  await expect.poll(() => matches().elements().length).toBe(1);
  expect(host.textContent, "STORAGE_DISCARD_CLEARS_SELECTION").not.toContain("1 selected");
});
test("The default state has exactly one primary-tone button", async () => {
  const fixture = storagePaneFixture({ state: "low" });
  await scene("dense", 1280, "dark", 1, { request: fixture.request, now: paneTime });
  await expect.poll(() => host.querySelector("[data-storage-banner]")).not.toBeNull();
  await expect.poll(() => host.querySelectorAll("[data-tool-row]").length).toBe(3);
  expect(primaries().map((el) => el.textContent), "STORAGE_ONE_PRIMARY").toEqual(["Find large files"]);
});
test("Opening the pane announces no empty selection that could talk over the mode", async () => {
  await scene("dense", 1280);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(live(), "STORAGE_NO_EMPTY_SELECTION_ANNOUNCEMENT").not.toContain("0 selected");
  await files();
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(live(), "STORAGE_FIND_ANNOUNCEMENT_STANDS").toBe("Find large files. 3 matching PDFs.");
  await select("Ithaca-harbor.pdf");
  await expect.poll(live).toMatch(/^1 selected; /);
});
test("List-only keyboard pass: drill, go up, find, inspect, select and review without the map", async () => {
  await scene("dense", 1280);
  row("Brain files").element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Brain files");
  (host.querySelector('.bk-storage-body button') as HTMLElement).focus();
  await userEvent.keyboard("{Backspace}");
  await expect.poll(() => document.activeElement === row("Brain files").elements()[0]).toBe(true);
  (button("Find large files").element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => matches().elements()[0]?.textContent ?? "").toContain("Ithaca-harbor.pdf");
  const target = inspect("Ithaca-harbor.pdf").element() as HTMLElement;
  target.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => disabled(button("Select file").element())).toBe(false);
  (button("Select file").element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
  expect(host.textContent).toContain("1 selected");
  (button("Review removal").element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => button("Remove 1 file").elements().length).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
  expect(document.activeElement, "STORAGE_ESCAPE_RETURNS_FOCUS").toBe(button("Review removal").element());
});

// ── The storage.md proof matrix, as real-browser baselines (#4549) ──
// Each scenario: its baseline cells, a list-only keyboard pass (every row
// reachable by Tab, no map needed), 200% zoom at 320, a greyscale capture
// and the accessible-name review.

type Cell = `${320 | 1280}-${"dark" | "light"}`;
interface MatrixScenario {
  name: string;
  cells: Cell[];
  kind: StorageScene;
  pane?: Parameters<typeof storagePaneFixture>[0] & { now?: number };
  act?: (fixture: Fixture) => Promise<void>;
  /** The element to capture; the pane by default, else the open dialog. */
  dialog?: boolean;
}
const ALL: Cell[] = ["320-dark", "320-light", "1280-dark", "1280-light"];
const MATRIX: MatrixScenario[] = [
  { name: "dense-overview", cells: ALL, kind: "dense", pane: { state: "low" } },
  { name: "separate-tmpfs", cells: ["320-dark", "1280-dark"], kind: "separate" },
  { name: "nearly-empty", cells: ["320-light", "1280-light"], kind: "empty" },
  {
    name: "drill-smaller",
    cells: ["320-dark", "1280-dark"],
    kind: "paged",
    act: async () => {
      for (const name of ["Brain files", "attachments", "papers"]) {
        await row(name).click();
        await expect.poll(() => document.activeElement?.textContent).toBe(name);
      }
    },
  },
  { name: "pdf-filter", cells: ALL, kind: "dense", act: files },
  { name: "partial-eacces", cells: ["320-dark", "1280-dark"], kind: "partial", act: about },
  {
    name: "file-sheet",
    cells: ["320-dark", "320-light", "1280-dark"],
    kind: "alias",
    dialog: true,
    act: async () => {
      await files();
      await inspect("Troy-charts.PDF").click();
      await expect.poll(() => page.getByRole("dialog").element().textContent).toContain("Eligibility: shared object");
    },
  },
  {
    name: "review",
    cells: ["320-dark", "1280-dark", "1280-light"],
    kind: "dense",
    dialog: true,
    act: async () => {
      await files();
      await select("Ithaca-harbor.pdf");
      await select("Troy-charts.PDF");
      await button("Review removal").click();
      await expect.poll(() => button("Remove 2 files").elements().length).toBe(1);
    },
  },
  {
    name: "mixed-result",
    cells: ALL,
    kind: "dense",
    dialog: true,
    act: async (fixture) => {
      await files();
      await select("Ithaca-harbor.pdf");
      await select("Troy-charts.PDF");
      fixture.changeVersion();
      await button("Review removal").click();
      await expect.poll(() => page.getByRole("dialog").element().textContent).toContain("A selected version changed");
    },
  },
  { name: "unsupported", cells: ["320-dark", "1280-dark"], kind: "unsupported", act: files },
  { name: "stale-low", cells: ["320-dark", "320-light", "1280-dark"], kind: "dense", pane: { state: "very-low", now: paneTime + 2 * 3_600_000 } },
  {
    name: "measuring",
    cells: ["320-dark", "320-light", "1280-dark"],
    kind: "never",
    act: async () => {
      await button("Measure").click();
      await expect.poll(() => host.textContent).toContain("Measuring…");
    },
  },
];
async function matrixScene(s: MatrixScenario, width: number, theme: string, zoom = 1) {
  const pane = s.pane ? storagePaneFixture({ ...s.pane, scene: s.kind }) : null;
  const fixture = await scene(s.kind, width, theme, zoom, pane ? { request: pane.request, now: s.pane?.now ?? paneTime } : {});
  if (pane) await expect.poll(() => host.querySelector("[data-storage-history-section] svg")).not.toBeNull();
  await s.act?.(pane?.inventory ?? fixture);
  return fixture;
}
/** Grow the host to its content so the baseline holds the whole pane. */
function unroll() {
  host.style.height = "auto";
  const pane = host.querySelector<HTMLElement>("[data-storage-pane]");
  if (pane) pane.style.overflow = "visible";
}
for (const s of MATRIX) {
  for (const cell of s.cells) {
    const [width, theme] = cell.split("-") as [string, "dark" | "light"];
    test(`Proof matrix ${s.name} ${cell}`, async () => {
      await matrixScene(s, Number(width), theme);
      await accessible(host);
      named(host);
      if (!s.dialog) unroll();
      const subject = s.dialog ? page.getByRole("dialog") : page.elementLocator(host);
      await expect(subject).toMatchScreenshot(`storage-${s.name}-${cell}`);
    });
  }
  test(`Proof matrix ${s.name}: list-only keyboard, 200% zoom at 320, greyscale`, async () => {
    await matrixScene(s, 320, "dark", 2);
    expect(host.scrollWidth, "STORAGE_NO_HORIZONTAL_OVERFLOW_200").toBeLessThanOrEqual(host.clientWidth + 1);
    const root = s.dialog ? (page.getByRole("dialog").element() as HTMLElement) : host;
    targets(root, 2);
    named(root);
    if (!s.dialog) {
      // Every list row is a Tab stop, reached without touching the map.
      const rows = Array.from(host.querySelectorAll<HTMLElement>(".bk-storage-row-main"));
      const reached = new Set<Element>();
      (host.querySelector("h2") as HTMLElement).focus();
      for (let i = 0; i < 400 && reached.size < rows.length; i++) {
        await userEvent.keyboard("{Tab}");
        if (document.activeElement && rows.includes(document.activeElement as HTMLElement)) reached.add(document.activeElement);
      }
      expect(reached.size, "STORAGE_LIST_ONLY_REACHES_EVERY_ROW").toBe(rows.length);
    }
    host.style.filter = "grayscale(1)";
    await commands.buttonCapture(`storage-${s.name}-greyscale`);
    host.style.filter = "";
  });
}
