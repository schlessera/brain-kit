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
    expect(detectCandidates("| a | b |\n|---|---|\n| ![x](a.png) | 1 |")).toEqual([]);
  });

  test("a code span or emphasis in a cell flattens to its text and the candidate stands", () => {
    const [table] = detectCandidates("| a | b |\n|---|---|\n| `bun run` | **1** |");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.rows).toEqual([["bun run", "1"]]);
    const [run] = detectCandidates("- **Startup**: ~10ms\n- **TypeScript**: runs `.ts` natively");
    expect(run?.kind).toBe("kv_run");
    if (run?.kind !== "kv_run") return;
    expect(run.rows[1]).toEqual({ k: "TypeScript", v: "runs .ts natively" });
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

  test("a single-item list is not a candidate, nor is a list continuing from a later number", () => {
    expect(detectCandidates("1. Alone")).toEqual([]);
    expect(detectCandidates("5. Fifth\n6. Sixth")).toEqual([]);
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

  test("a list item holding a quote, a heading or a definition is not a candidate: the block would be lost", () => {
    // Without the block, each list is a candidate, so the rejection below is
    // about the block and nothing else.
    expect(detectCandidates("1. Sail\n\n2. Return\n")[0]?.kind).toBe("ordered_list");
    expect(detectCandidates("- 09:00 Sail\n\n- 10:00 Return\n")[0]?.kind).toBe("timed_list");
    const blocks = ["> the Sirens sing", "## Aside", "[chart]: https://example.com/chart"];
    for (const block of blocks) {
      expect(detectCandidates(`1. Sail\n\n   ${block}\n\n2. Return\n`)).toEqual([]);
      expect(detectCandidates(`- 09:00 Sail\n\n  ${block}\n\n- 10:00 Return\n`)).toEqual([]);
    }
  });

  test("a hard break keeps the words on either side apart", () => {
    for (const hardBreak of ["  \n", "\\\n"]) {
      const [quote] = detectCandidates(`> Sail${hardBreak}> home\n`);
      if (quote?.kind !== "blockquote") throw new Error("expected blockquote");
      expect(quote.text).toBe("Sail home");

      const [steps] = detectCandidates(`1. Sail${hardBreak}   home\n2. Return\n`);
      if (steps?.kind !== "ordered_list") throw new Error("expected ordered_list");
      expect(steps.items[0]).toEqual({ title: "Sail home" });

      const [times] = detectCandidates(`- 09:00 Sail${hardBreak}  home\n- 10:00 Return\n`);
      if (times?.kind !== "timed_list") throw new Error("expected timed_list");
      expect(times.items[0]).toEqual({ time: "09:00", title: "Sail home" });
    }
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

  test("a value reads as its markup decodes, as the same text does in a quote", () => {
    const value = "**600** oars &amp; \\*sails\\* &#58; `spare`";
    const [quote] = detectCandidates(`> ${value}`);
    if (quote?.kind !== "blockquote") throw new Error("expected blockquote");
    expect(quote.text).toBe("600 oars & *sails* : spare");

    for (const text of [
      `**Ships:** 12\n**Crew:** ${value}`,
      `**Ships:** 12\n**Crew**: ${value}`,
      `**Ships:** 12\nCrew: ${value}`,
      `- **Ships:** 12\n- **Crew:** ${value}`,
    ]) {
      const [run] = detectCandidates(text);
      if (run?.kind !== "kv_run") throw new Error(`no kv_run for ${JSON.stringify(text)}`);
      expect(run.rows).toEqual([
        { k: "Ships", v: "12" },
        { k: "Crew", v: quote.text },
      ]);
    }
  });

  test("a value that opens like a block still reads as the text after its key", () => {
    const [run] = detectCandidates("**Rank:** #1\n**Step:** 1. Row\n**Rule:** ---\n**Ref:** [a]: b\n**Aside:** > far");
    if (run?.kind !== "kv_run") throw new Error("expected kv_run");
    expect(run.rows.map((row) => row.v)).toEqual(["#1", "1. Row", "---", "[a]: b", "> far"]);
  });

  test("a hard break ending a key line is not part of its value", () => {
    const [run] = detectCandidates("**Ships:** 12\\\n**Crew:** 600\\\\\n**Days at sea:** 9");
    if (run?.kind !== "kv_run") throw new Error("expected kv_run");
    // The first line ends in a break; the second in an escaped backslash.
    expect(run.rows.map((row) => row.v)).toEqual(["12", "600\\", "9"]);
  });

  test("a value that starts or ends inside a flattened address keeps the part of it that is on the value's side", () => {
    const rows = (text: string) => {
      const [run] = detectCandidates(text);
      if (run?.kind !== "kv_run") throw new Error(`no kv_run for ${JSON.stringify(text)}`);
      return run.rows;
    };
    // The trailing space is inside the address, so trimming the line ends the
    // value inside it.
    const site = "[https://ithaca.example/ ](<https://ithaca.example/ >)";
    expect(rows(`**Name:** Odysseus\n**Site:** ${site}`)[1]).toEqual({ k: "Site", v: "https://ithaca.example/" });
    expect(rows(`- **Name:** Odysseus\n- **Site:** ${site}`)[1]).toEqual({ k: "Site", v: "https://ithaca.example/" });
    expect(rows(`**Name:** Odysseus\n**Site:** go ${site}`)[1]).toEqual({ k: "Site", v: "go https://ithaca.example/" });
    // The key is inside the address, so the value starts inside it.
    expect(rows("[Key: value](<Key: value>)\nShips: 12")).toEqual([
      { k: "Key", v: "value" },
      { k: "Ships", v: "12" },
    ]);
  });

  test("markup that spans a line or the key keeps no delimiters in a value", () => {
    const values = (text: string) => {
      const [run] = detectCandidates(text);
      if (run?.kind !== "kv_run") throw new Error(`no kv_run for ${JSON.stringify(text)}`);
      return run.rows.map((row) => row.v);
    };
    expect(values("Crew: `600\nShips: 12`")).toEqual(["600", "12"]);
    expect(values("Crew: **600\nShips: 12**")).toEqual(["600", "12"]);
    expect(values("Crew *count: 600*\nShips: 12")).toEqual(["600", "12"]);
    expect(values("- Crew *count: 600*\n- Ships: 12")).toEqual(["600", "12"]);
  });

  test("one key line is prose, not a run", () => {
    expect(detectCandidates("**Ships:** 12")).toEqual([]);
  });

  test("a run of facts about one person is a key-value candidate, and a bare address on it reads as the address", () => {
    const [run] = detectCandidates("**Name:** Odysseus\n**Role:** King of Ithaca\n**Last seen:** Ogygia");
    expect(run?.kind).toBe("kv_run");
    if (run?.kind !== "kv_run") return;
    expect(run.rows[0]).toEqual({ k: "Name", v: "Odysseus" });

    // GFM autolinks a bare address. Its text is its own destination, so it
    // flattens with nothing lost and the run stays a candidate (#167).
    const [contact] = detectCandidates("**Name:** Odysseus\n**Herald:** eurybates@ithaca.example");
    expect(contact?.kind).toBe("kv_run");
    if (contact?.kind !== "kv_run") return;
    expect(contact.rows).toEqual([
      { k: "Name", v: "Odysseus" },
      { k: "Herald", v: "eurybates@ithaca.example" },
    ]);
  });

  test("every way of writing a bare address becomes the same plain value; a mailto: target reads as the bare address", () => {
    const valueOf = (line: string) => {
      const [run] = detectCandidates(`**Name:** Odysseus\n${line}`);
      if (run?.kind !== "kv_run") throw new Error(`no kv_run for ${JSON.stringify(line)}`);
      return run.rows[1]!.v;
    };
    expect(valueOf("**Herald:** eurybates@ithaca.example")).toBe("eurybates@ithaca.example");
    expect(valueOf("**Herald:** <eurybates@ithaca.example>")).toBe("eurybates@ithaca.example");
    expect(valueOf("**Herald:** <mailto:eurybates@ithaca.example>")).toBe("eurybates@ithaca.example");
    expect(valueOf("**Herald:** mailto:eurybates@ithaca.example")).toBe("eurybates@ithaca.example");
    expect(valueOf("**Herald:** [eurybates@ithaca.example](mailto:eurybates@ithaca.example)")).toBe(
      "eurybates@ithaca.example"
    );
    // The scheme is matched in the source: an escaped or entity-encoded one is
    // the author's text, not a scheme, so it stays, and reads decoded as any
    // other text in a value does (#236).
    expect(valueOf("**Herald:** mailto&#58;eurybates@ithaca.example")).toBe("mailto:eurybates@ithaca.example");
    expect(valueOf("**Herald:** mailto\\:eurybates@ithaca.example")).toBe("mailto:eurybates@ithaca.example");
    expect(valueOf("**Site:** https://ithaca.example/palace")).toBe("https://ithaca.example/palace");
    expect(valueOf("**Site:** <https://ithaca.example/palace>")).toBe("https://ithaca.example/palace");
    expect(valueOf("**Site:** see https://ithaca.example/palace first")).toBe("see https://ithaca.example/palace first");
    // `mailto:` is a scheme only as a word of its own: the tail of another
    // word is the author's text and stays.
    expect(valueOf("**Herald:** notmailto:eurybates@ithaca.example")).toBe("notmailto:eurybates@ithaca.example");
    expect(valueOf("**Herald:** (mailto:eurybates@ithaca.example)")).toBe("(eurybates@ithaca.example)");
    const [quote] = detectCandidates("> **not**mailto:eurybates@ithaca.example");
    expect(quote?.kind === "blockquote" && quote.text).toBe("notmailto:eurybates@ithaca.example");
    const [first] = detectCandidates("> mailto:eurybates@ithaca.example");
    expect(first?.kind === "blockquote" && first.text).toBe("eurybates@ithaca.example");
    // What decides it is the character the reader sees before the scheme,
    // across inline nodes: an earlier `mailto:` in the same text does not
    // license a later one, a word inside emphasis still counts, and code or
    // a line break before it is a boundary like any punctuation.
    const quoted = (text: string) => {
      const [q] = detectCandidates(text);
      return q?.kind === "blockquote" ? q.text : null;
    };
    expect(quoted("> mailto: notmailto:eurybates@ithaca.example")).toBe("mailto: notmailto:eurybates@ithaca.example");
    expect(quoted("> mailto:\n> notmailto:eurybates@ithaca.example")).toBe("mailto: notmailto:eurybates@ithaca.example");
    expect(quoted("> not**mailto:eurybates@ithaca.example**")).toBe("notmailto:eurybates@ithaca.example");
    expect(quoted("> `(`mailto:eurybates@ithaca.example")).toBe("(eurybates@ithaca.example");
    expect(quoted("> `not`mailto:eurybates@ithaca.example")).toBe("notmailto:eurybates@ithaca.example");
    // A letter outside the Basic Multilingual Plane is still one letter.
    expect(quoted("> \u{1D49C}mailto:eurybates@ithaca.example")).toBe("\u{1D49C}mailto:eurybates@ithaca.example");
    // So it is when it arrives from another node: emphasis, a code span, or
    // a flattened address.
    expect(quoted("> **\u{1D49C}**mailto:eurybates@ithaca.example")).toBe("\u{1D49C}mailto:eurybates@ithaca.example");
    expect(quoted("> `\u{1D49C}`mailto:eurybates@ithaca.example")).toBe("\u{1D49C}mailto:eurybates@ithaca.example");
    expect(
      quoted("> [https://ithaca.example/\u{1D49C}](https://ithaca.example/\u{1D49C})**mailto:eurybates@ithaca.example**")
    ).toBe("https://ithaca.example/\u{1D49C}mailto:eurybates@ithaca.example");
    // A flattened address before it counts by its own last character.
    expect(quoted("> [a@ithaca.example](mailto:a@ithaca.example)**mailto:eurybates@ithaca.example**")).toBe(
      "a@ithaca.examplemailto:eurybates@ithaca.example"
    );
    expect(quoted("> [https://ithaca.example/](https://ithaca.example/)**mailto:eurybates@ithaca.example**")).toBe(
      "https://ithaca.example/eurybates@ithaca.example"
    );
    // (A hard break reads as a space, so the address keeps its own word.)
    expect(quoted("> Write to\\\n> mailto:eurybates@ithaca.example")).not.toContain("mailto:");
    // A bullet list of key lines reads its values the same way.
    const [list] = detectCandidates("- **Name:** Odysseus\n- **Herald:** <eurybates@ithaca.example>");
    if (list?.kind !== "kv_run") throw new Error("expected kv_run");
    expect(list.rows[1]).toEqual({ k: "Herald", v: "eurybates@ithaca.example" });
  });

  test("a link that would lose something when flattened still keeps the run out of the pass", () => {
    const run = (line: string) => detectCandidates(`**Name:** Odysseus\n${line}`);
    // A labelled link loses its destination.
    expect(run("**Herald:** [Eurybates](mailto:eurybates@ithaca.example)")).toEqual([]);
    expect(run("**Site:** [the palace](https://ithaca.example/palace)")).toEqual([]);
    // A title would be dropped, and so would an image inside the link.
    expect(run('**Site:** [https://ithaca.example](https://ithaca.example "The palace")')).toEqual([]);
    expect(run("**Site:** [![https://ithaca.example](https://ithaca.example/a.png)](https://ithaca.example)")).toEqual([]);
    expect(
      run("**Site:** [![https://ithaca.example][pic]](https://ithaca.example)\n\n[pic]: https://ithaca.example/a.png")
    ).toEqual([]);
    // A backtick in an address is still refused, though its reason, a run
    // stripping backticks, is gone (#236); whether to admit it is #330.
    expect(run("**Herald:** <eury`bates@ithaca.example>")).toEqual([]);
    // A reference-style link, image or footnote loses its target just as an
    // inline one does, and an address beside it must not let it through
    // (#220): before #167 the address kept the run out, now nothing else did.
    expect(run("**Site:** [the palace][p] or eurybates@ithaca.example\n\n[p]: https://ithaca.example/palace")).toEqual([]);
    expect(run("**Crest:** ![the owl][owl] eurybates@ithaca.example\n\n[owl]: https://ithaca.example/owl.png")).toEqual([]);
    expect(run("**Herald:** eurybates@ithaca.example[^n]\n\n[^n]: Only by day.")).toEqual([]);
    // GFM links `www.` to `http://www.`: the text is not the destination, so
    // by the rule it is not a bare address (#167's ruling is text = target).
    expect(run("**Site:** www.ithaca.example")).toEqual([]);
  });

  test("a bare address flattens in every candidate kind, not only a key-value run", () => {
    const [table] = detectCandidates("| Who | Reach |\n|---|---|\n| Eurybates | <eurybates@ithaca.example> |");
    if (table?.kind !== "table") throw new Error("expected table");
    expect(table.rows).toEqual([["Eurybates", "eurybates@ithaca.example"]]);

    const [steps] = detectCandidates("1. Write to eurybates@ithaca.example\n2. Read https://ithaca.example/palace");
    if (steps?.kind !== "ordered_list") throw new Error("expected ordered_list");
    expect(steps.items).toEqual([
      { title: "Write to eurybates@ithaca.example" },
      { title: "Read https://ithaca.example/palace" },
    ]);

    const [quote] = detectCandidates("> Send word to <mailto:eurybates@ithaca.example>.");
    if (quote?.kind !== "blockquote") throw new Error("expected blockquote");
    expect(quote.text).toBe("Send word to eurybates@ithaca.example.");

    expect(
      detectCandidates("> Write [the docs][ref] and eurybates@ithaca.example\n\n[ref]: https://ithaca.example")
    ).toEqual([]);
    // And a labelled link still rejects there too.
    expect(detectCandidates("| Who | Reach |\n|---|---|\n| Eurybates | [write](mailto:eurybates@ithaca.example) |")).toEqual([]);
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
