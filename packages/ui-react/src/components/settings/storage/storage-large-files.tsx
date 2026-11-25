import { useId, useState } from "react";
import {
  Button,
  StorageConsumerList,
  StorageConsumerRow,
  StorageFilterRow,
  StorageSelectionBar,
  type StorageEligibility,
  type StorageGitFacet,
} from "@schlessera/brain-ui-kit";
import type { StorageFileEntry } from "@schlessera/brain-ui-sdk/protocol";
import { bytes, humanReason } from "./storage-model.js";
import { LARGER_PRESETS } from "./storage-pane-model.js";
import { running, type useStorage } from "./use-storage.js";

type StorageView = ReturnType<typeof useStorage>;
type Facts = NonNullable<StorageView["evidence"][string]["facts"]>;

const GIT: Record<Facts["git"], StorageGitFacet> = {
  tracked: "tracked",
  untracked: "untracked",
  ignored: "untracked",
  "no-repository": "untracked",
  unknown: "unknown",
};

const folderOf = (path: string) => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "./" : `${path.slice(0, index)}/`;
};

const CUSTOM = "custom";

/**
 * "What's using space" in Find large files mode (#4537 D11): Type, Larger
 * than, Where and search replace the owner switch, basis, legend, map and
 * list. The basis is file size, because removal is per file. The rows, the
 * selection bar, review, removal, receipt and Undo are the existing journey,
 * unchanged; every step is reachable from a row and from a button.
 */
export function StorageLargeFiles({
  view,
  onInspect,
  onReview,
  onReceipt,
}: {
  view: StorageView;
  onInspect: (entry: StorageFileEntry) => void;
  onReview: () => void;
  onReceipt: () => void;
}) {
  const id = useId();
  const [custom, setCustom] = useState(() => !LARGER_PRESETS.some((preset) => preset.value === view.larger));
  const unavailable = !view.capability?.available;
  const operationPending = running(view.receipt?.state) || view.receipt?.state === "unknown";
  const entries = view.files?.entries ?? [];
  const matched = view.files?.matched ?? "?";
  const partial = view.files?.totals.coverage !== "complete";
  const total = view.files?.fileLogicalTotal ?? null;
  function eligibility(entry: StorageFileEntry): { value: StorageEligibility; why?: string } {
    const facts = view.evidence[entry.id]?.facts;
    if (!facts) return { value: "cant-tell", why: "inspect to check" };
    if (facts.eligible) return { value: "can-remove" };
    return { value: "kept", why: humanReason(facts.reason) };
  }
  function select(entry: StorageFileEntry, next: boolean) {
    const known = view.evidence[entry.id];
    // An unverified file is inspected first; its sheet carries Select file.
    if (!known?.facts) return onInspect(entry);
    if (view.loading || view.busy || operationPending) return;
    if (next && !view.selected[entry.id] && view.selection.length >= (view.capability?.limits.items ?? 0)) return;
    view.toggle(known);
  }
  const rows = entries.map((entry) => {
    const facts = view.evidence[entry.id]?.facts ?? null;
    const size = entry.logical === null ? null : bytes(entry.logical);
    if (unavailable)
      return (
        <StorageConsumerRow
          key={entry.id}
          name={entry.name}
          owner="brain"
          action="inspect"
          kind="file"
          meta={folderOf(entry.path)}
          size={size}
          onActivate={() => onInspect(entry)}
        />
      );
    const mark = eligibility(entry);
    return (
      <StorageFilterRow
        key={entry.id}
        name={entry.name}
        folder={folderOf(entry.path)}
        size={size}
        git={facts ? GIT[facts.git] : "unknown"}
        links={facts ? facts.references.length : null}
        eligibility={mark.value}
        why={mark.why}
        selected={!!view.selected[entry.id]}
        onSelectedChange={(next) => select(entry, next)}
        onInspect={() => onInspect(entry)}
      />
    );
  });
  const blocked = view.busy || operationPending || view.overSelectionLimit;
  const footer = unavailable ? null : view.selection.length > 0 ? (
    <StorageSelectionBar
      count={view.selection.length}
      size={bytes(view.selectedBytes)}
      basis="file size · not space freed"
      onClear={view.clearSelection}
      onReview={() => {
        if (!blocked) onReview();
      }}
    />
  ) : view.receipt ? (
    <p className="flex flex-wrap items-center gap-x-3 text-xs" data-storage-last-removal="">
      <span>Last removal: {humanReason(view.receipt.state)}</span>
      <Button
        label={view.receipt.state === "review" ? "Resume recorded review" : "View receipt"}
        ariaLabel={view.receipt.state === "review" ? "Resume recorded review" : "View removal receipt"}
        tone="quiet"
        size="sm"
        reach
        block={false}
        onClick={onReceipt}
      />
    </p>
  ) : (
    <StorageSelectionBar count={0} size="" basis="" onClear={view.clearSelection} onReview={onReview} />
  );
  return (
    <div className="grid min-w-0 gap-3" data-storage-large-files="">
      <div className="grid min-w-0 grid-cols-2 gap-3 @[560px]/storage:grid-cols-[repeat(3,minmax(0,10rem))_minmax(0,1fr)]">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          Type
          <select aria-label="File type" className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground" value="pdf" onChange={() => {}}>
            <option value="pdf">PDF</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          Larger than
          <select
            aria-label="Larger than"
            className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground"
            value={custom ? CUSTOM : view.larger}
            onChange={(event) => {
              if (event.target.value === CUSTOM) setCustom(true);
              else {
                setCustom(false);
                view.setLarger(event.target.value);
              }
            }}
          >
            {LARGER_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        </label>
        <label className="col-span-2 grid min-w-0 gap-1 text-xs text-muted-foreground @[560px]/storage:col-span-1">
          Where
          <select
            aria-label="Where"
            className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground"
            value={view.where}
            onChange={(event) => view.setWhere(event.target.value)}
          >
            <option value="content">Brain files</option>
            <option value="all">All Brain stores</option>
          </select>
        </label>
        <label className="col-span-2 grid min-w-0 gap-1 text-xs text-muted-foreground @[560px]/storage:col-span-1">
          Search matching filenames
          <input
            aria-label="Search matching filenames"
            value={view.search}
            maxLength={128}
            onChange={(event) => view.setSearch(event.target.value)}
            className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground"
          />
        </label>
      </div>
      {custom && (
        <label className="grid min-w-0 max-w-xs gap-1 text-xs text-muted-foreground">
          Larger than (MB)
          <input
            aria-label="Larger than (MB)"
            inputMode="decimal"
            value={view.larger}
            onChange={(event) => view.setLarger(event.target.value)}
            className="min-h-11 min-w-0 rounded border border-border bg-surface px-2 text-sm text-foreground"
          />
        </label>
      )}
      {!view.validThreshold && (
        <p role="alert" className="text-xs">
          Enter a nonnegative MB value that resolves to a whole, safe byte count.
        </p>
      )}
      <p id={`${id}-count`} className="font-mono text-xs text-muted-foreground" data-storage-match-count="">
        {partial ? "≥ " : ""}
        {matched} matching PDFs · {total === null ? "? size" : `${partial ? "at least " : ""}${bytes(total)}`} file size
      </p>
      {unavailable && view.status && (
        <p className="text-xs" data-storage-removal-unavailable="">
          <span aria-hidden="true">⊘ </span>
          Removal isn't available on this host · {humanReason(view.capability?.reason ?? null)}
        </p>
      )}
      {view.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading observed entries…
        </p>
      )}
      <div aria-busy={view.loading}>
        <StorageConsumerList
          label={`Matching PDFs larger than ${view.larger} MB`}
          mode={unavailable ? "browse" : "filter"}
          sort={{ key: view.fileSort, direction: view.fileDirection === "asc" ? "ascending" : "descending" }}
          onSort={(key) => {
            if (view.fileSort === key) view.setFileDirection(view.fileDirection === "asc" ? "desc" : "asc");
            else {
              view.setFileSort(key);
              view.setFileDirection(key === "name" ? "asc" : "desc");
            }
          }}
          footer={footer}
          empty={
            <span className="text-xs">
              No PDFs larger than {view.larger} MB{partial ? " found in what was measured" : ""}.
            </span>
          }
        >
          {rows}
        </StorageConsumerList>
      </div>
      {view.overSelectionLimit && (
        <p role="alert" className="text-xs">
          Selection exceeds the {bytes(view.capability?.limits.totalBytes ?? null)} operation limit. Deselect files before reviewing.
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Button
          label="Copy visible file list"
          tone="quiet"
          size="sm"
          reach
          block={false}
          disabled={view.loading || !entries.length}
          onClick={() => void view.copyList()}
        />
        {view.cursor && (
          <Button label="First 200 items" tone="quiet" size="sm" reach block={false} disabled={view.loading} onClick={() => view.setCursor(undefined)} />
        )}
        {view.files?.nextCursor && (
          <Button
            label="Next 200 items"
            tone="quiet"
            size="sm"
            reach
            block={false}
            disabled={view.loading}
            onClick={() => view.setCursor(view.files?.nextCursor ?? undefined)}
          />
        )}
      </div>
    </div>
  );
}
