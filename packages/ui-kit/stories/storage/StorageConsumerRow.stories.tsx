import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { storageLargeFiles } from "../../fixtures/storage.js";
import { StorageConsumerList } from "../../src/storage/StorageConsumerList.js";
import { StorageConsumerRow, StorageFilterRow, type StorageConsumerRowProps } from "../../src/storage/StorageConsumerRow.js";
import { STORAGE_PARTIAL_REASON, storageUnknownReason } from "../../src/storage/storage-copy.js";
import { viewportAt } from "../_viewports.js";
import { Frame, LargeFiles, storageViewport } from "./_storage.js";

/** Rows only exist inside the list's table, so every story renders one. */
function Rows({ children, mode = "browse" }: { children: React.ReactNode; mode?: "browse" | "filter" }) {
  return (
    <Frame>
      <StorageConsumerList label="Contents of Storage" mode={mode} sort={{ key: "size", direction: "descending" }} onSort={() => undefined}>
        {children}
      </StorageConsumerList>
    </Frame>
  );
}

const folder: StorageConsumerRowProps = {
  name: "Packs",
  owner: "app",
  action: "drill",
  kind: "folder",
  meta: "git \u00b7 1,204 files",
  size: "9.80 GB",
  share: 1,
  shareLabel: "38% of view",
  onActivate: fn(),
};

const meta = preview.meta({
  title: "Storage/StorageConsumerRow",
  component: StorageConsumerRow,
  parameters: { layout: "fullscreen" },
  beforeEach: storageViewport,
  render: (args) => (
    <Rows>
      <StorageConsumerRow {...args} />
    </Rows>
  ),
  args: folder,
  globals: viewportAt(320),
});

/** A folder: the whole row is one button, `›` drills in. */
export const Folder = meta.story({
  play: async ({ canvas, args, userEvent }) => {
    const row = await canvas.findByRole("button", { name: "Packs, App, folder, 9.80 GB, 38% of view" });
    await expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(canvas.queryByRole("button", { name: /^Open/ }), "no per-row Open").toBeNull();
    await userEvent.tab();
    await expect(document.activeElement).toBe(canvas.getByRole("button", { name: "Name" }));
    await userEvent.tab();
    await expect(document.activeElement).toBe(canvas.getByRole("button", { name: "Size" }));
    await userEvent.tab();
    await expect(document.activeElement, "the row is the next stop after the headers").toBe(row);
    await userEvent.keyboard("{Enter}");
    await expect(args.onActivate).toHaveBeenCalledTimes(1);
  },
});
export const FolderDesktop = Folder.extend({ globals: viewportAt(1280) });

/** A file: `⋯` inspects, which opens the inspect panel where Open lives. */
export const File = meta.story({
  args: { name: "index-2026-07.db", action: "inspect", kind: "file", meta: "database", size: "1.90 GB", share: 0.19, shareLabel: undefined },
  play: async ({ canvas }) => {
    await canvas.findByRole("button", { name: "index-2026-07.db, App, file, 1.90 GB, inspect" });
  },
});
export const FileDesktop = File.extend({ globals: viewportAt(1280) });

/** The aggregate row mirrors the map's neutral "N smaller" tile. */
export const Smaller = meta.story({ args: { name: "+212 smaller", owner: null, kind: "list", meta: "each under 1% of this folder", size: "578 MB", share: 0.41, shareLabel: undefined } });

/** Partial coverage: a lower bound, `≥ 4.20 GB`, with its reason; the tile is drawn at the known size. */
export const Partial = meta.story({
  args: { name: "Transcripts", meta: "transcripts", size: "4.20 GB", atLeast: true, reason: STORAGE_PARTIAL_REASON },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole("button", { name: `Transcripts, App, folder, at least 4.20 GB, 38% of view, ${STORAGE_PARTIAL_REASON}` });
    await expect(canvasElement.querySelector(".bk-storage-size")?.textContent).toBe("≥ 4.20 GB");
  },
});

const reasons = ["metadata-unavailable", "unsupported-platform", "cancelled", "root-budget", null] as const;

/**
 * THE UNKNOWN ROW, once per reason: a dashed `?` row, `? not measured`, the
 * reason on line two, and no bar and no `0 B` — an unknown is a mark, never
 * a number.
 */
export const UnknownEveryReason = meta.story({
  render: () => (
    <Rows>
      {reasons.map((reason) => (
        <StorageConsumerRow
          key={String(reason)}
          name={reason ? `Store · ${reason}` : "Remote copy"}
          owner="operator"
          action="inspect"
          kind="store"
          meta="backup"
          size={null}
          reason={storageUnknownReason(reason)}
          onActivate={() => undefined}
        />
      ))}
    </Rows>
  ),
  play: async ({ canvasElement }) => {
    const rows = [...canvasElement.querySelectorAll<HTMLElement>('[data-unknown="true"]')];
    await expect(rows).toHaveLength(reasons.length);
    for (const [i, row] of rows.entries()) {
      await expect(getComputedStyle(row).borderTopStyle).toBe("dashed");
      await expect(row.querySelector(".bk-storage-bar"), "STORAGE_UNKNOWN_HAS_NO_BAR").toBeNull();
      await expect(row.querySelector(".bk-storage-size")?.textContent).toBe("? not measured");
      await expect(row.textContent).toContain(storageUnknownReason(reasons[i]));
      await expect(row.textContent).not.toMatch(/\b0 ?B\b/);
    }
  },
});
export const UnknownEveryReasonDesktop = UnknownEveryReason.extend({ globals: viewportAt(1280) });

/** A long name takes two lines, then an ellipsis; the row never scrolls sideways at 320. */
export const LongName = meta.story({
  args: { name: "Ithaca-harbor-survey-of-the-eastern-mooring-before-the-suitors-arrived-final-revised-copy-with-annotations.pdf", action: "inspect", kind: "file", meta: "attachment", size: "48.2 MB" },
  play: async ({ canvasElement }) => {
    const name = canvasElement.querySelector<HTMLElement>(".bk-storage-name")!;
    const line = parseFloat(getComputedStyle(name).lineHeight);
    await expect(name.getBoundingClientRect().height, "two lines at most").toBeLessThanOrEqual(line * 2 + 1);
    // At 320 the name needs more than two lines, so the rest is clipped to an ellipsis.
    if (innerWidth < 600) await expect(name.scrollHeight, "the rest is clipped to an ellipsis").toBeGreaterThan(name.clientHeight);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
});
export const LongNameDesktop = LongName.extend({ globals: viewportAt(1280) });

/** Hovering or focusing the row rings it, the same 2px ring its tile draws (`highlighted`). */
export const Highlighted = meta.story({ args: { highlighted: true } });

/* ── Filter mode (Find large files, #4537 D11) ─────────────────────────────── */

/**
 * One row for each eligibility word, two selected, and the selection bar.
 * Checkbox and inspect are sibling cells: Space toggles, Enter inspects.
 */
export const FilterMode = meta.story({
  render: () => (
    <Frame>
      <LargeFiles files={storageLargeFiles} initial={["model", "export"]} />
    </Frame>
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(await canvas.findByRole("status")).toHaveTextContent("2 selected · 5.00 GB on disk");
    for (const word of ["Can remove", "Check · other links exist", "Kept · tracked by Git", "Can't tell · not measured"])
      await expect(canvasElement.textContent).toContain(word);
    for (const row of canvasElement.querySelectorAll('.bk-storage-filter')) {
      const [check, content] = [...row.querySelectorAll('[role="cell"]')];
      await expect(check!.querySelector("button"), "no control nested in the checkbox cell").toBeNull();
      await expect(content!.querySelector("input"), "no checkbox in the inspect cell").toBeNull();
      const target = check!.querySelector("label")!.getBoundingClientRect();
      await expect(target.width).toBeGreaterThanOrEqual(44);
      await expect(target.height).toBeGreaterThanOrEqual(44);
    }
    const wav = canvas.getByRole("checkbox", { name: "Select transcript-0612.wav, size not measured, Can't tell" });
    wav.focus();
    await userEvent.keyboard(" ");
    await expect(wav).toBeChecked();
    await expect(canvas.getByRole("status")).toHaveTextContent("3 selected · 5.00 GB on disk + ? unknown");
    await userEvent.click(canvas.getByRole("button", { name: "Clear" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("");
    await expect(canvas.queryByRole("button", { name: "Review removal" }), "the bar shows only with a selection").toBeNull();
  },
});
export const FilterModeDesktop = FilterMode.extend({ globals: viewportAt(1280) });

/** `⊘ Kept` keeps a focusable, aria-disabled checkbox, described by its reason, that never selects. */
export const FilterKept = meta.story({
  render: (args) => (
    <Rows mode="filter">
      <StorageFilterRow
      name="pack-3f2a.pack"
      folder="Packs/"
      size="1.40 GB"
      git="tracked"
      links={1}
      eligibility="kept"
      why="tracked by Git"
      selected={false}
      onSelectedChange={args.onActivate}
      onInspect={() => undefined}
      />
    </Rows>
  ),
  play: async ({ canvas, args, userEvent }) => {
    const box = await canvas.findByRole("checkbox", { name: "Select pack-3f2a.pack, 1.40 GB, Kept" });
    await expect(box).toHaveAttribute("aria-disabled", "true");
    await expect(box).toHaveAccessibleDescription("Kept · tracked by Git");
    await userEvent.click(box);
    box.focus();
    await userEvent.keyboard(" ");
    await expect(box).not.toBeChecked();
    await expect(args.onActivate, "a Kept row never selects").not.toHaveBeenCalled();
  },
});
