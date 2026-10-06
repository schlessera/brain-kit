/**
 * The icon map is the one place in the kit that names an icon, and a wrong
 * name there fails silently: lucide renders nothing and the component still
 * lays out a correctly-sized empty box. Three assertions turn that whole class
 * of failure into a red build.
 *
 * It also pins the key and glyph counts (the port shipped 78 over 76, then 79 over 77; D52 added
 * eight session-state keys, 87 over 85) — so a key lost in a merge is caught, and the
 * two deprecated aliases stay repointed at their canonical exports.
 */

import { describe, expect, test } from "bun:test";
import * as lucide from "lucide-react";

import { ICONS } from "../src/primitives/Icon.js";

describe("icon map", () => {
  const entries = Object.entries(ICONS);

  test("every semantic key resolves to a real lucide-react export", () => {
    const exported = new Set(Object.values(lucide as Record<string, unknown>));
    const unresolved = entries.filter(([, glyph]) => !exported.has(glyph)).map(([key]) => key);
    expect(unresolved).toEqual([]);
  });

  test("all 87 keys survive, over 85 distinct glyphs", () => {
    // Two pairs are aliases — deny/dismiss and settings/filter. They render
    // identically today but mean different things, and collapsing them would
    // leave a future icon set unable to tell them apart.
    expect(entries.length).toBe(87);
    expect(new Set(entries.map(([, glyph]) => glyph)).size).toBe(85);
    expect(ICONS.deny).toBe(ICONS.dismiss);
    expect(ICONS.settings).toBe(ICONS.filter);
  });

  test("the two deprecated aliases point at canonical exports", () => {
    // `more-horizontal` and `bar-chart-3` still resolve in 0.460, but only
    // through aliases lucide has deprecated. Mapping to the canonical exports
    // is what stops a future lucide major silently blanking two icons.
    expect(ICONS.more).toBe(lucide.Ellipsis);
    expect(ICONS.health).toBe(lucide.ChartColumn);
    expect(lucide.Ellipsis).not.toBe(lucide.ChartColumn);
  });
});
