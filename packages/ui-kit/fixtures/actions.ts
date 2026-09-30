// The decision surfaces: where the async loop meets the person.
//
// Three rules from the design govern every string in this file, and they are
// worth restating because they are what keeps the world serious:
//
//   1. The effect is the UI, not the label. Every option names the tool, the
//      input and the target path, plus its effect type as a mono chip.
//   2. Resolution is free. A tap is a database write, so nothing here
//      promises a model call and nothing here costs anything to answer.
//   3. Trust is a server fact. Untrusted origin is a persistent label on the
//      card, never a phrase inside the model's prose.

import { REFERENCE_DATE, TIMEZONE_FOOTNOTE, daysAfter } from "./time.js";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import type { AskOption, ButtonTone, EmptyTone, IconKey, ReceiptRow, ToastTone, Tone } from "./types.js";

export type ActionKind =
  | "approval"
  | "choose"
  | "dead-letter"
  | "quarantined"
  | "unverified"
  | "fyi"
  | "suggestion";

export interface ActionFixture {
  kind: ActionKind;
  title: string;
  body?: string;
  /** Provenance, where the material came in from outside. */
  rightChip?: string;
  rightChipTone?: Tone;
  rightMeta?: string;
  rightMetaTone?: "neutral" | "red";
  footMeta?: string;
  footDot?: Tone;
  footPulse?: boolean;
  /** A premise that has gone stale strikes the title through. */
  struck?: boolean;
  thread?: string;
}

/** One card per kind, all seven, all from the same night. */
export const actions: ActionFixture[] = [
  {
    kind: "approval",
    title: "Fetch the wind forecast once, from outside the envelope?",
    body: "One request to a host the brain has never reached. Nothing is written until it returns.",
    rightMeta: "blocks a queue item",
    rightMetaTone: "red",
    footMeta: "escalated 4m ago · run #4c1",
    footDot: "amber",
    footPulse: true,
    thread: "Route home",
  },
  {
    kind: "choose",
    title: "Two places this omen fits. Pick one and it gets filed with a summary.",
    body: "An eagle carrying a goose across the courtyard, reported by a guest.",
    rightChip: "untrusted · relayed",
    rightChipTone: "purple",
    rightMeta: "resolves instantly",
    rightMetaTone: "neutral",
    footMeta: "staged 03:05 · run #9f2",
    footDot: "purple",
    thread: "The hall",
  },
  {
    kind: "dead-letter",
    title: "source-watch failed three times on winds.example.invalid",
    body: "NXDOMAIN each time. The run stopped rather than guessing, and two items are waiting behind it.",
    rightMeta: "2 blocked",
    rightMetaTone: "red",
    footMeta: "dead-lettered 01:40 · run #2b8",
    footDot: "red",
    thread: "Route home",
  },
  {
    kind: "quarantined",
    title: "An edit to oaths/helios.md that the brain did not write",
    body: "The file on disk does not match the hash recorded at the last index.",
    rightChip: "policy",
    rightChipTone: "red",
    rightMeta: "inert until you say",
    rightMetaTone: "red",
    footMeta: "detected 02:14 · index",
    footDot: "red",
    thread: "The grievance",
  },
  {
    kind: "unverified",
    title: "The west wind holds for seventeen days",
    body: "The only source for this has been unreachable for 24 days. Re-checking costs about 1k tokens; closing it costs nothing.",
    rightMeta: "premise stale",
    rightMetaTone: "red",
    footMeta: "first asserted day 3,628",
    struck: true,
    thread: "Route home",
  },
  {
    kind: "fyi",
    title: "Poseidon has left the far feast",
    body: "Reported second-hand. Nothing needs you; the return window is unchanged either way.",
    rightMeta: "no action",
    rightMetaTone: "neutral",
    footMeta: "01:40 · watch",
    footDot: "amber",
    footPulse: true,
    thread: "The grievance",
  },
  {
    kind: "suggestion",
    title: "Third omen about the household filed under omens/ this month. Make it a rule?",
    body: "File anything naming a member of the household under ithaca/, and summarise it in one line.",
    rightMeta: "saves ~9 taps/wk",
    rightMetaTone: "neutral",
    footMeta: "v2 · from your last three filings",
    footDot: "teal",
    thread: "The hall",
  },
];

/* ------------------------------------------------------------- the list */

/**
 * Everything on the list that asks for a decision. The FYI is not waiting on
 * anyone -- it sits in its own non-decision strip -- and the suggestion is a
 * rule offer the weekly review carries rather than an escalation, so neither
 * counts. What is left is the five kinds that need a person.
 */
export const actionsWaiting: ActionFixture[] = actions.filter((a) => a.kind !== "fyi" && a.kind !== "suggestion");

/** The FYIs, for the strip under the decisions. */
export const actionsFyis: ActionFixture[] = actions.filter((a) => a.kind === "fyi");

/**
 * Snoozed decisions are off the list by definition, so the count cannot be
 * derived from the cards on it. It is the two the weekly review carries as
 * "snoozed 2d" and "snoozed 4d" (`week.ts` cannot be imported from here
 * without a cycle; `tests/fixtures.test.ts` holds the two equal).
 */
export const actionsSnoozedCount = 2;

/** The header's teal meta line: two counts, no adjectives. */
export const actionsHeaderMeta = `${actionsWaiting.length} waiting · ${actionsSnoozedCount} snoozed`;

/** The non-decision strip under the list. */
export const actionsFyiStrip = `${actionsFyis.length} FYI${actionsFyis.length === 1 ? "" : "s"} · no reply needed`;

/**
 * The list groups by thread, in this order, and the quarantined policy is
 * NOT under its thread: a policy file that changed outside the brain is not
 * an open loop in anything, so the design gives it its own "Policies" label.
 */
export const actionThreads: { label: string; items: ActionFixture[] }[] = ["Route home", "The hall"].map(
  (label) => ({ label, items: actionsWaiting.filter((a) => a.thread === label && a.kind !== "quarantined") })
);

export const actionPolicies: ActionFixture[] = actionsWaiting.filter((a) => a.kind === "quarantined");

/**
 * Cap pressure, stated as a quiet meter rather than as an error. `open` is
 * every card on the list, decision or not -- the five waiting plus the FYI --
 * and the test holds it to that sum so the meter cannot say six while the
 * list shows seven.
 */
const OPEN = 6;
const CAP = 60;
export const actionsCap = {
  open: OPEN,
  cap: CAP,
  valueText: `${OPEN} / ${CAP} open`,
  /** 0-100, for `Meter`. */
  pct: Math.round((OPEN / CAP) * 100),
};

/* ------------------------------------------------------------- ask + choose */

export const askUser = {
  prompt: "Brain needs your input",
  question: "Where should the eagle omen live?",
  tag: "Filing",
  tone: "purple" as Tone,
};

/** Both options name the exact path and what would be written there. */
export const askOptions: AskOption[] = [
  {
    title: "omens/day-3651-eagle.md",
    subtitle: "Keep it with the other omens. Cross-link to people/penelope.md.",
    mono: true,
    selected: true,
  },
  {
    title: "ithaca/estate.md",
    subtitle: "Append under “reported from the hall” with a three-line summary.",
    mono: true,
  },
  {
    title: "Neither -- ask me again after landfall",
    subtitle: "Resurfaces in 17 days with the premise re-checked.",
    italic: true,
    dim: true,
  },
];

/* ------------------------------------------------------ ask over a list */

/** One scale over many items (`ask_user_list`, #583): how each landfall of
 * the voyage sat, so the brain can build a record of where to put in again. */
export const listRating = {
  question: "How did these landfalls sit with you?",
  noun: "landfalls",
  scale: [
    { label: "sail again" },
    { label: "glad I went" },
    { label: "once was enough" },
    { label: "never again" },
    { label: "not landed" },
    { label: "not interested" },
  ],
  items: [
    { id: "ismaros", label: "Ismaros", detail: "Cicones · raid, then a rout", link: "https://example.org/landfalls/ismaros" },
    { id: "lotus", label: "Land of the Lotus-eaters", detail: "three men would not come back aboard" },
    { id: "cyclops", label: "Island of the Cyclopes", detail: "one cave, one sheep ram, one name given as Nobody" },
    { id: "aeolia", label: "Aeolia", detail: "the floating island · a bag of winds" },
    { id: "telepylos", label: "Telepylos", detail: "Laestrygonians · eleven ships lost" },
    { id: "aeaea", label: "Aeaea", detail: "a year with Circe" },
    { id: "sirens", label: "The Sirens' meadow", detail: "passed, bound to the mast" },
    { id: "thrinacia", label: "Thrinacia", detail: "the cattle of the Sun" },
    { id: "ogygia", label: "Ogygia", detail: "seven years · the current landfall" },
    { id: "scheria", label: "Scheria", detail: "planned · the Phaeacians" },
  ],
  /** Half answered, for the pending-with-gaps stories. */
  partial: {
    ismaros: "once was enough",
    aeolia: "glad I went",
    aeaea: "sail again",
    sirens: "glad I went",
    ogygia: "once was enough",
  } as Record<string, string>,
  /** Every one answered, for the record. */
  answered: {
    ismaros: "once was enough",
    lotus: "never again",
    cyclops: "never again",
    aeolia: "glad I went",
    telepylos: "never again",
    aeaea: "sail again",
    sirens: "glad I went",
    thrinacia: "never again",
    ogygia: "once was enough",
    scheria: "not landed",
  } as Record<string, string>,
};

/** Thirty stale log entries on a three-option scale: the triage shape. */
export const listTriage = {
  question: "Keep these ship's logs? None has been opened since Troy.",
  noun: "logs",
  scale: [{ label: "keep" }, { label: "archive" }, { label: "delete" }],
  items: Array.from({ length: 30 }, (_, i) => ({
    id: `log-${i + 1}`,
    label: `logs/voyage/day-${String(3300 + i * 11).padStart(4, "0")}-${
      ["wind-report", "rations-count", "hull-soundings", "star-sightings", "oar-tally"][i % 5]
    }.md`,
    detail: `untouched ${11 - (i % 9)} months`,
  })),
};

/** The triage answered: a deterministic spread over the three options. */
export const listTriageAnswers: Record<string, string> = Object.fromEntries(
  listTriage.items.map((item, i) => [item.id, i % 5 === 0 ? "keep" : i % 7 === 0 ? "delete" : "archive"])
);

/** Five items on an eight-option scale: where the rest days on Scheria go. */
export const listEight = {
  question: "Where should the rest days on Scheria go?",
  noun: "places",
  scale: [
    { label: "must go" },
    { label: "keen" },
    { label: "fine" },
    { label: "only if nearby" },
    { label: "not now" },
    { label: "been", description: "visited on an earlier voyage" },
    { label: "never", description: "not for me, ever" },
    { label: "not sure" },
  ],
  items: [
    { id: "palace", label: "Palace of Alcinous", detail: "half a day inland" },
    { id: "washing", label: "The washing pools", detail: "by the river mouth" },
    { id: "games", label: "The Phaeacian games", detail: "discus and footrace" },
    { id: "harbour", label: "The twin harbour", detail: "where the ships are built" },
    { id: "grove", label: "Athena's grove", detail: "poplars by the road" },
  ],
};

/** The multi-select shape (catalog §13): which threads the digest keeps
 * following. Two chosen, one not; the answered card lists the two. */
export const followQuestion = { question: "Which of these should the digest keep following?", tag: "Triage" };

export const followOptions: AskOption[] = [
  { title: "The suitors' feast thread", subtitle: "Two open questions, one overdue.", selected: true },
  { title: "Scheria landfall hold", subtitle: "Expires on the 12th.", selected: true },
  { title: "Laertes' estate scope", subtitle: "Nothing has moved in 24 days." },
];

export const followAnswers = followOptions.filter((o) => o.selected).map((o) => o.title);

/** The diff a tool receipt's approval turns on — the tinted DiffBlock's
 * demo in §13. One context line is long enough to wrap at 390px. */
export const receiptDiff = [
  "  venue: the great hall at Ithaca",
  "- seats: 40",
  "+ seats: 24",
  "  catering: quoted for the smaller room, deposit unpaid, hold expires on the 12th",
  "- status: confirmed",
  "+ status: hold",
].join("\n");

/** The five dismissal reasons, as pill chips. */
export const dismissReasons = [
  "Already know this",
  "Wrong thread",
  "Not now",
  "Source is unreliable",
  "Never for this kind",
];

/** The standing-rule suggestion that follows a third identical dismissal. */
export const dismissSuggestion = {
  text: "Third “already know this” on relayed material. Make it a standing rule?",
  trailing: "v2",
};

/* ----------------------------------------------------------------- approval */

export const approval = {
  tool: "WebFetch",
  target: "winds.example.invalid/seventeen-days",
  toolIcon: "search" as IconKey,
  badge: "Outside envelope",
  diff: "- wind: west, holds 17 days (unverified)\n+ wind: west, holds 17 days (source: winds.example.invalid, fetched " + REFERENCE_DATE + ")",
  risk: "reaches a host the brain has never contacted, and writes a field two documents rely on",
  allowLabel: "Fetch once",
  denyLabel: "Skip it",
  allowEffect: "enqueue",
  denyEffect: "cancel_blocked",
  footnote: "resolves instantly · no model call · execution runs later",
};

/* -------------------------------------------------------------- quarantine */

/**
 * Hash mismatch, stated plainly. The hashes are obviously truncated display
 * strings, not real digests of anything.
 */
export const quarantine: { rows: ReceiptRow[]; diff: string; escalation: string; provenance: ReceiptRow[] } = {
  rows: [
    { k: "file", v: "oaths/helios.md", tone: "red" },
    { k: "expected", v: "a4f1...9c2", tone: "teal" },
    { k: "on disk", v: "7b0e...41d", tone: "red" },
    { k: "changed", v: "02:14, by nothing the brain ran", tone: "red" },
  ],
  diff: "- on_break: record\n+ on_break: run scripts/settle.sh",
  escalation:
    "This edit would let omen filing run shell commands. The brain did not write it, and the grant stays inert until you say otherwise.",
  provenance: [
    { k: "origin", v: "unknown", tone: "red" },
    { k: "arrived", v: "with relayed material, 01:40", tone: "purple" },
    { k: "signed", v: "no", tone: "red" },
  ],
};

/* ------------------------------------------------------------------ later */

/** "Later" is a rule, not a guess: each option shows what it resolves to. */
export const snoozeOptions: { label: string; resolvesTo: string; icon: IconKey }[] = [
  { label: "Two hours", resolvesTo: "today 08:40", icon: "later" },
  { label: "This evening", resolvesTo: "today 19:00", icon: "later" },
  { label: "First light tomorrow", resolvesTo: `${daysAfter(1)} 05:30`, icon: "sunrise" },
  { label: "When the raft makes landfall", resolvesTo: `${daysAfter(17)} 06:00`, icon: "calendar" },
];

export const snoozeFootnote = TIMEZONE_FOOTNOTE;

/* ------------------------------------------------------------ queue states */

export type QueueState = "claimed" | "blocked" | "ready" | "scheduled" | "failed" | "superseded";

export interface QueueItem {
  state: QueueState;
  subject: string;
  meta: string;
  link?: string;
  note?: string;
}

/** All six states, from one night's queue. */
export const queueItems: QueueItem[] = [
  { state: "claimed", subject: "index · omens/", meta: "lease 40s", note: "held by note-filer" },
  { state: "blocked", subject: "edit · voyage/_index.md", meta: "4m", link: "waiting on your approval" },
  { state: "ready", subject: "file · omens/day-3651-eagle.md", meta: "9m" },
  { state: "scheduled", subject: "digest · tomorrow", meta: "04:30" },
  {
    state: "failed",
    subject: "fetch · winds.example.invalid",
    meta: "2h",
    note: "dead-lettered after 3 attempts",
  },
  {
    state: "superseded",
    subject: "edit · voyage/_index.md",
    meta: "6h",
    note: "replaced by a later edit to the same field",
  },
];

export const queueFilters = ["all 9", "ready 3", "blocked 1", "failed 1"];

/* ------------------------------------------------------- toasts and empties */

export const toasts: { text: string; target: string; effect: string; tone: ToastTone }[] = [
  { text: "Filed", target: "omens/day-3651-eagle.md", effect: "write_note", tone: "teal" },
  { text: "Queued", target: "winds.example.invalid", effect: "enqueue", tone: "amber" },
  { text: "Rule saved", target: "policies/household-omens.md", effect: "write_policy", tone: "purple" },
];

export interface EmptyStateFixture {
  variant: "caught_up" | "no-results" | "offline" | "first-run" | "quiet";
  title: string;
  body: string;
  meta: string;
  icon: IconKey;
  tone: EmptyTone;
  primaryLabel?: string;
  primaryTone?: ButtonTone;
}

/** All five empty states, each in this world's voice. */
export const emptyStates: EmptyStateFixture[] = [
  {
    variant: "caught_up",
    title: "Nothing is waiting on you",
    body: "Everything that came in overnight has been filed or answered.",
    meta: "last escalation 4m ago · 41 resolved this week",
    icon: "resolved",
    tone: "teal",
  },
  {
    variant: "no-results",
    title: "Nothing in the corpus about that",
    body: "Ten years of this voyage are written down. This is not one of the things in them.",
    meta: "searched 4,812 documents · 0.2s",
    icon: "search",
    tone: "neutral",
    primaryLabel: "Ask it differently",
    primaryTone: "ghost",
  },
  {
    variant: "offline",
    title: "No reach to the host",
    body: "The brain is on the other side of an ocean and the raft has no mast antenna. Reads are served from the last index.",
    meta: "indexed 2 minutes ago · 4,812 documents",
    icon: "wifi",
    tone: "gold",
    primaryLabel: "Retry",
    primaryTone: "quiet",
  },
  {
    variant: "first-run",
    title: "What do you need to know?",
    body: "4,812 documents, indexed 2 minutes ago. Everything stays on your own machine.",
    meta: "nothing leaves this device unless you send it",
    icon: "brain",
    tone: "amber",
    primaryLabel: "Ask something",
    primaryTone: "primary",
  },
  {
    variant: "quiet",
    title: "Quiet so far",
    body: "Three runs finished overnight and none of them needed a decision.",
    meta: "next digest 04:30",
    icon: "sunrise",
    tone: "neutral",
  },
];

/** A homeward plan asks several independent questions in one exchange. */
export const groupedQuestions: AskUserQuestion[] = [
  { header: "Homeward", question: "Which route should the crew take on the next leg towards Ithaca?", multiSelect: false,
    options: [
      { label: "Along the coast", description: "Keep the headlands in sight and make shelter before nightfall.", preview: "Follow the coast; stop at the next sheltered harbour." },
      { label: "Across open water", description: "Take the shorter passage while the west wind holds." },
      { label: "Wait in harbour", description: "Rest the crew and ask for a fresh account of the wind." },
      { label: "Return to Aeaea", description: "Seek another account of the passage before choosing a course." },
    ] },
  { header: "Voyage notes", question: "Which parts of the voyage should the next digest keep following?", multiSelect: true,
    options: [
      { label: "The crew", description: "Oaths, supplies and each sailor's account of the passage." },
      { label: "The wind", description: "Changes in direction and the shelter available ahead." },
      { label: "The harbours", description: "Landfalls, hospitality and the distance to the next refuge." },
      { label: "The omens", description: "Reported signs and the source of each interpretation." },
    ] },
  { header: "Departure", question: "When should the crew leave the sheltered harbour on the next passage?", multiSelect: false,
    options: [
      { label: "At dawn", description: "Set sail as soon as the headlands can be seen." },
      { label: "After the meal", description: "Finish the provisions and speak to the watch first." },
      { label: "At midday", description: "Give the crew time to repair the oars before leaving." },
      { label: "The next day", description: "Wait for another account of the wind." },
    ] },
  { header: "Return route", question: "How much of the return route should the digest describe for the crew?", multiSelect: false,
    options: [
      { label: "The next landfall", description: "Name the next shelter and the signs used to reach it." },
      { label: "The next two days", description: "Include a second refuge in case the wind changes." },
      { label: "All the way home", description: "Keep the full route to Ithaca visible beside its uncertainties." },
      { label: "Only the risks", description: "List the disputed passages and the observations still needed." },
    ] },
];
