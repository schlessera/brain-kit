import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button, StorageMap } from "@schlessera/brain-ui-kit";
import type { StorageFileEntry } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import {
  bytes,
  exactBytes,
  humanReason,
  mapItems,
  ownerName,
  percent,
  time,
} from "./storage/storage-model.js";
import {
  StorageCapacities,
  StorageDelta,
} from "./storage/storage-observations.js";
import { StorageDialogs } from "./storage/storage-dialogs.js";
import { running, useStorage } from "./storage/use-storage.js";
const touch = { minHeight: 44 };
/** Account and root changes discard pending selections and local response ownership synchronously. */
export function StorageTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot(),
    rootKey = useMemo(() => crypto.randomUUID(), [root]);
  const epoch = useSyncExternalStore(
    root.authLock.state.subscribe,
    () => `${root.authLock.epoch()}:${root.authLock.state.getState().phase}`,
    () => `${root.authLock.epoch()}:${root.authLock.state.getState().phase}`
  );
  return active && root.authLock.state.getState().phase === "active" ? (
    <StorageSession key={`${rootKey}:${epoch}`} root={root} />
  ) : null;
}
function StorageSession({ root }: { root: BrainUiRoot }) {
  const view = useStorage(root),
    phone = useMediaQuery("(max-width: 599px)"),
    id = useId();
  const heading = useRef<HTMLHeadingElement>(null),
    breadcrumb = useRef<HTMLHeadingElement>(null),
    listHeading = useRef<HTMLHeadingElement>(null),
    container = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLElement | null>(null),
    pendingFocus = useRef<string | null>(null);
  const [width, setWidth] = useState(296),
    [now, setNow] = useState(Date.now()),
    [listOnly, setListOnly] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(1, element.clientWidth))
    );
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!view.snapshot) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, view.snapshot.staleAfter - Date.now())
    );
    return () => clearTimeout(timer);
  }, [view.snapshot]);
  useEffect(() => {
    if (
      view.loading ||
      !pendingFocus.current ||
      view.tree?.parentId !== (view.parent ?? null)
    )
      return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "breadcrumb") breadcrumb.current?.focus();
    else
      (
        container.current?.querySelector<HTMLElement>(
          `[data-storage-open="${target}"] [role="button"]`
        ) ?? breadcrumb.current
      )?.focus();
  }, [view.loading, view.tree, view.parent]);
  const snapshot = view.snapshot,
    tree = view.tree,
    page = view.filtering ? view.files : tree,
    total = page?.totals[view.metric] ?? null;
  const tiles = view.chart
      ? mapItems(view.chart, view.metric, width < 600)
      : [],
    shown = new Set(
      tiles.filter((tile) => !tile.smaller).map((tile) => tile.id)
    );
  const nodes = (tree?.nodes ?? []).filter(
    (node) => !view.smaller || !shown.has(node.id)
  );
  function open(entry: StorageFileEntry) {
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void view.inspect(entry);
  }
  function drill(nodeId: string) {
    pendingFocus.current = "breadcrumb";
    view.setParent(nodeId);
    view.setSearch("");
    view.setCursor(undefined);
  }
  function goUp(target: string | null) {
    const index =
      view.tree?.breadcrumbs.findIndex((crumb) => crumb.id === target) ?? -1;
    pendingFocus.current =
      view.tree?.breadcrumbs[index + 1]?.id ?? "breadcrumb";
    view.setParent(target ?? undefined);
    view.setSearch("");
    view.setCursor(undefined);
  }
  const returning = () =>
    trigger.current?.isConnected ? trigger.current : heading.current;
  const unavailable = !view.capability?.available,
    operationPending =
      running(view.receipt?.state) || view.receipt?.state === "unknown";
  const selectReason = (entry: StorageFileEntry) => {
    const file = view.evidence[entry.id];
    return unavailable
      ? "This host can't remove attachments yet"
      : file?.facts?.eligible
      ? "Eligible after fresh review"
      : file?.facts
      ? humanReason(file.facts.reason)
      : "Inspect to verify eligibility and Undo";
  };
  function inspectControl(entry: StorageFileEntry) {
    return (
      <Button
        label="Inspect"
        ariaLabel={`Inspect ${entry.name}`}
        block={false}
        style={touch}
        disabled={view.busy || view.loading}
        onClick={() => open(entry)}
      />
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-storage-pane="">
      <div
        ref={container}
        className="grid w-full max-w-[720px] min-w-0 gap-5 p-3 text-sm"
        style={{ overflowWrap: "anywhere" }}
      >
        <header className="grid gap-2">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            Storage
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              label={view.filtering ? "Back to overview" : "Find large files"}
              block={false}
              style={touch}
              onClick={() => {
                view.setFiltering(!view.filtering);
                view.setSearch("");
                view.setCursor(undefined);
              }}
            />
            <Button
              label={snapshot ? "Refresh" : "Measure"}
              block={false}
              style={touch}
              disabled={view.busy || view.status?.state === "scanning"}
              onClick={() => void view.refresh()}
            />
          </div>
          {!snapshot && (
            <p>{view.status ? "Not measured yet" : "Loading Storage…"}</p>
          )}
          {snapshot && (
            <p>
              {now >= snapshot.staleAfter ? "Out of date · " : ""}
              {view.status?.state === "scanning" ? "Previous result · " : ""}
              Measured {time(snapshot.observedAt)} · {snapshot.coverage} ·{" "}
              {snapshot.coverage !== "complete" ? "at least " : ""}
              {snapshot.entries} entries · live observation
            </p>
          )}
          {view.status?.state === "scanning" && (
            <div role="status" className="grid gap-2">
              <p>Measuring… Previous observations remain available.</p>
              <Button
                label="Cancel measurement"
                tone="quiet"
                style={touch}
                disabled={view.busy}
                onClick={() => void view.cancelScan()}
              />
            </div>
          )}
          {view.status?.lastFailure && (
            <p>
              Last measurement: {humanReason(view.status.lastFailure.reason)}.
              Known previous results remain unchanged.
            </p>
          )}
          {snapshot && view.newest && view.newest.id !== snapshot.id && (
            <Button
              label="Show new measurement"
              ariaLabel="Show new measurement"
              subtitle="Clears selections from the previous observation"
              style={touch}
              onClick={view.adopt}
            />
          )}
          {snapshot?.coverage !== "complete" && snapshot && (
            <div>
              <p>
                Partial evidence. Known subtotals are at least what was
                measured; unknown stores are excluded from map area.
              </p>
              <ul>
                {snapshot.errors.map((error, index) => (
                  <li key={index}>
                    {snapshot.roots.find((row) => row.id === error.rootId)
                      ?.label ?? "Observation"}
                    : {humanReason(error.reason)}
                  </li>
                ))}
              </ul>
              {snapshot.omittedErrors > 0 && (
                <p>{snapshot.omittedErrors} additional errors omitted.</p>
              )}
            </div>
          )}
          {view.error && (
            <div role="alert" className="grid gap-2">
              <p>{view.error}</p>
              <Button
                label="Check measurement status"
                tone="quiet"
                style={touch}
                disabled={view.busy}
                onClick={() => void view.checkStatus()}
              />
            </div>
          )}
        </header>
        {snapshot && (
          <>
            <StorageCapacities
              capacities={snapshot.capacities}
              roots={snapshot.roots}
            />
            {!view.filtering && (
              <fieldset className="flex flex-wrap gap-2">
                <legend className="mb-2 font-semibold">Ownership view</legend>
                {(["all", "brain", "app"] as const).map((owner) => (
                  <label
                    key={owner}
                    className="flex min-h-11 min-w-11 items-center gap-2 rounded border border-border px-3"
                  >
                    <input
                      type="radio"
                      name={`${id}-owner`}
                      checked={view.owner === owner}
                      onChange={() => {
                        view.setOwner(owner);
                        view.setParent(undefined);
                        view.setSearch("");
                      }}
                    />
                    {owner === "all" ? "All" : ownerName(owner)}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                Size basis
                <select
                  aria-label="Size basis"
                  className="min-h-11 min-w-0 rounded border border-border bg-surface px-2"
                  value={view.metric}
                  onChange={(event) =>
                    view.setMetric(
                      event.target.value as "allocated" | "logical"
                    )
                  }
                >
                  <option value="allocated">On disk (estimate)</option>
                  <option value="logical">File size</option>
                </select>
              </label>
              <p className="self-end text-xs text-muted-foreground">
                Decimal kB / MB / GB. On disk uses filesystem allocation, not
                exclusive or reclaimable bytes. Unknown allocation never falls
                back to file size.
              </p>
            </div>
            {view.filtering ? (
              <section
                className="grid gap-3"
                aria-label="Find large files filters"
              >
                <h3 className="font-semibold">Find large files</h3>
                <label className="grid gap-1">
                  Type
                  <select
                    aria-label="File type"
                    className="min-h-11 rounded border border-border bg-surface px-2"
                    value="pdf"
                    onChange={() => {}}
                  >
                    <option value="pdf">PDF (filename extension)</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  Larger than (MB)
                  <input
                    aria-label="Larger than (MB)"
                    inputMode="decimal"
                    value={view.larger}
                    onChange={(event) => view.setLarger(event.target.value)}
                    className="min-h-11 min-w-0 rounded border border-border bg-surface px-2"
                  />
                </label>
                <label className="grid gap-1">
                  Where
                  <select
                    aria-label="Where"
                    className="min-h-11 rounded border border-border bg-surface px-2"
                    value={view.where}
                    onChange={(event) => view.setWhere(event.target.value)}
                  >
                    <option value="content">Brain files</option>
                    <option value="all">All Brain stores</option>
                  </select>
                </label>
                {!view.validThreshold && (
                  <p role="alert">
                    Enter a nonnegative MB value that resolves to a whole, safe
                    byte count.
                  </p>
                )}
                <p>
                  Case-insensitive filename matching. Strictly more than{" "}
                  {view.validThreshold
                    ? exactBytes(Number(view.larger) * 1_000_000)
                    : "the entered limit"}
                  ; file contents are not used to identify PDFs.
                </p>
              </section>
            ) : (
              <nav
                aria-label="Storage breadcrumbs"
                className="flex flex-wrap items-center gap-1"
              >
                {(tree?.breadcrumbs ?? [{ id: null, name: "All stores" }]).map(
                  (crumb, index, array) => (
                    <span
                      className="flex min-w-0 items-center gap-1"
                      key={crumb.id ?? "all"}
                    >
                      <Button
                        label={crumb.name}
                        block={false}
                        tone="quiet"
                        style={touch}
                        disabled={index === array.length - 1}
                        onClick={() => goUp(crumb.id)}
                      />
                      {index < array.length - 1 && (
                        <span aria-hidden="true">›</span>
                      )}
                    </span>
                  )
                )}
              </nav>
            )}
            <section className="grid gap-3" aria-busy={view.loading}>
              <h3 ref={breadcrumb} tabIndex={-1} className="font-semibold">
                {view.filtering ? "Matching PDFs" : tree?.name ?? "All stores"}
              </h3>
              <p>
                {page?.totals.coverage !== "complete" ? "At least " : ""}
                {page?.matched ?? "Unknown"}{" "}
                {view.filtering ? "matching entries" : "children"} ·{" "}
                {view.filtering
                  ? bytes(view.files?.fileLogicalTotal ?? null)
                  : bytes(total)}{" "}
                {view.filtering
                  ? "file size (entry sum)"
                  : view.metric === "allocated"
                  ? "measured on disk estimate"
                  : "measured file size"}
              </p>
              {view.filtering && (
                <p className="text-xs">
                  Exact entry sum:{" "}
                  {exactBytes(view.files?.fileLogicalTotal ?? null)}. Matching
                  object union: {bytes(view.files?.totals.logical ?? null)} file
                  size. Shared names may count separately in the entry sum.
                </p>
              )}
              {!view.filtering && (
                <>
                  <label className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={listOnly}
                      onChange={(event) => setListOnly(event.target.checked)}
                    />
                    Use list only
                  </label>
                  {!listOnly && tiles.length > 0 && (
                    <StorageMap
                      items={tiles}
                      width={Math.max(1, width - 24)}
                      height={phone ? 240 : 260}
                      label={`Storage map, ${view.owner}, ${
                        tree?.name ?? "All stores"
                      }`}
                      descriptionId={`${id}-map-description`}
                      onOpen={(nodeId) => {
                        if (nodeId === "smaller") {
                          view.setSmaller(true);
                          listHeading.current?.focus();
                          return;
                        }
                        const node = view.chart?.nodes.find(
                          (item) => item.id === nodeId
                        );
                        if (node?.kind === "root" || node?.kind === "directory")
                          drill(nodeId);
                        else if (node?.entry) open(node.entry);
                      }}
                      onUp={() => goUp(tree?.breadcrumbs.at(-2)?.id ?? null)}
                    />
                  )}
                  {!listOnly && !tiles.length && (
                    <p>
                      No known nonzero area to draw. Use the list for zero or
                      unknown entries.
                    </p>
                  )}
                  <p id={`${id}-map-description`} className="text-xs">
                    Equivalent contents list below. Brain: solid outline. App:
                    hatching. Operator backups and smaller items: dashed
                    outline. Unknown subtrees have no proportional area. Arrow
                    keys move between map tiles; Enter opens; Backspace goes up.
                  </p>
                  {view.chart?.nodes
                    .filter((node) => node.area[view.metric] === null)
                    .map((node) => (
                      <p key={node.id}>
                        {node.name}: Unknown · {humanReason(node.reason)}
                      </p>
                    ))}
                </>
              )}
            </section>
            <section className="grid gap-3" aria-label="Storage contents">
              <h3 ref={listHeading} tabIndex={-1} className="font-semibold">
                {view.smaller ? "Smaller items" : "Contents"}
              </h3>
              {view.smaller && (
                <Button
                  label="Show all children"
                  tone="quiet"
                  style={touch}
                  onClick={() => view.setSmaller(false)}
                />
              )}
              <label className="grid gap-1">
                {view.filtering
                  ? "Search matching filenames"
                  : "Search this folder"}
                <input
                  aria-label={
                    view.filtering
                      ? "Search matching filenames"
                      : "Search this folder"
                  }
                  value={view.search}
                  maxLength={128}
                  onChange={(event) => view.setSearch(event.target.value)}
                  className="min-h-11 min-w-0 rounded border border-border bg-surface px-2"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  label={
                    view.sort === "name"
                      ? "Name order selected"
                      : "Sort by name"
                  }
                  tone="quiet"
                  block={false}
                  style={touch}
                  onClick={() => {
                    view.setSort("name");
                    view.setDirection("asc");
                  }}
                />
                <Button
                  label={
                    view.sort === "size"
                      ? "Size order selected"
                      : "Sort by size"
                  }
                  tone="quiet"
                  block={false}
                  style={touch}
                  onClick={() => {
                    view.setSort("size");
                    view.setDirection("desc");
                  }}
                />
                <Button
                  label={view.direction === "asc" ? "Ascending" : "Descending"}
                  tone="quiet"
                  block={false}
                  style={touch}
                  onClick={() =>
                    view.setDirection(view.direction === "asc" ? "desc" : "asc")
                  }
                />
              </div>
              {view.loading && <p role="status">Loading observed entries…</p>}
              <table
                className="block w-full table-fixed sm:table"
                aria-label="Storage contents table"
              >
                <thead className="sr-only sm:not-sr-only sm:table-header-group">
                  <tr>
                    <th
                      className="text-left"
                      aria-sort={
                        view.sort === "name"
                          ? view.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      Name and owner
                    </th>
                    <th
                      className="text-left"
                      aria-sort={
                        view.sort === "size"
                          ? view.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      {view.metric === "allocated" ? "On disk" : "File size"}
                    </th>
                    <th className="text-left">Action</th>
                  </tr>
                </thead>
                <tbody className="block sm:table-row-group">
                  {view.filtering
                    ? (view.files?.entries ?? []).map((entry) => {
                        const known = view.evidence[entry.id],
                          reason = selectReason(entry),
                          checked = !!view.selected[entry.id],
                          disabled =
                            view.loading ||
                            view.busy ||
                            unavailable ||
                            !known?.facts?.eligible ||
                            operationPending ||
                            (!checked &&
                              view.selection.length >=
                                (view.capability?.limits.items ?? 0));
                        return (
                          <tr
                            key={entry.id}
                            className="mb-3 block rounded border border-border p-3 sm:table-row"
                          >
                            <td className="block min-w-0 p-1 align-top sm:table-cell">
                              <label className="flex min-h-11 items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  aria-label={`Select ${entry.name}, ${bytes(
                                    entry.logical
                                  )} file size, ${reason}`}
                                  onChange={() => known && view.toggle(known)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      open(entry);
                                    }
                                  }}
                                />
                                <span className="font-semibold">
                                  {entry.name}
                                </span>
                              </label>
                              <p>{entry.path} · Brain</p>
                              <p className="text-xs">
                                {known?.facts?.git ?? "Git unknown"} ·{" "}
                                {known?.facts
                                  ? `${known.facts.references.length} checked links; other references unknown`
                                  : "Links unknown"}{" "}
                                · {reason}
                              </p>
                            </td>
                            <td className="block p-1 align-top sm:table-cell">
                              <p>
                                {bytes(entry[view.metric])}
                                {view.metric === "allocated" ? " estimate" : ""}
                              </p>
                              <p className="text-xs">
                                File size {exactBytes(entry.logical)}
                                {entry.aliasOf || entry.links > 1
                                  ? " · Shared object"
                                  : ""}
                              </p>
                            </td>
                            <td className="block p-1 align-top sm:table-cell">
                              {inspectControl(entry)}
                            </td>
                          </tr>
                        );
                      })
                    : nodes.map((node) => (
                        <tr
                          key={node.id}
                          className="mb-3 block rounded border border-border p-3 sm:table-row"
                        >
                          <td className="block min-w-0 p-1 align-top sm:table-cell">
                            <p className="font-semibold">{node.name}</p>
                            <p>
                              {ownerName(node.owner)} · {node.totals.coverage}
                            </p>
                            {node.reason && (
                              <p className="text-xs">
                                {humanReason(node.reason)}
                              </p>
                            )}
                          </td>
                          <td className="block p-1 align-top sm:table-cell">
                            <p>
                              {node.totals.coverage !== "complete" &&
                              node.totals[view.metric] !== null
                                ? "At least "
                                : ""}
                              {bytes(node.totals[view.metric])}
                              {view.metric === "allocated" ? " estimate" : ""}
                            </p>
                            <p className="text-xs">
                              {percent(node.area[view.metric], total)}
                              {node.area[view.metric] === 0 &&
                              node.totals[view.metric] !== 0
                                ? " · Shared object already counted"
                                : ""}
                            </p>
                            {total !== null &&
                              total > 0 &&
                              node.area[view.metric] !== null && (
                                <div
                                  aria-hidden="true"
                                  className="h-1 bg-surface-raised"
                                >
                                  <div
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        (node.area[view.metric]! / total) * 100
                                      )}%`,
                                      height: "100%",
                                      background: "var(--bk-color-ink-mute)",
                                    }}
                                  />
                                </div>
                              )}
                          </td>
                          <td className="block p-1 align-top sm:table-cell">
                            {node.kind === "root" ||
                            node.kind === "directory" ? (
                              <span data-storage-open={node.id} tabIndex={-1}>
                                <Button
                                  label="Open"
                                  ariaLabel={`Open ${node.name}`}
                                  block={false}
                                  style={touch}
                                  disabled={view.loading}
                                  onClick={() => drill(node.id)}
                                />
                              </span>
                            ) : node.entry ? (
                              inspectControl(node.entry)
                            ) : (
                              <span>Directory metadata</span>
                            )}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
              {!view.loading && page?.matched === 0 && (
                <p>
                  {view.filtering
                    ? `No PDFs larger than ${view.larger} MB`
                    : "No matching children"}
                  {page.totals.coverage !== "complete"
                    ? " found in what was measured"
                    : ""}
                  .
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {view.filtering && (
                  <Button
                    label="Copy visible file list"
                    block={false}
                    tone="quiet"
                    style={touch}
                    disabled={view.loading || !view.files?.entries.length}
                    onClick={() => void view.copyList()}
                  />
                )}{" "}
                {view.cursor && (
                  <Button
                    label="First 200 items"
                    tone="quiet"
                    style={touch}
                    block={false}
                    disabled={view.loading}
                    onClick={() => view.setCursor(undefined)}
                  />
                )}
                <Button
                  label="Next 200 items"
                  tone="quiet"
                  block={false}
                  style={touch}
                  disabled={view.loading || !page?.nextCursor}
                  onClick={() => view.setCursor(page?.nextCursor ?? undefined)}
                />
              </div>
            </section>
            {view.selection.length > 0 && (
              <section
                aria-label="Selected files"
                className="grid gap-2 rounded-lg border border-border bg-surface p-3"
              >
                <p>
                  {view.selection.length} selected · {bytes(view.selectedBytes)}{" "}
                  · file size, not space freed
                </p>
                {view.overSelectionLimit && (
                  <p role="alert">
                    Selection exceeds the{" "}
                    {bytes(view.capability?.limits.totalBytes ?? null)}{" "}
                    operation limit. Deselect files before reviewing.
                  </p>
                )}
                <Button
                  label="Review selected files"
                  style={touch}
                  disabled={
                    view.busy || operationPending || view.overSelectionLimit
                  }
                  onClick={() => {
                    trigger.current = document.activeElement as HTMLElement;
                    void view.reviewSelection();
                  }}
                />
              </section>
            )}
          </>
        )}
        {unavailable && view.status && (
          <p>
            This host can't remove attachments yet.{" "}
            {humanReason(view.capability?.reason ?? null)}. Preview, Open in
            Files and inspection remain available.
          </p>
        )}
        {view.receipt && (
          <div className="grid gap-2">
            <p>Last attachment operation: {humanReason(view.receipt.state)}.</p>
            <Button
              label={
                view.receipt.state === "review"
                  ? "Resume recorded review"
                  : "View removal receipt"
              }
              style={touch}
              onClick={() => {
                trigger.current = document.activeElement as HTMLElement;
                view.setReviewOpen(true);
              }}
            />
          </div>
        )}
        <section className="grid gap-3" aria-label="Storage maintenance">
          <h3 className="font-semibold">Maintenance</h3>
          <p>
            Owner-supported actions only. Capacity provisioning may be needed
            when protected stores consume space.
          </p>
          {view.maintenance.map((row) => (
            <div
              key={row.id}
              className="grid gap-2 rounded border border-border p-3"
            >
              <h4 className="font-semibold">{row.label}</h4>
              <p>
                Owner: {row.owner}. {row.effect}
              </p>
              <p>{row.headroom.note}</p>
              {row.id === "prune-scratch" && (
                <p>
                  Existing seven-day / 1.07 GB policy (1,073,741,824 bytes);
                  pinned answers kept.
                </p>
              )}
              {row.latest && (
                <p>
                  Last run: {humanReason(row.latest.state)} ·{" "}
                  {time(row.latest.requestedAt)}
                </p>
              )}
              {!row.available && <p>{humanReason(row.reason)}</p>}
              <Button
                label={row.label}
                effect="maintain"
                style={touch}
                disabled={
                  !row.available ||
                  view.busy ||
                  (!!view.maintenanceId &&
                    (!view.maintenanceReceipt ||
                      running(view.maintenanceReceipt.state) ||
                      view.maintenanceReceipt.state === "unknown"))
                }
                onClick={() => void view.maintain(row.id)}
              />
            </div>
          ))}
          {view.maintenanceId && (
            <div className="grid gap-2">
              <p>
                Maintenance:{" "}
                {view.maintenanceReceipt
                  ? humanReason(view.maintenanceReceipt.state)
                  : "response unconfirmed"}
                .{" "}
                {view.maintenanceReceipt?.reason
                  ? humanReason(view.maintenanceReceipt.reason)
                  : ""}
              </p>
              <Button
                label="Check maintenance receipt"
                tone="quiet"
                style={touch}
                disabled={view.busy}
                onClick={() => void view.checkMaintenance()}
              />
              {running(view.maintenanceReceipt?.state) && (
                <Button
                  label="Cancel maintenance"
                  tone="quiet"
                  style={touch}
                  disabled={view.busy}
                  onClick={() => void view.cancelMaintenance()}
                />
              )}
              <StorageDelta
                before={view.maintenanceReceipt?.before ?? null}
                after={view.maintenanceReceipt?.after ?? null}
              />
              {view.maintenanceReceipt?.outcome && (
                <p>
                  Owner result:{" "}
                  {view.maintenanceReceipt.outcome.removed ?? "unknown"}{" "}
                  removed, {view.maintenanceReceipt.outcome.failed ?? "unknown"}{" "}
                  failed,{" "}
                  {view.maintenanceReceipt.outcome.deferred ?? "unknown"}{" "}
                  deferred. Pinned files:{" "}
                  {view.maintenanceReceipt.outcome.pinnedFiles ?? "unknown"}.
                </p>
              )}
            </div>
          )}
        </section>
        <span role="status" aria-live="polite" className="sr-only">
          {view.announcement}
        </span>
      </div>
      <StorageDialogs
        view={view}
        root={root}
        phone={phone}
        returnFocus={returning}
      />
    </div>
  );
}
