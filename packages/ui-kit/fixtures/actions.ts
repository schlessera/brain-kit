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

/** Cap pressure, stated as a quiet meter rather than as an error. */
export const actionsCap = { open: 6, cap: 60, valueText: "6 / 60 open" };

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
