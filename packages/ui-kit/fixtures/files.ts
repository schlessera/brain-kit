// The tree, and the things attached to it.
//
// The folder counts are not decoration: they sum to `corpusSize.documents`
// (4,812), and `journal/` holds exactly one entry per day since Troy. Both are
// asserted in `tests/fixtures.test.ts`, so a screenshot of the Files screen
// and a screenshot of the first-run screen can never disagree about how big
// this brain is.

import { DAYS_SINCE_TROY } from "./time.js";
import type { FilterItem, IconKey, RelatedFile, TabItem, Tone } from "./types.js";

export interface FileNode {
  label: string;
  kind: "folder" | "open" | "file" | "image";
  /** Indent level. 0 is the root listing. */
  depth: number;
  /** Unprocessed count, shown as a badge. */
  badge?: string;
  /** The right-hand meta: a document count, or a reason it is flagged. */
  meta?: string;
  metaTone?: Tone;
  /** A left-edge flag: stale, failing, or fine. */
  flag?: "red" | "gold" | "teal";
  active?: boolean;
}

/**
 * The tree as the Files browser shows it: `omens/` open because it is the
 * folder with unprocessed items in it, everything else closed.
 */
export const fileTree: FileNode[] = [
  { label: "voyage", kind: "folder", depth: 0, meta: "612" },
  { label: "journal", kind: "folder", depth: 0, meta: "3,652" },
  { label: "knowledge", kind: "folder", depth: 0, meta: "214" },
  { label: "crew", kind: "folder", depth: 0, meta: "118", flag: "red" },
  { label: "omens", kind: "open", depth: 0, badge: "3", meta: "86" },
  { label: "day-3651-eagle.md", kind: "file", depth: 1, meta: "1d" },
  { label: "day-3646-hawk.md", kind: "file", depth: 1, meta: "6d" },
  { label: "ionian-approach.png", kind: "image", depth: 1, meta: "sketch" },
  { label: "_index.md", kind: "file", depth: 1, meta: "index lag 9d", metaTone: "gold" },
  { label: "decisions", kind: "folder", depth: 0, meta: "63" },
  { label: "people", kind: "folder", depth: 0, meta: "41" },
  { label: "oaths", kind: "folder", depth: 0, meta: "stale 38d", metaTone: "gold", flag: "gold" },
  { label: "ithaca", kind: "folder", depth: 0, meta: "9" },
  { label: "notes", kind: "folder", depth: 0, meta: "4" },
  { label: "goals", kind: "folder", depth: 0, meta: "1" },
];

/**
 * Document counts per top-level folder. Kept beside the tree rather than
 * parsed out of it, because `oaths/` shows a staleness flag where the others
 * show a count and a display string is not a number.
 */
export const folderCounts: Record<string, number> = {
  voyage: 612,
  journal: DAYS_SINCE_TROY,
  knowledge: 214,
  crew: 118,
  omens: 86,
  decisions: 63,
  people: 41,
  oaths: 12,
  ithaca: 9,
  notes: 4,
  goals: 1,
};

/** Everything the brain holds. Equals the sum of `folderCounts`. */
export const documentCount = Object.values(folderCounts).reduce((a, b) => a + b, 0);

/**
 * The label under the breathing brain core, and the reassurance line on the
 * first-run screen. Derived from the tree so the two can never drift.
 */
export const corpusSize = { documents: documentCount, indexedAgo: "2 minutes ago" };

/** The four filter pills above the tree. */
export const fileFilters: FilterItem[] = [
  { label: "All" },
  { label: "Unprocessed 3" },
  { label: "Stale 11" },
  { label: "Orphans 2" },
];

/* ---------------------------------------------------------- attachments */

export interface Attachment {
  kind: "image" | "audio" | "doc" | "link";
  label: string;
  meta: string;
  /** Audio only. */
  duration?: string;
  seconds?: number;
  played?: number;
  /** The line worth pulling out of it. */
  extract?: string;
  /** Provenance, where the thing did not originate on this device. */
  trust?: string;
}

export const attachments: Attachment[] = [
  {
    kind: "audio",
    label: "Sailing directions",
    meta: "captured 06:12 · transcribed on device",
    duration: "0:38",
    seconds: 38,
    played: 11,
    extract: "Keep the Great Bear on your left hand, and do not correct it at night.",
  },
  {
    kind: "image",
    label: "Ionian approach",
    meta: "sketched on the beach · 1 of 3 · 890 KB",
    extract: "Headlands and soundings for the last two days of the passage.",
  },
  {
    kind: "doc",
    label: "Ship manifest, twelve hulls",
    meta: "crew/manifest-0012.md · 600 names · closed",
    extract: "Every name has a place beside it now, and none of the places is Ithaca.",
  },
  {
    kind: "link",
    label: "What the hall is saying about the succession",
    meta: "relayed second-hand · 4 min · staged 01:40",
    trust: "untrusted · came in through a guest · treated as data",
  },
];

/** The link preview, broken out, because it needs the provenance line. */
export const linkPreview = {
  title: "What the hall is saying about the succession",
  meta: "relayed second-hand · 4 min · staged 01:40",
  trust: "untrusted · came in through a guest · treated as data",
};

/* --------------------------------------------------------------- chrome */

/** The five tab slots. Actions carries the only badge. */
export const tabs: TabItem[] = [
  { icon: "chat", label: "Brain" },
  { icon: "approval", label: "Actions", badge: "3" },
  { icon: "activity", label: "Activity" },
  { icon: "files", label: "Files" },
  { icon: "settings", label: "Settings" },
];

/** The launcher rows on the first-run screen. */
export const launchers: { title: string; subtitle: string; icon: IconKey; tone: Tone }[] = [
  {
    title: "What happened since Troy?",
    subtitle: "Ten years, fifteen landfalls, one survivor",
    icon: "digest",
    tone: "amber",
  },
  {
    title: "Process 3 loose omens",
    subtitle: "One of them is about the household",
    icon: "filer",
    tone: "teal",
  },
  {
    title: "Brain health",
    subtitle: "4,812 documents, indexed 2 minutes ago",
    icon: "health",
    tone: "purple",
  },
];

/** The backlinks panel on the file viewer. */
export const backlinks: RelatedFile[] = [
  { path: "knowledge/scylla.md", reason: "names this decision", score: "0.93", icon: "file", tone: "teal" },
  { path: "knowledge/charybdis.md", reason: "names this decision", score: "0.91", icon: "file", tone: "teal" },
  { path: "crew/_index.md", reason: "carries the cost of it", score: "0.77", icon: "file", tone: "neutral" },
  { path: "journal/day-1043.md", reason: "written the same evening", score: "0.68", icon: "file", tone: "gold" },
];
