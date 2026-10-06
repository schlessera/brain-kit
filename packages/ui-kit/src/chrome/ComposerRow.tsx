import type { ReactNode } from "react";

/**
 * The shared row between the message area and the composer (D52 §3): working
 * sessions in the left half, pending follow-ups for the open session in the
 * right half.
 *
 * It is a **sibling** of the message area and the composer, never an overlay,
 * so the scroll disc (inside the message area, at `bottom: 16px`) can never
 * share its box. The geometry lives in `tokens.css` under `.bk-composer-row`:
 *
 * - a two-column grid with an 8px gutter over the composer's measure (720px
 *   at most); each half is `(width − 8px) / 2` and a hard box, so content
 *   never crosses the gutter;
 * - an empty half paints nothing but keeps its column, so a lone pending pill
 *   stays right and a lone working session stays left;
 * - the halves are bottom-aligned, and the row is as tall as the taller half;
 * - when both halves are empty the row is absent, with no spacer. "Empty"
 *   means the half rendered no element, which is what `SessionStrip` does
 *   with no sessions, so a caller can always pass both halves.
 *
 * Each half is the size container `ListRow density="pill"` reads to choose two
 * lines (under 240px) or one. DOM order is left then right, which is the tab
 * order D52 requires: transcript → working sessions → pending follow-ups →
 * composer. At ≥1280 the caller passes no `left`: the working sessions live in
 * the Sessions pane there, and the row carries only the right half.
 *
 * The row owns no state and hides nothing on its own. R4's rule (once the
 * composer passes three lines with the keyboard up, the row hides first) is
 * the caller's, because only the caller knows the composer's line count.
 */
export interface ComposerRowProps {
  /** Working sessions: a `SessionStrip`. */
  left?: ReactNode;
  /** Pending follow-ups for the open session (#1002). */
  right?: ReactNode;
}

export function ComposerRow(p: ComposerRowProps) {
  return (
    <div className="bk-composer-row" data-composer-row="">
      <div className="bk-row-half" data-row-half="left">{p.left ?? null}</div>
      <div className="bk-row-half" data-row-half="right">{p.right ?? null}</div>
    </div>
  );
}
