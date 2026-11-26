import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  StorageBreadcrumb,
  StorageConsumerList,
  StorageConsumerRow,
  StorageMap,
  StorageMapLegend,
  TextButton,
  type StorageMapLegendOwner,
  type StorageOwner,
} from "@schlessera/brain-ui-kit";
import type { StorageFileEntry, StorageSnapshot } from "@schlessera/brain-ui-sdk/protocol";
import { bytes, mapItems } from "./storage-model.js";
import { storageConsumerRows, storageListing } from "./storage-consumers.js";
import { StorageSegmented } from "./storage-segmented.js";
import type { useStorage } from "./use-storage.js";
import { usePageFocus } from "./storage-page-focus.js";

type StorageView = ReturnType<typeof useStorage>;

/** Side by side from 840px of section, stacked below, the 120px strip below 560px (#4549 brief). */
const SIDE_BY_SIDE = 840;
const STRIP = 560;
const ROOT = "all";

const OWNERS: ReadonlyArray<{ value: "all" | StorageOwner; label: string }> = [
  { value: "all", label: "All" },
  { value: "brain", label: "Brain" },
  { value: "app", label: "App" },
  { value: "operator", label: "Operator" },
];

/** A section's own width, so the layout follows the pane and not the window. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(Math.max(1, element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The basis select, shared by the overview controls. */
function SizeBasis({ view }: { view: StorageView }) {
  return (
    <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
      Size basis
      <select
        aria-label="Size basis"
        className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground"
        value={view.metric}
        onChange={(event) => view.setMetric(event.target.value as "allocated" | "logical")}
      >
        <option value="allocated">On disk (estimate)</option>
        <option value="logical">File size</option>
      </select>
    </label>
  );
}

/**
 * "What's using space" in its overview mode (#4537 D2): the owner switch,
 * size basis and search; the legend; the map and the list side by side,
 * stacked when the section is narrow. The list is always present and
 * equivalent to the map, so there is no "list only" switch (#4549 decision).
 * Unknown sizes are `?` rows and draw no tile; nothing here is a capacity.
 */
export function StorageBreakdown({
  view,
  snapshot,
  summary,
  onInspect,
}: {
  view: StorageView;
  snapshot: StorageSnapshot;
  /** The "What this app added" row, above the list. */
  summary?: ReactNode;
  onInspect: (entry: StorageFileEntry) => void;
}) {
  const id = useId();
  const [frame, width] = useWidth<HTMLDivElement>();
  const [highlight, setHighlight] = useState<string | null>(null),
    [showEmpty, setShowEmpty] = useState(false);
  const pendingFocus = useRef<string | null>(null);
  const tree = view.tree;
  const { pager, paging } = usePageFocus(view.loading, tree);
  const side = width >= SIDE_BY_SIDE,
    strip = width > 0 && width < STRIP;
  const mapWidth = side ? Math.floor((width - 24) / 2) : width;
  const mapHeight = strip ? 120 : side ? Math.min(420, Math.round((mapWidth * 3) / 4)) : Math.round((mapWidth * 10) / 16);
  const tiles = view.chart ? mapItems(view.chart, view.metric, strip) : [];
  const shown = new Set(tiles.filter((tile) => !tile.smaller).map((tile) => tile.id));
  const rowId = (nodeId: string) => `${id}-row-${nodeId}`;
  const derived = useMemo(
    () =>
      tree
        ? storageConsumerRows(tree, view.metric, {
            inventory: snapshot,
            sort: { key: view.sort, direction: view.direction === "asc" ? "ascending" : "descending" },
          })
        : { rows: [], empty: [] },
    [tree, view.metric, view.sort, view.direction, snapshot]
  );
  const { listed, counted: rows } = storageListing(derived, { shown: view.smaller ? shown : null, showEmpty });
  // Focus after navigation lands once the requested page is the one shown.
  useEffect(() => {
    if (view.loading || !pendingFocus.current || view.tree?.parentId !== (view.parent ?? null)) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    const crumb = frame.current?.querySelector<HTMLElement>("[data-storage-crumb-current]");
    if (target === "breadcrumb") crumb?.focus();
    else (document.getElementById(rowId(target))?.querySelector<HTMLElement>("button") ?? crumb)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.loading, view.tree, view.parent]);
  function drill(nodeId: string) {
    pendingFocus.current = "breadcrumb";
    view.setParent(nodeId);
    view.setSearch("");
    view.setCursor(undefined);
  }
  function goUp(target: string | null) {
    const crumbs = view.tree?.breadcrumbs ?? [];
    const index = crumbs.findIndex((crumb) => crumb.id === target);
    pendingFocus.current = crumbs[index + 1]?.id ?? "breadcrumb";
    view.setParent(target ?? undefined);
    view.setSearch("");
    view.setCursor(undefined);
  }
  function activate(nodeId: string) {
    const node = tree?.nodes.find((value) => value.id === nodeId);
    if (node?.kind === "root" || node?.kind === "directory") drill(nodeId);
    else if (node?.entry) onInspect(node.entry);
  }
  const legend = useMemo(() => {
    const owners: StorageMapLegendOwner[] = (["brain", "app", "operator"] as const)
      .filter((owner) => rows.some((row) => row.owner === owner))
      .map((owner) => {
        const mine = rows.filter((row) => row.owner === owner);
        const sum = mine.reduce((total, row) => total + (row.bytes ?? 0), 0);
        const partial = mine.some((row) => row.bytes === null || row.atLeast);
        // A measured zero is "none"; an owner with unknown stores has only a lower bound, or none.
        const total = sum > 0 ? `${partial ? "≥ " : ""}${bytes(sum)}` : partial ? undefined : "none";
        return { owner, total };
      });
    return { owners, unknown: rows.filter((row) => row.bytes === null) };
  }, [rows]);
  const trail = (tree?.breadcrumbs ?? [{ id: null, name: "All stores" }]).map((crumb) => ({
    id: crumb.id ?? ROOT,
    label: crumb.name,
  }));
  const here = tree?.name ?? "All stores";
  const total = tree?.totals[view.metric] ?? null;
  const basis = view.metric === "allocated" ? "on disk" : "file size";
  const partial = tree?.totals.coverage !== "complete";
  const descriptionId = `${id}-map-description`;
  const map = (
    <div className="flex min-w-0 flex-col gap-1.5">
      {tiles.length ? (
        <StorageMap
          items={tiles}
          width={Math.max(1, mapWidth)}
          height={mapHeight}
          label={`Storage map, ${OWNERS.find((value) => value.value === view.owner)!.label}, ${here}`}
          descriptionId={descriptionId}
          highlightedId={highlight}
          onHighlight={setHighlight}
          muted={!!view.search && !view.loading && tree?.matched === 0}
          onOpen={(nodeId) => {
            if (nodeId === "smaller") {
              view.setSmaller(true);
              frame.current?.querySelector<HTMLElement>("[data-storage-list-heading]")?.focus();
              return;
            }
            const node = view.chart?.nodes.find((item) => item.id === nodeId);
            if (node?.kind === "root" || node?.kind === "directory") drill(nodeId);
            else if (node?.entry) onInspect(node.entry);
          }}
          onUp={() => goUp(tree?.breadcrumbs.at(-2)?.id ?? null)}
        />
      ) : (
        <p className="rounded border border-dashed border-border p-3 font-mono text-xs text-muted-foreground">
          ? Nothing measurable to draw · see the list
        </p>
      )}
      <p id={descriptionId} className="sr-only">
        Arrow keys move between tiles. Enter opens. Backspace goes up. The list has every entry.
      </p>
    </div>
  );
  const list = (
    <div className="flex min-w-0 flex-col gap-2">
      {summary}
      <h4 data-storage-list-heading="" tabIndex={-1} className="font-mono text-xs text-muted-foreground">
        {view.smaller ? "Smaller items · " : ""}
        {here} · {partial ? "≥ " : ""}
        {tree?.matched ?? "?"} items · {total === null ? "? size" : `${partial ? "≥ " : ""}${bytes(total)}`} {basis}
      </h4>
      {view.smaller && (
        <TextButton
          inline
          label="Show all children"
          onClick={() => {
            // The button leaves with the smaller items; the list heading keeps focus.
            view.setSmaller(false);
            frame.current?.querySelector<HTMLElement>("[data-storage-list-heading]")?.focus();
          }}
        />
      )}
      {view.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading observed entries…
        </p>
      )}
      <div aria-busy={view.loading}>
        <StorageConsumerList
          label={`Contents of ${here}`}
          sort={{ key: view.sort, direction: view.direction === "asc" ? "ascending" : "descending" }}
          onSort={(key) => {
            if (view.sort === key) view.setDirection(view.direction === "asc" ? "desc" : "asc");
            else {
              view.setSort(key);
              view.setDirection(key === "name" ? "asc" : "desc");
            }
          }}
          onUp={() => goUp(tree?.breadcrumbs.at(-2)?.id ?? null)}
          empty={
            <span className="text-xs">
              {view.search
                ? `No files or folders match “${view.search}” in ${trail.map((crumb) => crumb.label).join(" › ")}`
                : "No matching children"}
              {partial ? " found in what was measured" : ""}.
            </span>
          }
        >
          {listed.map(({ id: key, nodeId, members: _members, bytes: _bytes, shared: _shared, parts: _parts, ...row }) => (
            <StorageConsumerRow
              key={key}
              {...row}
              id={rowId(nodeId)}
              onActivate={() => activate(nodeId)}
              highlighted={highlight === nodeId}
              onHighlight={(active) => setHighlight(active ? nodeId : null)}
            />
          ))}
        </StorageConsumerList>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {derived.empty.length > 0 && (
          <TextButton
            inline
            label={showEmpty ? "Hide entries with no size" : `Show ${derived.empty.length} with no size`}
            onClick={() => setShowEmpty((value) => !value)}
          />
        )}
        <div ref={pager} className="contents">
          {view.cursor && (
            <Button
              label="First 200 items"
              tone="quiet"
              size="sm"
              reach
              block={false}
              disabled={view.loading}
              onClick={() => {
                paging();
                view.setCursor(undefined);
              }}
            />
          )}
          {tree?.nextCursor && (
            <Button
              label="Next 200 items"
              tone="quiet"
              size="sm"
              reach
              block={false}
              disabled={view.loading}
              onClick={() => {
                paging();
                view.setCursor(tree.nextCursor ?? undefined);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div ref={frame} className="grid min-w-0 gap-3" data-storage-breakdown="" data-layout={side ? "side" : strip ? "strip" : "stacked"}>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <StorageSegmented
          label="Ownership view"
          options={OWNERS}
          value={view.owner}
          onChange={(owner) => {
            view.setOwner(owner);
            view.setParent(undefined);
            view.setSearch("");
          }}
        />
        <SizeBasis view={view} />
        <label className="grid min-w-0 flex-1 basis-48 gap-1 text-xs text-muted-foreground">
          Search this folder
          <input
            aria-label="Search this folder"
            value={view.search}
            maxLength={128}
            onChange={(event) => view.setSearch(event.target.value)}
            className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground"
          />
        </label>
      </div>
      <StorageBreadcrumb trail={trail} onNavigate={(crumb) => goUp(crumb === ROOT ? null : crumb)} />
      <StorageMapLegend
        owners={legend.owners}
        unknownCount={legend.unknown.length}
        onShowUnknown={
          legend.unknown[0]
            ? () => document.getElementById(rowId(legend.unknown[0]!.nodeId))?.querySelector<HTMLElement>("button")?.focus()
            : undefined
        }
      />
      {width > 0 ? (
        <div className={side ? "grid grid-cols-2 items-start gap-6" : "grid grid-cols-1 gap-3"}>
          {map}
          {list}
        </div>
      ) : null}
    </div>
  );
}
