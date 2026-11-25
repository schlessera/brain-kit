import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StorageConsumerList } from "../src/storage/StorageConsumerList.js";
import { StorageConsumerRow, StorageFilterRow } from "../src/storage/StorageConsumerRow.js";
import { StorageMap, type StorageMapItem } from "../src/storage/StorageMap.js";
import { StorageMapLegend } from "../src/storage/StorageMapLegend.js";
import { StorageSelectionBar } from "../src/storage/StorageSelectionBar.js";

const noop = () => {};
const tile = (id: string, owner: StorageMapItem["owner"], bytes: number, extra: Partial<StorageMapItem> = {}): StorageMapItem => ({
  id,
  name: id,
  owner,
  bytes,
  label: `${bytes} GB`,
  ...extra,
});

describe("StorageMap ownership skin (#4544)", () => {
  const html = renderToStaticMarkup(
    <StorageMap
      items={[tile("Packs", "app", 9.8), tile("Backups", "operator", 3), tile("Notes", "brain", 1.2), tile("+38 smaller", "operator", 0.6, { smaller: true }), tile("Unknown", "brain", Number.NaN)]}
      width={480}
      height={280}
      label="Storage map, All, Storage"
      descriptionId="map-description"
      onOpen={noop}
      onUp={noop}
    />,
  );

  test("no tile is hatched; every tile names its owner and edge", () => {
    expect(html, "STORAGE_NO_HATCH").not.toContain("repeating-linear-gradient");
    expect(html.match(/data-owner="app"[^>]*data-edge="dotted"/g)).toHaveLength(1);
    expect(html.match(/data-owner="operator"[^>]*data-edge="dashed"/g)).toHaveLength(1);
    expect(html.match(/data-owner="brain"[^>]*data-edge="solid"/g)).toHaveLength(1);
    expect(html, "the aggregate is neutral whatever owner it was given").toMatch(/data-owner="aggregate"[^>]*data-edge="outline"/);
  });

  test("an unknown size draws no tile", () => {
    expect(html).not.toContain(">Unknown<");
    expect(html.match(/data-storage-map-index=/g)?.length).toBeLessThanOrEqual(4);
  });

  test("labelled tiles carry the owner cue; the aggregate names its list", () => {
    expect(html).toMatch(/data-owner-cue="App ·"/);
    expect(html).toContain('aria-label="Packs, App, 9.8 GB"');
    expect(html).toContain('aria-label="+38 smaller, 0.6 GB. Open list."');
  });
});

describe("StorageConsumerRow (#4544 Q3/Q4)", () => {
  test("a folder drills and a file inspects, each one button with the brief's name", () => {
    const folder = renderToStaticMarkup(
      <StorageConsumerRow name="Packs" owner="app" action="drill" kind="folder" meta="git · 1,204 files" size="9.8 GB" share={1} shareLabel="38% of view" onActivate={noop} />,
    );
    expect(folder).toContain('aria-label="Packs, App, folder, 9.8 GB, 38% of view"');
    expect(folder.match(/<button/g)).toHaveLength(1);
    expect(folder).toContain('data-glyph="drill"');
    expect(folder).not.toMatch(/>Open</);
    const file = renderToStaticMarkup(<StorageConsumerRow name="index-2026-07.db" owner="app" action="inspect" kind="file" meta="database" size="1.9 GB" onActivate={noop} />);
    expect(file).toContain('aria-label="index-2026-07.db, App, file, 1.9 GB, inspect"');
    expect(file).toContain('data-glyph="inspect"');
  });

  test("the unknown row is a dashed ? row with its reason, no bar and no zero", () => {
    const row = renderToStaticMarkup(
      <StorageConsumerRow name="Backups" owner="operator" action="inspect" kind="store" meta="backup" size={null} share={0.5} reason="couldn't read file details" onActivate={noop} />,
    );
    expect(row).toContain('data-unknown="true"');
    expect(row).toContain('data-owner-swatch="unknown"');
    expect(row, "STORAGE_UNKNOWN_HAS_NO_BAR").not.toContain("bk-storage-bar");
    expect(row).toContain("? not measured");
    expect(row).toContain("Operator · backup · couldn&#x27;t read file details");
    expect(row).not.toMatch(/\b0 ?B\b/);
    expect(row).toContain('aria-label="Backups, Operator, store, size not measured, couldn&#x27;t read file details, inspect"');
  });

  test("a partial row prints its lower bound", () => {
    const row = renderToStaticMarkup(<StorageConsumerRow name="Transcripts" owner="app" action="drill" kind="folder" size="4.2 GB" atLeast reason="size so far · scan stopped early" onActivate={noop} />);
    expect(row).toContain("≥ 4.2 GB");
    expect(row).toContain("at least 4.2 GB");
  });
});

describe("StorageFilterRow (#4544 Q5)", () => {
  test("checkbox and inspect are sibling cells, never nested", () => {
    const row = renderToStaticMarkup(
      <StorageFilterRow name="model-q8.gguf" folder="Models/" size="4.1 GB" git="untracked" links={1} eligibility="can-remove" selected onSelectedChange={noop} onInspect={noop} />,
    );
    const cells = row.split('role="cell"').slice(1);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain('type="checkbox"');
    expect(cells[0]).not.toContain("<button");
    expect(cells[1]).toContain("<button");
    expect(cells[1]).not.toContain('type="checkbox"');
    expect(row).toContain('aria-label="Select model-q8.gguf, 4.1 GB, Can remove"');
    expect(row).toContain("not in Git");
    expect(row).toContain("1 link");
  });

  test("a Kept row keeps an aria-disabled checkbox described by its reason", () => {
    const row = renderToStaticMarkup(
      <StorageFilterRow name="pack-3f2a.pack" folder="Packs/" size="1.4 GB" git="tracked" links={1} eligibility="kept" why="tracked by Git" selected onSelectedChange={noop} onInspect={noop} />,
    );
    expect(row).toMatch(/<input[^>]*type="checkbox"[^>]*aria-disabled="true"/);
    expect(row).not.toMatch(/<input[^>]*checked/);
    expect(row).not.toMatch(/<input[^>]* disabled/);
    const described = /aria-describedby="([^"]+)"/.exec(row)![1]!;
    expect(row).toContain(`id="${described}"`);
    expect(row).toContain("Kept · tracked by Git");
  });
});

describe("legend, list and selection bar", () => {
  test("the legend prints the unknown chip only when stores are unknown", () => {
    const owners = [{ owner: "brain" as const, total: "4.8 GB" }, { owner: "app" as const, total: "26.0 GB" }];
    expect(renderToStaticMarkup(<StorageMapLegend owners={owners} />)).not.toContain("size unknown");
    const html = renderToStaticMarkup(<StorageMapLegend owners={owners} unknownCount={2} />);
    expect(html).toContain("2 stores · size unknown · not drawn");
    expect(html, "chips are not filters").not.toContain("<button");
    expect(renderToStaticMarkup(<StorageMapLegend owners={owners} unknownCount={1} onShowUnknown={noop} />)).toContain('aria-label="1 store · size unknown · not drawn. Show in list"');
  });

  test("the sorted column carries aria-sort and an empty list prints its message", () => {
    const html = renderToStaticMarkup(<StorageConsumerList label="Contents of Packs" sort={{ key: "size", direction: "descending" }} onSort={noop} empty={<p>No files or folders match</p>} />);
    expect(html).toMatch(/role="columnheader" aria-sort="descending"[^>]*bk-storage-head-size/);
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toContain("No files or folders match");
  });

  test("the selection bar never says space freed and keeps its status mounted", () => {
    const closed = renderToStaticMarkup(<StorageSelectionBar count={0} size="0 B" basis="on disk" onClear={noop} onReview={noop} />);
    expect(closed).toContain('role="status"');
    expect(closed).not.toContain("<button");
    const open = renderToStaticMarkup(<StorageSelectionBar count={2} size="5.0 GB" basis="on disk" unknown onClear={noop} onReview={noop} />);
    expect(open).toContain("2 selected · 5.0 GB on disk + ? unknown");
    expect(open).not.toMatch(/freed|free\b/i);
  });
});
