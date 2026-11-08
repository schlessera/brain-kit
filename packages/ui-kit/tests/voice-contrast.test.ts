/**
 * The voice surface's text contrast (#3692), as numbers.
 *
 * The words, the state label and every notice line sit on the field's opaque
 * ground (`voice-ground-*`), never on a meter bar, so their contrast is a
 * property of two solid colours. These assertions hold every ink the voice
 * parts print on every ground at 4.5:1 in both themes, so the day a token
 * moves, this fails before axe has to find it in a story. The opaque grounds
 * are also pinned to their tints: each one is that tint composited once over
 * its theme's canvas.
 */
import { describe, expect, test } from "bun:test";

import { LIGHT_TOKENS, TOKENS } from "../src/tokens.js";
import { contrast, over, parse } from "./_contrast.js";

const TONES = ["you", "brain", "idle", "fail"] as const;
const STATE_INK = { you: "amber-ink", brain: "teal-ink", idle: "color-ink-dim", fail: "red-ink" } as const;
const TEXT_INKS = ["color-ink", "color-ink-dim", "color-ink-mute"] as const;

for (const [theme, T] of [["dark", TOKENS], ["light", LIGHT_TOKENS]] as const) {
  const value = (name: string) => parse((T as Record<string, string>)[name]!).rgb;
  describe(`voice contrast, ${theme}`, () => {
    test("each opaque ground is its tint over the canvas, within one level per channel", () => {
      for (const tone of TONES) {
        const composited = over(parse((T as Record<string, string>)[`voice-tint-${tone}`]!), value("color-canvas"));
        const ground = value(`voice-ground-${tone}`);
        for (const [i, channel] of ground.entries()) expect(Math.abs(channel - composited[i]!), `${tone} channel ${i}`).toBeLessThanOrEqual(1);
      }
    });

    test("every text ink clears 4.5:1 on every ground", () => {
      const misses: string[] = [];
      for (const tone of TONES) {
        for (const ink of [...TEXT_INKS, STATE_INK[tone]]) {
          const ratio = contrast(value(ink), value(`voice-ground-${tone}`));
          if (ratio < 4.5) misses.push(`${ink} on ${tone}: ${ratio}`);
        }
      }
      expect(misses).toEqual([]);
    });

    test("text on the solid controls clears 4.5:1", () => {
      for (const fill of ["amber-fill", "teal-fill", "red-fill"]) expect(contrast(value("on-fill"), value(fill)), fill).toBeGreaterThanOrEqual(4.5);
      expect(contrast(value("color-ink"), value("color-raised"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(value("color-canvas"), value("color-ink")), "pressed control").toBeGreaterThanOrEqual(4.5);
    });
  });
}
