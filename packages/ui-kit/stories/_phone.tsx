/**
 * `PhoneFrame` — story furniture, NOT a shipped component (D16).
 *
 * It is a device mock for presenting screens, not a thing the app renders, so
 * it lives here beside `_stage.tsx` rather than in `src/`. Three consequences
 * follow, and all three are the point of putting it here:
 *
 *   - **It is absent from `src/index.ts`**, so no consumer can import it and
 *     nothing in the public API has to keep working.
 *   - **It never reaches the npm tarball.** `package.json`'s `files` array is
 *     `["src", "dist", "README.md"]`, and `bun pm pack --dry-run` is the check.
 *   - **The token rule does not reach it either.** `tests/tokens-match-theme.ts`
 *     forbids a colour literal in `src/`; furniture is exempt for the same
 *     reason the design marks its own `browser-window.jsx` "raw elements / hex
 *     / px by design". The bezel and shadow literals below are the design's
 *     own, verbatim — the dark frame from `PhoneFrame.dc.html`, the paper one
 *     from `Brain Kit Light.dc.html` §L4.
 *
 * `theme="paper"` puts `data-theme="light"` on the frame, so everything inside
 * it resolves the light half of every token: the screen IS the light theme,
 * not a mock of it. The screen's ground and ink come from the tokens for that
 * reason — only the bezel, which is a device and not a surface, is a literal.
 * Before the 2026-09-18 drop this was a light bezel around dark components
 * (design-feedback §8); that gap is closed.
 */
import type { ReactNode } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../src/primitives/Icon.js";

export interface PhoneFrameProps {
  children?: ReactNode;
  /** `paper` is the design's one light surface. */
  theme?: "dark" | "paper";
  /** The clock and the radios. On by default. */
  showStatus?: boolean;
  /** The home indicator. Off by default. */
  showHome?: boolean;
  /** The status-bar clock. A literal string — this world has no stopwatch. */
  time?: string;
  width?: number;
  height?: number;
}

export function PhoneFrame(p: PhoneFrameProps) {
  const paper = (p.theme || "dark") === "paper";

  const frame: CSSProperties = {
    width: Number(p.width) || 390,
    height: Number(p.height) || 844,
    borderRadius: 42,
    // The bezel: a device, not a surface, so it is the design's literal.
    border: `9px solid ${paper ? "#d9d2c6" : "#1c1d20"}`,
    // `content-box`, explicitly, and this is a third instance of the Tailwind
    // preflight exception waves 1 and 3 both recorded (`Chip variant="count"`,
    // `MapView`'s scale bar). Preflight sets `box-sizing: border-box`
    // globally, which the DC pages never loaded — so under the kit's own
    // stylesheet the 9px bezel would eat into the 844, and a screen mocked at
    // "390 x 844" would really be 372 x 826. The bezel is a bezel: it is
    // OUTSIDE the screen, and the numbers on these props are the device's
    // screen size.
    boxSizing: "content-box",
    background: "var(--bk-color-canvas)",
    overflow: "hidden",
    position: "relative",
    flex: "none",
    // The light catalog's device shadow is warm; the dark one is black.
    boxShadow: paper ? "0 24px 60px rgba(90,78,58,.28)" : "0 24px 60px rgba(0,0,0,.5)",
    fontFamily: "'Plus Jakarta Sans',system-ui,sans-serif",
    color: "var(--bk-color-ink)",
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div style={frame} data-theme={p.theme ? (paper ? "light" : "dark") : undefined}>
      {p.showStatus !== false ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 26px 4px",
            font: "600 13px/1 'Plus Jakarta Sans'",
            flex: "none",
          }}
        >
          <span>{p.time || "9:41"}</span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Icon icon="wifi" size={14} />
            <Icon icon="battery" size={17} />
          </span>
        </div>
      ) : null}
      {/* The screen. `min-height: 0` for the same reason `ScreenBody` has it:
       * without it the frame grows past its own height instead of clipping. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {p.children ?? null}
      </div>
      {p.showHome === true ? (
        <div style={{ flex: "none", height: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ width: 120, height: 4, borderRadius: 99, background: "var(--bk-color-edge)" }} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The frame as a decorator, which is how screens will use it in wave 5.
 *
 * `stageWidth` is not enough for a screen: the stage constrains a column and a
 * phone constrains a device. So this replaces `stage` rather than wrapping it,
 * and a story picks one.
 */
export function phone(options: PhoneFrameProps = {}) {
  return function decorator(Story: () => ReactNode) {
    return (
      <PhoneFrame {...options}>
        <Story />
      </PhoneFrame>
    );
  };
}
