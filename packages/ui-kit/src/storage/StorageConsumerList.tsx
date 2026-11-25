import { Children, type KeyboardEvent, type ReactNode } from "react";
import { color, font } from "../tokens.js";

export type StorageSortKey = "name" | "size";
export type StorageSortDirection = "ascending" | "descending";

export interface StorageConsumerListProps {
  /** The table's accessible name, e.g. "Contents of Packs". */
  label: string;
  /** `filter` adds the selection column for Find large files (#4537 D11). */
  mode?: "browse" | "filter";
  /** The column the rows are sorted by; its header carries `aria-sort`. */
  sort: { key: StorageSortKey; direction: StorageSortDirection };
  /** Makes the Name and Size headers buttons. The caller sorts; an unknown size stays last either way. */
  onSort?: (key: StorageSortKey) => void;
  /** Backspace or Alt+↑ while a row has focus, the list's half of the map's "go up". */
  onUp?: () => void;
  /** `StorageConsumerRow`s or `StorageFilterRow`s. */
  children?: ReactNode;
  /** What prints in place of rows when there are none, e.g. a search that matched nothing. */
  empty?: ReactNode;
  /** After the rows, inside the list region: `StorageSelectionBar`, which sticks to the list's bottom. */
  footer?: ReactNode;
}

const ARROW: Record<StorageSortDirection, string> = { ascending: "▴", descending: "▾" };

function editing(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type);
}

/**
 * The ranked list beside the map, with the same hierarchy and denominator
 * (storage.md "the list alone supports every navigation, inspection and
 * action"). A `role="table"` so `aria-sort` and the row/column relationships
 * reach a screen reader; each row is one button (`›` drills, `⋯` inspects),
 * so there is no per-row Open (#4544 ruling 1).
 *
 * Laid out as a container: the rows reflow at the list's own width, not the
 * viewport's, so the same list works beside the map and stacked under it.
 */
export function StorageConsumerList({ label, mode = "browse", sort, onSort, onUp, children, empty, footer }: StorageConsumerListProps) {
  const columns = mode === "filter" ? 3 : 2;
  const rows = Children.toArray(children).length > 0;
  function key(event: KeyboardEvent) {
    if (!onUp || editing(event.target)) return;
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
      event.preventDefault();
      onUp();
    }
  }
  const header = (key: StorageSortKey, text: string, align: "left" | "right") => {
    const sorted = sort.key === key;
    return (
      <div
        role="columnheader"
        aria-sort={sorted ? sort.direction : undefined}
        className={`bk-storage-head-cell bk-storage-head-${key}`}
        style={{ textAlign: align }}
      >
        {onSort ? (
          <button
            /* raw-button: kit — a sortable column header, 44px tall */
            type="button"
            className="bk-storage-sort"
            onClick={() => onSort(key)}
          >
            {text}
            <span aria-hidden="true" style={{ visibility: sorted ? "visible" : "hidden" }}>
              {ARROW[sorted ? sort.direction : "descending"]}
            </span>
          </button>
        ) : (
          <span className="bk-storage-sort" data-static="">
            {text}
            {sorted ? <span aria-hidden="true">{ARROW[sort.direction]}</span> : null}
          </span>
        )}
      </div>
    );
  };
  return (
    <div className="bk-storage-list" data-mode={mode} onKeyDown={key}>
      <div role="table" aria-label={label} aria-colcount={columns} style={{ minWidth: 0 }}>
        <div role="rowgroup">
          <div role="row" className="bk-storage-head" style={{ color: color.inkMute, font: `600 9.5px/1 ${font.mono}` }}>
            {mode === "filter" ? (
              <div role="columnheader" className="bk-storage-head-cell bk-storage-head-select">
                Select
              </div>
            ) : null}
            {header("name", "Name", "left")}
            {header("size", "Size", "right")}
          </div>
        </div>
        <div role="rowgroup" className="bk-storage-body">
          {rows ? (
            children
          ) : (
            <div role="row" className="bk-storage-row" data-empty="">
              <div role="cell" aria-colspan={columns} className="bk-storage-empty">
                {empty}
              </div>
            </div>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}
