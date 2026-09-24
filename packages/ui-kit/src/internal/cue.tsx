import type { CSSProperties } from "react";

import { ICONS, type IconName } from "../primitives/Icon.js";

/**
 * The glyph a tone draws beside its value (#309): the mark `tone-cue.ts`
 * assigns, rendered the way the ruling states it.
 *
 * - `aria-hidden`, because it repeats what the colour said and a screen
 *   reader never received the colour either; the spoken word per tone is a
 *   copy decision in its own issue. It is never interactive, so no target
 *   changes.
 * - Drawn in the tone's own `ink` role, which is the colour the value is
 *   already set in: every ink clears 4.5:1 in dark, light and print
 *   (`tests/contrast.test.ts`), so the glyph clears the 3:1 non-text bar.
 * - `data-cue` on the SVG names the key, so a test can tell a cued element
 *   from a plain one without reading a colour.
 *
 * Not `Icon`: that component owns the box and hands nothing through to the
 * SVG, and the two attributes above have to sit on the SVG itself.
 */
export interface CueProps {
  icon: IconName;
  /** 11 in rows and cells, 12 in the trend pill, 13 in a tile. */
  size: number;
  /** The tone's ink. Defaults to `currentColor`, which is the same thing
   * wherever the glyph sits inside the element the tone colours. */
  color?: string;
  /** Inside running text: 4px before the text, and pulled down so an 11px
   * box centres on the digits rather than sitting on the baseline. Off in
   * a flex row, where the row's own `gap` and `align-items` place it. */
  inline?: boolean;
  /** Breathes, on the kit's one ambient keyframe. `TimelineList` only. */
  pulse?: boolean;
}

export function Cue({ icon, size, color, inline, pulse }: CueProps) {
  const Glyph = ICONS[icon];
  const box: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: size,
    height: size,
    color: color || "currentColor",
    // A box on the baseline reaches its full height above it, so its centre
    // sits over the ascenders; 1.5px down puts an 11px glyph's centre on the
    // digits' centre for the 11-12.5px text these glyphs sit in.
    verticalAlign: inline ? "-1.5px" : undefined,
    marginRight: inline ? 4 : undefined,
    animation: pulse ? "breathe 2s ease-in-out infinite" : undefined,
  };
  return (
    <span style={box}>
      <Glyph width={size} height={size} strokeWidth={2} aria-hidden="true" data-cue={icon} />
    </span>
  );
}
