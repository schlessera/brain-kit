import { Button } from "../primitives/Button.js";
import { color, font } from "../tokens.js";
import { selectionCopy } from "./storage-copy.js";

export interface StorageSelectionBarProps {
  count: number;
  /** The selected total, pre-formatted ("5.0 GB"). */
  size: string;
  /** The basis the total is in, as printed: "on disk", "file size". Never "space freed" (D5). */
  basis: string;
  /** Any selected size is unknown: appends `+ ? unknown`. */
  unknown?: boolean;
  onClear: () => void;
  onReview: () => void;
  /** The primary action, defaulting to `Review removal`; it leads to the existing confirm flow. */
  reviewLabel?: string;
}

/**
 * The Find large files selection bar: `{n} selected · {size} on disk`, Clear
 * and Review removal. It sticks to the bottom of the list region, not the
 * viewport, and takes its own space so it never covers the last row.
 *
 * The polite status line is always mounted, so the count is announced when it
 * changes; the bar itself shows only once something is selected.
 */
export function StorageSelectionBar({ count, size, basis, unknown, onClear, onReview, reviewLabel = "Review removal" }: StorageSelectionBarProps) {
  const copy = count > 0 ? selectionCopy(count, size, basis, unknown) : "";
  return (
    <div className="bk-storage-selection" data-open={count > 0 ? "true" : "false"}>
      <span role="status" aria-live="polite" className="bk-storage-selection-status" style={{ font: `600 12px/1.35 ${font.body}`, color: color.ink }}>
        {copy}
      </span>
      {count > 0 ? (
        <span className="bk-storage-selection-actions">
          <Button label="Clear" tone="quiet" size="md" block={false} reach onClick={onClear} />
          <Button label={`${reviewLabel} ›`} ariaLabel={reviewLabel} tone="primary" size="md" block={false} reach onClick={onReview} />
        </span>
      ) : null}
    </div>
  );
}
