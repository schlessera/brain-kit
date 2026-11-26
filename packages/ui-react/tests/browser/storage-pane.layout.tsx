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
  style: HTMLStyleElement,
  outer: { width: number; height: number } | undefined;
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
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});
type Fixture = ReturnType<typeof storageViewFixture>;
async function scene(
  kind: StorageScene = "dense",
  width = 320,
  theme = "dark",
  zoom = 1,
  options: { request?: Fixture["request"]; now?: number } = {}
) {
  // The runner's outer frame grows with the viewport, so a wide layout is
  // drawn at its own size rather than scaled down to fit the runner.
  outer ??= await commands.formViewport(width * zoom, 800 * zoom);
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
  // The last page has no Next: focus moves to First, never to the body (#4549 review F5).
  await expect
    .poll(() => document.activeElement, { message: "STORAGE_BREAKDOWN_NEXT_KEEPS_FOCUS" })
    .toBe(button("First 200 items").element());
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

// #4549 review F2: a control that changes or leaves while focused never drops
// focus to the body. The tool row keeps its action button through Run,
// Check receipt and Cancel; a control that does leave hands focus on.
test("Free up space and the status alert keep focus while their controls change or leave", async () => {
  await scene("maintenance");
  const list = () => host.querySelector("[data-tool-list]")!;
  const inList = () => document.activeElement !== document.body && list().contains(document.activeElement);
  const press = async (name: string) => {
    (button(name).element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
  };
  await press("Run Pack Git objects");
  await expect.poll(() => list().textContent).toContain("response unconfirmed");
  // The row's own button stays, held, and keeps focus: not a neighbour.
  const action = () => document.activeElement?.getAttribute("aria-label");
  expect(action(), "STORAGE_RUN_KEEPS_FOCUS").toBe("Try again Pack Git objects");
  // The error's own button leaves with the error it checks.
  await press("Check measurement status");
  await expect.poll(() => host.querySelector('[role="alert"]')).toBeNull();
  expect(document.activeElement, "STORAGE_CHECK_STATUS_KEEPS_FOCUS").toBe(
    page.getByRole("heading", { name: "Storage", exact: true, level: 2 }).element()
  );
  await press("Check maintenance receipt");
  await expect.poll(() => button("Cancel Pack Git objects").elements().length).toBe(1);
  expect(inList(), "STORAGE_CHECK_RECEIPT_KEEPS_FOCUS").toBe(true);
  // Check receipt leaves once the run is over: focus stays in its row.
  (button("Check maintenance receipt").element() as HTMLElement).focus();
  (button("Cancel Pack Git objects").element() as HTMLElement).click();
  await expect.poll(() => list().textContent).toContain("Cancelled");
  await expect.poll(() => button("Check maintenance receipt").elements().length).toBe(0);
  expect(inList(), "STORAGE_LEAVING_CHECK_RECEIPT_KEEPS_FOCUS").toBe(true);
  // Cancel pressed from the keyboard, in a second run.
  await press("Try again Pack Git objects");
  await expect.poll(() => list().textContent).toContain("response unconfirmed");
  await press("Check maintenance receipt");
  await expect.poll(() => button("Cancel Pack Git objects").elements().length).toBe(1);
  await press("Cancel Pack Git objects");
  await expect.poll(() => list().textContent).toContain("Cancelled");
  expect(action(), "STORAGE_CANCEL_KEEPS_FOCUS").toBe("Try again Pack Git objects");
});
test("Show all children leaves with the smaller items, and focus stays on the list", async () => {
  await scene("paged", 1280);
  for (const name of ["Brain files", "attachments", "papers"]) {
    await row(name).click();
    await expect.poll(() => document.activeElement?.textContent).toBe(name);
  }
  const smaller = () => host.querySelector<HTMLElement>('[aria-label$="Open list."]');
  await expect.poll(smaller).not.toBeNull();
  smaller()!.click();
  await expect.poll(() => page.getByRole("button", { name: "Show all children" }).elements().length).toBe(1);
  (page.getByRole("button", { name: "Show all children" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => page.getByRole("button", { name: "Show all children" }).elements().length).toBe(0);
  expect(document.activeElement, "STORAGE_SHOW_ALL_KEEPS_FOCUS").toBe(host.querySelector("[data-storage-list-heading]"));
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
// #4549 review (sixth round): a removal still running keeps its selection,
// and Review removal is held while it runs. Closing its dialog must leave the
// receipt reachable, for status and Cancel, without clearing the selection.
test("A running removal's receipt stays reachable beside its retained selection", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  await select("Troy-charts.PDF");
  fixture.holdNextConfirmation();
  await button("Review removal").click();
  await button("Remove 2 files").click();
  await expect.poll(() => button("Cancel remaining files").elements().length).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
  expect(host.textContent).toContain("2 selected");
  await expect
    .poll(() => button("View removal receipt").elements().length, { message: "STORAGE_RUNNING_RECEIPT_WITH_SELECTION" })
    .toBe(1);
  await button("View removal receipt").click();
  await expect.poll(() => button("Cancel remaining files").elements().length).toBe(1);
});
// #4549 review (seventh round): when that removal finishes, its receipt line
// leaves the selection bar. Focus on it moves to a surviving control there.
test("A finishing removal hands focus from its receipt line to the selection bar", async () => {
  const fixture = await scene();
  await files();
  await select("Ithaca-harbor.pdf");
  await select("Troy-charts.PDF");
  fixture.holdNextConfirmation();
  await button("Review removal").click();
  await button("Remove 2 files").click();
  await expect.poll(() => button("Cancel remaining files").elements().length).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
  await expect.poll(() => button("View removal receipt").elements().length).toBe(1);
  (button("View removal receipt").element() as HTMLElement).focus();
  fixture.finishHeldRemoval();
  await expect.poll(() => button("View removal receipt").elements().length).toBe(0);
  const active = document.activeElement;
  expect(active === document.body ? "body" : "control", "STORAGE_FINISHED_RECEIPT_KEEPS_FOCUS").toBe("control");
  expect(host.querySelector("[data-storage-large-files]")?.contains(active)).toBe(true);
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
// A database and its sidecars are one item (#4546, maintainer 2026-11-26):
// one map tile and one list row at the combined size, no sidecar of its own.
test("A folded database is one tile and one row in the real pane", async () => {
  const fixture = storageViewFixture("dense");
  const wal = "f".repeat(31) + "1";
  const request: Fixture["request"] = async (url, init) => {
    const response = await fixture.request(url, init);
    const query = new URL(url, "http://fixture.invalid");
    if (!query.pathname.endsWith("/tree") || query.searchParams.get("parentId")) return response;
    const page = await response.json();
    const base = page.nodes.find((node: { name: string }) => node.name === "App state");
    const size = { logical: 1_500_000_000, allocated: 1_500_000_000, coverage: "complete" };
    page.nodes.push({ ...base, id: wal, rootId: wal, name: "App state-wal", totals: size, area: size });
    page.totals.allocated += size.allocated;
    page.totals.logical += size.logical;
    page.matched += 1;
    return Response.json(page);
  };
  await scene("dense", 1280, "dark", 1, { request });
  const map = () => page.getByRole("group", { name: /Storage map/ }).element();
  await expect.poll(() => map().querySelector('[aria-label^="App state, "]')).not.toBeNull();
  expect(map().querySelector('[aria-label^="App state-wal, "]'), "STORAGE_SIDECAR_NO_TILE").toBeNull();
  const list = () => page.getByRole("table", { name: /^Contents of / }).element();
  await expect.poll(() => list().textContent).toContain("with -wal");
  expect(row("App state-wal").elements(), "STORAGE_SIDECAR_NO_ROW").toHaveLength(0);
});
// #4549 review F2 (third round): a row's links come from its removal
// inspection. An inspection that did not check every reference leaves the
// count unknown, never "no links"; a complete one states its count.
for (const complete of [false, true])
  test(`A row reads its links from ${complete ? "a complete" : "an incomplete"} inspection`, async () => {
    const fixture = storageViewFixture("dense");
    const request: Fixture["request"] = async (url, init) => {
      const response = await fixture.request(url, init);
      if (!new URL(url, "http://fixture.invalid").pathname.endsWith("/inspection")) return response;
      return Response.json({ ...(await response.json()), complete });
    };
    await scene("dense", 1280, "dark", 1, { request });
    await files();
    await select("Ithaca-harbor.pdf");
    await select("Troy-charts.PDF");
    const links = (name: string) => inspect(name).element().textContent ?? "";
    expect([links("Ithaca-harbor.pdf"), links("Troy-charts.PDF")].map((text) => /\? links unknown|no links|\d+ links?/.exec(text)?.[0]), "STORAGE_ROW_LINKS").toEqual(
      complete ? ["2 links", "no links"] : ["? links unknown", "? links unknown"]
    );
  });
// #4601: the inspect sheet and the review dialog read a file's links by the
// rows' rule. An empty list from an inspection that did not check every
// reference, or from a file refused as consequences_incomplete, is unknown
// coverage, never "No references found".
for (const coverage of ["incomplete", "refused", "complete"] as const)
  test(`The inspect sheet and review read a link-free file from ${coverage === "complete" ? "a complete" : coverage === "refused" ? "a consequences_incomplete" : "an incomplete"} inspection`, async () => {
    const fixture = storageViewFixture("dense");
    const complete = coverage !== "incomplete";
    const request: Fixture["request"] = async (url, init) => {
      const response = await fixture.request(url, init);
      const path = new URL(url, "http://fixture.invalid").pathname;
      if (path.endsWith("/inspection")) {
        const body = await response.json();
        const files = body.files.map((file: { reason: string | null; eligible: boolean }) =>
          coverage === "refused" ? { ...file, eligible: false, reason: "consequences_incomplete" } : file
        );
        return Response.json({ ...body, complete, files });
      }
      if (!path.startsWith("/api/storage/removals")) return response;
      // A review's coverage, wherever its receipt is returned.
      const body = await response.clone().json().catch(() => null);
      if (!body || typeof body !== "object") return response;
      const covered =(receipt: { review?: object } | null | undefined) =>
        receipt?.review ? { ...receipt, review: { ...receipt.review, complete } } : receipt;
      return Response.json("latest" in body ? { ...body, latest: covered(body.latest) } : covered(body), { status: response.status });
    };
    await scene("dense", 1280, "dark", 1, { request });
    await files();
    await inspect("Troy-charts.PDF").click();
    const sheet = () => page.getByRole("dialog").element().textContent ?? "";
    await expect.poll(sheet).toContain("Current source review:");
    if (coverage === "complete") {
      expect(sheet(), "STORAGE_SHEET_NONE_FOUND").toContain("No references found in the checked scope.");
    } else {
      expect(sheet(), "STORAGE_SHEET_LINKS_UNKNOWN").not.toContain("No references found");
      expect(sheet(), "STORAGE_SHEET_LINKS_UNKNOWN").toContain("Links unknown: not every reference was checked.");
    }
    if (coverage === "refused") return;
    await button("Select file").click();
    await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
    await button("Review removal").click();
    const review = () => page.getByRole("dialog").element().textContent ?? "";
    await expect.poll(review).toContain("Troy-charts.PDF");
    if (complete) {
      expect(review(), "STORAGE_REVIEW_NONE_FOUND").toContain("No references found in checked scope; other consumers remain unknown.");
    } else {
      expect(review(), "STORAGE_REVIEW_LINKS_UNKNOWN").not.toContain("No references found");
      expect(review(), "STORAGE_REVIEW_LINKS_UNKNOWN").toContain("Links unknown: not every reference was checked; other consumers remain unknown.");
    }
  });
// #4549 review F1 (third round): inventory expires after ten minutes while
// removal receipts persist, so the last removal's receipt and its Undo stay
// reachable when no measurement is current, as they were before the overhaul.
test("The last removal's receipt and Undo stay reachable without a current measurement", async () => {
  const fixture = storageViewFixture("never");
  const id = "f".repeat(31) + "2";
  await fixture.request("/api/storage/removals/reviews", {
    method: "POST",
    body: JSON.stringify({ id, paths: ["attachments/Ithaca-harbor.pdf"] }),
  });
  await fixture.request("/api/storage/removals", {
    method: "POST",
    body: JSON.stringify({ id, fingerprint: "a".repeat(64) }),
  });
  expect(fixture.receipt?.items.map((item) => item.undoAvailable)).toEqual([true]);
  await scene("never", 320, "dark", 1, { request: fixture.request });
  await expect
    .poll(() => host.querySelector("[data-storage-status]")?.getAttribute("data-storage-status"))
    .toBe("never");
  await expect
    .poll(() => button("View removal receipt").elements().length, { message: "STORAGE_RECEIPT_WITHOUT_SNAPSHOT" })
    .toBe(1);
  expect(host.querySelector("[data-storage-last-removal]")?.textContent).toContain("Last removal: partial");
  await button("View removal receipt").click();
  await expect
    .poll(() => button("Undo removal of attachments/Ithaca-harbor.pdf").elements().length)
    .toBe(1);
  await button("Undo removal of attachments/Ithaca-harbor.pdf").click();
  await expect.poll(() => button("Restore 1 file").elements().length, { message: "STORAGE_UNDO_WITHOUT_SNAPSHOT" }).toBe(1);
});
// #4549 review (fourth round): the server can report removal unavailable
// while it still holds the last receipt. Receipt access does not depend on
// removal capability, so Find large files still offers it.
test("The last removal's receipt stays reachable when removal becomes unavailable", async () => {
  const fixture = storageViewFixture("unsupported");
  const id = "f".repeat(31) + "3";
  await fixture.request("/api/storage/removals/reviews", {
    method: "POST",
    body: JSON.stringify({ id, paths: ["attachments/Ithaca-harbor.pdf"] }),
  });
  await fixture.request("/api/storage/removals", {
    method: "POST",
    body: JSON.stringify({ id, fingerprint: "a".repeat(64) }),
  });
  expect(fixture.receipt?.state).toBeTruthy();
  await scene("unsupported", 1280, "dark", 1, { request: fixture.request });
  await files();
  await expect.poll(() => host.textContent).toContain("Removal isn't available on this host");
  await expect
    .poll(() => button("View removal receipt").elements().length, { message: "STORAGE_RECEIPT_WHEN_REMOVAL_UNAVAILABLE" })
    .toBe(1);
  expect(host.querySelectorAll('[data-storage-large-files] input[type="checkbox"]')).toHaveLength(0);
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
// #4549 review F1: the mode lists files by file size, its own basis, in its
// own order; the overview's sort, direction and basis never leak into it.
test("Find large files asks for its own file-size order, not the overview's", async () => {
  const fixture = await scene("dense", 1280);
  const contents = page.getByRole("table", { name: /^Contents of / });
  await contents.getByRole("button", { name: "Name", exact: true }).click();
  await expect
    .poll(() => contents.getByRole("columnheader", { name: /^Name/ }).element().getAttribute("aria-sort"))
    .toBe("ascending");
  await files();
  const asked = () => fixture.requests.filter((value) => value.path.endsWith("/entries")).at(-1)?.query;
  expect(asked(), "STORAGE_FIND_OWN_ORDER").toMatchObject({ sort: "size", direction: "desc", metric: "logical" });
  const size = () => matches().getByRole("columnheader", { name: /^Size/ }).element().getAttribute("aria-sort");
  expect(size()).toBe("descending");
  // The header stays a sortable control, and what it shows is what was asked.
  await matches().getByRole("button", { name: "Size", exact: true }).click();
  await expect.poll(() => asked()?.direction, { message: "STORAGE_FIND_SORTABLE" }).toBe("asc");
  expect(asked()).toMatchObject({ sort: "size", metric: "logical" });
  await expect.poll(size).toBe("ascending");
  await expect
    .poll(() => matches().element().querySelector('.bk-storage-body > [role="row"]')?.textContent ?? "")
    .toContain("Sirens-score.pdf");
});
// #4549 review F4: an inspection asked for while another action is pending
// opens nothing, and a late response never reopens or replaces a sheet.
test("Inspecting while an inspection is pending opens no sheet, and a closed sheet stays closed", async () => {
  const fixture = await scene();
  await files();
  const release = fixture.deferInspection();
  await inspect("Ithaca-harbor.pdf").click();
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").elements().length).toBe(0);
  await inspect("Troy-charts.PDF").click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(page.getByRole("dialog").elements(), "STORAGE_BUSY_INSPECTION_OPENS_NOTHING").toHaveLength(0);
  const verified = () => page.getByRole("checkbox", { name: /^Select Ithaca-harbor\.pdf, / }).element().getAttribute("aria-label");
  const before = verified();
  release();
  await expect.poll(verified).not.toBe(before);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(page.getByRole("dialog").elements(), "STORAGE_LATE_INSPECTION_STAYS_CLOSED").toHaveLength(0);
  // Once nothing is pending, inspection opens and settles as before.
  await inspect("Troy-charts.PDF").click();
  await expect.poll(() => disabled(button("Select file").element())).toBe(false);
});
// #4549 review F5: an action that removes its own focused control moves
// focus to a surviving one, never to the document body.
test("Clear, Show new measurement and paging keep focus on the pane", async () => {
  const fixture = await scene("paged", 1280);
  await button("Find large files").click();
  await expect.poll(() => matches().elements()[0]?.textContent ?? "").toContain("Ithaca-chart-");
  (button("Next 200 items").element() as HTMLElement).focus();
  await button("Next 200 items").click();
  await expect
    .poll(() => document.activeElement?.getAttribute("role") === "button" && document.activeElement.textContent, { message: "STORAGE_NEXT_KEEPS_FOCUS" })
    .toBe("First 200 items");
  await button("First 200 items").click();
  await expect
    .poll(() => document.activeElement?.getAttribute("role") === "button" && document.activeElement.textContent, { message: "STORAGE_FIRST_KEEPS_FOCUS" })
    .toBe("Next 200 items");
  await select("Ithaca-chart-204.pdf");
  await button("Clear").click();
  await expect.poll(() => host.textContent).not.toContain("1 selected");
  await expect
    .poll(() => document.activeElement, { message: "STORAGE_CLEAR_KEEPS_FOCUS" })
    .toBe(page.getByRole("heading", { name: "Find large files", exact: true }).element());
  await button("Measure again").click();
  await expect.poll(() => button("Show new measurement").elements().length, { timeout: 4000 }).toBe(1);
  await button("Show new measurement").click();
  await expect
    .poll(() => document.activeElement, { message: "STORAGE_SHOW_KEEPS_FOCUS" })
    .toBe(page.getByRole("heading", { name: "Storage", exact: true, level: 2 }).element());
  expect(fixture.requests.some((value) => value.path === "/api/storage/scans")).toBe(true);
});
test("The default state has exactly one primary-tone button", async () => {
  const fixture = storagePaneFixture({ state: "low" });
  await scene("dense", 1280, "dark", 1, { request: fixture.request, now: paneTime });
  await expect.poll(() => host.querySelector("[data-storage-banner]")).not.toBeNull();
  await expect.poll(() => host.querySelectorAll("[data-tool-row]").length).toBe(3);
  expect(primaries().map((el) => el.textContent), "STORAGE_ONE_PRIMARY").toEqual(["Find large files"]);
});
test("Each rendered volume card shows its own Trend and Runway, never another volume's", async () => {
  // The data volume falls 1.2 GB/day with a 14-day short window; the backups
  // disk falls 100 MB/day and is not running out in either window.
  const fixture = storagePaneFixture({ state: "low" });
  await scene("dense", 1280, "dark", 1, { request: fixture.request, now: paneTime });
  await expect.poll(() => host.querySelectorAll("[data-volume-id]").length).toBe(2);
  const cards = Array.from(host.querySelectorAll("[data-volume-id]")).map((card) => ({
    id: card.getAttribute("data-volume-id"),
    text: card.textContent ?? "",
  }));
  const data = fixture.guidance.capacities[0]!.identity,
    disk = fixture.guidance.capacities[1]!.identity;
  expect(cards.map((card) => card.id)).toEqual([data, disk]);
  const [first, second] = cards as [(typeof cards)[0], (typeof cards)[0]];
  expect(first.text, "STORAGE_CARD_OWN_TREND").toContain("−1.2 GB/day");
  expect(first.text, "STORAGE_CARD_OWN_RUNWAY").toContain("~14 days");
  expect(second.text, "STORAGE_CARD_OWN_TREND").toContain("−100 MB/day");
  expect(second.text, "STORAGE_CARD_OWN_RUNWAY").toContain("not projected · not running out");
  expect(second.text, "STORAGE_CARD_NOT_ANOTHER_VOLUMES_FIGURES").not.toMatch(/−1\.2 GB\/day|~14 days/);
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
  // The approved composition's states (#4549 brief): healthy with no banner,
  // Low with the banner, Very low with a refused tool; filter mode is pdf-filter.
  {
    name: "healthy",
    cells: ALL,
    kind: "dense",
    pane: { state: "healthy" },
    act: async () => {
      await expect.poll(() => host.querySelectorAll("[data-tool-row]").length).toBe(3);
      expect(host.querySelector("[data-storage-banner]"), "STORAGE_HEALTHY_HAS_NO_BANNER").toBeNull();
    },
  },
  { name: "dense-overview", cells: ALL, kind: "dense", pane: { state: "low" } },
  {
    name: "very-low-refused",
    cells: ALL,
    kind: "dense",
    pane: { state: "very-low" },
    act: async () => {
      await expect.poll(() => host.querySelector("[data-storage-banner]")?.getAttribute("data-storage-banner")).toBe("critical");
      await expect.poll(() => host.querySelector("[data-storage-free-up]")?.textContent ?? "", { message: "STORAGE_VERY_LOW_SHOWS_REFUSED_TOOL" }).toContain("not enough free space to pack");
    },
  },
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
    act: async () => {
      await files();
      await select("Ithaca-harbor.pdf");
      await select("Troy-charts.PDF");
      await button("Review removal").click();
      await expect.poll(() => button("Remove 2 files").elements().length).toBe(1);
      // The owner removes one file and finds the other changed since review.
      await button("Remove 2 files").click();
      // #4549 review F4: the matrix row is the mixed removal result itself.
      await expect
        .poll(() => page.getByRole("dialog").element().textContent, { message: "STORAGE_MIXED_RESULT_SHOWN" })
        .toContain("1 removed · 0 restored · 1 other outcomes");
      expect(page.getByRole("dialog").element().textContent).toContain("changed since review");
      expect(button("Undo removal of attachments/Ithaca-harbor.pdf").elements(), "STORAGE_MIXED_RESULT_OFFERS_UNDO").toHaveLength(1);
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
/** Grow the host, and the viewport, to the content so the baseline holds the whole pane. */
async function unroll(width: number) {
  host.style.height = "auto";
  const pane = host.querySelector<HTMLElement>("[data-storage-pane]");
  if (pane) pane.style.overflow = "visible";
  const tall = Math.ceil(host.getBoundingClientRect().height) + 16;
  await commands.formViewport(width, tall);
  await page.viewport(width, tall);
  await document.fonts.ready;
}
for (const s of MATRIX) {
  for (const cell of s.cells) {
    const [width, theme] = cell.split("-") as [string, "dark" | "light"];
    test(`Proof matrix ${s.name} ${cell}`, async () => {
      await matrixScene(s, Number(width), theme);
      await accessible(host);
      named(host);
      if (!s.dialog) await unroll(Number(width));
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
