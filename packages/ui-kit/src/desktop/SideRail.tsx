import type { CSSProperties, KeyboardEvent } from "react";

import { focusSibling, useRoving } from "../internal/roving.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { Meter } from "../primitives/Meter.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * Desktop navigation: the mobile {@link TabBar} unrolled into a vertical rail.
 *
 * Same five destinations, same amber-means-here rule. What a rail can afford
 * that a tab bar cannot is a keyboard shortcut per destination and the day's
 * spend in the footer, both always visible rather than behind a tap.
 *
 * Per D22 it is the nav for every width above phone: `expanded={false}`
 * collapses it to a **60px** icon rail for 480-899px, and expanded it is
 * **208px** from 900px up. Collapsing hides the labels, the shortcut keys and
 * the spend meter — everything whose value is a word — and keeps the icons, the
 * badge and the ⌘K key.
 *
 * ## Two-pane layout, and the thing that bites
 *
 * A rail lives in a flex ROW beside a whole screen, which is the exact shape
 * that overflowed in wave 2: since the `sc-host` wrapper went, `width: 100%` on
 * a component root is live, and two such roots in one row each claim the whole
 * row. The rail is safe because it declares `flex: none` and an explicit width
 * rather than `width: 100%`, so the pane beside it takes the remainder — but
 * that is a property to verify rather than assume, and `SideRail.stories.tsx`
 * does it with `overflowing()` in a real two-pane story.
 *
 * ## One tab stop, not five
 *
 * The destination list is a vertical `tablist` with a roving tabindex
 * ({@link useRoving}): Tab reaches the rail once and lands on the active
 * destination, ↑↓ move inside it, ⏎ / space navigate. Manual activation, for
 * the same reason as {@link TabBar} — arrowing onto Files must not navigate to
 * Files. Before this the rail cost five tab presses and the mobile bar cost
 * five more, which is the ten a screen carrying both used to spend before any
 * content (`.plan/design-feedback.md` §11).
 *
 * The wordmark, the spend meter and the ⌘K cap are not controls and were never
 * tab stops, so the rail is one stop in total.
 */
export interface RailItem {
  icon: IconName;
  label: string;
  /** A count. Red, because a nav badge means "something needs you". */
  badge?: string;
  /** The destination's own key. Hidden when collapsed. */
  shortcut?: string;
  onClick?: () => void;
}

export interface SideRailProps {
  items?: RailItem[];
  /** Index of the amber destination. */
  active?: number;
  /** `false` collapses to the 60px icon rail. */
  expanded?: boolean;
  /** The mono line under the wordmark. */
  status?: string;
  /** 0-100, the day's spend against its cap. */
  spendPct?: number;
  /** The spend as the user reads it. */
  spendText?: string;
  /** What ⌘K opens. */
  hint?: string;
  /** Expanded width in px. Collapsed is always 60. */
  width?: number;
}

const FALLBACK: RailItem[] = [
  { icon: "brain", label: "Chat", shortcut: "1" },
  { icon: "resolved", label: "Actions", badge: "6", shortcut: "2" },
  { icon: "activity", label: "Activity", shortcut: "3" },
  { icon: "files", label: "Files", shortcut: "4" },
  { icon: "settings", label: "Settings", shortcut: "5" },
];

export function SideRail(p: SideRailProps) {
  const expanded = p.expanded !== false;
  const src = p.items || FALLBACK;
  const active = Number(p.active ?? 1);
  const eligible = src.map((it) => Boolean(it.onClick));
  const anyInteractive = eligible.includes(true);
  const roving = useRoving(eligible, active);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      src[index]?.onClick?.();
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    focusSibling(event.currentTarget, delta, '[role="tab"][tabindex]');
  }

  const rail: CSSProperties = {
    width: expanded ? Number(p.width) || 208 : 60,
    // The two declarations that keep a rail out of the wave-2 row hazard: an
    // explicit width and a refusal to grow. NOT `width: 100%`.
    flex: "none",
    alignSelf: "stretch",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: expanded ? "16px 12px" : "16px 8px",
    background: token("rail-bg"),
    borderRight: `1px solid ${color.line}`,
  };

  return (
    <div style={rail}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: expanded ? "0 3px" : 0,
          justifyContent: expanded ? "flex-start" : "center",
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 10,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: color.surface,
            border: `1px solid ${color.edge}`,
          }}
        >
          <Icon icon="brain" size={17} color={accent.amber.ink} />
        </span>
        {expanded ? (
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
              font: `400 15px/1 ${font.display}`,
              color: color.ink,
            }}
          >
            Brain
            <span
              style={{
                font: `500 9px/1 ${font.mono}`,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: accent.teal.ink,
              }}
            >
              {p.status ?? "connected"}
            </span>
          </span>
        ) : null}
      </div>

      <div
        style={{ display: "flex", flexDirection: "column", gap: 3 }}
        role={anyInteractive ? "tablist" : undefined}
        aria-orientation={anyInteractive ? "vertical" : undefined}
      >
        {src.map((it, i) => {
          const on = i === active;
          const act = Boolean(it.onClick);
          const row: CSSProperties = {
            display: "flex",
            alignItems: "center",
            gap: 11,
            minHeight: 36,
            padding: expanded ? "8px 11px" : "8px 0",
            justifyContent: expanded ? "flex-start" : "center",
            borderRadius: 10,
            cursor: act ? "pointer" : "default",
            background: on ? token("rail-tint-active") : "transparent",
            color: on ? accent.amber.ink : color.inkMute,
            ...({
              "--hv-bg": on ? token("rail-tint-active-hover") : token("hover-veil-firm"),
              // One step up, never a change of tone: the amber row lifts to
              // gold, the quiet rows to dim ink.
              "--hv-fg": on ? accent.gold.ink : color.inkDim,
            } as CSSProperties),
          };
          return (
            <div
              key={`${it.label}-${i}`}
              style={row}
              // `.bk-row` + `.bk-row-fg`: a rail row fills its container, so the
              // ring is drawn INSIDE at -2, and its hover moves the background
              // and the foreground but not a border it does not have.
              className={act ? "bk-row bk-row-fg" : undefined}
              role={act ? "tab" : undefined}
              aria-selected={act ? on : undefined}
              aria-label={act && !expanded ? it.label : undefined}
              tabIndex={act ? roving.tabIndexFor(i) : undefined}
              onClick={it.onClick}
              onFocus={act ? () => roving.onItemFocus(i) : undefined}
              onKeyDown={act ? (event) => onKeyDown(event, i) : undefined}
            >
              <Icon icon={it.icon} size={17} />
              {expanded ? (
                <span style={{ flex: 1, minWidth: 0, font: `${on ? 600 : 500} 12.5px/1 ${font.body}` }}>
                  {it.label}
                </span>
              ) : null}
              {it.badge ? (
                <span
                  style={{
                    flex: "none",
                    minWidth: 16,
                    height: 16,
                    borderRadius: 999,
                    background: accent.red.fill,
                    color: token("chip-count-ink"),
                    font: `600 9.5px/16px ${font.body}`,
                    textAlign: "center",
                    padding: "0 4px",
                  }}
                >
                  {it.badge}
                </span>
              ) : null}
              {expanded && it.shortcut ? (
                <span style={{ flex: "none", font: `500 9.5px/1 ${font.mono}`, color: color.inkMute }}>
                  {it.shortcut}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 11,
          paddingTop: 13,
          borderTop: `1px solid ${color.line}`,
        }}
      >
        {expanded ? (
          <Meter
            variant="row"
            label="today"
            value={Number(p.spendPct ?? 38)}
            valueText={p.spendText ?? "$1.90/5"}
            tone="teal"
            labelWidth={38}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: expanded ? "flex-start" : "center",
            font: `400 10px/1 ${font.mono}`,
            color: color.inkMute,
          }}
        >
          <span
            style={{
              flex: "none",
              border: `1px solid ${color.edge}`,
              borderRadius: 5,
              padding: "3px 5px",
              font: `500 9.5px/1 ${font.mono}`,
              color: color.inkDim,
            }}
          >
            ⌘K
          </span>
          {expanded ? <span>{p.hint ?? "Command palette"}</span> : null}
        </div>
      </div>
    </div>
  );
}
