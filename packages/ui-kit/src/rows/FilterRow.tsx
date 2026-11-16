import type { CSSProperties, KeyboardEvent } from "react";

import { edgeFor, focusEdge, focusSibling, useRoving } from "../internal/roving.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * Scrolling filter pills. The selected pill is amber; counts live inside the
 * label ("ready 3") rather than in a separate badge, so the row stays one line.
 *
 * Each pill is a `tab`, which means two things:
 *
 *   **←→ moves between pills**, per the design's key table, wrapping at both
 *   ends. Activation follows focus — an arrow key selects, which is the
 *   automatic-activation pattern a filter row wants, because moving through
 *   filters *is* filtering.
 *
 *   **The row renders `role="tablist"`** when any pill is interactive. The
 *   source leaves the container role off, but a `tab` with no `tablist` around
 *   it is invalid ARIA and a screen reader announces neither the set nor the
 *   position in it. The container is this component's own element, so
 *   completing it here is a port finishing the job rather than a redesign.
 *
 * Gating is per item, not per row: a row of decorative pills has no tablist, no
 * roles and no tab stops.
 *
 * ## One tab stop, not one per pill
 *
 * The row takes a roving tabindex ({@link useRoving}): Tab reaches the row once
 * and lands on the selected pill, ←→ move inside it, Tab leaves. This is the
 * component where **automatic activation is right** and {@link TabBar}'s manual
 * activation would be wrong — arrowing through filters IS filtering, and the
 * pattern's own rule is that automatic activation is for a group whose items
 * are cheap and instant to apply.
 *
 * Because activation follows focus, the arrow handler acts on the ELEMENT it
 * just focused rather than on a positional guess into `items`: the DOM walk
 * skips decorative pills, so in a mixed row the two indexes diverge and firing
 * `items[n]` would filter by the wrong pill.
 *
 * ## Every interactive pill reaches 44px (#4086)
 *
 * Under `any-pointer: coarse` each pill with an `onClick` carries `.bk-hit`,
 * so its target reaches 44px past its 20.5px paint, and it paints at least
 * 44px wide, so it never reaches sideways. The strip then clips only
 * horizontally (`.bk-filter-row`), which lets the vertical reach through.
 * A fine pointer keeps the paint and the strip as they are. Decorative pills
 * never reach. The neighbour rule still binds the caller: a reaching control
 * above or below the row needs a gap of at least the sum of the two vertical
 * reaches, 11.75px for the pill, so a row that wraps under a neighbour widens
 * its row gap under a coarse pointer (the design-kit record has the numbers).
 */
export interface FilterItem {
  label: string;
  onClick?: () => void;
}

export interface FilterRowProps {
  items?: FilterItem[];
  /** Index of the selected pill. */
  active?: number;
  /** Mono is the default here — the labels carry counts. */
  mono?: boolean;
}

const FALLBACK: FilterItem[] = [
  { label: "all 9" },
  { label: "ready 3" },
  { label: "blocked 1" },
  { label: "failed 1" },
];

export function FilterRow(p: FilterRowProps) {
  const mono = p.mono !== false;
  const src = p.items || FALLBACK;
  const active = Number(p.active ?? 0);
  const eligible = src.map((item) => Boolean(item.onClick));
  const anyInteractive = eligible.includes(true);
  const roving = useRoving(eligible, active);

  // The strip's clipping lives in `.bk-filter-row`, because under a coarse
  // pointer it clips one axis only, which an inline style cannot express.
  const row: CSSProperties = {
    display: "flex",
    gap: 6,
    boxSizing: "border-box",
    width: "100%",
  };

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>, index: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      src[index]?.onClick?.();
      return;
    }
    const edge = edgeFor(event.key);
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0 && !edge) return;
    event.preventDefault();
    const next = edge
      ? focusEdge(event.currentTarget, edge, '[role="tab"][tabindex]')
      : focusSibling(event.currentTarget, delta, '[role="tab"][tabindex]');
    // Activation follows focus: arrowing through filters is filtering. Driven
    // off the element, not off an index into `items` — see the class doc.
    next?.click();
  }

  return (
    <div style={row} className="bk-filter-row" role={anyInteractive ? "tablist" : undefined}>
      {src.map((item, i) => {
        const on = i === active;
        const act = Boolean(item.onClick);
        const style: CSSProperties = {
          flex: "none",
          borderRadius: 999,
          padding: "4px 10px",
          whiteSpace: "nowrap",
          // Centred for the coarse-pointer 44px minimum width; a pill at its
          // natural width has no free space to centre in.
          textAlign: "center",
          font: `500 10.5px/1 ${mono ? font.mono : font.body}`,
          // A filter pill IS a chip — same shape, same 40% border and 10% tint —
          // so it reads the chip ramp rather than minting a second one.
          border: `1px solid ${on ? token("chip-border-amber") : color.edge}`,
          background: on ? token("chip-tint-amber") : "transparent",
          color: on ? accent.amber.ink : color.inkMute,
          cursor: act ? "pointer" : "default",
          // The selected pill holds its own values on hover: it is already the
          // amber one, and hover never changes what a control means. A custom
          // property is not in React's CSSProperties, so the entries are cast.
          ...({
            "--hv-bg": on ? token("chip-tint-amber") : token("hover-veil-firm"),
            "--hv-bd": on ? token("chip-border-amber") : token("hover-border"),
            "--hv-fg": on ? accent.amber.ink : color.inkDim,
          } as CSSProperties),
        };
        return (
          <span
            key={`${item.label}-${i}`}
            style={style}
            // A pill is control-shaped, not row-shaped: it moves all three hover
            // properties, so it takes wave 1's `.bk-control` rather than
            // `.bk-row`. The unpadded strip clips,
            // so its ring is inset rather than extending beyond the pill.
            // `.bk-hit` reaches 44px under a coarse pointer (#4086).
            className={act ? "bk-control bk-control-inset bk-hit" : undefined}
            role={act ? "tab" : undefined}
            aria-selected={act ? on : undefined}
            tabIndex={act ? roving.tabIndexFor(i) : undefined}
            onClick={item.onClick}
            onFocus={act ? () => roving.onItemFocus(i) : undefined}
            onKeyDown={act ? (event) => onKeyDown(event, i) : undefined}
          >
            {item.label}
          </span>
        );
      })}
    </div>
  );
}
