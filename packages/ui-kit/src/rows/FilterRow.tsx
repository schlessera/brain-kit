import type { CSSProperties, KeyboardEvent } from "react";

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
  const anyInteractive = src.some((item) => Boolean(item.onClick));

  const row: CSSProperties = {
    display: "flex",
    gap: 6,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
  };

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>, index: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      src[index]?.onClick?.();
      return;
    }
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const tabs = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"][tabindex]') ?? [])];
    const here = tabs.indexOf(event.currentTarget);
    if (here === -1 || tabs.length < 2) return;
    const next = (here + delta + tabs.length) % tabs.length;
    tabs[next].focus();
    // Activation follows focus: arrowing through filters is filtering.
    src[next]?.onClick?.();
  }

  return (
    <div style={row} role={anyInteractive ? "tablist" : undefined}>
      {src.map((item, i) => {
        const on = i === active;
        const act = Boolean(item.onClick);
        const style: CSSProperties = {
          flex: "none",
          borderRadius: 999,
          padding: "4px 10px",
          whiteSpace: "nowrap",
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
            // properties and its ring sits OUTSIDE it, so it takes wave 1's
            // `.bk-control` rather than `.bk-row`.
            className={act ? "bk-control" : undefined}
            role={act ? "tab" : undefined}
            aria-selected={act ? on : undefined}
            tabIndex={act ? 0 : undefined}
            onClick={item.onClick}
            onKeyDown={act ? (event) => onKeyDown(event, i) : undefined}
          >
            {item.label}
          </span>
        );
      })}
    </div>
  );
}
