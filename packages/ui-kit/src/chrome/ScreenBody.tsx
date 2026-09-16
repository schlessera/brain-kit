import type { CSSProperties, ReactNode } from "react";

/**
 * The scrolling middle of a screen — and the one component in this kit the
 * design does not have.
 *
 * Every assembled screen in the catalog retypes the same container by hand:
 *
 * ```
 * flex: 1; min-height: 0; overflow: hidden;
 * display: flex; flex-direction: column;
 * padding: <per screen>; gap: 9-14px;
 * ```
 *
 * Nine screens, nine chances to drop `min-height: 0` and get a body that
 * refuses to scroll because a flex item's default `min-height: auto` floors it
 * at its content. That failure looks like "the list is too long" rather than
 * like a missing declaration, which is why it is worth one component instead of
 * nine copies.
 *
 * This is the single addition wave 4 makes to the component set, and it is
 * deliberate: D4's "no more than the design" is a scope rule about not
 * inventing surfaces, not a prohibition on fixing an omission the design's own
 * screens work around by repetition.
 *
 * `padding` and `gap` stay props because the design really does vary them per
 * screen (2-20px of padding, 4-14px of gap) and that variation is editorial.
 * What does not vary — the three declarations that make it scroll — is not a
 * prop at all.
 *
 * ## The fourth declaration, which wave 5 had to find the hard way
 *
 * A flex column's children default to `flex-shrink: 1`, so the moment a
 * screen's content is taller than the phone, EVERY child gives up height at
 * once instead of the body scrolling. It fails quietly and it fails as somebody
 * else's bug: on the weekly review a `FilterRow` compressed from 22px to 14px
 * and clipped the descenders off its own labels, an `ActionCard` swallowed the
 * last line of its body, and a `margin-top: auto` spacer stopped spacing
 * because there was no free space left to distribute. Three components looked
 * broken; the container was.
 *
 * `.bk-screen-body > * { flex-shrink: 0 }` is the whole fix, and it lives in
 * `theme.css` because it applies to the children — which is the reason it
 * belongs to this component rather than to each of the fifty-eight that might
 * be put inside one.
 *
 * ## A scrolling body is a tab stop, and it has to be
 *
 * `overflow: auto` makes this a scrollable region, and axe's
 * `scrollable-region-focusable` is right about what that costs: a region you
 * can scroll with a wheel and cannot reach with a keyboard is content some
 * people simply cannot read. The usual escape — "its children are focusable, so
 * Tab scrolls it" — holds only while the body HAS focusable children, and this
 * kit gates every role and every tab stop on a handler. A replayed transcript,
 * a read-only list, a static screen: all of them render exactly the same
 * markup with nothing focusable in it, and all of them would strand whatever is
 * below the fold.
 *
 * So a scrolling body takes `tabIndex={0}` and a clipping one does not. The
 * cost is one tab stop at the top of a scrolling screen — the wave that removed
 * ten redundant ones does not get to pretend this one is free — and it buys the
 * static case, which is the case that was broken.
 */
export interface ScreenBodyProps {
  children?: ReactNode;
  /** Any CSS padding value. The design's screens run 2-20px. */
  padding?: number | string;
  /** Gap between children. The design's screens run 4-14px. */
  gap?: number;
  /**
   * `hidden` clips, which is what the design's mockups do because a static
   * mockup has nothing to scroll. A real screen wants `auto`; pass it.
   */
  overflow?: "hidden" | "auto";
  /** Merged last onto the root — the kit's `hostPositionStyle` successor. */
  style?: CSSProperties;
}

export function ScreenBody(p: ScreenBodyProps) {
  const scrolls = (p.overflow ?? "hidden") === "auto";
  const body: CSSProperties = {
    flex: 1,
    // Not optional, and not a style choice. Without it a flex item's
    // `min-height: auto` floors this box at its content height and the screen
    // grows instead of scrolling.
    minHeight: 0,
    overflow: scrolls ? "auto" : "hidden",
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    padding: p.padding ?? "12px 16px 8px",
    gap: p.gap ?? 10,
    ...p.style,
  };
  // `.bk-screen-body` is one declaration -- `> * { flex-shrink: 0 }` -- and it
  // is the difference between a screen that scrolls and a screen whose children
  // all give up height at once. It cannot be an inline style because it applies
  // to the CHILDREN, which is exactly why it belongs to the container rather
  // than to each component that might be put inside one. See `theme.css`.
  return (
    <div
      className="bk-screen-body"
      style={body}
      // Only when it scrolls. A clipping body is not a scrollable region and a
      // tab stop on it would be a stop that does nothing.
      tabIndex={scrolls ? 0 : undefined}
    >
      {p.children}
    </div>
  );
}
