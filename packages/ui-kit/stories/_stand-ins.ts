import type { CSSProperties } from "react";

import { color, font } from "../src/tokens.js";

/**
 * A story's stand-in composer: a plain textarea that only holds focus or a
 * draft for the play function. It is drawn in the kit's type and paint so it
 * does not read as a broken, unstyled control next to the real component.
 */
export const standInField: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 44,
  padding: "10px 12px",
  border: `1px solid ${color.edge}`,
  borderRadius: 8,
  background: color.canvas,
  color: color.ink,
  font: `400 13px/1.5 ${font.body}`,
};
