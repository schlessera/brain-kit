/**
 * `show_block` — the answer blocks, as one tool (D41).
 *
 * The kit draws a comparison table, stat tiles, a trend chart and ten more
 * blocks that belong INSIDE an answer, and until this contract nothing told
 * the model they existed. One tool with a discriminated union of blocks keeps
 * the system prompt to one paragraph and the contract count at five; the
 * per-block shape rules ride in the description, which the model reads once
 * per session rather than on every turn.
 *
 * The schemas mirror the kit's props field for field. The client's block
 * renderer is a switch typed by this payload that hands each variant to its
 * kit component, so a field the kit does not accept, or a kit prop the
 * schema does not carry, is a `tsc` error there. The tone unions below are
 * the kit's own sets; `packages/ui-react/tests/block-contract.test-d.ts`
 * asserts the equality in both directions, because the kit exports types and
 * the schema needs runtime lists, and the two can only drift silently.
 *
 * The tool has no side effect: the handler validates and echoes, so the
 * payload is the input, it needs no bridge, and both backends auto-allow it.
 * The root of the argument is an object, not the union itself, because the
 * Claude SDK's `tool()` takes a raw object shape; the union sits under
 * `block`.
 */

import { z } from "zod";

import { defineToolComponentContract } from "./contract.js";

// ---------------------------------------------------------------------------
// The kit's unions, as runtime lists
// ---------------------------------------------------------------------------

/** `Tone` in `@schlessera/brain-ui-kit`. */
export const BLOCK_TONES = [
  "amber",
  "gold",
  "teal",
  "purple",
  "blue",
  "red",
  "neutral",
] as const;

/** `ValueTone`: any accent, or one of the two inks. */
export const BLOCK_VALUE_TONES = [...BLOCK_TONES, "ink", "dim"] as const;

/** `DeltaTone`: the trend pill has two readings and no third. */
export const BLOCK_DELTA_TONES = ["teal", "red"] as const;

/** `StepListVariant`. */
export const BLOCK_STEP_VARIANTS = ["numbered", "checklist", "progress"] as const;

/** `StepState`. */
export const BLOCK_STEP_STATES = ["done", "current", "todo"] as const;

/** `QuoteTone`: provenance, not severity, so no red. */
export const BLOCK_QUOTE_TONES = ["teal", "amber", "purple", "blue", "neutral"] as const;

/** `ContactKind`. */
export const BLOCK_CONTACT_KINDS = ["person", "company", "project"] as const;

/** `ContactTone`: the entity colours. */
export const BLOCK_CONTACT_TONES = ["teal", "blue", "purple", "amber", "neutral"] as const;

const tone = z.enum(BLOCK_TONES);
const valueTone = z.enum(BLOCK_VALUE_TONES);
const deltaTone = z.enum(BLOCK_DELTA_TONES);

const toneDoc = "One of the kit's accents; omit for the default.";
const valueToneDoc =
  'One of the kit\'s accents, or "ink" (primary text) / "dim" (secondary text); omit for the default.';

/**
 * Icons are the kit's semantic keys (`IconName`), a list the SDK does not
 * carry because it lives next to React components. The client drops a key
 * the kit does not know rather than rendering an empty box.
 */
const iconDoc =
  'A kit icon key such as "wallet", "calendar", "deadline", "ledger", "health", "link", "file", "agent". Omit when unsure: an unknown key is dropped.';

// ---------------------------------------------------------------------------
// How the schema is written for the model (#336)
// ---------------------------------------------------------------------------

/**
 * Two ways to write the same accepted input in fewer characters, D47's two
 * reductions. Neither changes what a variant accepts: an id is metadata, not
 * a check, and a description is never one. What they change is what the
 * model reads on every turn, so neither ships until #336's A/B says the API
 * and the model accept it. Until then `SHOW_BLOCK_INPUT_SCHEMA` is the
 * shipped form, and the other forms exist so that the A/B measures exactly
 * what would ship.
 */
export interface ShowBlockSchemaForm {
  /**
   * Reduction 1: `tone` and `valueTone`, each with its description, and
   * `icon` get a registry id, so the Agent SDK's draft-7 conversion emits
   * each once under `definitions` and references it at every site.
   */
  readonly sharedDefinitions: boolean;
  /**
   * Reduction 2: `false` drops the field descriptions that say what
   * `SHOW_BLOCK_DESCRIPTION` already says (the `restated` sites below).
   */
  readonly restatedProse: boolean;
}

/** The form that ships. */
export const SHIPPED_SHOW_BLOCK_SCHEMA_FORM: ShowBlockSchemaForm = {
  sharedDefinitions: false,
  restatedProse: true,
};

/** What varies between forms; everything else is the same code in all of them. */
interface BlockFields {
  readonly tone: z.ZodOptional<typeof tone>;
  readonly valueTone: z.ZodOptional<typeof valueTone>;
  readonly icon: z.ZodOptional<z.ZodString>;
  /** A description that restates `SHOW_BLOCK_DESCRIPTION`, kept or dropped. */
  readonly restated: <T extends z.ZodType>(schema: T, doc: string) => T;
}

/**
 * The fields for one form. The registry ids are process-global
 * (`z.globalRegistry`), but they only collide when two DIFFERENT schemas with
 * the same id meet in one conversion, and `showBlockInputSchema` builds each
 * form once, so the ids below always name these objects.
 */
function blockFields(form: ShowBlockSchemaForm): BlockFields {
  const restated = <T extends z.ZodType>(schema: T, doc: string): T =>
    form.restatedProse ? schema.describe(doc) : schema;
  if (!form.sharedDefinitions) {
    return {
      tone: tone.optional().describe(toneDoc),
      valueTone: valueTone.optional().describe(valueToneDoc),
      icon: z.string().optional().describe(iconDoc),
      restated,
    };
  }
  return {
    tone: tone.describe(toneDoc).meta({ id: "tone" }).optional(),
    valueTone: valueTone.describe(valueToneDoc).meta({ id: "valueTone" }).optional(),
    icon: z.string().describe(iconDoc).meta({ id: "icon" }).optional(),
    restated,
  };
}

const SHIPPED_FIELDS = blockFields(SHIPPED_SHOW_BLOCK_SCHEMA_FORM);

// ---------------------------------------------------------------------------
// The thirteen answer blocks
// ---------------------------------------------------------------------------

const comparisonBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("comparison"),
    columns: z
      .array(
        z.object({
          label: z.string().describe("The option's name."),
          note: z
            .string()
            .optional()
            .describe("A quiet mono line under the label: provenance, not a second value."),
          tone: f.valueTone,
          recommended: z
            .boolean()
            .optional()
            .apply(f.restated, "Tints the whole column. At most one column, and only with a footnote."),
        })
      )
      .min(2)
      .max(4)
      .apply(f.restated, "The options being compared. Three fit a phone; four only on a wide screen."),
    rows: z
      .array(
        z.object({
          label: z.string().describe("The criterion."),
          cells: z
            .array(
              z.union([
                z.string(),
                z.object({ v: z.string(), tone: f.valueTone }),
              ])
            )
            .describe("One cell per column, in column order. A string, or {v, tone} to colour it."),
        })
      )
      .min(1)
      .describe("The criteria, one row each."),
    corner: z.string().optional().describe("The top-left cell. Usually empty."),
    footnote: z
      .string()
      .optional()
      .apply(f.restated, "Why the recommendation is the recommendation, stated as a cost. Required when a column is recommended."),
  });

export const COMPARISON_BLOCK_SCHEMA = comparisonBlock(SHIPPED_FIELDS);

const statsBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("stats"),
    tiles: z
      .array(
        z.object({
          label: z.string().describe("Short uppercase-able label."),
          value: z.string().apply(f.restated, "The figure, pre-formatted with its unit."),
          meta: z.string().optional().describe("A line under the value: the comparison or the period."),
          icon: f.icon,
          tone: f.valueTone,
        })
      )
      .min(1)
      .max(8)
      .apply(f.restated, "Headline figures. Three or four read best; they wrap in threes on a phone."),
  });

export const STATS_BLOCK_SCHEMA = statsBlock(SHIPPED_FIELDS);

const trendBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("trend"),
    label: z.string().optional().describe("The uppercase mono line above the number."),
    value: z.string().optional().apply(f.restated, "The headline figure, pre-formatted. The chart does no arithmetic."),
    delta: z.string().optional().apply(f.restated, 'The change pill, e.g. "+12%" or "−3 days". Omit when there is no comparison.'),
    deltaTone: deltaTone.optional().describe('"teal" for a good change, "red" for a bad one.'),
    values: z
      .array(z.number())
      .min(2)
      .apply(f.restated, "The series in its own unit, oldest first. Scaled against its own maximum."),
    ticks: z
      .array(z.string())
      .optional()
      .describe("One label per bucket; empty strings are unlabelled slots. Same length as values."),
    tone: f.tone,
  });

export const TREND_BLOCK_SCHEMA = trendBlock(SHIPPED_FIELDS);

const tableBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("table"),
    columns: z
      .array(
        z.object({
          label: z.string(),
          align: z.enum(["left", "right"]).optional().apply(f.restated, "Right-align numbers."),
        })
      )
      .min(1)
      .max(6),
    rows: z
      .array(
        z.object({
          cells: z
            .array(
              z.object({
                v: z.string(),
                tone: f.tone,
                mono: z.boolean().optional().describe("Monospace, for ids and figures."),
                bold: z.boolean().optional(),
              })
            )
            .describe("One cell per column, in column order."),
        })
      )
      .min(1)
      .describe("Records, one row each."),
  });

export const TABLE_BLOCK_SCHEMA = tableBlock(SHIPPED_FIELDS);

const barsBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("bars"),
    rows: z
      .array(
        z.object({
          label: z.string(),
          pct: z.number().min(0).max(100).apply(f.restated, "The bar length, 0-100."),
          value: z.string().apply(f.restated, "The figure shown beside the bar, pre-formatted."),
          tone: tone
            .optional()
            .apply(f.restated, "The class of work this row is, not a judgement of it; the same class draws the same colour on every chart. Omit for the default."),
        })
      )
      .min(1)
      .max(12)
      .apply(f.restated, "Shares of a whole, largest first unless the order means something."),
  });

export const BARS_BLOCK_SCHEMA = barsBlock(SHIPPED_FIELDS);

const receiptBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("receipt"),
    title: z.string().optional().describe("The uppercase mono header. Omit for a bare row list."),
    titleIcon: f.icon,
    titleTone: f.tone,
    rows: z
      .array(
        z.object({
          k: z.string().describe("The key, short."),
          v: z.string().apply(f.restated, "The value, pre-formatted."),
          tone: f.valueTone,
        })
      )
      .min(1),
    diff: z.string().optional().describe("A unified diff, rendered inset under the rows."),
    footnote: z.string().optional().apply(f.restated, "The scope line: what this receipt covers."),
  });

export const RECEIPT_BLOCK_SCHEMA = receiptBlock(SHIPPED_FIELDS);

const stepsBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("steps"),
    steps: z
      .array(
        z.object({
          title: z.string(),
          detail: z.string().optional(),
          meta: z.string().optional().describe("A short right-aligned note: a duration, a place."),
          code: z.string().optional().describe("A mono line under the detail: a command, a bearing."),
          state: z.enum(BLOCK_STEP_STATES).optional().apply(f.restated, 'For "progress": exactly one "current".'),
        })
      )
      .min(1),
    variant: z
      .enum(BLOCK_STEP_VARIANTS)
      .optional()
      .apply(f.restated, "numbered = a recipe to follow, checklist = things to tick off, progress = something being done for the reader."),
  });

export const STEPS_BLOCK_SCHEMA = stepsBlock(SHIPPED_FIELDS);

const timelineBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("timeline"),
    items: z
      .array(
        z.object({
          time: z.string().describe('Short, mono: "09:40", "Tue", "2019".'),
          title: z.string(),
          detail: z.string().optional(),
          meta: z.string().optional(),
          tone: f.tone,
          pulse: z.boolean().optional().apply(f.restated, "Reserved for the one event still happening."),
        })
      )
      .min(1)
      .apply(f.restated, "What happened, in order."),
  });

export const TIMELINE_BLOCK_SCHEMA = timelineBlock(SHIPPED_FIELDS);

const scheduleBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("schedule"),
    groups: z
      .array(
        z.object({
          day: z.string().describe('"Today", "Tomorrow", "Thu 24".'),
          meta: z.string().optional().describe("A note beside the day: a count, a place."),
          items: z
            .array(
              z.object({
                time: z.string(),
                title: z.string(),
                detail: z.string().optional(),
                tag: z.string().optional().describe('A small pill. "conflict" is drawn gold.'),
                tone: f.tone,
              })
            )
            .min(1),
        })
      )
      .min(1)
      .apply(f.restated, "What is coming, grouped by day."),
  });

export const SCHEDULE_BLOCK_SCHEMA = scheduleBlock(SHIPPED_FIELDS);

const quoteBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("quote"),
    quote: z.string().apply(f.restated, "The words themselves, verbatim."),
    source: z.string().optional().describe("Whose words: a document title, a person, a page."),
    locator: z.string().optional().describe("Line or section, so the reader can check it."),
    note: z.string().optional().describe("Why this is being surfaced."),
    tone: z.enum(BLOCK_QUOTE_TONES).optional().describe("Provenance colour; omit for the default."),
    icon: f.icon,
  });

export const QUOTE_BLOCK_SCHEMA = quoteBlock(SHIPPED_FIELDS);

const contactBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("contact"),
    label: z.string().describe("The display name."),
    role: z.string().optional().describe("What they are to the reader, or their title."),
    contactKind: z.enum(BLOCK_CONTACT_KINDS).optional().describe("Decides the avatar shape and the default colour."),
    badge: z.string().optional().describe("A soft chip beside the name: standing, not status."),
    tone: z.enum(BLOCK_CONTACT_TONES).optional().describe("The entity colour; omit for the kind's default."),
    facts: z
      .array(
        z.object({
          k: z.string(),
          v: z.string(),
          tone: f.valueTone,
        })
      )
      .optional()
      .describe("Key-value facts: last contact, company, city."),
    initials: z.string().optional().describe("Derived from the label when absent."),
  });

export const CONTACT_BLOCK_SCHEMA = contactBlock(SHIPPED_FIELDS);

/**
 * A page the reader may want to open (#43). The schema bounds the shape; what
 * the address may BE is `classifyLink`'s call (`@schlessera/brain-ui-kit/links`),
 * made by the handler, which rejects a refused address, and again by the
 * card, which draws a refused one as withheld. The host is deliberately not a
 * field: it is derived from `url`, so the model cannot state one that
 * disagrees with where the link goes. Nothing is fetched to render it.
 */
export const LINK_BLOCK_SCHEMA = z.object({
  kind: z.literal("link"),
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "The absolute http(s) address, exactly as the reader should open it. No user:password@. Brain does not open or check it."
    ),
  title: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("What the page is, in your words. Plain text; shown as written by you."),
  description: z
    .string()
    .max(240)
    .optional()
    .describe("One or two sentences on why it is relevant. Plain text; shown as written by you."),
});

/**
 * Several named places, drawn on real geography with a numbered list under
 * them (#44). The model says WHICH places; the surface decides HOW they are
 * drawn. That is why nothing that shapes the drawing is here: no span, zoom,
 * bbox, height, paths, tone or numbering. Those are the levers that would let
 * a map claim more than it knows. A coordinate is the brain's claim, never
 * something the background geography verifies, and a place with no position
 * is listed without one rather than given an estimated pin.
 *
 * The cap is a schema rejection the model sees and must fix. Nothing is ever
 * cut on the client: every place is a row in the list, numbered in payload
 * order, whatever the map could fit.
 */
export const MAP_PLACE_SCHEMA = z
  .object({
    label: z.string().min(1).max(80).describe("The place's name. Wraps; never cut."),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    meta: z.string().max(40).optional().describe("A short fact: a time, a day, a count."),
    source: z
      .string()
      .max(80)
      .optional()
      .describe("Where you got the position: a note path, a document."),
    accuracyM: z
      .number()
      .positive()
      .max(100_000)
      .optional()
      .describe("How sure the position is, in metres, if a source says so. Omit rather than guess."),
  })
  .refine((place) => (place.lat === undefined) === (place.lon === undefined), {
    message: "lat and lon come together",
  });

const mapBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("map"),
    title: z.string().max(60).optional().describe("What the set is: 'Where the crew went ashore'."),
    places: z
      .array(MAP_PLACE_SCHEMA)
      .min(1)
      .max(30)
      .apply(
        f.restated,
        "In the order the reader should read them; the numbers follow this order. A place with no known position goes in WITHOUT lat/lon; never estimate one."
      ),
  });

export const MAP_BLOCK_SCHEMA = mapBlock(SHIPPED_FIELDS);

export type MapPlace = z.infer<typeof MAP_PLACE_SCHEMA>;

/** Imported file evidence: the surface resolves the original, rather than model-restated coordinates. */
export const TRACK_BLOCK_SCHEMA = z.object({
  kind: z.literal("track"),
  source: z.object({ path: z.string().min(1).max(512).describe("The staged track file path returned by attachment intake. The surface reads this file; do not restate its coordinates.") }),
  title: z.string().max(100).optional().describe("A short title. Source provenance and measurements come from the file."),
});

// ---------------------------------------------------------------------------
// The one block that is not part of the answer
// ---------------------------------------------------------------------------

/** The longest follow-up a chip holds: two lines at 320px, never ellipsised. */
export const SUGGESTION_MAX_LENGTH = 80;

/** The shortest one worth offering. */
export const SUGGESTION_MIN_LENGTH = 4;

/** At most two: past that it is a menu of the model's ideas. */
export const SUGGESTIONS_MAX_ITEMS = 2;

/**
 * Follow-ups the model offers after its own answer (#40). The data projection
 * of the kit's `SuggestionChips` minus `onClick` (a callback) and `tone` (a
 * suggestion never carries an effect, so it is never amber), asserted in both
 * directions by `packages/ui-react/tests/block-contract.test-d.ts`.
 *
 * Unlike every other kind it is not drawn where it is called: the client
 * lifts the turn's last valid call to the answer's closing row (D50), and a
 * chip fills the composer; it never sends.
 */
const suggestionsBlock = (f: BlockFields) =>
  z.object({
    kind: z.literal("suggestions"),
    label: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .optional()
      .describe('The uppercase mono line above the chips. Omit for the default, "Ask next".'),
    items: z
      .array(
        z.object({
          label: z
            .string()
            .trim()
            .min(SUGGESTION_MIN_LENGTH)
            .max(SUGGESTION_MAX_LENGTH)
            .regex(/^[^\r\n]*$/, "one line")
            .describe("The follow-up as the reader would type it; one line, at most 80 characters."),
          icon: f.icon,
        })
      )
      .min(1)
      .max(SUGGESTIONS_MAX_ITEMS)
      .apply(f.restated, "One or two follow-ups grounded in this answer."),
  });

export const SUGGESTIONS_BLOCK_SCHEMA = suggestionsBlock(SHIPPED_FIELDS);

/** The union the tool's `block` argument carries. */
export const BLOCK_SCHEMA = z.discriminatedUnion("kind", [
  COMPARISON_BLOCK_SCHEMA,
  STATS_BLOCK_SCHEMA,
  TREND_BLOCK_SCHEMA,
  TABLE_BLOCK_SCHEMA,
  BARS_BLOCK_SCHEMA,
  RECEIPT_BLOCK_SCHEMA,
  STEPS_BLOCK_SCHEMA,
  TIMELINE_BLOCK_SCHEMA,
  SCHEDULE_BLOCK_SCHEMA,
  QUOTE_BLOCK_SCHEMA,
  CONTACT_BLOCK_SCHEMA,
  MAP_BLOCK_SCHEMA,
  TRACK_BLOCK_SCHEMA,
  LINK_BLOCK_SCHEMA,
  SUGGESTIONS_BLOCK_SCHEMA,
]);

export type Block = z.infer<typeof BLOCK_SCHEMA>;
export type BlockKind = Block["kind"];

/** Every block kind, in the order the brief names them. */
export const BLOCK_KINDS = BLOCK_SCHEMA.options.map(
  (option) => option.shape.kind.value
) as readonly BlockKind[];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export const SHOW_BLOCK_TOOL_NAME = "show_block";

export const SHOW_BLOCK_DESCRIPTION = [
  "Render one structured block inline in your answer, at the point where you call it: a comparison table, stat tiles, a trend chart, a data table, a bar list, a receipt, a step list, a timeline, a schedule, a quote card, a contact card, a map of places, an imported track or a link card. One kind is the exception: suggestions is not drawn where you call it but under the finished answer.",
  "If you are about to write a markdown table, stop and call this instead: kind=comparison when the columns are options the reader is choosing between, kind=table otherwise. A markdown table in this chat is a block that was not drawn.",
  "The block IS part of the answer, so call it where the block belongs and write the prose around it; do not repeat the block's contents in prose, and do not draw the same thing as a markdown table. One or two blocks per answer; more than three is a dashboard, not an answer.",
  "Values are strings you have already formatted with their unit and precision; the blocks do no arithmetic, no rounding and no currency. Keep labels short: they are read on a phone.",
  "comparison: the reader is choosing between 2-4 options. Three columns fit a phone; use four only when the reader is on a wide screen. Mark at most one column recommended, and then give a footnote that states what the recommendation costs.",
  "stats: 3-4 headline figures with a one-line meta each; they wrap in threes. trend: one figure over time, values oldest first, a delta pill only when there is a comparison. table: records with 2-6 columns, right-align numbers. bars: shares of a whole, pct 0-100; tone is the class of work (the same class draws the same colour on every chart), not a judgement of the row.",
  "receipt: what a tool or a change did, as key/value rows, with a footnote for scope; a toned value fits one phone line at 25 characters (28 untoned) and wraps past it. steps: a procedure (numbered), things to tick off (checklist) or work being done for the reader (progress, exactly one current step).",
  "timeline: what happened when, oldest first, pulse only on the one thing still happening. schedule: what is coming, grouped by day. quote: the exact words with a source and a locator, when the words themselves are the evidence. contact: a person, company or project with facts, when the answer is who.",
  "map: 1-30 named places in reading order; the surface numbers them, draws them on real geography and lists every one under the map. Give lat/lon only when a source states them and name the source; list a place without them rather than estimating. You choose the places, never the zoom or the drawing.",
  "track: a validated GPX, KML or supported GeoJSON attachment. Give only source.path from intake; the surface reads the original, calculates shared measurements and draws it without inferring recorded travel. Never restate coordinates or choose a viewport.",
  "link: one external page the reader may want to open, with an absolute http(s) url and no user:password@. Brain shows its address and marks your title and description as yours; it never opens the page. A url that is relative, not http(s), carries credentials, or mixes alphabets in one part of its name is rejected with the reason.",
  "suggestions: at most two follow-ups the reader would plausibly ask next, each grounded in this answer and phrased as the reader would type it; omit it when the answer ends by asking the reader something, and never add generic ones. Tapping one only puts it in the reader's composer to edit; it never sends. Call it last, at most once.",
  "The tool has no side effect and returns what it was given; a rejected call means the block did not fit its schema, or a link's address was refused, so fix the shape or the address rather than retrying it unchanged.",
].join("\n");

export const SHOW_BLOCK_INPUT_SCHEMA = z.object({
  block: BLOCK_SCHEMA,
});

export type ShowBlockInput = z.infer<typeof SHOW_BLOCK_INPUT_SCHEMA>;

const FORMS = new Map<string, typeof SHOW_BLOCK_INPUT_SCHEMA>();

/**
 * `show_block`'s input schema written in `form` (#336). The shipped form is
 * `SHOW_BLOCK_INPUT_SCHEMA` itself. Any other form is built once per process,
 * so its registry ids are registered once, and it accepts exactly the input
 * the shipped form accepts; `tests/show-block-schema-forms.test.ts` holds it
 * to that.
 */
export function showBlockInputSchema(form: ShowBlockSchemaForm): typeof SHOW_BLOCK_INPUT_SCHEMA {
  if (
    form.sharedDefinitions === SHIPPED_SHOW_BLOCK_SCHEMA_FORM.sharedDefinitions &&
    form.restatedProse === SHIPPED_SHOW_BLOCK_SCHEMA_FORM.restatedProse
  ) {
    return SHOW_BLOCK_INPUT_SCHEMA;
  }
  const key = `${form.sharedDefinitions}/${form.restatedProse}`;
  let schema = FORMS.get(key);
  if (!schema) {
    const f = blockFields(form);
    schema = z.object({
      block: z.discriminatedUnion("kind", [
        comparisonBlock(f),
        statsBlock(f),
        trendBlock(f),
        tableBlock(f),
        barsBlock(f),
        receiptBlock(f),
        stepsBlock(f),
        timelineBlock(f),
        scheduleBlock(f),
        quoteBlock(f),
        contactBlock(f),
        mapBlock(f),
        TRACK_BLOCK_SCHEMA,
        // No tone, icon or restated field, so every form shares the one schema.
        LINK_BLOCK_SCHEMA,
        suggestionsBlock(f),
      ]),
    });
    FORMS.set(key, schema);
  }
  return schema;
}

/**
 * The payload is the input: the handler validates and echoes. That makes this
 * the one payload parsed with a strict tree (`z.object` strips unknown keys)
 * rather than a loose one: the payload is the model's own argument, so there
 * is no server-added field to preserve, and an older client parsing a newer
 * variant field drops it from the rendered block and still renders. Stated
 * in `docs/integration-contract.md` next to the additive-payload rule.
 */
export const SHOW_BLOCK_PAYLOAD_SCHEMA = SHOW_BLOCK_INPUT_SCHEMA;

export type ShowBlockPayload = ShowBlockInput;

export const SHOW_BLOCK_CONTRACT = defineToolComponentContract({
  name: SHOW_BLOCK_TOOL_NAME,
  description: SHOW_BLOCK_DESCRIPTION,
  input: SHOW_BLOCK_INPUT_SCHEMA,
  payload: SHOW_BLOCK_PAYLOAD_SCHEMA,
  brief: (name) =>
    `- **Never write a markdown table; call \`${name}\` instead.** It renders
  one inline block; a table you would have typed is a
  \`comparison\` (choosing between options) or a \`table\`
  (records). Reach for it whenever a shape beats prose: \`stats\` for three
  or four headline figures; a \`trend\` for one figure over time; \`bars\`
  for shares of a whole; a \`receipt\` for what a tool or a change did;
  \`steps\` for a procedure; a \`timeline\` for what happened when; a
  \`schedule\` for what is coming; a \`quote\` when the words are the
  evidence; a \`contact\` when the answer is who; a \`map\` for several
  places; a \`track\` for an imported file; a \`link\` for a page to open. Write the prose around the block,
  never its contents again.`,
});
