import { describe, expect, test } from "bun:test";

import { detectCandidates } from "../src/classification/index";

// The deterministic half of D42: what the text plainly contains, with the
// span it occupies. Samples are in the Odysseus world.

const COMPARISON = `Two ways home, and neither is free.

| | Ithaca | Pylos | Sparta |
|---|---|---|---|
| Days at sea | 0 | 4 | 6 |
| Host | Penelope | Nestor | Menelaus |

Pick Ithaca if the crew will hold.`;

describe("detectCandidates", () => {
  test("prose alone yields nothing, so no call is made", () => {
    expect(detectCandidates("Sing to me of the man, Muse.\n\nHe wandered.")).toEqual([]);
    expect(detectCandidates("")).toEqual([]);
    expect(detectCandidates("   \n")).toEqual([]);
  });

  test("a GFM table becomes a table candidate whose span cuts the text cleanly", () => {
    const [table] = detectCandidates(COMPARISON);
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.id).toBe("c0");
    expect(table.headers).toEqual(["", "Ithaca", "Pylos", "Sparta"]);
    expect(table.rows).toEqual([
      ["Days at sea", "0", "4", "6"],
      ["Host", "Penelope", "Nestor", "Menelaus"],
    ]);
    const cut = COMPARISON.slice(table.start, table.end);
    expect(cut.startsWith("| | Ithaca")).toBe(true);
    expect(cut.endsWith("| Menelaus |")).toBe(true);
    expect(COMPARISON.slice(table.end).trim().startsWith("Pick Ithaca")).toBe(true);
  });

  test("a ragged row is padded to the header width, as GFM renders it", () => {
    const [table] = detectCandidates("| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.rows).toEqual([["1", ""], ["2", "3"]]);
  });

  test("a table with a link in a cell stays markdown: the kit's cells hold strings", () => {
    expect(
      detectCandidates("| a | b |\n|---|---|\n| [x](https://example.test) | 1 |")
    ).toEqual([]);
    expect(detectCandidates("| a | b |\n|---|---|\n| `code` | 1 |")).toEqual([]);
  });

  test("an ordered list keeps the first paragraph as title and the rest as detail", () => {
    const text = "1. String the bow\n\n   Only Odysseus can.\n\n2. Shoot through the axes\n3. Reveal yourself";
    const [list] = detectCandidates(text);
    expect(list?.kind).toBe("ordered_list");
    if (list?.kind !== "ordered_list") return;
    expect(list.items).toEqual([
      { title: "String the bow", detail: "Only Odysseus can." },
      { title: "Shoot through the axes" },
      { title: "Reveal yourself" },
    ]);
  });

  test("a task list carries its checks", () => {
    const [list] = detectCandidates("1. [x] Bow strung\n2. [ ] Axes lined up");
    if (list?.kind !== "ordered_list") throw new Error("expected ordered_list");
    expect(list.items).toEqual([
      { title: "Bow strung", checked: true },
      { title: "Axes lined up", checked: false },
    ]);
  });

  test("a single-item list is not a candidate", () => {
    expect(detectCandidates("1. Alone")).toEqual([]);
  });

  test("a bullet list whose items open with times is a timed list", () => {
    const [list] = detectCandidates(
      "- 09:40 — Sail from Aeolia\n- 18:15 Open the bag\n- Tue 12 · Wash up on Aeaea"
    );
    expect(list?.kind).toBe("timed_list");
    if (list?.kind !== "timed_list") return;
    expect(list.items).toEqual([
      { time: "09:40", title: "Sail from Aeolia" },
      { time: "18:15", title: "Open the bag" },
      { time: "Tue 12", title: "Wash up on Aeaea" },
    ]);
  });

  test("a bullet list without times at the head is not a timed list", () => {
    expect(detectCandidates("- Sail from Aeolia at 09:40\n- Open the bag")).toEqual([]);
  });

  test("a blockquote is a quote candidate, and a trailing attribution joins its span", () => {
    const text = "> Sing to me of the man, Muse.\n\n— Homer, Odyssey, Book 1\n\nThat is the opening.";
    const [quote] = detectCandidates(text);
    expect(quote?.kind).toBe("blockquote");
    if (quote?.kind !== "blockquote") return;
    expect(quote.text).toBe("Sing to me of the man, Muse.");
    expect(quote.source).toBe("Homer, Odyssey, Book 1");
    expect(text.slice(quote.start, quote.end).endsWith("Book 1")).toBe(true);
    expect(text.slice(quote.end).trim()).toBe("That is the opening.");
  });

  test("a blockquote with no attribution keeps its own span", () => {
    const text = "> Do not touch the cattle.\n\nThe crew had sworn.";
    const [quote] = detectCandidates(text);
    if (quote?.kind !== "blockquote") throw new Error("expected blockquote");
    expect(quote.source).toBeUndefined();
    expect(text.slice(quote.end).trim()).toBe("The crew had sworn.");
  });

  test("a run of bold key lines is a key-value candidate; so is a bullet list of them", () => {
    const paragraph = "**Ships:** 12\n**Crew:** 600\n**Days at sea:** 9";
    const [run] = detectCandidates(paragraph);
    expect(run?.kind).toBe("kv_run");
    if (run?.kind !== "kv_run") return;
    expect(run.rows).toEqual([
      { k: "Ships", v: "12" },
      { k: "Crew", v: "600" },
      { k: "Days at sea", v: "9" },
    ]);

    const list = "- **Ships**: 12\n- Crew: 600";
    const [fromList] = detectCandidates(list);
    expect(fromList?.kind).toBe("kv_run");
    if (fromList?.kind !== "kv_run") return;
    expect(fromList.rows).toEqual([
      { k: "Ships", v: "12" },
      { k: "Crew", v: "600" },
    ]);
  });

  test("one key line is prose, not a run", () => {
    expect(detectCandidates("**Ships:** 12")).toEqual([]);
  });

  test("candidates keep document order and stable ids", () => {
    const text = `${COMPARISON}\n\n1. Go\n2. Stay\n\n> Words.\n`;
    const kinds = detectCandidates(text).map((c) => [c.id, c.kind]);
    expect(kinds).toEqual([
      ["c0", "table"],
      ["c1", "ordered_list"],
      ["c2", "blockquote"],
    ]);
  });
});
