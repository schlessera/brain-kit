// One valid `show_block` payload per block kind, in the Odysseus world.
// Shared by the block-card render tests and the share-document tests, so both
// draw the same twelve blocks.
import type { Block } from "@schlessera/brain-ui-sdk/client";

/** The kinds drawn inside the answer: every kind but `suggestions` (D50). */
export type AnswerBlockKind = Exclude<Block["kind"], "suggestions">;

/** One payload per kind drawn in the answer, each in the Odysseus world. */
export const BLOCKS: Record<AnswerBlockKind, Block> = {
  comparison: {
    kind: "comparison",
    columns: [
      { label: "Ithaca", note: "home", recommended: true },
      { label: "Pylos" },
      { label: "Sparta", tone: "dim" },
    ],
    rows: [
      { label: "Days at sea", cells: ["0", { v: "4", tone: "red" }, "6"] },
      { label: "Host", cells: ["Penelope", "Nestor", "Menelaus"] },
    ],
    footnote: "Home costs a longer crossing.",
  },
  stats: {
    kind: "stats",
    tiles: [
      { label: "Ships", value: "12", meta: "of 12", icon: "wallet" },
      { label: "Crew", value: "600", tone: "teal" },
      { label: "Days", value: "9", icon: "not-a-kit-icon" },
    ],
  },
  trend: {
    kind: "trend",
    label: "Ships remaining",
    value: "1",
    delta: "−11",
    deltaTone: "red",
    values: [12, 12, 11, 6, 1],
    ticks: ["Troy", "", "Cyclops", "", "Thrinacia"],
  },
  table: {
    kind: "table",
    columns: [{ label: "Island" }, { label: "Nights", align: "right" }],
    rows: [
      { cells: [{ v: "Aeaea" }, { v: "365", mono: true }] },
      { cells: [{ v: "Ogygia", bold: true }, { v: "2555", mono: true, tone: "amber" }] },
    ],
  },
  bars: {
    kind: "bars",
    rows: [
      { label: "Ogygia", pct: 70, value: "7 y" },
      { label: "Aeaea", pct: 10, value: "1 y", tone: "purple" },
    ],
  },
  receipt: {
    kind: "receipt",
    title: "Suitors",
    titleIcon: "ledger",
    rows: [
      { k: "counted", v: "108" },
      { k: "left", v: "0", tone: "teal" },
    ],
    footnote: "the great hall only",
  },
  steps: {
    kind: "steps",
    variant: "progress",
    steps: [
      { title: "String the bow", state: "done" },
      { title: "Shoot through the axes", state: "current", code: "12 axes" },
      { title: "Reveal yourself", state: "todo" },
    ],
  },
  timeline: {
    kind: "timeline",
    items: [
      { time: "y1", title: "Troy falls" },
      { time: "y10", title: "Ithaca", detail: "disguised as a beggar", tone: "teal", pulse: true },
    ],
  },
  schedule: {
    kind: "schedule",
    groups: [
      {
        day: "Today",
        meta: "2 items",
        items: [
          { time: "dawn", title: "Sail from Aeolia" },
          { time: "dusk", title: "Open the bag", tag: "conflict", tone: "amber" },
        ],
      },
    ],
  },
  quote: {
    kind: "quote",
    quote: "Sing to me of the man, Muse.",
    source: "Odyssey",
    locator: "Book 1, line 1",
    note: "the opening",
    tone: "purple",
  },
  contact: {
    kind: "contact",
    label: "Eumaeus",
    role: "swineherd",
    contactKind: "person",
    badge: "loyal",
    facts: [{ k: "last seen", v: "20 years ago", tone: "red" }],
  },
  map: {
    kind: "map",
    title: "Where the crew went ashore",
    places: [
      { label: "Harbour steps", lat: 38.3644, lon: 20.7202, meta: "09:40", source: "notes/landing.md" },
      { label: "Agora well", lat: 38.3667, lon: 20.7207 },
      { label: "Raft timber stand" },
    ],
  },
};

/** The follow-ups the model offers under its answer (#40), drawn in the closing row. */
export const SUGGESTIONS: Extract<Block, { kind: "suggestions" }> = {
  kind: "suggestions",
  items: [
    { label: "What did Circe say about Charybdis?" },
    { label: "Who was on watch then?", icon: "ask" },
  ],
};
