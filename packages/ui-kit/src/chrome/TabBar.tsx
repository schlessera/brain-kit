import type { CSSProperties, KeyboardEvent } from "react";

import { edgeFor, focusEdge, focusSibling, useRoving } from "../internal/roving.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * Bottom navigation, five slots.
 *
 * Actions owns its own slot, because "decide this" and "something broke" must
 * never share a badge. Only one item is amber at a time.
 *
 * ## The hit target, and this is the design's OTHER sanctioned method
 *
 * Waves 1 and 3 expanded a target with a transparent `::before` at negative
 * inset. `TabBar` uses the second method the design's README names: **padding
 * cancelled by an equal negative margin** (`padding: 9px 14px; margin: -9px
 * -14px`). The padding grows the element's own border box by 18px vertically
 * and 28px horizontally; the negative margin subtracts exactly the same amount
 * from its margin box, so siblings lay out as though nothing had changed.
 *
 * **It has no off-by-one, and that is worth stating because the pseudo-element
 * method does.** Wave 3 measured `inset: -9px` on a bordered element and found
 * it short by 1px per side, because `inset` on an absolutely positioned
 * pseudo-element resolves against the containing block's PADDING box and a 1px
 * border eats 1px of reach. Padding is not measured against anything — it IS
 * the box — so the expansion is exact whether or not the element has a border.
 * `TabBar.stories.tsx` measures the real box and asserts it.
 *
 * **The constraint is the same one, though, and here it is horizontal, and it
 * has a number.** Each item reaches 14px past its own paint on each side, so two
 * adjacent items need at least 28px of clear space between their visuals or the
 * later sibling's padding sits on top of the earlier one's label and wins the
 * hit test.
 *
 * With `justify-content: space-around` the clear gap is the bar's free space
 * divided by the slot count, so for the five default slots — 135px of content —
 * the gap is `(width - 135) / 5` and it reaches 28px at a bar width of **276px**.
 * Measured, not derived: at 275px the two expanded boxes touch (-0.02px), at
 * 276px they separate (+0.19px). At the design's 390px the clear gap is 50.98px
 * and each item's hit box is 50.5 x 50-63px around a 32.5px-tall visual, which
 * is the README's "~33px visual -> 51px hit" to within font metrics.
 *
 * **So a five-slot bar below 276px steals its own clicks**, and the
 * `NarrowBarStealsTheClick` story reproduces that at 240px on demand. That is
 * comfortably under any phone the design targets, but it is a real floor and it
 * moves with the slot count and the label lengths — a six-slot bar needs more.
 *
 * **The expansion is NOT gated on a handler, and that is the one place this
 * component departs from the kit's rule.** Waves 1 and 3 gate theirs because a
 * pseudo-element at negative inset exists for no other purpose. This padding
 * also positions the badge — `right: 0` resolves against the padding box — so
 * gating it would move the badge out of the corner the moment an item lost its
 * handler. The cost is that a STATIC item in a mixed bar still carries an
 * expanded box and can sit on an interactive neighbour's label; the
 * `MixedGating` story measures that the clear gap at phone width leaves room
 * for it, and `NarrowBarStealsTheClick` is what happens when it does not.
 *
 * ## One tab stop, not five
 *
 * The bar is a `tablist` and takes a roving tabindex ({@link useRoving}): Tab
 * reaches the bar once and lands on the active slot, ←→ move inside it, and Tab
 * again leaves for the next thing on the screen. Selection does not follow
 * focus — a tab bar is a NAVIGATION, and arrowing onto Files must not navigate
 * to Files — so ⏎ / space stay the activation, which is the manual-activation
 * half of the pattern. `FilterRow` is the other half and takes the opposite
 * answer, for the reason its own doc gives.
 *
 * In a mixed bar the stop is the active slot only if the active slot has a
 * handler; otherwise it is the first slot that does, so a bar whose amber item
 * is decorative is still reachable.
 */
export interface TabItem {
  icon: IconName;
  label: string;
  /** A count. Red, because a tab-bar badge means "something needs you". */
  badge?: string;
  onClick?: () => void;
}

export interface TabBarProps {
  items?: TabItem[];
  /** Index of the amber slot. */
  active?: number;
}

/**
 * The same five destinations as the desktop rail, in the same order, with
 * Settings folded into More: six into five does not go, and the one you
 * live in least is the one to fold. Activity is not a slot — it is the
 * all-runs lens of Actions (see `SideRail`). New chat is not a slot either:
 * a tab is a place, and starting a chat is an act.
 */
const FALLBACK: TabItem[] = [
  { icon: "brain", label: "Chat" },
  { icon: "resolved", label: "Actions", badge: "6" },
  { icon: "files", label: "Files" },
  { icon: "graph", label: "Graph" },
  { icon: "more", label: "More" },
];

export function TabBar(p: TabBarProps) {
  const src = p.items || FALLBACK;
  const active = Number(p.active ?? 1);
  const eligible = src.map((it) => Boolean(it.onClick));
  const anyInteractive = eligible.includes(true);
  const roving = useRoving(eligible, active);

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
    if (edge) focusEdge(event.currentTarget, edge, '[role="tab"][tabindex]');
    else focusSibling(event.currentTarget, delta, '[role="tab"][tabindex]');
  }

  const bar: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    height: 60,
    flex: "none",
    boxSizing: "border-box",
    width: "100%",
    borderTop: `1px solid ${color.edge}`,
    background: color.surface,
    paddingBottom: 8,
  };

  return (
    <div style={bar} role={anyInteractive ? "tablist" : undefined}>
      {src.map((it, i) => {
        const on = i === active;
        const act = Boolean(it.onClick);
        const item: CSSProperties = {
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          font: `500 9.5px/1 ${font.body}`,
          color: on ? accent.amber.ink : color.inkMute,
          cursor: act ? "pointer" : "default",
          // The hit target, UNGATED — unlike wave 1's `.bk-switch::before` and
          // wave 3's `.bk-thumb::before`, which exist only to expand a target
          // and are therefore interactive treatment. This padding is also the
          // badge's containing block: `right: 0` is the padding box's right
          // edge, so gating it would move the badge whenever an item lost its
          // handler. Geometry that two things depend on is not gated on one of
          // them. The consequence is recorded in the class doc and measured in
          // `TabBar.stories.tsx`.
          padding: "9px 14px",
          margin: "-9px -14px",
          // TabBar's hover moves the FOREGROUND ONLY — there is no row to
          // shade under a tab bar item — so it sets `--hv-fg` and nothing
          // else, which is what `.bk-row-fg` is for. The active item lifts to
          // gold and the rest to dim ink: one step up, never a change of tone.
          ...({ "--hv-fg": on ? accent.gold.ink : color.inkDim } as CSSProperties),
        };
        return (
          <span
            key={`${it.label}-${i}`}
            style={item}
            // `.bk-row`, not `.bk-control`: the design puts this ring at offset
            // -2, drawn INSIDE, because a tab sits against the bar's edge and
            // a ring outside it is clipped by the frame.
            className={act ? "bk-row bk-row-fg" : undefined}
            role={act ? "tab" : undefined}
            aria-selected={act ? on : undefined}
            tabIndex={act ? roving.tabIndexFor(i) : undefined}
            onClick={it.onClick}
            onFocus={act ? () => roving.onItemFocus(i) : undefined}
            onKeyDown={act ? (event) => onKeyDown(event, i) : undefined}
          >
            <Icon icon={it.icon} size={20} />
            {it.label}
            {it.badge ? (
              <span
                style={{
                  position: "absolute",
                  right: 0,
                  top: -2,
                  minWidth: 15,
                  height: 15,
                  borderRadius: 999,
                  background: accent.red.fill,
                  color: token("chip-count-ink"),
                  font: `600 9px/15px ${font.body}`,
                  textAlign: "center",
                  padding: "0 3px",
                }}
              >
                {it.badge}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
