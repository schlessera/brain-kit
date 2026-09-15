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
  const body: CSSProperties = {
    flex: 1,
    // Not optional, and not a style choice. Without it a flex item's
    // `min-height: auto` floors this box at its content height and the screen
    // grows instead of scrolling.
    minHeight: 0,
    overflow: p.overflow ?? "hidden",
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    padding: p.padding ?? "12px 16px 8px",
    gap: p.gap ?? 10,
    ...p.style,
  };
  return <div style={body}>{p.children}</div>;
}
