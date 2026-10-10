import type { CSSProperties, KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { edgeFor, focusEdge, focusSibling, useRoving } from "../internal/roving.js";
import { BrandMark } from "../primitives/BrandMark.js";
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
 * ## Acts, and All commands (D52 §1)
 *
 * Under the destinations, past a divider, sit the rail's **acts**: things to
 * do rather than places to be (Search, Add a note, Daily briefing). An act is
 * never "here", so its row is never amber and activating it moves nothing.
 * Its effect and cost are printed at rest, in the shortcut column, and a
 * disabled act prints its reason on a second line rather than vanishing. The
 * collapsed rail draws only the acts that need no words: one with an effect,
 * a cost or a reason cannot show it in a 44px column, so it is not drawn
 * there (D52 §8, V6), and the app reaches it through All commands.
 *
 * `onOpenPalette` turns the passive ⌘K cap into the **All commands** button,
 * the visible route to every command without a row of its own. It prints ⌘K
 * at every width and on every pointer (D36 addendum). Without the callback
 * the cap stays a picture, because a control that opens nothing is a lie.
 *
 * The wordmark and All commands are pinned; in a short viewport the middle,
 * from the destinations through the acts, scrolls.
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
 * ## Three tab stops at most, not one per row
 *
 * The destination list is a vertical `tablist` with a roving tabindex
 * ({@link useRoving}): Tab reaches it once and lands on the active
 * destination, ↑↓ move inside it, ⏎ / space navigate. Manual activation, for
 * the same reason as {@link TabBar} — arrowing onto Files must not navigate to
 * Files. Before this the rail cost five tab presses and the mobile bar cost
 * five more, which is the ten a screen carrying both used to spend before any
 * content (`docs/decisions/design-feedback.md` §11).
 *
 * The acts are a second, independent group: a vertical `toolbar` named
 * `Acts` with its own roving stop. ↑↓ / Home / End stay inside it and never
 * cross the divider into the tablist. All commands is the third stop. A rail
 * given neither acts nor the callback is the one stop it always was; the
 * wordmark and the spend meter are not controls and are never stops.
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

/**
 * A thing to do from the rail, not a place to go. The rail draws acts in the
 * order given; placing and ordering them is the app's (D52 §8, V7).
 */
export interface RailAct {
  icon: IconName;
  /** The visible label, e.g. `Search`. */
  label: string;
  /**
   * The accessible name when it says more than the label, e.g. `Search the
   * brain`. Effect, cost and reason are appended to it either way.
   */
  name?: string;
  /** What running this WRITES, e.g. `sync`. Printed at rest, amber. */
  effect?: string;
  /** What running this SPENDS, e.g. `spends`. Printed at rest, gold. */
  cost?: string;
  /**
   * Why it cannot run right now, e.g. `needs the host`. Its presence makes the
   * act DISABLED: `aria-disabled`, reason printed on a second line, still
   * focusable so the reason can be read, never invoked.
   */
  why?: string;
  onClick?: () => void;
}

export interface SideRailProps {
  items?: RailItem[];
  /**
   * The acts under the destinations (D52 §1): at most four. Collapsed, only
   * the acts with no effect, cost or reason are drawn.
   */
  acts?: RailAct[];
  /**
   * Opens the command palette. Its presence turns the passive ⌘K cap into the
   * `All commands` button; without it the cap stays a picture.
   */
  onOpenPalette?: () => void;
  /** Index of the amber destination. */
  active?: number;
  /** `false` collapses to the 60px icon rail. */
  expanded?: boolean;
  /** The mono line under the wordmark. */
  status?: string;
  /** The status line's ink. Teal is the design's; red and amber are for a
   * rail that has to say the connection is gone or on its way back. */
  statusTone?: "teal" | "amber" | "red";
  /**
   * 0-100, the day's spend against its cap. `null` means the app has no spend
   * to show and draws no meter; `undefined` keeps the fixture default, which
   * is what the stories and the parity harness render.
   */
  spendPct?: number | null;
  /** The spend as the user reads it. */
  spendText?: string;
  /**
   * What the passive ⌘K cap says ⌘K opens. `null` means the app has no
   * palette, and the cap goes with the hint — a printed key that does nothing
   * is a lie the design's "every shortcut is printed where it applies" rule
   * forbids. Ignored by the `All commands` button, whose name is fixed.
   */
  hint?: string | null;
  /** Expanded width in px. Collapsed is always 60. */
  width?: number;
}

const FALLBACK: RailItem[] = [
  { icon: "brain", label: "Chat", shortcut: "1" },
  { icon: "resolved", label: "Actions", badge: "6", shortcut: "2" },
  { icon: "files", label: "Files", shortcut: "3" },
  { icon: "graph", label: "Graph", shortcut: "4" },
  { icon: "settings", label: "Settings", shortcut: "5" },
];

export function SideRail(p: SideRailProps) {
  const expanded = p.expanded !== false;
  const src = p.items || FALLBACK;
  const active = Number(p.active ?? 1);
  const showSpend = p.spendPct !== null;
  const showPalette = p.hint !== null;
  const statusInk = p.statusTone === "red" ? accent.red.ink : p.statusTone === "amber" ? accent.amber.ink : accent.teal.ink;
  const eligible = src.map((it) => Boolean(it.onClick));
  const anyInteractive = eligible.includes(true);
  const roving = useRoving(eligible, active);

  if ((p.acts?.length ?? 0) > 4) {
    warnOnce("SideRail: the act section holds at most four rows (D52 §1); move the least frequent act to the palette.");
  }
  // Collapsed, a row is an icon: an act whose effect, cost or reason is part
  // of what it IS cannot be drawn there without hiding it (D52 §8, V6).
  const acts = (p.acts ?? []).filter((it) => expanded || (!it.effect && !it.cost && !it.why));
  const actEligible = acts.map((it) => Boolean(it.onClick));
  // No act is ever "selected": the stop is the last act focused, else the first.
  const actRoving = useRoving(actEligible, -1);
  const anyAct = actEligible.includes(true);
  const middleScrolls = anyInteractive || anyAct;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      src[index]?.onClick?.();
      return;
    }
    const edge = edgeFor(event.key);
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 && !edge) return;
    event.preventDefault();
    if (edge) focusEdge(event.currentTarget, edge, '[role="tab"][tabindex]');
    else focusSibling(event.currentTarget, delta, '[role="tab"][tabindex]');
  }

  // ⏎ and space are the button's own, so each invokes exactly once. The arrows
  // walk this toolbar only and never cross the divider into the tablist.
  function onActKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const edge = edgeFor(event.key);
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 && !edge) return;
    event.preventDefault();
    if (edge) focusEdge(event.currentTarget, edge, "[data-rail-act]");
    else focusSibling(event.currentTarget, delta, "[data-rail-act]");
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
    paddingBlock: 16,
    paddingInline: expanded ? 12 : undefined,
    background: token("rail-bg"),
    borderRight: `1px solid ${color.line}`,
  };

  return (
    <div style={rail} className="bk-side-rail" data-expanded={expanded}>
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
          <BrandMark size={20} />
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
                color: statusInk,
              }}
            >
              {p.status ?? "connected"}
            </span>
          </span>
        ) : null}
      </div>

      {/* The middle scrolls in a short viewport; the wordmark above it and the
          footer below it stay pinned. Only a middle with controls in it
          scrolls: those controls are what reach a scrolled-off row from the
          keyboard, and a picture of a rail has none, as before acts. A
          picture above an operable All commands is clipped instead, so the
          rail's one control is never pushed out of it. */}
      <div
        className={middleScrolls ? "bk-side-rail-middle" : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          ...(!middleScrolls && p.onOpenPalette ? { minHeight: 0, overflow: "hidden" } : null),
        }}
      >
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
              minHeight: act ? undefined : 36,
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
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", font: `${on ? 600 : 500} 12.5px/1 ${font.body}` }}>
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

        {acts.length > 0 ? (
          <>
            <div aria-hidden style={{ flex: "none", height: 1, background: color.line }} />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 3 }}
              role={anyAct ? "toolbar" : undefined}
              aria-orientation={anyAct ? "vertical" : undefined}
              aria-label={anyAct ? "Acts" : undefined}
            >
              {acts.map((it, i) => (
                <ActRow
                  key={`${it.label}-${i}`}
                  act={it}
                  expanded={expanded}
                  tabIndex={actEligible[i] ? actRoving.tabIndexFor(i) : undefined}
                  onFocus={() => actRoving.onItemFocus(i)}
                  onKeyDown={onActKeyDown}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div
        style={{
          marginTop: "auto",
          flex: "none",
          display: "flex",
          flexDirection: "column",
          gap: 11,
          paddingTop: 13,
          borderTop: `1px solid ${color.line}`,
        }}
      >
        {expanded && showSpend ? (
          <Meter
            variant="row"
            label="today"
            value={Number(p.spendPct ?? 38)}
            valueText={p.spendText ?? "$1.90/5"}
            tone="teal"
            labelWidth={38}
          />
        ) : null}
        {p.onOpenPalette ? (
          <button
            type="button"
            // A rail row, so `.bk-row`'s inside ring; `bk-side-rail-palette`
            // gives it the destination rows' 36px, and 44px under a coarse pointer.
            className="bk-row bk-row-fg bk-side-rail-palette"
            aria-keyshortcuts="Meta+K"
            aria-label={expanded ? undefined : PALETTE_NAME}
            onClick={p.onOpenPalette}
            style={{
              ...BUTTON_RESET,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: expanded ? "8px 11px" : "8px 0",
              justifyContent: expanded ? "flex-start" : "center",
              borderRadius: 10,
              cursor: "pointer",
              color: color.inkMute,
              font: `500 12.5px/1 ${font.body}`,
              ...({ "--hv-bg": token("hover-veil-firm"), "--hv-fg": color.inkDim } as CSSProperties),
            }}
          >
            {/* Printed at every width and on every pointer: the one rail key
                not gated on a fine pointer (D36 addendum). */}
            <span aria-hidden style={CAP}>
              ⌘K
            </span>
            {expanded ? <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{PALETTE_NAME}</span> : null}
          </button>
        ) : showPalette ? (
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
            <span style={CAP}>⌘K</span>
            {expanded ? <span>{p.hint ?? "Command palette"}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** D52 §2 names the button; the name is the contract, so it is not a prop. */
const PALETTE_NAME = "All commands";

const CAP: CSSProperties = {
  flex: "none",
  border: `1px solid ${color.edge}`,
  borderRadius: 5,
  padding: "3px 5px",
  font: `500 9.5px/1 ${font.mono}`,
  color: color.inkDim,
};

/** A `<button>` that draws as a rail row: none of the UA's chrome. */
const BUTTON_RESET: CSSProperties = {
  appearance: "none",
  boxSizing: "border-box",
  width: "100%",
  margin: 0,
  border: 0,
  background: "transparent",
  textAlign: "left",
};

const CHIP: CSSProperties = {
  flex: "none",
  border: `1px solid ${color.edge}`,
  borderRadius: 5,
  padding: "3px 6px",
  font: `600 9px/1.3 ${font.mono}`,
};

interface ActRowProps {
  act: RailAct;
  expanded: boolean;
  tabIndex: 0 | -1 | undefined;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * One act. A row with a handler is a real `<button>`, so ⏎ and space are the
 * browser's and fire once; a disabled one stays focusable, says why in text
 * and in its name, and has no handler to fire. A row without a handler is a
 * picture of one: no role, no stop, no hover.
 */
function ActRow({ act: it, expanded, tabIndex, onFocus, onKeyDown }: ActRowProps) {
  const off = Boolean(it.why);
  const live = Boolean(it.onClick);
  // What the screen prints, the name says: `Daily briefing, spends`, and
  // `…, unavailable: needs the host` when it cannot run (D52 §2).
  const name = [it.name ?? it.label, it.effect, it.cost].filter(Boolean).join(", ") + (off ? `, unavailable: ${it.why}` : "");
  // Disabled dims what the act IS, never what it would do or why it cannot:
  // the chips and the reason are the text the user has to read at rest.
  const dim: CSSProperties | undefined = off ? { opacity: 0.45 } : undefined;
  const body = (
    <>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          justifyContent: expanded ? "flex-start" : "center",
        }}
      >
        <span style={{ display: "flex", flex: "none", ...dim }}>
          <Icon icon={it.icon} size={17} />
        </span>
        {expanded ? (
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", font: `500 12.5px/1.2 ${font.body}`, ...dim }}>
            {it.label}
          </span>
        ) : null}
        {expanded && it.cost ? <span style={{ ...CHIP, color: accent.gold.ink }}>{it.cost}</span> : null}
        {expanded && it.effect ? <span style={{ ...CHIP, color: accent.amber.ink }}>{it.effect}</span> : null}
      </span>
      {expanded && it.why ? (
        <span style={{ paddingLeft: 28, overflowWrap: "anywhere", font: `500 9.5px/1.2 ${font.mono}`, color: color.inkMute }}>
          {it.why}
        </span>
      ) : null}
    </>
  );
  const row: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 4,
    padding: expanded ? "8px 11px" : "8px 0",
    borderRadius: 10,
    // Never amber: an act is never "here".
    color: color.inkMute,
  };
  if (!live) return <div style={{ ...row, minHeight: 36 }}>{body}</div>;
  return (
    <button
      type="button"
      data-rail-act=""
      // Disabled keeps the inside ring and drops the hover lift, so it never
      // looks like it will do something.
      className={off ? "bk-row bk-side-rail-act" : "bk-row bk-row-fg bk-side-rail-act"}
      aria-label={name}
      aria-disabled={off ? true : undefined}
      tabIndex={tabIndex}
      onClick={off ? undefined : it.onClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={{
        ...BUTTON_RESET,
        ...row,
        cursor: off ? "default" : "pointer",
        ...({
          "--hv-bg": off ? "transparent" : token("hover-veil-firm"),
          "--hv-fg": color.inkDim,
        } as CSSProperties),
      }}
    >
      {body}
    </button>
  );
}
