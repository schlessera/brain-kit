import { describe, expect, test } from "bun:test";

import {
  BLOCK_KINDS,
  BLOCK_SCHEMA,
} from "../src/tool-contracts/index";
import {
  CANDIDATE_KINDS,
  CATALOGUE_BLOCK_KINDS,
  CONFIDENCE,
  applyClassification,
  detectCandidates,
  observeClassification,
  planClassification,
  questionsFor,
  thresholdOf,
  transformCandidate,
  type ClassificationAnswers,
} from "../src/classification/index";

const CONTACT_RUN = "**Name:** Odysseus\n**Role:** King of Ithaca\n**Last seen:** Ogygia";

const COMPARISON = `| | Ithaca | Pylos |
|---|---|---|
| Days at sea | 0 | 4 |
| Host | Penelope | Nestor |`;

const choice = (choice: string, confidence: number) => ({
  type: "choice" as const,
  choice,
  probabilities: { [choice]: confidence },
  confidence,
});
const noul = (value: number) => ({ type: "noul" as const, noul: value });

describe("the catalogue", () => {
  test("every candidate kind has questions, and every question is a choice or a noul", () => {
    const samples = [
      COMPARISON,
      "1. Go\n2. Stay",
      "- 09:40 Sail\n- 18:00 Land",
      "> Words.",
      "**Ships:** 12\n**Crew:** 600",
    ];
    const seen = new Set<string>();
    for (const sample of samples) {
      for (const candidate of detectCandidates(sample)) {
        seen.add(candidate.kind);
        const questions = questionsFor(candidate);
        expect(Object.keys(questions).length).toBeGreaterThan(0);
        for (const [id, question] of Object.entries(questions)) {
          expect(id.startsWith(`${candidate.id}.`)).toBe(true);
          expect(["choice", "noul"]).toContain(question.type);
          // The classifier is told which state key to look at, never the
          // whole answer.
          expect(question.instructions).toContain(`\`${candidate.id}\``);
          if (question.type === "choice") {
            expect(Object.keys(question.criteria).length).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...CANDIDATE_KINDS].sort());
  });

  test("a table the classifier calls a comparison becomes a comparison block", () => {
    const [table] = detectCandidates(COMPARISON);
    const answers: ClassificationAnswers = {
      "c0.shape": choice("comparison", 0.91),
      "c0.recommended": choice("Ithaca", 0.85),
      "c0.criteria_first": noul(0.95),
    };
    const result = transformCandidate(table!, answers);
    expect(result?.confidence).toBe(0.91);
    expect(result?.block).toEqual({
      kind: "comparison",
      columns: [{ label: "Ithaca", recommended: true }, { label: "Pylos" }],
      rows: [
        { label: "Days at sea", cells: ["0", "4"] },
        { label: "Host", cells: ["Penelope", "Nestor"] },
      ],
    });
    expect(BLOCK_SCHEMA.safeParse(result?.block).success).toBe(true);
  });

  test("a recommendation below the tone threshold is not drawn", () => {
    const [table] = detectCandidates(COMPARISON);
    const result = transformCandidate(table!, {
      "c0.shape": choice("comparison", 0.9),
      "c0.recommended": choice("Ithaca", 0.5),
      "c0.criteria_first": noul(0.9),
    });
    expect(result?.block).toMatchObject({
      columns: [{ label: "Ithaca" }, { label: "Pylos" }],
    });
    expect(JSON.stringify(result?.block)).not.toContain("recommended");
  });

  test("a comparison whose first column is not criteria stays markdown", () => {
    const [table] = detectCandidates(COMPARISON);
    expect(
      transformCandidate(table!, {
        "c0.shape": choice("comparison", 0.9),
        "c0.criteria_first": noul(0.2),
      })
    ).toBeNull();
  });

  test("a table the classifier calls data becomes a data table with numeric columns right-aligned and mono", () => {
    const [table] = detectCandidates("| Island | Nights |\n|---|---|\n| Aeaea | 365 |\n| Ogygia | 2555 |");
    const result = transformCandidate(table!, { "c0.shape": choice("data", 0.8) });
    expect(result?.block).toEqual({
      kind: "table",
      columns: [{ label: "Island" }, { label: "Nights", align: "right" }],
      rows: [
        { cells: [{ v: "Aeaea" }, { v: "365", mono: true }] },
        { cells: [{ v: "Ogygia" }, { v: "2555", mono: true }] },
      ],
    });
  });

  test("below the swap threshold, or 'plain', nothing is drawn", () => {
    const [table] = detectCandidates(COMPARISON);
    expect(transformCandidate(table!, { "c0.shape": choice("comparison", CONFIDENCE.swap - 0.01), "c0.criteria_first": noul(1) })).toBeNull();
    expect(transformCandidate(table!, { "c0.shape": choice("plain", 0.99) })).toBeNull();
    expect(transformCandidate(table!, {})).toBeNull();
  });

  test("a comparison with five options is more than the kit draws, so it stays markdown", () => {
    const [table] = detectCandidates("| | a | b | c | d | e |\n|---|---|---|---|---|---|\n| r | 1 | 2 | 3 | 4 | 5 |");
    expect(
      transformCandidate(table!, { "c0.shape": choice("comparison", 0.9), "c0.criteria_first": noul(1) })
    ).toBeNull();
  });

  /** A GFM table with `options` columns after the corner, every header distinct. */
  const wideTable = (options: number) => {
    const headers = ["", ...Array.from({ length: options }, (_, i) => `Ship ${i + 1}`)];
    const row = ["Oars", ...Array.from({ length: options }, (_, i) => String(i + 1))];
    return [headers, headers.map(() => "---"), row].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
  };

  test("no question asked of a table carries more than the classifier's 255 options, however wide the table", () => {
    // One over-limit question fails the request for every candidate in the
    // message, not only this table's.
    for (const options of [1, 4, 5, 254, 255, 256, 300]) {
      const [table] = detectCandidates(wideTable(options));
      expect(table?.kind).toBe("table");
      for (const [id, question] of Object.entries(questionsFor(table!))) {
        if (question.type !== "choice") continue;
        const count = Object.keys(question.criteria).length;
        if (count > 255) throw new Error(`${options}-option table: ${id} offers ${count} options`);
      }
    }
  });

  test("the `recommended` question is asked only of a table narrow enough to be drawn as a comparison", () => {
    const [narrow] = detectCandidates(wideTable(4));
    expect(Object.keys(questionsFor(narrow!))).toEqual(["c0.shape", "c0.recommended", "c0.criteria_first"]);
    const [wide] = detectCandidates(wideTable(5));
    expect(Object.keys(questionsFor(wide!))).toEqual(["c0.shape", "c0.criteria_first"]);
  });

  test("at the bound, a comparison is drawn and its recommended column marked", () => {
    const [widest] = detectCandidates(wideTable(4));
    const result = transformCandidate(widest!, {
      "c0.shape": choice("comparison", 0.9),
      "c0.recommended": choice("Ship 4", 0.9),
      "c0.criteria_first": noul(1),
    });
    expect(result?.block.kind).toBe("comparison");
    // Whole, so a column marked that the answer did not name fails too.
    expect(result?.block.kind === "comparison" && result.block.columns).toEqual([
      { label: "Ship 1" },
      { label: "Ship 2" },
      { label: "Ship 3" },
      { label: "Ship 4", recommended: true },
    ]);
  });

  test("a column named after something on Object.prototype is offered and can be marked recommended", () => {
    // Headers are model output. `in` also sees `constructor` and the rest of
    // Object.prototype, and assigning `__proto__` on a plain object sets its
    // prototype instead of a key, so both went unoffered.
    for (const header of ["constructor", "__proto__"]) {
      const [table] = detectCandidates(
        `| | ${header.replaceAll("_", "\\_")} | Pylos |\n|---|---|---|\n| Days at sea | 0 | 4 |\n| Host | Penelope | Nestor |`
      );
      const recommended = questionsFor(table!)["c0.recommended"];
      expect(recommended?.type).toBe("choice");
      if (recommended?.type !== "choice") return;
      expect(Object.keys(recommended.criteria)).toEqual(["none", header, "Pylos"]);
      const result = transformCandidate(table!, {
        "c0.shape": choice("comparison", 0.9),
        "c0.recommended": choice(header, 0.9),
        "c0.criteria_first": noul(1),
      });
      expect(result?.block.kind === "comparison" && result.block.columns).toEqual([
        { label: header, recommended: true },
        { label: "Pylos" },
      ]);
    }
  });

  test("above the bound, a comparison stays markdown and a data table is drawn with no column recommended", () => {
    const [wide] = detectCandidates(wideTable(5));
    // A recommendation the classifier was never asked for is not honoured
    // either: a comparison this wide is refused whatever the answers say.
    expect(
      transformCandidate(wide!, {
        "c0.shape": choice("comparison", 0.9),
        "c0.recommended": choice("Ship 1", 0.95),
        "c0.criteria_first": noul(1),
      })
    ).toBeNull();
    const data = transformCandidate(wide!, { "c0.shape": choice("data", 0.9) });
    expect(data?.block.kind).toBe("table");
    expect(JSON.stringify(data?.block)).not.toContain("recommended");
    // Past the data table's own six columns nothing is drawn at all.
    const [wider] = detectCandidates(wideTable(6));
    expect(transformCandidate(wider!, { "c0.shape": choice("data", 0.9) })).toBeNull();
    expect(
      transformCandidate(wider!, { "c0.shape": choice("comparison", 0.9), "c0.criteria_first": noul(1) })
    ).toBeNull();
  });

  test("an ordered list becomes steps; checks force the checklist variant", () => {
    const [plain] = detectCandidates("1. String the bow\n2. Shoot");
    expect(
      transformCandidate(plain!, { "c0.shape": choice("steps", 0.8), "c0.variant": choice("progress", 0.7) })?.block
    ).toEqual({ kind: "steps", variant: "progress", steps: [{ title: "String the bow" }, { title: "Shoot" }] });

    const [checked] = detectCandidates("1. [x] Bow strung\n2. [ ] Axes lined up");
    expect(
      transformCandidate(checked!, { "c0.shape": choice("steps", 0.8), "c0.variant": choice("numbered", 0.9) })?.block
    ).toEqual({
      kind: "steps",
      variant: "checklist",
      steps: [{ title: "Bow strung", state: "done" }, { title: "Axes lined up", state: "todo" }],
    });
    expect(transformCandidate(plain!, { "c0.shape": choice("plain", 0.9) })).toBeNull();
  });

  test("a timed list becomes a timeline or a one-group schedule", () => {
    const [list] = detectCandidates("- 09:40 Sail from Aeolia\n- 18:15 Open the bag");
    expect(transformCandidate(list!, { "c0.shape": choice("timeline", 0.8) })?.block).toEqual({
      kind: "timeline",
      items: [{ time: "09:40", title: "Sail from Aeolia" }, { time: "18:15", title: "Open the bag" }],
    });
    expect(transformCandidate(list!, { "c0.shape": choice("schedule", 0.8) })?.block).toEqual({
      kind: "schedule",
      groups: [{ day: "Coming up", items: [{ time: "09:40", title: "Sail from Aeolia" }, { time: "18:15", title: "Open the bag" }] }],
    });
  });

  test("a blockquote becomes a quote with its attribution; the tone needs the higher bar", () => {
    const [quote] = detectCandidates("> Sing to me of the man, Muse.\n\n— Homer");
    expect(
      transformCandidate(quote!, { "c0.shape": choice("quote", 0.9), "c0.tone": choice("purple", 0.9) })?.block
    ).toEqual({ kind: "quote", quote: "Sing to me of the man, Muse.", source: "Homer", tone: "purple" });
    expect(
      transformCandidate(quote!, { "c0.shape": choice("quote", 0.9), "c0.tone": choice("purple", 0.6) })?.block
    ).toEqual({ kind: "quote", quote: "Sing to me of the man, Muse.", source: "Homer" });
    expect(transformCandidate(quote!, { "c0.shape": choice("plain", 0.9) })).toBeNull();
  });

  test("a key-value run becomes a receipt, or stat tiles when every value is a figure", () => {
    const [run] = detectCandidates("**Ships:** 12\n**Crew:** 600");
    expect(transformCandidate(run!, { "c0.shape": choice("receipt", 0.8) })?.block).toEqual({
      kind: "receipt",
      rows: [{ k: "Ships", v: "12" }, { k: "Crew", v: "600" }],
    });
    expect(transformCandidate(run!, { "c0.shape": choice("stats", 0.8) })?.block).toEqual({
      kind: "stats",
      tiles: [{ label: "Ships", value: "12" }, { label: "Crew", value: "600" }],
    });
    const [words] = detectCandidates("**Host:** Penelope\n**Port:** Ithaca");
    expect(transformCandidate(words!, { "c0.shape": choice("stats", 0.9) })).toBeNull();
  });

  test("a key-value run the classifier calls a contact becomes a contact card, the named row its label", () => {
    const [run] = detectCandidates(CONTACT_RUN);
    const result = transformCandidate(run!, {
      "c0.shape": choice("contact", 0.88),
      "c0.subject": choice("Name", 0.93),
      "c0.contact_kind": choice("person", 0.9),
    });
    expect(result?.confidence).toBe(0.88);
    expect(result?.block).toEqual({
      kind: "contact",
      label: "Odysseus",
      contactKind: "person",
      facts: [
        { k: "Role", v: "King of Ithaca" },
        { k: "Last seen", v: "Ogygia" },
      ],
    });
    expect(BLOCK_SCHEMA.safeParse(result?.block).success).toBe(true);
  });

  test("a contact whose run carries a bare address draws the address as a plain fact", () => {
    // #167: the address flattens to its text, and a `mailto:` target to the
    // bare address, so the card shows exactly what the reader would type.
    const [run] = detectCandidates(
      "**Name:** Odysseus\n**Herald:** <mailto:eurybates@ithaca.example>\n**Site:** https://ithaca.example/palace"
    );
    const result = transformCandidate(run!, {
      "c0.shape": choice("contact", 0.88),
      "c0.subject": choice("Name", 0.93),
      "c0.contact_kind": choice("person", 0.9),
    });
    expect(result?.block).toEqual({
      kind: "contact",
      label: "Odysseus",
      contactKind: "person",
      facts: [
        { k: "Herald", v: "eurybates@ithaca.example" },
        { k: "Site", v: "https://ithaca.example/palace" },
      ],
    });
  });

  test("a contact the run does not name stays markdown, and so does a run the classifier calls plain", () => {
    const [run] = detectCandidates("**Role:** King of Ithaca\n**Last seen:** Ogygia");
    // The run is about someone, but no line carries the name; a label the
    // text does not hold is one the surface would have to invent.
    expect(
      transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice("none", 0.95) })
    ).toBeNull();
    expect(
      transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice("Role", CONFIDENCE.swap - 0.01) })
    ).toBeNull();
    expect(transformCandidate(run!, { "c0.shape": choice("contact", 0.9) })).toBeNull();
    expect(transformCandidate(run!, { "c0.shape": choice("plain", 0.95) })).toBeNull();
  });

  test("a line keyed `none` does not become a label, because it was never offered as one", () => {
    const [run] = detectCandidates("**none:** Nobody\n**Role:** King of Ithaca");
    // `none` is the answer for "no line names it", and it is the only meaning
    // available: the line keyed `none` is not among the options the question
    // lists, so an answer of `none` cannot be pointing at it.
    const options = questionsFor(run!)["c0.subject"];
    expect(options?.type).toBe("choice");
    if (options?.type !== "choice") return;
    expect(Object.keys(options.criteria)).toEqual(["none", "Role"]);
    expect(
      transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice("none", 0.95) })
    ).toBeNull();
  });

  test("a key that also names something on Object.prototype is still offered", () => {
    // The run's keys are model output, and `toString` or `constructor` would
    // be masked by a plain `in` check, and `__proto__` by assigning it:
    // unoffered by the question, accepted by the transform.
    for (const key of ["toString", "__proto__"]) {
      const [run] = detectCandidates(`**${key}:** Odysseus\n**Role:** King of Ithaca`);
      const subject = questionsFor(run!)["c0.subject"];
      expect(subject?.type).toBe("choice");
      if (subject?.type !== "choice") return;
      expect(Object.keys(subject.criteria)).toEqual(["none", key, "Role"]);
      expect(
        transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice(key, 0.9) })?.block
      ).toMatchObject({ kind: "contact", label: "Odysseus" });
    }
  });

  test("a name that strips to nothing is no name, so the markdown stays", () => {
    // A value that was only a code span survives detection as an empty
    // string; `label` is a plain string in the schema, so a blank card would
    // otherwise validate.
    const [run] = detectCandidates("**Name:** `` \n**Role:** King of Ithaca");
    expect((run as { rows: Array<{ k: string; v: string }> }).rows[0]).toEqual({ k: "Name", v: "" });
    expect(
      transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice("Name", 0.95) })
    ).toBeNull();
  });

  test("when two lines share a key, the first is the name and the second stays a fact", () => {
    const [run] = detectCandidates("**Name:** Odysseus\n**Name:** Nobody\n**Role:** King of Ithaca");
    expect(
      transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice("Name", 0.95) })?.block
    ).toEqual({
      kind: "contact",
      label: "Odysseus",
      facts: [{ k: "Name", v: "Nobody" }, { k: "Role", v: "King of Ithaca" }],
    });
  });

  test("a contact kind the block schema does not carry is dropped, not passed on", () => {
    const [run] = detectCandidates(CONTACT_RUN);
    const result = transformCandidate(run!, {
      "c0.shape": choice("contact", 0.9),
      "c0.subject": choice("Name", 0.9),
      "c0.contact_kind": choice("deity", 0.95),
    });
    expect(result?.block).toEqual({
      kind: "contact",
      label: "Odysseus",
      facts: [{ k: "Role", v: "King of Ithaca" }, { k: "Last seen", v: "Ogygia" }],
    });
  });

  test("a value tone colours the row it was asked about, on a receipt and on a contact's facts", () => {
    const [run] = detectCandidates("**Ships:** 12\n**Crew:** lost");
    expect(
      transformCandidate(run!, {
        "c0.shape": choice("receipt", 0.9),
        "c0.value_tone_0": choice("none", 0.95),
        "c0.value_tone_1": choice("red", 0.9),
      })?.block
    ).toEqual({ kind: "receipt", rows: [{ k: "Ships", v: "12" }, { k: "Crew", v: "lost", tone: "red" }] });

    const [contact] = detectCandidates(CONTACT_RUN);
    expect(
      transformCandidate(contact!, {
        "c0.shape": choice("contact", 0.9),
        "c0.subject": choice("Name", 0.9),
        "c0.value_tone_2": choice("amber", 0.9),
      })?.block
    ).toEqual({
      kind: "contact",
      label: "Odysseus",
      facts: [{ k: "Role", v: "King of Ithaca" }, { k: "Last seen", v: "Ogygia", tone: "amber" }],
    });
  });

  test("a value tone below the tone bar is not drawn", () => {
    const [run] = detectCandidates("**Ships:** 12\n**Crew:** lost");
    expect(
      transformCandidate(run!, {
        "c0.shape": choice("receipt", 0.9),
        "c0.value_tone_1": choice("red", CONFIDENCE.tone - 0.01),
      })?.block
    ).toEqual({ kind: "receipt", rows: [{ k: "Ships", v: "12" }, { k: "Crew", v: "lost" }] });
  });

  test("the value-tone question does not offer `neutral`, and an answer it did not offer is ignored", () => {
    // In this kit `neutral` is the grey machine-meta accent, not "default" —
    // a value that wants the default carries no tone at all. An off-menu
    // answer, including one that happens to be a tone the schema accepts,
    // leaves the row alone rather than colouring it.
    const [run] = detectCandidates("**Ships:** 12\n**Crew:** lost");
    const question = questionsFor(run!)["c0.value_tone_1"];
    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") return;
    expect(Object.keys(question.criteria)).toEqual(["teal", "amber", "red", "dim", "none"]);
    expect(
      transformCandidate(run!, {
        "c0.shape": choice("receipt", 0.9),
        "c0.value_tone_1": choice("neutral", 0.99),
      })?.block
    ).toEqual({ kind: "receipt", rows: [{ k: "Ships", v: "12" }, { k: "Crew", v: "lost" }] });
  });

  test("a run longer than a card is asked only what shape it is, so the question count follows the shape, not the length", () => {
    // The `subject` question offers one option per line and the classifier
    // takes at most 255, and one oversized question fails the request for
    // every candidate batched into it — so the bound is not only editorial.
    const long = Array.from({ length: 9 }, (_, i) => `**Oar ${i + 1}:** shipped`).join("\n");
    const [run] = detectCandidates(long);
    expect(run?.kind).toBe("kv_run");
    expect(Object.keys(questionsFor(run!))).toEqual(["c0.shape"]);
    // And the transform refuses on its own, rather than relying on the
    // answers being absent.
    expect(
      transformCandidate(run!, { "c0.shape": choice("contact", 0.9), "c0.subject": choice("Oar 1", 0.95) })
    ).toBeNull();

    const [short] = detectCandidates(CONTACT_RUN);
    expect(Object.keys(questionsFor(short!))).toEqual([
      "c0.shape",
      "c0.subject",
      "c0.contact_kind",
      "c0.value_tone_0",
      "c0.value_tone_1",
      "c0.value_tone_2",
    ]);
  });
});

/*
 * D42's decision 6 lists the catalogue's routes, and nothing asserted that
 * the code still had them: two of the six were missing from the day the pass
 * shipped and were found by a reader, not a test (#132). This is that
 * assertion — the set of block kinds the transforms can produce, proved by
 * driving every one of them rather than by reading the table.
 */
/** Does this block variant's payload carry a number anywhere? Walks the schema. */
function carriesAFigure(kind: string): boolean {
  const variant = BLOCK_SCHEMA.options.find((option) => option.shape.kind.value === kind);
  const walk = (schema: unknown): boolean => {
    const def = (schema as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (!def) return false;
    if (def.type === "number") return true;
    if (def.innerType) return walk(def.innerType);
    if (def.element) return walk(def.element);
    if (def.shape) return Object.values(def.shape as Record<string, unknown>).some(walk);
    return false;
  };
  return !!variant && walk(variant);
}

describe("the kinds the catalogue can draw", () => {
  const DRIVEN: Array<{ text: string; answers: ClassificationAnswers }> = [
    {
      text: COMPARISON,
      answers: { "c0.shape": choice("comparison", 0.9), "c0.criteria_first": noul(0.9) },
    },
    {
      text: "| Island | Nights |\n|---|---|\n| Aeaea | 365 |",
      answers: { "c0.shape": choice("data", 0.9) },
    },
    { text: "1. Go\n2. Stay", answers: { "c0.shape": choice("steps", 0.9) } },
    {
      text: "- 09:40 Sail\n- 18:00 Land",
      answers: { "c0.shape": choice("timeline", 0.9) },
    },
    {
      text: "- 09:40 Sail\n- 18:00 Land",
      answers: { "c0.shape": choice("schedule", 0.9) },
    },
    { text: "> Words.", answers: { "c0.shape": choice("quote", 0.9) } },
    {
      text: "**Host:** Penelope\n**Port:** Ithaca",
      answers: { "c0.shape": choice("receipt", 0.9) },
    },
    {
      text: "**Ships:** 12\n**Crew:** 600",
      answers: { "c0.shape": choice("stats", 0.9) },
    },
    {
      text: CONTACT_RUN,
      answers: { "c0.shape": choice("contact", 0.9), "c0.subject": choice("Name", 0.9) },
    },
  ];

  test("every kind the rows declare is one a transform actually produces", () => {
    const drawn = new Set<string>();
    for (const { text, answers } of DRIVEN) {
      const [candidate] = detectCandidates(text);
      const classified = transformCandidate(candidate!, answers);
      expect(classified).not.toBeNull();
      drawn.add(classified!.block.kind);
    }
    expect([...drawn].sort()).toEqual([...CATALOGUE_BLOCK_KINDS].sort());
  });

  test("the pass draws the nine kinds a text can carry; `trend` and `bars` are the tool's alone", () => {
    expect([...CATALOGUE_BLOCK_KINDS]).toEqual([
      "comparison",
      "table",
      "steps",
      "timeline",
      "schedule",
      "quote",
      "receipt",
      "stats",
      "contact",
    ]);
    // The two the pass leaves are exactly the two whose payload is numbers
    // rather than the answer's own strings. That is D45's reason for not
    // routing them, so it is read off the schemas rather than listed here: a
    // twelfth variant carrying a figure has to be argued, not absorbed.
    const leftOver = BLOCK_KINDS.filter((kind) => !CATALOGUE_BLOCK_KINDS.includes(kind));
    expect(leftOver).toEqual(["trend", "bars"]);
    expect(leftOver).toEqual(BLOCK_KINDS.filter(carriesAFigure));
  });
});

describe("planning and applying one pass", () => {
  test("no candidates, no plan", () => {
    expect(planClassification(["Only prose.", "More prose."])).toBeNull();
    expect(planClassification([])).toBeNull();
  });

  test("the line a confidence has to clear never goes on the wire", () => {
    // Where the surface acts on a probability is the surface's business, not
    // the classifier's, and D42 §1 says the request carries only what the
    // classifier needs. The plan keeps the lines; the request is the same set
    // without them, and it is the request that leaves the machine.
    const plan = planClassification(["**Name:** Argos\n**Role:** Hound\n**Status:** waiting"])!;
    const asked = Object.keys(plan.request.questions);
    // A run short enough to be a card is asked its generated per-row tones
    // too, so this covers the generated ids and not only the named ones.
    expect(asked).toEqual([
      "p0c0.shape",
      "p0c0.subject",
      "p0c0.contact_kind",
      "p0c0.value_tone_0",
      "p0c0.value_tone_1",
      "p0c0.value_tone_2",
    ]);
    // Every question the plan kept has a line...
    for (const id of asked) expect(plan.questions[id]!.threshold).toBeTypeOf("number");
    // ...and not one of them reaches the body that is serialised and sent.
    for (const id of asked) {
      expect(plan.request.questions[id]).not.toHaveProperty("threshold");
    }
    expect(JSON.stringify(plan.request)).not.toContain("threshold");
    // The strip removes the line and nothing else: what the classifier is
    // asked is otherwise identical to what the catalogue declared.
    for (const id of asked) {
      const { threshold: _line, ...rest } = plan.questions[id]!;
      expect(plan.request.questions[id]).toEqual(rest);
    }
  });

  test("candidates across parts share one request, keyed per part; answers anchor back", () => {
    const parts = ["Before.\n\n" + COMPARISON + "\n\nAfter.", "Steps:\n\n1. Go\n2. Stay"];
    const plan = planClassification(parts);
    expect(plan).not.toBeNull();
    expect(Object.keys(plan!.request.state)).toEqual(["p0c0", "p1c0"]);
    expect(plan!.request.model).toBe("jev-latest");
    expect(Object.keys(plan!.request.questions)).toEqual([
      "p0c0.shape",
      "p0c0.recommended",
      "p0c0.criteria_first",
      "p1c0.shape",
      "p1c0.variant",
    ]);
    // Only the candidate reaches the state, never the surrounding prose.
    expect(JSON.stringify(plan!.request.state)).not.toContain("Before");

    const blocks = applyClassification(plan!, {
      "p0c0.shape": choice("comparison", 0.9),
      "p0c0.recommended": choice("none", 0.9),
      "p0c0.criteria_first": noul(0.9),
      "p1c0.shape": choice("plain", 0.9),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ partIndex: 0, confidence: 0.9, block: { kind: "comparison" } });
    expect(parts[0]!.slice(blocks[0]!.start, blocks[0]!.end)).toBe(COMPARISON);
  });
});

describe("what the classifier answered, for tuning the thresholds", () => {
  const SAMPLES = [
    COMPARISON,
    "1. Go\n2. Stay",
    "- 09:40 Sail\n- 18:00 Land",
    "> Words.",
    "**Ships:** 12\n**Crew:** 600",
  ];

  test("each question retains its pre-refactor threshold (#179)", () => {
    const expected: Record<string, Record<string, number>> = {
      table: { shape: 0.6, recommended: 0.8, criteria_first: 0.7 },
      ordered_list: { shape: 0.6, variant: 0.6 },
      timed_list: { shape: 0.6 },
      blockquote: { shape: 0.6, tone: 0.8 },
      kv_run: {
        shape: 0.6, subject: 0.6, contact_kind: 0.6,
        ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`value_tone_${i}`, 0.8])),
      },
    };
    const samples = [...SAMPLES.slice(0, -1), Array.from({ length: 8 }, (_, i) => `**Field ${i}:** ${i}`).join("\n")];
    const actual: Record<string, Record<string, number>> = {};
    for (const sample of samples) {
      for (const candidate of detectCandidates(sample)) {
        actual[candidate.kind] = Object.fromEntries(
          Object.entries(questionsFor(candidate)).map(([id, question]) => [id.slice(id.lastIndexOf(".") + 1), question.threshold])
        );
      }
    }
    expect(actual).toEqual(expected);
  });

  test("every question the catalogue asks declares its own line, generated ids included", () => {
    // A question with no line is recorded with `threshold: null` and
    // `cleared: false` whatever its answer was — a lie in the tuning table
    // about an answer the transform may well have acted on.
    const kindsSeen = new Set<string>();
    const idsSeen: string[] = [];
    for (const sample of SAMPLES) {
      for (const candidate of detectCandidates(sample)) {
        kindsSeen.add(candidate.kind);
        const questions = questionsFor(candidate);
        for (const id of Object.keys(questions)) {
          idsSeen.push(id);
          // No line names a figure of its own: they all come from CONFIDENCE.
          const threshold = thresholdOf(questions, id);
          expect(threshold).toBeTypeOf("number");
          expect(Object.values<number>(CONFIDENCE)).toContain(threshold!);
        }
      }
    }
    // The samples have to reach every row, or a kind's questions go unchecked
    // and the assertion above passes by not looking.
    expect([...kindsSeen].sort()).toEqual([...CANDIDATE_KINDS].sort());
    // And at least one id has to be GENERATED rather than named, because that
    // is the case a lookup keyed by question name cannot cover at all.
    expect(idsSeen.some((id) => /\.value_tone_\d+$/.test(id))).toBe(true);
  });

  test("a question nobody asked has no line, and no answer worth reading", () => {
    const [run] = detectCandidates("**Ships:** 12\n**Crew:** 600");
    const questions = questionsFor(run!);
    expect(thresholdOf(questions, "c0.value_tone_0")).toBe(CONFIDENCE.tone);
    // One past the run's rows: never asked, so never gated.
    expect(thresholdOf(questions, "c0.value_tone_2")).toBeUndefined();
    // And the transform will not act on an answer to it either.
    expect(
      transformCandidate(run!, {
        "c0.shape": choice("receipt", 0.9),
        "c0.value_tone_2": choice("red", 0.99),
      })?.block
    ).toEqual({ kind: "receipt", rows: [{ k: "Ships", v: "12" }, { k: "Crew", v: "600" }] });
  });

  test("a swap records every answer behind it, with the line each had to clear", () => {
    const plan = planClassification([COMPARISON])!;
    const answers: ClassificationAnswers = {
      "p0c0.shape": choice("comparison", 0.91),
      "p0c0.recommended": choice("Ithaca", 0.85),
      "p0c0.criteria_first": noul(0.95),
    };
    const blocks = applyClassification(plan, answers);
    expect(blocks).toHaveLength(1);
    expect(observeClassification(plan, answers, blocks)).toEqual([
      {
        candidateId: "p0c0",
        candidateKind: "table",
        question: "shape",
        answerType: "choice",
        choice: "comparison",
        confidence: 0.91,
        threshold: CONFIDENCE.swap,
        cleared: true,
        outcome: "swapped",
      },
      {
        candidateId: "p0c0",
        candidateKind: "table",
        question: "recommended",
        answerType: "choice",
        choice: "Ithaca",
        confidence: 0.85,
        threshold: CONFIDENCE.tone,
        cleared: true,
        outcome: "swapped",
      },
      {
        candidateId: "p0c0",
        candidateKind: "table",
        question: "criteria_first",
        answerType: "noul",
        confidence: 0.95,
        threshold: CONFIDENCE.noul,
        cleared: true,
        outcome: "swapped",
      },
    ]);
  });

  test("a candidate kept under the line records the number it fell short by", () => {
    const plan = planClassification([COMPARISON])!;
    const answers: ClassificationAnswers = {
      "p0c0.shape": choice("comparison", 0.58),
      "p0c0.criteria_first": noul(0.95),
    };
    const blocks = applyClassification(plan, answers);
    expect(blocks).toEqual([]);
    const observed = observeClassification(plan, answers, blocks);
    expect(observed.map((o) => [o.question, o.confidence, o.cleared, o.outcome])).toEqual([
      ["shape", 0.58, false, "kept"],
      ["criteria_first", 0.95, true, "kept"],
    ]);
  });

  test("a candidate kept at high confidence is distinguishable from one kept under the line", () => {
    const plan = planClassification([COMPARISON])!;
    const answers: ClassificationAnswers = { "p0c0.shape": choice("plain", 0.97) };
    const observed = observeClassification(plan, answers, applyClassification(plan, answers));
    // The markdown stayed, but not because the classifier was unsure.
    expect(observed).toMatchObject([{ choice: "plain", cleared: true, outcome: "kept" }]);
  });

  test("observations are per candidate, and an answer the plan did not ask for is ignored", () => {
    const plan = planClassification([COMPARISON, "1. Go\n2. Stay"])!;
    const answers: ClassificationAnswers = {
      "p0c0.shape": choice("comparison", 0.9),
      "p0c0.criteria_first": noul(0.9),
      "p1c0.shape": choice("steps", 0.7),
      // Not this plan's candidate at all.
      "p9c9.shape": choice("steps", 0.99),
      // This plan's candidate, but a question the catalogue never asks of an
      // ordered list. Recording it would put a figure in the distribution
      // that no transform ever compared against anything.
      "p1c0.tone": choice("teal", 0.99),
      // And an id that only looks like one of p0c0's, because `p0c0` is a
      // prefix of `p0c01`.
      "p0c01.shape": choice("comparison", 0.99),
    };
    const observed = observeClassification(plan, answers, applyClassification(plan, answers));
    expect(observed.map((o) => [o.candidateId, o.candidateKind, o.question, o.outcome])).toEqual([
      ["p0c0", "table", "shape", "swapped"],
      ["p0c0", "table", "criteria_first", "swapped"],
      ["p1c0", "ordered_list", "shape", "swapped"],
    ]);
  });

  test("a question the classifier left unanswered is simply absent", () => {
    const plan = planClassification([COMPARISON])!;
    // The catalogue asks three questions of a table; only two came back.
    const answers: ClassificationAnswers = {
      "p0c0.shape": choice("comparison", 0.9),
      "p0c0.criteria_first": noul(0.9),
    };
    const observed = observeClassification(plan, answers, applyClassification(plan, answers));
    expect(Object.keys(questionsFor(plan.candidates[0]!.candidate))).toHaveLength(3);
    expect(observed.map((o) => o.question)).toEqual(["shape", "criteria_first"]);
  });

  test("two candidates in one part are told apart by their own span", () => {
    const part = `${COMPARISON}\n\nAnd:\n\n1. Go\n2. Stay`;
    const plan = planClassification([part])!;
    const answers: ClassificationAnswers = {
      "p0c0.shape": choice("comparison", 0.9),
      "p0c0.criteria_first": noul(0.9),
      "p0c1.shape": choice("plain", 0.9),
    };
    const observed = observeClassification(plan, answers, applyClassification(plan, answers));
    expect(observed.map((o) => [o.candidateId, o.outcome])).toEqual([
      ["p0c0", "swapped"],
      ["p0c0", "swapped"],
      ["p0c1", "kept"],
    ]);
  });
});
