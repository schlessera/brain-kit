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
 *     / px by design". The literals below are the design's own, verbatim, and
 *     the paper values are the one place in this repo the light palette is
 *     drawn at all.
 *
 * `theme="paper"` is the only light surface in the whole design drop, which is
 * what made the two-theme question worth asking in the first place (D9 → D21).
 * It is a MOCK of the light theme rather than the light theme: the frame's own
 * chrome changes colour and the components inside it do not, because their
 * tokens still resolve against the dark root. Wiring `[data-theme="light"]`
 * onto the screen is the light-theme wave's job, and this is where it goes.
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
    background: paper ? "#f4f0e8" : "#0c0e12",
    overflow: "hidden",
    position: "relative",
    flex: "none",
    boxShadow: "0 24px 60px rgba(0,0,0,.5)",
    fontFamily: "'Plus Jakarta Sans',system-ui,sans-serif",
    color: paper ? "#231f1a" : "#e8e4df",
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div style={frame}>
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
          <span style={{ width: 120, height: 4, borderRadius: 99, background: paper ? "#ddd4c4" : "#2a2d35" }} />
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
