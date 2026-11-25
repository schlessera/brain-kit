/**
 * Story furniture for the storage breakdown (#4544): the derivation a caller
 * does before it hands the kit its props, and the side-by-side / stacked
 * layout of the approved design (Q6). Not shipped: in the app this lives in
 * ui-react (#4546, #4549). It is here so the composed stories exercise the
 * kit components the way the pane will.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { formatBytes, type StorageEntry, type StorageLargeFile } from "../../fixtures/storage.js";
import { appAddedRising } from "../../fixtures/storage-history.js";
import { Sparkline } from "../../src/storage/Sparkline.js";
import { StorageBreadcrumb, type StorageCrumb } from "../../src/storage/StorageBreadcrumb.js";
import { StorageConsumerList, type StorageSortDirection, type StorageSortKey } from "../../src/storage/StorageConsumerList.js";
import { StorageConsumerRow, StorageFilterRow } from "../../src/storage/StorageConsumerRow.js";
import { StorageMap, type StorageMapItem } from "../../src/storage/StorageMap.js";
import { StorageMapLegend, type StorageMapLegendOwner } from "../../src/storage/StorageMapLegend.js";
import { StorageSelectionBar } from "../../src/storage/StorageSelectionBar.js";
import { StorageSummaryRow } from "../../src/storage/StorageSummaryRow.js";
import { storageUnknownReason } from "../../src/storage/storage-copy.js";
import type { StorageOwner } from "../../src/storage/storage-geometry.js";
import { color, font } from "../../src/tokens.js";

export const SMALLER_ID = "smaller";

/**
 * Opens the story at the width its `viewport` global names, in the Vitest
 * runner only (`viewportAt(320)` / `viewportAt(1280)`), so 320 and desktop
 * are real layouts rather than a column squeezed into the runner's default
 * frame. The outer frame grows too, so Vitest does not scale the iframe.
 * Opened by hand, Storybook's own viewport toolbar does the same job.
 */
export async function storageViewport({ globals }: { globals?: { viewport?: unknown } }) {
  if (!document.documentElement.dataset.expectedStoryTheme) return;
  const key = (globals?.viewport as { value?: string } | undefined)?.value ?? "";
  const width = Number(/^consumer-(\d+)$/.exec(key)?.[1]);
  if (!width) throw new Error(`storage stories open at viewportAt(320) or viewportAt(1280), not "${key}"`);
  const { page, commands } = await import("vitest/browser");
  const before = { width: innerWidth, height: innerHeight };
  const outer = await commands.consumerParityViewport(width);
  await page.viewport(width, 800);
  return async () => {
    await page.viewport(before.width, before.height);
    await commands.consumerParityViewport(null, outer);
  };
}

/** The 320px phone gutter (storage.md), or desktop padding. */
export function Frame({ children, filter }: { children: ReactNode; filter?: string }) {
  return (
    <div data-storage-frame="" style={{ boxSizing: "border-box", width: "100%", padding: 12, background: color.canvas, filter, minHeight: "100vh" }}>
      {children}
    </div>
  );
}

/** Every way the frame's content escapes the page width at this zoom. */
export function pageOverflow(): number {
  return document.documentElement.scrollWidth - document.documentElement.clientWidth;
}

/** Side by side from 840px of container, stacked below, a 120px strip below 400px (Q6). */
export const SIDE_BY_SIDE = 840;
export const STRIP = 400;

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const known = (entry: StorageEntry) => entry.bytes !== null && entry.bytes > 0;

/**
 * Map items from the known positive entries, the way ui-react's `mapItems`
 * builds them: children under 1% fold into "N smaller", a phone shows at most
 * six tiles plus that aggregate. Unknown entries are never passed.
 */
export function mapItemsFor(entries: readonly StorageEntry[], phone: boolean): StorageMapItem[] {
  const measured = entries.filter(known).sort((a, b) => b.bytes! - a.bytes!);
  const total = measured.reduce((sum, e) => sum + e.bytes!, 0);
  if (total <= 0) return [];
  const shown = measured.filter((e) => e.bytes! / total >= 0.01).slice(0, phone ? 6 : measured.length);
  const pct = (bytes: number) => `${((bytes / total) * 100).toPrecision(2)}%`;
  const items: StorageMapItem[] = shown.map((e) => ({ id: e.id, name: e.name, owner: e.owner, bytes: e.bytes!, label: `${formatBytes(e.bytes!)} · ${pct(e.bytes!)}` }));
  const rest = measured.length - shown.length;
  const remainder = total - shown.reduce((sum, e) => sum + e.bytes!, 0);
  if (rest > 0 && remainder > 0)
    items.push({ id: SMALLER_ID, name: `+${rest} smaller`, owner: "app", bytes: remainder, label: formatBytes(remainder), smaller: true });
  return items;
}

/** Per-owner totals within the view (never across capacities), and how many stores are unknown. */
export function legendFor(entries: readonly StorageEntry[]): { owners: StorageMapLegendOwner[]; unknownCount: number } {
  const order: StorageOwner[] = ["brain", "app", "operator"];
  const owners = order
    .filter((owner) => entries.some((e) => e.owner === owner))
    .map((owner) => {
      const mine = entries.filter((e) => e.owner === owner);
      const sum = mine.filter((e) => e.bytes !== null).reduce((s, e) => s + e.bytes!, 0);
      const partial = mine.some((e) => e.bytes === null || e.atLeast);
      // A measured zero is "none"; an owner with unknown stores has no total, or only a lower bound.
      const total = sum > 0 ? `${partial ? "\u2265 " : ""}${formatBytes(sum)}` : partial ? undefined : "none";
      return { owner, total };
    });
  return { owners, unknownCount: entries.filter((e) => e.bytes === null).length };
}

/** Sorted rows; an unknown size sorts last whatever the direction (Q4). */
export function sortEntries(entries: readonly StorageEntry[], key: StorageSortKey, direction: StorageSortDirection) {
  const sign = direction === "ascending" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if ((a.bytes === null) !== (b.bytes === null)) return a.bytes === null ? 1 : -1;
    if (key === "name") return sign * a.name.localeCompare(b.name);
    return sign * ((a.bytes ?? 0) - (b.bytes ?? 0)) || a.name.localeCompare(b.name);
  });
}

/** The real usage sparkline (#4543); the row prints the value and window, so the line carries none. */
export function SummarySparkline() {
  return <Sparkline points={appAddedRising} label="App added 3.4 GB on Data volume in 7 days" showValue={false} />;
}

export interface BreakdownProps {
  entries: readonly StorageEntry[];
  trail?: readonly StorageCrumb[];
  /** Prints the "What this app added" row above the list. */
  summary?: boolean;
  /** A search with no matches: the list prints why, the map is shown muted with a caption. */
  noMatchesFor?: string;
  onDrill?: (id: string) => void;
  onInspect?: (id: string) => void;
  onUp?: () => void;
  onNavigate?: (id: string) => void;
  /** Rendered after the current crumb, where Open for the folder lives. */
  crumbActions?: ReactNode;
}

/** The breakdown as the pane composes it: legend, map and list, side by side or stacked. */
export function Breakdown({ entries, trail = [{ id: "root", label: "Storage" }], summary, noMatchesFor, onDrill, onInspect, onUp, onNavigate, crumbActions }: BreakdownProps) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const [sort, setSort] = useState<{ key: StorageSortKey; direction: StorageSortDirection }>({ key: "size", direction: "descending" });
  const [highlight, setHighlight] = useState<string | null>(null);
  const side = width >= SIDE_BY_SIDE,
    strip = width > 0 && width < STRIP,
    phone = width < 600;
  const mapWidth = side ? Math.floor((width - 24) / 2) : width;
  const mapHeight = strip ? 120 : side ? Math.round((mapWidth * 3) / 4) : Math.max(180, Math.round((mapWidth * 10) / 16));
  const tiles = mapItemsFor(entries, phone);
  const legend = legendFor(entries);
  const here = trail.at(-1)!.label;
  const shownIds = new Set(tiles.map((t) => t.id));
  const smaller = tiles.find((t) => t.smaller);
  // The list mirrors the map: what the map folds into "N smaller", the list folds too.
  const visible = sortEntries(
    entries.filter((e) => !smaller || shownIds.has(e.id) || e.bytes === null || e.bytes === 0),
    sort.key,
    sort.direction,
  );
  const largest = Math.max(1, ...visible.map((e) => e.bytes ?? 0), smaller?.bytes ?? 0);
  const total = entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  const firstUnknown = visible.find((e) => e.bytes === null);
  const rowId = (id: string) => `storage-row-${id}`;
  const rows = noMatchesFor
    ? []
    : visible.map((e) => (
        <StorageConsumerRow
          key={e.id}
          id={rowId(e.id)}
          name={e.name}
          owner={e.owner}
          action={e.kind === "folder" ? "drill" : "inspect"}
          kind={e.kind}
          meta={e.meta}
          size={e.bytes === null ? null : e.bytes === 0 ? "none" : formatBytes(e.bytes)}
          atLeast={e.atLeast}
          share={(e.bytes ?? 0) / largest}
          shareLabel={e.bytes ? `${Math.round((e.bytes / total) * 100)}% of view` : undefined}
          reason={e.bytes === null || e.atLeast ? storageUnknownReason(e.reason) : undefined}
          onActivate={() => (e.kind === "folder" ? onDrill?.(e.id) : onInspect?.(e.id))}
          highlighted={highlight === e.id}
          onHighlight={(active) => setHighlight(active ? e.id : null)}
        />
      ));
  // The aggregate sorts with the measured rows; unknown rows stay last whatever the order.
  const firstUnknownRow = noMatchesFor ? 0 : visible.findIndex((e) => e.bytes === null);
  if (smaller && !noMatchesFor)
    rows.splice(firstUnknownRow < 0 ? rows.length : firstUnknownRow, 0,
      <StorageConsumerRow
        key={SMALLER_ID}
        id={rowId(SMALLER_ID)}
        name={smaller.name}
        owner={null}
        action="drill"
        kind="list"
        meta="each under 1% of this folder"
        size={formatBytes(smaller.bytes)}
        share={smaller.bytes / largest}
        onActivate={() => onDrill?.(SMALLER_ID)}
        highlighted={highlight === SMALLER_ID}
        onHighlight={(active) => setHighlight(active ? SMALLER_ID : null)}
      />,
    );
  const descriptionId = "storage-map-description";
  const map = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {tiles.length ? (
        <StorageMap
          items={tiles}
          width={Math.max(1, mapWidth)}
          height={mapHeight}
          label={`Storage map, All, ${here}`}
          descriptionId={descriptionId}
          onOpen={(id) => (id === SMALLER_ID || entries.find((e) => e.id === id)?.kind === "folder" ? onDrill?.(id) : onInspect?.(id))}
          onUp={() => onUp?.()}
          highlightedId={highlight}
          onHighlight={setHighlight}
          muted={Boolean(noMatchesFor)}
        />
      ) : (
        <p style={{ margin: 0, font: `400 12px/1.4 ${font.body}`, color: color.inkDim }}>Nothing measured to draw. The list has every entry.</p>
      )}
      <p id={descriptionId} style={{ margin: 0, font: `400 10.5px/1.4 ${font.mono}`, color: color.inkMute }}>
        {noMatchesFor ? `Map shows ${here} · search matches none` : "The list below has every entry. Arrow keys move between tiles; Enter opens; Backspace goes up."}
      </p>
    </div>
  );
  const list = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {summary ? <StorageSummaryRow chart={<SummarySparkline />} value="+3.4 GB" window="7 d" /> : null}
      <StorageConsumerList
        label={`Contents of ${here}`}
        sort={sort}
        onSort={(key) => setSort((s) => ({ key, direction: s.key === key && s.direction === "descending" ? "ascending" : "descending" }))}
        onUp={onUp}
        empty={
          <span style={{ display: "flex", flexDirection: "column", gap: 4, font: `400 12px/1.4 ${font.body}`, color: color.ink }}>
            <span>
              No files or folders match &ldquo;{noMatchesFor}&rdquo; in {trail.map((c) => c.label).join(" › ")}.
            </span>
          </span>
        }
      >
        {rows}
      </StorageConsumerList>
    </div>
  );
  return (
    <div ref={frame} data-storage-breakdown="" data-layout={side ? "side" : strip ? "strip" : "stacked"} style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      <StorageBreadcrumb trail={trail} onNavigate={(id) => onNavigate?.(id)} actions={crumbActions} />
      <StorageMapLegend
        owners={legend.owners}
        unknownCount={legend.unknownCount}
        onShowUnknown={firstUnknown ? () => document.getElementById(rowId(firstUnknown.id))?.querySelector("button")?.focus() : undefined}
      />
      {width > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: side ? "minmax(320px, 1fr) minmax(360px, 1fr)" : "minmax(0, 1fr)", gap: side ? 24 : 12, alignItems: "start" }}>
          {map}
          {list}
        </div>
      ) : null}
    </div>
  );
}

/** Find large files: the filter-mode list with its selection bar. */
export function LargeFiles({ files, initial = [] }: { files: readonly StorageLargeFile[]; initial?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial);
  const chosen = files.filter((f) => selected.includes(f.id));
  const size = chosen.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <StorageConsumerList
        label="Find large files, larger than 100 MB"
        mode="filter"
        sort={{ key: "size", direction: "descending" }}
        footer={
          <StorageSelectionBar
            count={chosen.length}
            size={formatBytes(size)}
            basis="on disk"
            unknown={chosen.some((f) => f.bytes === null)}
            onClear={() => setSelected([])}
            onReview={() => undefined}
          />
        }
      >
        {files.map((f) => (
          <StorageFilterRow
            key={f.id}
            name={f.name}
            folder={f.folder}
            size={f.bytes === null ? null : formatBytes(f.bytes)}
            git={f.git}
            links={f.links}
            eligibility={f.eligibility}
            why={f.why}
            selected={selected.includes(f.id)}
            onSelectedChange={(next) => setSelected((s) => (next ? [...s, f.id] : s.filter((id) => id !== f.id)))}
            onInspect={() => undefined}
          />
        ))}
      </StorageConsumerList>
    </div>
  );
}
