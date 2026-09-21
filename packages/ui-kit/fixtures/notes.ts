// The documents.
//
// Notes, knowledge, decisions, journal, omens and oaths -- six kinds, one
// shape. Every `links` entry is the path of another document that exists in
// this file, so the wiki-link graph closes: there are no unresolved links and
// no orphans here, which is the opposite of the core corpus's deliberately
// engineered gaps and is the right choice for a set whose job is to render
// well rather than to exercise a resolver.
//
// One hazard worth naming, because this world walks straight past it: the
// poem is full of bird omens, and one of the leakage gate's banned tokens is a
// plumage-colour word. Birds here are described by what they are doing, never
// by their colouring. Keep it that way when adding entries.

import { daysBefore } from "./time.js";
import type { Note, NoteId, QuoteTone, Step, Tone } from "./types.js";

export const notes: Note[] = [
  {
    id: "note:no-name",
    path: "notes/do-not-give-my-name.md",
    title: "Do not tell Polyphemus my real name",
    kind: "note",
    updated: daysBefore(3556),
    staleDays: 3556,
    tags: ["#crew", "#danger", "#gods"],
    links: ["people/polyphemus.md", "decisions/name-at-the-stern.md", "people/poseidon.md"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    excerpt:
      "He cannot complain about a man he cannot name. Keep it that way until the ship is out of earshot.",
  },
  {
    id: "note:sirens",
    path: "knowledge/sirens.md",
    title: "Sirens",
    kind: "knowledge",
    updated: daysBefore(3032),
    staleDays: 3032,
    tags: ["#danger", "#route"],
    links: ["people/circe.md", "voyage/day-1041-sirens.md"],
    people: ["person:circe"],
    places: ["place:sirens"],
    excerpt:
      "A vocal lure, effective at range and lethal at close quarters. Wax in the crew's ears; rope on anyone who wants to hear it. Tested once. Held.",
  },
  {
    id: "note:scylla",
    path: "knowledge/scylla.md",
    title: "Scylla",
    kind: "knowledge",
    updated: daysBefore(3030),
    staleDays: 3030,
    tags: ["#danger", "#route"],
    links: ["knowledge/charybdis.md", "decisions/scylla-or-charybdis.md"],
    people: ["person:circe"],
    places: ["place:scylla", "place:messina"],
    excerpt:
      "Six heads, six men, one pass. Not a fight. Row hard and accept the count -- stopping to fight it costs six more.",
  },
  {
    id: "note:charybdis",
    path: "knowledge/charybdis.md",
    title: "Charybdis",
    kind: "knowledge",
    updated: daysBefore(3030),
    staleDays: 3030,
    tags: ["#danger", "#route"],
    links: ["knowledge/scylla.md", "decisions/scylla-or-charybdis.md"],
    people: ["person:circe"],
    places: ["place:charybdis", "place:messina"],
    excerpt:
      "Swallows and returns three times a day. Nothing on the surface survives a swallow. There is a fig tree on the rock above it; this turned out to matter.",
  },
  {
    id: "note:forecast",
    path: "knowledge/teiresias-forecast.md",
    title: "The forecast",
    kind: "knowledge",
    updated: daysBefore(3032),
    staleDays: 3032,
    tags: ["#gods", "#route", "#ithaca"],
    links: ["people/teiresias.md", "oaths/helios.md", "goals/return-to-ithaca.md"],
    people: ["person:teiresias"],
    places: ["place:acheron", "place:thrinacia", "place:ithaca"],
    excerpt:
      "You may still reach home, and late, and alone, and in a ship not your own -- if nobody touches the cattle of Helios.",
  },
  {
    id: "note:scylla-decision",
    path: "decisions/scylla-or-charybdis.md",
    title: "Scylla or Charybdis",
    kind: "decision",
    updated: daysBefore(3030),
    staleDays: 3030,
    tags: ["#crew", "#danger", "#route"],
    links: ["knowledge/scylla.md", "knowledge/charybdis.md", "crew/_index.md"],
    people: ["person:circe", "person:eurylochus"],
    places: ["place:scylla", "place:charybdis"],
    excerpt:
      "Decided: Scylla. Six certain against six hundred possible is not a close call, and the crew were not told, which is the part still worth arguing about.",
  },
  {
    id: "note:name-decision",
    path: "decisions/name-at-the-stern.md",
    title: "Giving the name at the stern",
    kind: "decision",
    updated: daysBefore(3556),
    staleDays: 3556,
    tags: ["#gods", "#danger"],
    links: ["notes/do-not-give-my-name.md", "people/poseidon.md"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes"],
    excerpt:
      "Reversed my own written instruction, out loud, from a ship already clear of the beach. Every delay since has a date that starts here.",
  },
  {
    id: "note:cattle-decision",
    path: "decisions/cattle-of-helios.md",
    title: "The cattle on Thrinacia",
    kind: "decision",
    updated: daysBefore(2608),
    staleDays: 2608,
    tags: ["#crew", "#gods", "#danger"],
    links: ["oaths/helios.md", "knowledge/teiresias-forecast.md", "crew/eurylochus.md"],
    people: ["person:eurylochus", "person:teiresias"],
    places: ["place:thrinacia"],
    excerpt:
      "Overruled while asleep. Thirty days of wrong wind, one oath, six hundred men, and the only condition the forecast set.",
  },
  {
    id: "note:oath-helios",
    path: "oaths/helios.md",
    title: "Oath sworn on Thrinacia",
    kind: "oath",
    updated: daysBefore(2638),
    staleDays: 2638,
    tags: ["#gods", "#crew"],
    links: ["decisions/cattle-of-helios.md"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    excerpt: "Every man swore not to touch the herds. Twenty-nine days later, every man had.",
  },
  {
    id: "note:journal-today",
    path: "journal/day-3652.md",
    title: "Day 3,652",
    kind: "journal",
    updated: daysBefore(0),
    staleDays: 0,
    tags: ["#ithaca", "#route"],
    links: ["voyage/ogygia/raft.md", "people/calypso.md", "goals/return-to-ithaca.md"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    excerpt:
      "Ten years to the day since Troy. The war took ten years. Coming back has now taken the same, and I have got as far as a raft.",
  },
  {
    id: "note:journal-seven-years",
    path: "journal/day-2914.md",
    title: "Day 2,914",
    kind: "journal",
    updated: daysBefore(738),
    staleDays: 738,
    tags: ["#ithaca"],
    links: ["people/calypso.md", "journal/day-3652.md"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    excerpt: "Sat on the shore again. Stopped counting sails some time in the fifth year and have not restarted.",
  },
  {
    id: "note:omen-eagle",
    path: "omens/day-3651-eagle.md",
    title: "Eagle over the courtyard",
    kind: "omen",
    updated: daysBefore(1),
    staleDays: 1,
    tags: ["#gods", "#ithaca"],
    links: ["people/penelope.md", "people/antinous.md"],
    people: ["person:penelope", "person:antinous"],
    places: ["place:ithaca"],
    excerpt:
      "Reported second-hand: an eagle carrying a goose, crossing the courtyard from the right, and twenty geese on the ground watching it go.",
  },
  {
    id: "note:omen-hawk",
    path: "omens/day-3646-hawk.md",
    title: "Hawk on the right hand",
    kind: "omen",
    updated: daysBefore(6),
    staleDays: 6,
    tags: ["#gods", "#route"],
    links: ["people/athena.md"],
    people: ["person:athena"],
    places: ["place:pylos"],
    excerpt: "A hawk crossed to the right of the ship, carrying, and let nothing fall. Filed without interpretation.",
  },
  {
    id: "note:voyage-sirens",
    path: "voyage/day-1041-sirens.md",
    title: "Day 1,041 -- the Sirens",
    kind: "note",
    updated: daysBefore(3032),
    staleDays: 3032,
    tags: ["#crew", "#danger", "#route"],
    links: ["knowledge/sirens.md", "people/circe.md"],
    people: ["person:circe"],
    places: ["place:sirens"],
    excerpt:
      "Wind dropped to nothing at the right moment, which is the only luck of the whole passage. Fifty-two men rowed past it and not one of them heard a note.",
  },
  {
    id: "note:voyage-strait",
    path: "voyage/day-1043-strait.md",
    title: "Day 1,043 -- the strait",
    kind: "note",
    updated: daysBefore(3030),
    staleDays: 3030,
    tags: ["#crew", "#danger", "#route"],
    links: ["decisions/scylla-or-charybdis.md", "knowledge/scylla.md", "crew/_index.md"],
    people: ["person:eurylochus"],
    places: ["place:scylla", "place:charybdis", "place:messina"],
    excerpt:
      "Held the Calabrian shore close enough to touch it, and nobody stopped rowing. Six gone off the deck before the order could change.",
  },
  {
    id: "note:penelope",
    path: "people/penelope.md",
    title: "Penelope",
    kind: "person",
    updated: daysBefore(12),
    staleDays: 12,
    tags: ["#ithaca"],
    links: ["ithaca/estate.md", "people/antinous.md", "people/telemachus.md"],
    people: ["person:penelope"],
    places: ["place:ithaca"],
    excerpt: "Three years of weaving and unweaving the same cloth. The trick worked until somebody counted the nights.",
  },
  {
    id: "note:telemachus",
    path: "people/telemachus.md",
    title: "Telemachus",
    kind: "person",
    updated: daysBefore(3),
    staleDays: 3,
    tags: ["#ithaca", "#danger"],
    links: ["people/nestor.md", "people/menelaus.md", "people/antinous.md"],
    people: ["person:telemachus", "person:antinous"],
    places: ["place:pylos", "place:sparta"],
    excerpt: "Gone to Pylos and on to Sparta for news. There is a ship waiting in the strait for him to come back.",
  },
  {
    id: "note:raft",
    path: "voyage/ogygia/raft.md",
    title: "The raft",
    kind: "note",
    updated: daysBefore(0),
    staleDays: 0,
    tags: ["#route"],
    links: ["people/calypso.md", "voyage/_index.md"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    excerpt:
      "Twenty trees, seasoned and dry. Broad in the beam as a merchantman's hull, decked, and fitted with a steering oar. Four days.",
  },
];

export const noteById: Record<NoteId, Note> = Object.fromEntries(
  notes.map((n) => [n.id, n])
) as Record<NoteId, Note>;

/** Every path the world knows about, for link-resolution assertions. */
export const notePaths: string[] = notes.map((n) => n.path);

/** The tag vocabulary, in the order the Files screen shows it. */
export const tags = ["#ithaca", "#crew", "#gods", "#danger", "#route"] as const;

export const tagTone: Record<(typeof tags)[number], Tone> = {
  "#ithaca": "teal",
  "#crew": "neutral",
  "#gods": "purple",
  "#danger": "red",
  "#route": "amber",
};

/* ------------------------------------------------------------ kit shapes */

/** Frontmatter as `Chip variant="kv"` -- the File viewer's header. */
export const frontmatterChips: { k: string; v: string; tone?: Tone }[] = [
  { k: "type", v: "decision" },
  { k: "status", v: "settled", tone: "teal" },
  { k: "cost", v: "6 men", tone: "red" },
  { k: "source", v: "circe", tone: "purple" },
];

/**
 * The document the file viewer opens: the strait decision, as prose.
 *
 * The kit has no prose component (the design source's catalog records the
 * type contract the viewer implies), so this is the document broken into the
 * shapes the kit does have: paragraphs with one live wiki-link each, an
 * editorial aside, and the open questions as a checklist. Every link resolves
 * to a path in `notes` above, and `backlinks` in `files.ts` are the documents
 * that point back at this one.
 */
export interface ViewerParagraph {
  /** The prose up to the link. */
  before: string;
  /** A wiki-link, by target path. Resolves, like every link in this file. */
  link?: string;
  /** The prose after the link. */
  after?: string;
}

export const viewerDocument = {
  note: noteById["note:scylla-decision"]!,
  heading: "The count",
  paragraphs: [
    {
      before: "Circe named both before we were out of the bay. Under Scylla the loss is six men and certain -- ",
      link: "knowledge/scylla.md",
      after: " -- and over Charybdis it is the ship and every man on it, three times a day.",
    },
    {
      before: "Decided: Scylla. Held the Calabrian shore close enough to touch it, and nobody stopped rowing. The six are counted in ",
      link: "crew/_index.md",
      after: ".",
    },
  ] satisfies ViewerParagraph[],
  aside: "The crew were told about Charybdis and not about Scylla. Six men rowed past a thing they had not been warned of, and that is the part still worth arguing about.",
  questions: [
    { title: "Would the six have rowed if they had known?", state: "todo" },
    { title: "Does the oath on Thrinacia trace back to this silence?", state: "todo" },
  ] satisfies Step[],
  askLabel: "Ask about this file",
  saveLabel: "Save",
};

/**
 * The sentence a `QuoteCard` puts on screen, with the locator that lets the
 * reader check it. This is the quote the whole cattle decision contradicts.
 */
export const forecastQuote = {
  quote: "Do not touch the cattle of Helios. Touch them, and you lose the ship and every man on it.",
  source: "knowledge/teiresias-forecast.md",
  locator: "line 12",
  note: "This is the sentence the crew had sworn to, in writing, thirty days before they broke it.",
  // QuoteCard's tones are PROVENANCE, not severity: purple is an outside
  // source, and this forecast is one. See `src/blocks/QuoteCard.tsx`.
  tone: "purple" as QuoteTone,
};

/** A second quote, for the story that needs two. */
export const nameQuote = {
  quote: "He cannot complain about a man he cannot name.",
  source: "notes/do-not-give-my-name.md",
  locator: "line 3",
  note: "Written by me. Ignored by me, two hours later, from the stern of the ship.",
  tone: "amber" as QuoteTone,
};

/**
 * The `CodeBlock` specimen. The kit's code block is for things the user has
 * to run on the host, so the world's version is the brain's own CLI.
 */
export const reindexCommand = {
  code: "brain index --path omens/ --force",
  lang: "bash",
  caption: "run on the host, not on the raft",
};

/** The answer as a numbered `StepList` -- how the strait was actually passed. */
export const straitSteps: Step[] = [
  { title: "Wax in every ear but mine", detail: "Sirens first, two days earlier.", state: "done" },
  { title: "Told the crew about Charybdis", detail: "Not about Scylla.", meta: "decisions/scylla-or-charybdis.md", state: "done" },
  { title: "Held the Calabrian shore", detail: "Close enough to touch the cliff.", code: "bearing 012", state: "done" },
  { title: "Rowed through", detail: "Six taken from the deck. Nobody stopped rowing.", meta: "6 lost", state: "done" },
];
