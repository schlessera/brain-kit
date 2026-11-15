// The roadmap track each epic is mapped to in `scripts/sync-project.ts`.
// Membership only seeds one level down (an epic's direct sub-issues), so a
// nested epic is listed itself, under its ancestor's track, for its own
// children to inherit that track.

import { describe, expect, test } from "bun:test";
import { TRACKS } from "../scripts/sync-project.ts";

const KIT = "schlessera/brain-kit";

/** Every track that lists a reference, as an epic or a standalone issue. */
function tracksOf(repo: string, number: number): string[] {
  return Object.entries(TRACKS)
    .filter(([, groups]) =>
      groups.some((g) => g.repo === repo && (g.epics.includes(number) || g.also.includes(number))),
    )
    .map(([track]) => track);
}

describe("TRACKS", () => {
  test("no reference is mapped to two tracks, so the first match in trackFor is the only one", () => {
    const seen = new Map<string, string>();
    for (const [track, groups] of Object.entries(TRACKS)) {
      for (const group of groups) {
        for (const number of [...group.epics, ...group.also]) {
          const ref = `${group.repo}#${number}`;
          expect({ ref, track: seen.get(ref) ?? track }).toEqual({ ref, track });
          seen.set(ref, track);
        }
      }
    }
  });

  // #1722 and #3836: epics and standalone issues the mapping had dropped.
  const expected: [number, string][] = [
    [912, "Async collaboration"],
    [918, "Answer quality"],
    [1422, "Distribution"],
    [1779, "Reliability"],
    [1849, "Reliability"],
    [2963, "Reliability"],
    [1152, "Reliability"],
    [1365, "Reliability"],
    [1366, "Reliability"],
    [1375, "Contract and 1.0"],
    [3781, "Modules"],
    [3017, "Modules"],
    [3018, "Modules"],
    [3120, "Answer quality"],
    [3791, "Answer quality"],
    [3133, "Reliability"],
    // Nested epics, under their ancestor's track: #3428 sits under #1645
    // (Hardening) and holds #3596-#3598; #3690 sits under #54 (Voice).
    [3428, "Hardening"],
    [3596, "Hardening"],
    [3597, "Hardening"],
    [3598, "Hardening"],
    [3690, "Voice"],
  ];

  test.each(expected)("#%d is on the %s track", (number, track) => {
    expect(tracksOf(KIT, number)).toEqual([track]);
  });
});
