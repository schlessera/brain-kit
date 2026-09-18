// What happened, what is scheduled, and what keeps asking.
//
// All times are local to Ogygia (UTC+2) and are literal strings, not
// formatted instants: a fixture that formats 06:40 through Intl renders
// "06:40" in one locale and "6:40 AM" in another, and a visual-regression
// baseline cannot survive that.

import { usd } from "./runs.js";
import { TIMEZONE_FOOTNOTE, YEARS_AWAY, daysAfter } from "./time.js";
import type {
  DigestGroup,
  NotificationAction,
  ScheduleGroup,
  StatTile,
  TimelineItem,
  Tone,
} from "./types.js";

/** The three tiles above the morning digest. Three, not four: the catalog's
 * own digest dropped to three after a fourth wrapped alone onto a second row
 * at phone width (design-feedback §14). */
/**
 * What the night cost, in cents. The digest's spend tile and the "Overnight"
 * section label are the same figure in two places on one screen, so there is
 * one figure.
 */
export const overnightSpendCents = 40;
export const overnightSpend = usd(overnightSpendCents);

export const digestStats: StatTile[] = [
  { label: "waiting on you", value: "3", meta: "1 approval", icon: "approval", tone: "amber" },
  { label: "crew", value: "0", meta: "of 600", icon: "failed", tone: "red" },
  { label: "spend", value: overnightSpend, meta: "overnight", icon: "wallet", tone: "teal" },
];

/** Overnight, 23:00 to 06:40. The work stated as fact before anything asks. */
export const overnight: TimelineItem[] = [
  {
    time: "23:10",
    title: "Release order delivered",
    detail: "From the council, by messenger. Acknowledged on Ogygia without argument.",
    meta: "run #1a7",
    tone: "purple",
  },
  {
    time: "01:40",
    title: "Wind service unreachable",
    detail: "winds.example.invalid returned NXDOMAIN on three attempts, then dead-lettered.",
    meta: "2 actions blocked",
    tone: "red",
  },
  {
    time: "03:05",
    title: "4 omens filed",
    detail: "Three went to omens/. The fourth has two plausible homes and is waiting on you.",
    meta: "note-filer",
    tone: "teal",
  },
  {
    time: "04:30",
    title: "Crew ledger closed",
    detail: "Six hundred out of Troy, zero returned, one survivor. Reconciled against the voyage log.",
    meta: "ledger · $0.04",
    tone: "neutral",
  },
  {
    time: "06:12",
    title: "Sailing directions transcribed",
    detail: "Voice memo, 0:38, transcribed on device. Bearing and star both captured.",
    meta: "on device",
    tone: "teal",
    pulse: true,
  },
];

/** Today and the deadline at the end of it. */
export const today: ScheduleGroup[] = [
  {
    day: "Today",
    meta: "3 items",
    items: [
      {
        time: "07:00",
        title: "Launch the raft",
        detail: "Tide turns at seven. Stores aboard, sail bent on, steering oar shipped.",
        tag: "no slack",
        tone: "amber",
      },
      {
        time: "11:00",
        title: "Set the bearing",
        detail: "Keep the Great Bear on the left hand. Do not correct it at night.",
        tag: "17 days",
        tone: "teal",
      },
      {
        time: "21:00",
        title: "First night watch",
        detail: "There is no second watch aboard. There is no second person aboard.",
        tag: "alone",
        tone: "gold",
      },
    ],
  },
  {
    day: `Wed ${daysAfter(17).slice(8)}`,
    meta: "landfall window",
    items: [
      {
        time: "06:00",
        title: "Scheria, if the forecast holds",
        detail: "Seventeen days of open water on a raft built in four.",
        tag: "deadline",
        tone: "red",
      },
    ],
  },
];

/** The footnote every scheduled time in this world carries. */
export const scheduleFootnote = TIMEZONE_FOOTNOTE;

/** The digest card's own grouping -- the same night, told as a summary. */
export const digestGroups: DigestGroup[] = [
  {
    label: "Resolved",
    icon: "resolved",
    tone: "teal",
    count: "3",
    items: [
      { text: "Release order acknowledged", meta: "23:10" },
      { text: "Raft rigged and provisioned", meta: "05:50" },
      { text: "Crew ledger closed at zero", meta: "04:30" },
    ],
  },
  {
    label: "Needs you",
    icon: "approval",
    tone: "amber",
    count: "3",
    items: [
      { text: "One omen with two plausible homes", meta: "filing" },
      { text: "Fetch the wind forecast once, from outside the envelope", meta: "approval" },
      { text: "Seventeen days of water, one skin aboard", meta: "unresolved" },
    ],
  },
  {
    label: "Failed",
    icon: "failed",
    tone: "red",
    count: "1",
    items: [{ text: "source-watch · winds.example.invalid · NXDOMAIN", meta: "3 attempts" }],
  },
];

export const digestFootnote = "nothing else needs you · next digest 04:30";

/* ------------------------------------------------------------- reminders */

export interface Reminder {
  title: string;
  /** What the row shows on the right: a due time, or how far past it. */
  value: string;
  icon: "repeat" | "deadline" | "later" | "resolved";
  tone: Tone;
  /** Recurring reminders resurface; one-shots do not. */
  repeats: boolean;
  done: boolean;
}

/**
 * The reminders. The joke in the second one only works because everything
 * around it is stated plainly, so it is stated plainly too.
 */
export const reminders: Reminder[] = [
  {
    title: "Tie me to the mast before the Sirens",
    value: "done · day 1,041",
    icon: "resolved",
    tone: "teal",
    repeats: false,
    done: true,
  },
  {
    title: "Call Penelope",
    value: `overdue · ${YEARS_AWAY / 2} years`,
    icon: "deadline",
    tone: "red",
    repeats: true,
    done: false,
  },
  {
    title: "Bury Elpenor",
    value: "done · 11 days late",
    icon: "resolved",
    tone: "gold",
    repeats: false,
    done: true,
  },
  {
    title: "Pour the offering before making sail",
    value: "07:00",
    icon: "repeat",
    tone: "purple",
    repeats: true,
    done: false,
  },
  {
    title: "Do not correct the bearing at night",
    value: "nightly · 17",
    icon: "repeat",
    tone: "amber",
    repeats: true,
    done: false,
  },
];

/* ---------------------------------------------------------- notifications */

export interface NotificationFixture {
  variant: "rich" | "compact" | "dim";
  tone: Tone;
  app: string;
  time: string;
  lead: string;
  body: string;
  meta: string;
  icon: "approval" | "digest" | "failed" | "fyi";
  actions: NotificationAction[];
}

/** The lock screen, all three densities. */
export const notifications: NotificationFixture[] = [
  {
    variant: "rich",
    tone: "amber",
    app: "Brain · Actions",
    time: "2m",
    lead: "3 actions waiting",
    body: " — 1 approval, 1 choice, 1 failed run",
    meta: "coalesced over 10m · quiet hours respected",
    icon: "approval",
    actions: [
      { label: "Approve the fetch", tone: "primary" },
      { label: "Later", tone: "quiet" },
    ],
  },
  {
    variant: "compact",
    tone: "teal",
    app: "Brain · Digest",
    time: "06:40",
    lead: "Your morning is ready",
    body: " — 5 overnight, 3 today, 1 deadline",
    meta: "next digest 04:30",
    icon: "digest",
    actions: [],
  },
  {
    variant: "dim",
    tone: "neutral",
    app: "Brain · Watch",
    time: "01:40",
    lead: "Poseidon has left the far feast",
    body: " — reported second-hand, treated as data",
    meta: "FYI · never pushes",
    icon: "fyi",
    actions: [],
  },
];

/** What the notification-rules list states, one row per kind. */
export const notificationRules: { kind: string; policy: string; tone: Tone }[] = [
  { kind: "Approvals", policy: "push now", tone: "amber" },
  { kind: "Choices", policy: "coalesce 10m", tone: "purple" },
  { kind: "Failed runs", policy: "first only, then digest", tone: "red" },
  { kind: "FYIs", policy: "never push", tone: "neutral" },
];
