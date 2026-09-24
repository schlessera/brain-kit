/**
 * The tone-to-glyph maps (#309), pinned the way `icon-map.test.ts` pins the
 * icon map: every tone has an entry, the entry is the one the ruling names,
 * and every glyph key resolves to a real lucide export. A wrong key there
 * fails silently in the browser (an empty 11px box), which is why it is
 * asserted here rather than looked at.
 *
 * The three "no cue" rules are asserted as a whole set, not one at a time:
 * the value map is `null` for EXACTLY teal, blue, neutral, ink and dim. A
 * tick on every teal cell would bury the red ones; blue is a category the
 * text names; neutral prints as grey and grey is its meaning (D33); ink and
 * dim are inks.
 */
import { describe, expect, test } from "bun:test";
import * as lucide from "lucide-react";

import { ICONS } from "../src/primitives/Icon.js";
import { SCHEDULE_CUE, TIMELINE_CUE, VALUE_CUE } from "../src/internal/tone-cue.js";
import type { Tone, ValueTone } from "../src/types.js";

/** The two unions as runtime lists, in `types.ts` order. */
const TONES: readonly Tone[] = ["amber", "gold", "teal", "purple", "blue", "red", "neutral"];
const VALUE_TONES: readonly ValueTone[] = [...TONES, "ink", "dim"];

const cued = (map: Record<string, string | null>) =>
  Object.entries(map)
    .filter(([, key]) => key !== null)
    .map(([tone]) => tone)
    .sort();

describe("tone cues", () => {
  test("the value map covers every ValueTone, and only those", () => {
    expect(Object.keys(VALUE_CUE).sort()).toEqual([...VALUE_TONES].sort());
  });

  test("the timeline and schedule maps cover every Tone, and only those", () => {
    expect(Object.keys(TIMELINE_CUE).sort()).toEqual([...TONES].sort());
    expect(Object.keys(SCHEDULE_CUE).sort()).toEqual([...TONES].sort());
  });

  test("the value map is null for exactly teal, blue, neutral, ink and dim", () => {
    const silent = Object.entries(VALUE_CUE)
      .filter(([, key]) => key === null)
      .map(([tone]) => tone)
      .sort();
    expect(silent).toEqual(["blue", "dim", "ink", "neutral", "teal"]);
    // And the other four are cued, so the set above is not empty by omission.
    expect(cued(VALUE_CUE)).toEqual(["amber", "gold", "purple", "red"]);
  });

  test("the value glyphs are the ruling's: a triangle, a circle, a hand and a question mark", () => {
    expect(VALUE_CUE).toEqual({
      red: "failed",
      gold: "fyi",
      amber: "hand",
      purple: "unverified",
      teal: null,
      blue: null,
      neutral: null,
      ink: null,
      dim: null,
    });
    // Four distinct silhouettes, and none of them is the tick StepList draws
    // for done.
    const glyphs = Object.values(VALUE_CUE).filter((k): k is NonNullable<typeof k> => k !== null);
    expect(new Set(glyphs.map((k) => ICONS[k])).size).toBe(4);
    expect(glyphs).not.toContain("confirm");
  });

  test("the timeline map names the event kinds, and leaves noted and blue as dots", () => {
    expect(TIMELINE_CUE).toEqual({
      teal: "confirm",
      amber: "agent",
      red: "failed",
      purple: "unverified",
      gold: "fyi",
      blue: null,
      neutral: null,
    });
  });

  test("the schedule map names the claim on you, and agrees with the value map where the meanings agree", () => {
    expect(SCHEDULE_CUE).toEqual({
      red: "deadline",
      amber: "hand",
      teal: "agent",
      gold: "fyi",
      purple: "unverified",
      blue: null,
      neutral: null,
    });
    // The hand is "yours" in both; the question mark is "untrusted" in both.
    expect(SCHEDULE_CUE.amber).toBe(VALUE_CUE.amber);
    expect(SCHEDULE_CUE.purple).toBe(VALUE_CUE.purple);
  });

  test("every glyph key is in the icon map and resolves to a real lucide-react export", () => {
    const exported = new Set(Object.values(lucide as Record<string, unknown>));
    const keys = [VALUE_CUE, TIMELINE_CUE, SCHEDULE_CUE].flatMap((map) =>
      Object.values(map).filter((k): k is NonNullable<typeof k> => k !== null),
    );
    expect(keys.length).toBeGreaterThan(0);
    const unresolved = keys.filter((key) => !Object.hasOwn(ICONS, key) || !exported.has(ICONS[key]));
    expect(unresolved).toEqual([]);
  });
});
