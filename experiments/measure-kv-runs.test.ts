/**
 * The `kv_run` columns of `scripts/measure-show-block.ts`, asserted (#208).
 *
 * The report reads the gap between runs written and candidates detected, so
 * each column has to count what it names and nothing else. The reply set is
 * the three cases the issue names: a run whose address flattens, which the
 * detector keeps; a run with a labelled link, which it rejects; and a run with
 * no address at all.
 */

import { describe, expect, test } from "bun:test";

import { countKvRuns, kvRunColumns, kvRunRows } from "../scripts/measure-kv-runs.ts";

const FLATTENS = "- **Email:** odysseus@example.com\n- **Web:** https://example.com/odysseus";
const LABELLED = "**Web:** [Odysseus's page](https://example.com/odysseus)\n**Role:** King of Ithaca";
const NONE = "Name: Odysseus\nRole: King of Ithaca";

describe("the kv_run columns", () => {
  test("a run whose address flattens is written, carries an address, and is detected", () => {
    expect(kvRunColumns([FLATTENS])).toEqual({ written: 1, withAddress: 1, detected: 1 });
  });

  test("a run with a labelled link is written and carries an address, but is not detected", () => {
    expect(kvRunColumns([LABELLED])).toEqual({ written: 1, withAddress: 1, detected: 0 });
  });

  test("a run with no address is written and detected, and carries none", () => {
    expect(kvRunColumns([NONE])).toEqual({ written: 1, withAddress: 0, detected: 1 });
  });

  test("the three together sum column by column", () => {
    const columns = kvRunColumns([[FLATTENS, LABELLED, NONE].join("\n\n")]);
    expect(columns).toEqual({ written: 3, withAddress: 2, detected: 2 });
  });

  test("the report prints each column from the turns it is given", () => {
    const turns = [kvRunColumns([FLATTENS]), kvRunColumns([LABELLED]), kvRunColumns([NONE])];
    // Non-empty by construction, so a row of zeros cannot pass.
    expect(turns.every((turn) => turn.written > 0)).toBe(true);
    const rows = kvRunRows([
      { label: "brief", turns },
      { label: "no-brief", turns: [] },
    ]);
    expect(rows[0]).toContain("kv-shaped runs written");
    expect(rows[0]).toContain("carrying an address");
    expect(rows[0]).toContain("`kv_run` candidates detected");
    expect(rows[2]).toBe("| brief | 3 | 3 | 2 | 2 |");
    expect(rows[3]).toBe("| no-brief | 0 | 0 | 0 | 0 |");
  });
});

describe("the shape count", () => {
  test("does not count prose, a single line, or a run with one prose line in it", () => {
    expect(countKvRuns("Odysseus is a king of Ithaca.\nHe studies navigation.").written).toBe(0);
    expect(countKvRuns("**Email:** odysseus@example.com").written).toBe(0);
    expect(countKvRuns("**Email:** odysseus@example.com\nwrite any time").written).toBe(0);
  });

  test("does not count an ordered list, which is steps, not a run", () => {
    expect(countKvRuns("1. **Email:** odysseus@example.com\n2. **Role:** King of Ithaca").written).toBe(0);
  });

  test("does not count a run inside a fenced code block, which draws nothing", () => {
    expect(countKvRuns("```\nName: Odysseus\nRole: King of Ithaca\n```").written).toBe(0);
  });

  test("counts a run with an image or inline HTML the detector would reject", () => {
    expect(countKvRuns("**Photo:** ![Odysseus](https://example.com/a.png)\n**Role:** King of Ithaca")).toEqual({
      written: 1,
      withAddress: 1,
    });
    expect(countKvRuns("**Note:** <b>bold</b>\n**Role:** King of Ithaca")).toEqual({ written: 1, withAddress: 0 });
  });

  test("counts GFM's www. form and a mailto link as addresses", () => {
    expect(countKvRuns("**Web:** www.example.com\n**Role:** King of Ithaca").withAddress).toBe(1);
    expect(countKvRuns("**Email:** [write](mailto:odysseus@example.com)\n**Role:** King of Ithaca").withAddress).toBe(1);
  });

  test("counts per part, never over the join", () => {
    // Joined, the two lines become one paragraph and one run; the reader saw
    // two single lines, which are not runs.
    expect(countKvRuns("Name: Odysseus", "Role: King of Ithaca").written).toBe(0);
    expect(countKvRuns("Name: Odysseus\nRole: King of Ithaca").written).toBe(1);
  });
});
