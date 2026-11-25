import type { CSSProperties } from "react";
import { accent, color, font } from "../tokens.js";
import { OwnerSwatch } from "./owner-paint.js";
import { unknownStoresCopy } from "./storage-copy.js";
import { OWNER_WORD, type StorageOwner } from "./storage-geometry.js";

export interface StorageMapLegendOwner {
  owner: StorageOwner;
  /** The owner's total within the current view, pre-formatted ("4.8 GB"). Never a sum across capacities. */
  total?: string;
}

export interface StorageMapLegendProps {
  /** The owners present in the view, in the order to print them. */
  owners: readonly StorageMapLegendOwner[];
  /** Stores whose size is unknown and so draw no tile. 0 or absent prints no unknown chip. */
  unknownCount?: number;
  /**
   * Makes the unknown chip a button that jumps to the first `?` row in the
   * list. Without it the chip is plain text, like the owner chips.
   */
  onShowUnknown?: () => void;
  /** The list's accessible name. */
  label?: string;
}

const CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 26,
  padding: "3px 8px 3px 6px",
  boxSizing: "border-box",
  borderRadius: 5,
  border: `1px solid ${color.line}`,
  background: color.surface,
  color: color.ink,
  font: `500 11.5px/1.3 ${font.body}`,
  maxWidth: "100%",
};

/**
 * Decodes the map: one chip per owner (its swatch with the edge sample, its
 * word, its total in the view) and, when some stores have no measured size,
 * `? {n} stores · size unknown · not drawn`.
 *
 * The owner chips are not filters (owner filtering is `FilterRow`'s job), so
 * they are plain text. It sits above the map and wraps, side by side or
 * stacked, never below the map where it would fall under the fold (#4544 Q2).
 */
export function StorageMapLegend({ owners, unknownCount = 0, onShowUnknown, label = "Map legend" }: StorageMapLegendProps) {
  const unknown = unknownCount > 0 ? unknownStoresCopy(unknownCount) : null;
  const unknownChip = unknown ? (
    <span style={{ ...CHIP, borderStyle: "dashed", borderColor: accent.neutral.ink }}>
      <span aria-hidden="true" style={{ font: `700 11px/1 ${font.mono}`, width: 16, textAlign: "center", flex: "none" }}>
        ?
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{unknown}</span>
    </span>
  ) : null;
  return (
    <ul
      aria-label={label}
      data-storage-legend=""
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 8px", margin: 0, padding: 0, listStyle: "none", minWidth: 0, maxWidth: "100%" }}
    >
      {owners.map(({ owner, total }) => (
        <li key={owner} data-legend-owner={owner} style={{ display: "flex", maxWidth: "100%" }}>
          <span style={CHIP}>
            <OwnerSwatch owner={owner} size={16} />
            <span style={{ fontWeight: 600 }}>{OWNER_WORD[owner]}</span>
            {total ? <span style={{ fontFamily: font.mono, fontSize: 11 }}>{total}</span> : null}
          </span>
        </li>
      ))}
      {unknownChip ? (
        <li data-legend-unknown="" style={{ display: "flex", maxWidth: "100%" }}>
          {onShowUnknown ? (
            <button
              /* raw-button: kit — a legend chip whose 44px target jumps to the first unknown row */
              type="button"
              className="bk-storage-legend-jump"
              aria-label={`${unknown}. Show in list`}
              onClick={onShowUnknown}
            >
              {unknownChip}
            </button>
          ) : (
            unknownChip
          )}
        </li>
      ) : null}
    </ul>
  );
}
