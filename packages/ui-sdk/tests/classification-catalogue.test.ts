import { describe, expect, test } from "bun:test";

import {
  BLOCK_SCHEMA,
} from "../src/tool-contracts/index";
import {
  CANDIDATE_KINDS,
  CONFIDENCE,
  applyClassification,
  detectCandidates,
  planClassification,
  questionsFor,
  transformCandidate,
  type ClassificationAnswers,
} from "../src/classification/index";

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
});

describe("planning and applying one pass", () => {
  test("no candidates, no plan", () => {
    expect(planClassification(["Only prose.", "More prose."])).toBeNull();
    expect(planClassification([])).toBeNull();
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
