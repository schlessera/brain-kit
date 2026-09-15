// The cast.
//
// Roles are stated in the world's own register. There are no modern job
// titles here -- "Chief suitor", not "Primary stakeholder" -- because the
// whole conceit is that only the tooling is modern. The collision lands when
// the data underneath it is serious.
//
// Contact details use reserved ranges only: the 555-0100..555-0199 block
// (NANP, reserved for fiction) and `example.com` (RFC 2606). Where the world
// genuinely has no contact detail, the field is null rather than invented --
// gods do not have numbers, and the dead do not answer.

import type {
  ContactAction,
  ContactFact,
  Person,
  PersonId,
  RelatedFile,
  Tone,
} from "./types.js";

export const people: Person[] = [
  {
    id: "person:penelope",
    name: "Penelope",
    role: "Wife · holding Ithaca",
    at: "place:ithaca",
    standing: "household",
    initials: "PE",
    relationship:
      "Has run the estate alone for twenty years and has not once asked for instructions. The weaving is a delaying tactic and it has been found out.",
    phone: "555-0101",
    email: "penelope@example.com",
    path: "people/penelope.md",
    staleDays: 12,
    tone: "teal",
  },
  {
    id: "person:telemachus",
    name: "Telemachus",
    role: "Son · travelling for news",
    at: "place:sparta",
    standing: "household",
    initials: "TE",
    relationship:
      "Was an infant at the sailing and is now old enough to be a problem to the suitors, which is why they have put men on the strait to meet him coming back.",
    phone: "555-0112",
    email: "telemachus@example.com",
    path: "people/telemachus.md",
    staleDays: 3,
    tone: "teal",
  },
  {
    id: "person:athena",
    name: "Athena",
    role: "Patron · Olympos",
    at: null,
    standing: "ally",
    initials: "AT",
    relationship:
      "Reliable in outcome, unpredictable in timing and appearance. Has argued the case in council twice and won it once. Do not plan around her arriving.",
    phone: null,
    email: null,
    path: "people/athena.md",
    staleDays: 1,
    tone: "purple",
  },
  {
    id: "person:poseidon",
    name: "Poseidon",
    role: "Sea · holds the grievance",
    at: null,
    standing: "hostile",
    initials: "PO",
    relationship:
      "The blinding of his son is the open item. He cannot stop the return outright, only make every leg of it cost something. Currently away, which is the whole reason today is possible.",
    phone: null,
    email: null,
    path: "people/poseidon.md",
    staleDays: 0,
    tone: "red",
  },
  {
    id: "person:calypso",
    name: "Calypso",
    role: "Host · Ogygia",
    at: "place:ogygia",
    standing: "host",
    initials: "CA",
    relationship:
      "Kept him seven years and then, under instruction, spent four days helping him build the raft that leaves. Gave the sailing directions herself and they are the best in the file.",
    phone: null,
    email: null,
    path: "people/calypso.md",
    staleDays: 0,
    tone: "amber",
  },
  {
    id: "person:circe",
    name: "Circe",
    role: "Aeaea · gave the route",
    at: "place:aeaea",
    standing: "counterparty",
    initials: "CI",
    relationship:
      "Started as the threat and ended as the only source whose predictions have all come true. Every hazard between Aeaea and Thrinacia was described in advance, in order, correctly.",
    phone: null,
    email: null,
    path: "people/circe.md",
    staleDays: 2609,
    tone: "purple",
  },
  {
    id: "person:teiresias",
    name: "Teiresias",
    role: "Seer · consulted once",
    at: "place:acheron",
    standing: "counterparty",
    initials: "TI",
    relationship:
      "One consultation, one forecast, three conditions. Two of the conditions have already been broken by other people. The third is still ahead.",
    phone: null,
    email: null,
    path: "people/teiresias.md",
    staleDays: 3032,
    tone: "purple",
  },
  {
    id: "person:polyphemus",
    name: "Polyphemus",
    role: "Cyclops · the original mistake",
    at: "place:cyclopes",
    standing: "hostile",
    initials: "PY",
    relationship:
      "Would have been a closed incident. Became a ten-year one the moment he was given a name to complain about.",
    phone: null,
    email: null,
    path: "people/polyphemus.md",
    staleDays: 1861,
    tone: "red",
  },
  {
    id: "person:eurylochus",
    name: "Eurylochus",
    role: "Second in command · lost at Thrinacia",
    at: "place:thrinacia",
    standing: "dead",
    initials: "EU",
    relationship:
      "Disagreed in writing three times and was right once. The third disagreement was about the cattle, and it ended the ship.",
    phone: null,
    email: null,
    path: "crew/eurylochus.md",
    staleDays: 2608,
    tone: "neutral",
  },
  {
    id: "person:elpenor",
    name: "Elpenor",
    role: "Crew · died on Aeaea",
    at: "place:aeaea",
    standing: "dead",
    initials: "EL",
    relationship:
      "Fell from a roof the morning we sailed and was not missed until the underworld, where he asked, reasonably, to be buried.",
    phone: null,
    email: null,
    path: "crew/elpenor.md",
    staleDays: 3032,
    tone: "neutral",
  },
  {
    id: "person:laertes",
    name: "Laertes",
    role: "Father · the upland farm",
    at: "place:ithaca",
    standing: "household",
    initials: "LA",
    relationship:
      "Left the hall for the farm when the news stopped coming and has not been back. Sleeps by the fire in winter with the servants.",
    phone: "555-0104",
    email: null,
    path: "people/laertes.md",
    staleDays: 431,
    tone: "gold",
  },
  {
    id: "person:eumaeus",
    name: "Eumaeus",
    role: "Swineherd · Ithaca",
    at: "place:ithaca",
    standing: "household",
    initials: "EM",
    relationship:
      "Has kept the herds intact against a household that eats one animal a day, and has never once been thanked in writing. Start there.",
    phone: "555-0137",
    email: "eumaeus@example.com",
    path: "people/eumaeus.md",
    staleDays: 38,
    tone: "teal",
  },
  {
    id: "person:antinous",
    name: "Antinous",
    role: "Chief suitor · in the hall",
    at: "place:ithaca",
    standing: "hostile",
    initials: "AN",
    relationship:
      "Loudest of the hundred and eight, and the one who put the ambush on the strait. Everything filed under his name came in second-hand and stays marked as such.",
    phone: "555-0168",
    email: null,
    path: "people/antinous.md",
    staleDays: 6,
    tone: "red",
  },
  {
    id: "person:nestor",
    name: "Nestor",
    role: "Pylos · knew the fleet",
    at: "place:pylos",
    standing: "counterparty",
    initials: "NE",
    relationship:
      "Answers every question at length and none of them directly. Sent Telemachus onward to Sparta with a chariot and no news.",
    phone: null,
    email: null,
    path: "people/nestor.md",
    staleDays: 21,
    tone: "blue",
  },
  {
    id: "person:menelaus",
    name: "Menelaus",
    role: "Sparta · has the first real news",
    at: "place:sparta",
    standing: "counterparty",
    initials: "ME",
    relationship:
      "Came home himself, eventually, and heard from a sea-god that Odysseus was alive on an island. Has been sitting on that for a while.",
    phone: null,
    email: null,
    path: "people/menelaus.md",
    staleDays: 3,
    tone: "blue",
  },
  {
    id: "person:argos",
    name: "Argos",
    role: "Dog · Ithaca",
    at: "place:ithaca",
    standing: "household",
    initials: "AR",
    relationship:
      "Trained as a puppy and never hunted with. Twenty years old, which for a dog is not a figure of speech.",
    phone: null,
    email: null,
    path: "people/argos.md",
    staleDays: 3652,
    tone: "gold",
  },
];

export const peopleById: Record<PersonId, Person> = Object.fromEntries(
  people.map((p) => [p.id, p])
) as Record<PersonId, Person>;

/** The household, in the order the hall would seat them. */
export const household: Person[] = people.filter((p) => p.standing === "household");

/** Everyone the return has to get past. */
export const hostile: Person[] = people.filter((p) => p.standing === "hostile");

/* ------------------------------------------------------------ kit shapes */

/** ContactCard facts for Penelope -- the card the "Call ..." reminder opens. */
export const penelopeFacts: ContactFact[] = [
  { k: "at", v: "Ithaca · the hall", tone: "teal" },
  { k: "phone", v: "555-0101" },
  { k: "last spoke", v: "20 years ago", tone: "amber" },
  { k: "holding", v: "estate · herds · 108 guests", tone: "amber" },
  { k: "asked for", v: "nothing", tone: "neutral" },
];

export const penelopeActions: ContactAction[] = [
  { label: "Call", icon: "chat", tone: "primary" },
  { label: "Open note", icon: "file", tone: "quiet" },
];

/** ContactCard facts for the party on the other side of the grievance. */
export const poseidonFacts: ContactFact[] = [
  { k: "standing", v: "unresolved · 10 years", tone: "amber" },
  { k: "grievance", v: "people/polyphemus.md", tone: "amber" },
  { k: "last seen", v: "away, at the far feast", tone: "neutral" },
  { k: "escalated to", v: "Zeus · council, twice", tone: "purple" },
  { k: "can", v: "delay, not prevent", tone: "neutral" },
];

export const poseidonActions: ContactAction[] = [
  { label: "Open grievance", icon: "policy", tone: "danger" },
  { label: "Snooze", icon: "later", tone: "quiet" },
];

/**
 * The relationship read as the Files screen reads it: who a document is
 * about, why it surfaced, and how strongly. Feeds `RelatedFiles`.
 */
export const relatedPeople: RelatedFile[] = [
  {
    path: "people/penelope.md",
    reason: "named in the oath you swore at the sailing",
    score: "0.94",
    icon: "file",
    tone: "teal",
  },
  {
    path: "people/telemachus.md",
    reason: "the ambush on the strait blocks his return, not yours",
    score: "0.88",
    icon: "file",
    tone: "gold",
  },
  {
    path: "people/polyphemus.md",
    reason: "origin of the grievance that dates every delay since",
    score: "0.81",
    icon: "file",
    tone: "red",
  },
  {
    path: "crew/eurylochus.md",
    reason: "dissented on the cattle and was overruled",
    score: "0.62",
    icon: "file",
    tone: "neutral",
  },
];

/** Tone by standing, so a list and a graph agree on what red means. */
export const standingTone: Record<Person["standing"], Tone> = {
  household: "teal",
  ally: "purple",
  hostile: "red",
  host: "amber",
  crew: "neutral",
  counterparty: "blue",
  dead: "neutral",
};
