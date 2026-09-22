/**
 * The classification catalogue (D42 §6): what is asked of each candidate
 * kind, and how the answers become a `Block`.
 *
 * Each row names the questions the classifier is asked about one candidate
 * of that kind — always a `choice` or a `noul` over things the surface can
 * name from the text, never a request to count, compare, or produce a
 * string — and a transform from candidate plus answers to one of D41's
 * blocks, or null when the answers say to leave the markdown alone. The
 * request to the classifier is GENERATED from this table, so a new kind is
 * one row plus its detector, the same move D3 made for tool briefs.
 *
 * Every transform's output is re-validated against `BLOCK_SCHEMA` before it
 * leaves this module: a block the kit cannot draw is a null, and the
 * markdown stays.
 *
 * The rows between them reach nine of D41's eleven block kinds
 * (`CATALOGUE_BLOCK_KINDS`). The two they leave, `trend` and `bars`, are the
 * two whose payload is numbers rather than the answer's own strings, and
 * deriving those from prose is not a judgment the classifier is asked to
 * make — D45.
 */

import {
  BLOCK_SCHEMA,
  BLOCK_CONTACT_KINDS,
  BLOCK_QUOTE_TONES,
  BLOCK_VALUE_TONES,
  type Block,
} from "../tool-contracts/blocks.js";
import type {
  BlockquoteCandidate,
  Candidate,
  CandidateKind,
  KeyValueRunCandidate,
  OrderedListCandidate,
  TableCandidate,
  TimedListCandidate,
} from "./detect.js";

// ---------------------------------------------------------------------------
// Questions and answers, in the classifier's own shape
// ---------------------------------------------------------------------------

/** A `choice` question: one option from a defined set, each described. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** A `noul` question: is this statement true, as a 0–1. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export type ClassificationQuestion = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type ClassificationAnswer = ChoiceAnswer | NoulAnswer;

/** Answers keyed by question id, as the classifier returns them. */
export type ClassificationAnswers = Record<string, ClassificationAnswer>;

/**
 * Where to act. A swap needs the primary choice at or above `swap`; a tone,
 * which colours a reader's judgment, needs more; a noul counts as true at
 * `noul`. Measured on the transcript corpus, not assumed — the classifier
 * calibrates the probabilities, these say where the surface acts on them.
 */
export const CONFIDENCE = Object.freeze({ swap: 0.6, tone: 0.8, noul: 0.7 });

/**
 * Which of `CONFIDENCE`'s lines each question's answer has to clear, by the
 * suffix the catalogue gives that question. The transforms read their figure
 * from here rather than naming one inline, so a recorded confidence can be
 * reported next to the line it was actually compared against and the two
 * cannot drift apart.
 */
export const QUESTION_THRESHOLD = Object.freeze({
  shape: CONFIDENCE.swap,
  variant: CONFIDENCE.swap,
  recommended: CONFIDENCE.tone,
  tone: CONFIDENCE.tone,
  criteria_first: CONFIDENCE.noul,
});

/**
 * The line the answer to one question id (`p0c0.shape`) has to clear, or
 * undefined for a suffix the catalogue does not ask about.
 */
export function thresholdFor(questionId: string): number | undefined {
  const suffix = questionId.slice(questionId.lastIndexOf(".") + 1);
  return (QUESTION_THRESHOLD as Record<string, number | undefined>)[suffix];
}

/** What a transform yields: the block, and the confidence the swap rests on. */
export interface Classified {
  block: Block;
  confidence: number;
}

function choiceAt(
  answers: ClassificationAnswers,
  id: string,
  threshold: number
): { choice: string; confidence: number } | null {
  const answer = answers[id];
  if (!answer || answer.type !== "choice") return null;
  if (!(answer.confidence >= threshold)) return null;
  return { choice: answer.choice, confidence: answer.confidence };
}

function noulAt(answers: ClassificationAnswers, id: string, threshold: number): boolean {
  const answer = answers[id];
  return !!answer && answer.type === "noul" && answer.noul >= threshold;
}

/** The kit-drawable block, or null — the schema is the final judge. */
function validated(block: unknown, confidence: number): Classified | null {
  const parsed = BLOCK_SCHEMA.safeParse(block);
  return parsed.success ? { block: parsed.data, confidence } : null;
}

const NUMERIC = /^[-+−]?\s?[$€£]?\s?\d[\d,.\s]*(?:%|[a-zA-Z]{0,3})?$/;
const isNumeric = (value: string): boolean => value.trim() !== "" && NUMERIC.test(value.trim());

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

interface CatalogueRow<C extends Candidate> {
  /**
   * The block kinds this row's transform can return, in the order it tries
   * them. D42's decision 6 is the route list and the code drifted from it
   * unnoticed (#132); this is what `CATALOGUE_BLOCK_KINDS` is built from, so
   * a route that appears or disappears moves a tested set.
   */
  produces: ReadonlyArray<Block["kind"]>;
  /** The questions for one candidate; keys are suffixes under the candidate id. */
  questions(candidate: C): Record<string, ClassificationQuestion>;
  transform(candidate: C, answers: ClassificationAnswers): Classified | null;
}

const table: CatalogueRow<TableCandidate> = {
  produces: ["comparison", "table"],
  questions(candidate) {
    const headerOptions: Record<string, string> = { none: "No column is presented as the recommended one." };
    for (const header of candidate.headers.slice(1)) {
      if (header && !(header in headerOptions)) {
        headerOptions[header] = `The column "${header}" is the option the text recommends.`;
      }
    }
    return {
      shape: {
        type: "choice",
        instructions: `Consider the table in \`${candidate.id}\` (headers and rows). Which kind of table is it?`,
        criteria: {
          comparison:
            "The columns are alternatives the reader is choosing between, and each row is one criterion compared across them. The first column holds the criteria names.",
          data: "The rows are records, one per row, and the columns are fields of those records.",
          plain: "Neither: a layout device, a schedule, or a table that mixes both readings.",
        },
      },
      recommended: {
        type: "choice",
        instructions: `In \`${candidate.id}\`, does the text single out one column as recommended or preferred? Answer only from what is written.`,
        criteria: headerOptions,
      },
      criteria_first: {
        type: "noul",
        instructions: `In \`${candidate.id}\`, the first column's cells name criteria or attributes rather than data values.`,
      },
    };
  },
  transform(candidate, answers) {
    const shape = choiceAt(answers, `${candidate.id}.shape`, QUESTION_THRESHOLD.shape);
    if (!shape) return null;
    if (shape.choice === "comparison") {
      const options = candidate.headers.slice(1);
      if (options.length < 2 || options.length > 4 || candidate.rows.length === 0) return null;
      if (!noulAt(answers, `${candidate.id}.criteria_first`, QUESTION_THRESHOLD.criteria_first)) return null;
      const recommended = choiceAt(answers, `${candidate.id}.recommended`, QUESTION_THRESHOLD.recommended);
      const columns = options.map((label) => ({
        label,
        ...(recommended && recommended.choice !== "none" && recommended.choice === label
          ? { recommended: true }
          : {}),
      }));
      const rows = candidate.rows.map((row) => ({ label: row[0] ?? "", cells: row.slice(1) }));
      const corner = candidate.headers[0];
      return validated(
        { kind: "comparison", columns, rows, ...(corner ? { corner } : {}) },
        shape.confidence
      );
    }
    if (shape.choice === "data") {
      if (candidate.headers.length > 6 || candidate.rows.length === 0) return null;
      const numericColumn = candidate.headers.map((_, i) =>
        candidate.rows.every((row) => isNumeric(row[i] ?? "") || (row[i] ?? "") === "")
      );
      const columns = candidate.headers.map((label, i) => ({
        label,
        ...(candidate.align[i] === "right" || numericColumn[i] ? { align: "right" as const } : {}),
      }));
      const rows = candidate.rows.map((row) => ({
        cells: row.map((v, i) => ({ v, ...(numericColumn[i] && v ? { mono: true } : {}) })),
      }));
      return validated({ kind: "table", columns, rows }, shape.confidence);
    }
    return null;
  },
};

const orderedList: CatalogueRow<OrderedListCandidate> = {
  produces: ["steps"],
  questions(candidate) {
    return {
      shape: {
        type: "choice",
        instructions: `Consider the numbered list in \`${candidate.id}\`. What is it?`,
        criteria: {
          steps: "A procedure: things to do in order, a recipe, a checklist, or work being carried out stage by stage.",
          plain: "Not a procedure: a ranking, a list of reasons or examples, or an enumeration with no action in it.",
        },
      },
      variant: {
        type: "choice",
        instructions: `If \`${candidate.id}\` is a procedure, which kind?`,
        criteria: {
          numbered: "Instructions the reader follows in order.",
          checklist: "Independent things to tick off; order does not matter.",
          progress: "Stages of work being done for the reader, some done, one in progress, the rest to come.",
        },
      },
    };
  },
  transform(candidate, answers) {
    const shape = choiceAt(answers, `${candidate.id}.shape`, QUESTION_THRESHOLD.shape);
    if (!shape || shape.choice !== "steps") return null;
    const hasChecks = candidate.items.some((item) => typeof item.checked === "boolean");
    const variant = hasChecks
      ? "checklist"
      : (choiceAt(answers, `${candidate.id}.variant`, QUESTION_THRESHOLD.variant)?.choice ?? "numbered");
    const steps = candidate.items.map((item) => ({
      title: item.title,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(typeof item.checked === "boolean" ? { state: item.checked ? "done" : "todo" } : {}),
    }));
    return validated({ kind: "steps", variant, steps }, shape.confidence);
  },
};

const timedList: CatalogueRow<TimedListCandidate> = {
  produces: ["timeline", "schedule"],
  questions(candidate) {
    return {
      shape: {
        type: "choice",
        instructions: `Consider the list in \`${candidate.id}\`, whose items each open with a time. What is it?`,
        criteria: {
          timeline: "Events that already happened, in the order they happened.",
          schedule: "Things still to come: appointments, departures, a plan for the day.",
          plain: "Neither: the times are labels or data, not a sequence of events.",
        },
      },
    };
  },
  transform(candidate, answers) {
    const shape = choiceAt(answers, `${candidate.id}.shape`, QUESTION_THRESHOLD.shape);
    if (!shape) return null;
    if (shape.choice === "timeline") {
      const items = candidate.items.map((item) => ({
        time: item.time,
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
      }));
      return validated({ kind: "timeline", items }, shape.confidence);
    }
    if (shape.choice === "schedule") {
      // One group: the list carries times, not days. A day-grouped schedule
      // needs a detector that reads headings, which is a later row.
      const items = candidate.items.map((item) => ({
        time: item.time,
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
      }));
      return validated({ kind: "schedule", groups: [{ day: "Coming up", items }] }, shape.confidence);
    }
    return null;
  },
};

const blockquote: CatalogueRow<BlockquoteCandidate> = {
  produces: ["quote"],
  questions(candidate) {
    return {
      shape: {
        type: "choice",
        instructions: `Consider the quoted passage in \`${candidate.id}\`. Why is it quoted?`,
        criteria: {
          quote: "It reproduces someone's actual words, a passage from a document, or a cited line — the words themselves are the evidence.",
          plain: "It is an aside, a callout, a note, or emphasis by the writer, not a citation.",
        },
      },
      tone: {
        type: "choice",
        instructions: `If \`${candidate.id}\` is a citation, what is its provenance?`,
        criteria: {
          teal: "The reader's own notes or a source they trust.",
          amber: "A source that needs checking, or words the reader should act on.",
          purple: "An external or untrusted origin: the web, a third party, a forwarded message.",
          blue: "A company, an institution, or an official document.",
          neutral: "Unremarkable provenance, or not stated.",
        },
      },
    };
  },
  transform(candidate, answers) {
    const shape = choiceAt(answers, `${candidate.id}.shape`, QUESTION_THRESHOLD.shape);
    if (!shape || shape.choice !== "quote") return null;
    const tone = choiceAt(answers, `${candidate.id}.tone`, QUESTION_THRESHOLD.tone);
    const quoteTone =
      tone && (BLOCK_QUOTE_TONES as readonly string[]).includes(tone.choice) ? tone.choice : undefined;
    return validated(
      {
        kind: "quote",
        quote: candidate.text,
        ...(candidate.source ? { source: candidate.source } : {}),
        ...(quoteTone ? { tone: quoteTone } : {}),
      },
      shape.confidence
    );
  },
};

/**
 * A run short enough to read as one card. Past it the run is a record dump: a
 * colour on every line is noise, it is not stat tiles, and it is not a contact
 * either — a card is a name and a handful of facts. It also keeps both
 * question counts bounded by the run's shape rather than the text's length,
 * which matters because the `subject` question offers one option per line and
 * the classifier takes at most 255 (D42), and one oversized question would
 * fail the request for every candidate batched into it.
 */
const CARD_ROWS_MAX = 8;

/** The `subject` answer that means no line of the run holds the name. */
const NO_SUBJECT = "none";

/**
 * The tones a value can be given, each named by what the text says rather than
 * by its colour, plus `none` for "leave it alone". `none` is the fall-through
 * and `neutral` is deliberately not offered: in this kit `neutral` is the grey
 * machine-meta accent and means that everywhere, not "default" — a value that
 * wants the default says nothing, and every tone lookup falls back on its own
 * (`packages/ui-kit/src/types.ts`, design-feedback §4).
 */
const VALUE_TONE_CRITERIA: Record<string, string> = {
  teal: "It reports something that went well, is finished, or is healthy.",
  amber: "It reports something that wants attention: pending, overdue, a warning.",
  red: "It reports a failure, an error, or an outcome the reader would not want.",
  dim: "There is no value: none, unset, not applicable, unknown.",
  none: "A plain fact with no good or bad reading. Most values are this.",
};

/** The tone for one row's value, or undefined to leave the kit's default. */
function valueToneAt(
  candidate: KeyValueRunCandidate,
  answers: ClassificationAnswers,
  index: number
): string | undefined {
  const answer = choiceAt(answers, `${candidate.id}.value_tone_${index}`, CONFIDENCE.tone);
  // Honour only an option the question offered, then only one the kit draws —
  // which is what drops the `none` fall-through.
  if (!answer || !Object.prototype.hasOwnProperty.call(VALUE_TONE_CRITERIA, answer.choice)) {
    return undefined;
  }
  return (BLOCK_VALUE_TONES as readonly string[]).includes(answer.choice) ? answer.choice : undefined;
}

const kvRun: CatalogueRow<KeyValueRunCandidate> = {
  produces: ["receipt", "stats", "contact"],
  questions(candidate) {
    // The contact questions and the tones are both card-sized: a run longer
    // than one is asked neither, and the transform refuses it the same way
    // rather than relying on the answers being absent.
    const cardSized = candidate.rows.length <= CARD_ROWS_MAX;
    const perCard: Record<string, ClassificationQuestion> = {};
    if (cardSized) {
      // Which line holds the name, asked over the keys the run actually has —
      // the same move the table's `recommended` question makes over its
      // headers. A contact needs a label, and a label the text does not carry
      // is one the surface would be inventing.
      const subjectOptions: Record<string, string> = {
        [NO_SUBJECT]: "No line names it: the lines are facts about something the run does not name.",
      };
      for (const row of candidate.rows) {
        // `in` would also see `toString` and the rest of Object.prototype, and
        // a key the run really has would then go unoffered while the transform
        // below still accepted it. The keys come from model output.
        if (row.k && !Object.prototype.hasOwnProperty.call(subjectOptions, row.k)) {
          subjectOptions[row.k] = `The line "${row.k}" holds the name.`;
        }
      }
      perCard.subject = {
        type: "choice",
        instructions: `If \`${candidate.id}\` describes one person, company or project, which line holds its name?`,
        criteria: subjectOptions,
      };
      perCard.contact_kind = {
        type: "choice",
        instructions: `If \`${candidate.id}\` describes one person, company or project, which of the three is it?`,
        criteria: {
          person: "A human being.",
          company: "An organisation, a business, an institution.",
          project: "A piece of work, a product, a repository, an effort.",
        },
      };
      candidate.rows.forEach((row, index) => {
        perCard[`value_tone_${index}`] = {
          type: "choice",
          instructions: `In \`${candidate.id}\`, how does the text read the value on the "${row.k}" line? Answer only from what is written.`,
          criteria: VALUE_TONE_CRITERIA,
        };
      });
    }
    return {
      shape: {
        type: "choice",
        instructions: `Consider the key-and-value lines in \`${candidate.id}\`. What are they?`,
        criteria: {
          receipt: "A record of what was done or what something is: settings, outcomes, facts about one thing, each key naming a field.",
          stats: "Headline figures: every value is a number or a measurement the reader would scan as a dashboard.",
          contact: "Facts about one person, company or project — who they are, how to reach them, what they are to the reader.",
          plain: "None of those: definitions, a glossary, or prose that happens to use colons.",
        },
      },
      ...perCard,
    };
  },
  transform(candidate, answers) {
    const shape = choiceAt(answers, `${candidate.id}.shape`, QUESTION_THRESHOLD.shape);
    if (!shape) return null;
    const tones = candidate.rows.map((_, index) => valueToneAt(candidate, answers, index));
    const toned = (index: number) => (tones[index] ? { tone: tones[index] } : {});
    if (shape.choice === "receipt") {
      const rows = candidate.rows.map((row, index) => ({ ...row, ...toned(index) }));
      return validated({ kind: "receipt", rows }, shape.confidence);
    }
    if (shape.choice === "stats") {
      if (candidate.rows.length > CARD_ROWS_MAX || !candidate.rows.every((row) => isNumeric(row.v))) {
        return null;
      }
      const tiles = candidate.rows.map((row, index) => ({
        label: row.k,
        value: row.v,
        ...toned(index),
      }));
      return validated({ kind: "stats", tiles }, shape.confidence);
    }
    if (shape.choice === "contact") {
      if (candidate.rows.length > CARD_ROWS_MAX) return null;
      const subject = choiceAt(answers, `${candidate.id}.subject`, CONFIDENCE.swap);
      // The sentinel wins over a line that happens to be keyed "none": that
      // line is never offered as an option, so the answer cannot mean it.
      if (!subject || subject.choice === NO_SUBJECT) return null;
      // A key the run does not carry: no label, so no card.
      const named = candidate.rows.findIndex((row) => row.k === subject.choice);
      if (named < 0) return null;
      // A value that was nothing but a code span strips to empty. A card with
      // no name on it is worse than the markdown it would replace.
      const label = candidate.rows[named]!.v.trim();
      if (!label) return null;
      const facts = candidate.rows.flatMap((row, index) =>
        index === named ? [] : [{ k: row.k, v: row.v, ...toned(index) }]
      );
      const contactKind = choiceAt(answers, `${candidate.id}.contact_kind`, CONFIDENCE.swap);
      return validated(
        {
          kind: "contact",
          label,
          ...(contactKind && (BLOCK_CONTACT_KINDS as readonly string[]).includes(contactKind.choice)
            ? { contactKind: contactKind.choice }
            : {}),
          ...(facts.length ? { facts } : {}),
        },
        shape.confidence
      );
    }
    return null;
  },
};

const CATALOGUE: { [K in CandidateKind]: CatalogueRow<Extract<Candidate, { kind: K }>> } = {
  table,
  ordered_list: orderedList,
  timed_list: timedList,
  blockquote,
  kv_run: kvRun,
};

/** The candidate kinds the catalogue knows, in a stable order. */
export const CANDIDATE_KINDS = Object.keys(CATALOGUE) as CandidateKind[];

/**
 * Every block kind the pass can draw, in catalogue order. The rest of
 * D41's union is the tool's alone.
 */
export const CATALOGUE_BLOCK_KINDS: ReadonlyArray<Block["kind"]> = Object.freeze([
  ...new Set(Object.values(CATALOGUE).flatMap((row) => row.produces)),
]);

/** The questions for one candidate, keyed `${id}.${suffix}`. */
export function questionsFor(candidate: Candidate): Record<string, ClassificationQuestion> {
  const row = CATALOGUE[candidate.kind] as CatalogueRow<Candidate>;
  const out: Record<string, ClassificationQuestion> = {};
  for (const [suffix, question] of Object.entries(row.questions(candidate))) {
    out[`${candidate.id}.${suffix}`] = question;
  }
  return out;
}

/** The block one candidate becomes under these answers, or null to leave it. */
export function transformCandidate(
  candidate: Candidate,
  answers: ClassificationAnswers
): Classified | null {
  const row = CATALOGUE[candidate.kind] as CatalogueRow<Candidate>;
  return row.transform(candidate, answers);
}
