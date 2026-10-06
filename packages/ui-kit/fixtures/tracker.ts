// Tracker changes (#1001): issues and pull requests the brain says it changed
// in the household's tracker, for `TrackerPillList`.
//
// GitHub-shaped addresses carry their repository, number and type in the url,
// which is the only place the list reads them from. The shipyard's tracker is
// a non-GitHub host on the reserved `.example` TLD, and one address carries a
// sign-in name, so the list draws it withheld.

import type { TrackerEvent } from "../src/blocks/TrackerPillList.js";

const HALL = "https://github.com/ithaca/hall";
const VOYAGE = "https://github.com/ithaca/pylos-voyage";

/** The phone-width list the issue asks for: an issue opened, a PR merged, an issue closed with a reason, a withheld url and a non-GitHub host. */
export const trackerMixed: readonly TrackerEvent[] = [
  { url: `${HALL}/issues/12`, action: "opened", title: "Suitors overstay in the great hall" },
  { url: `${HALL}/pull/21`, action: "merged", title: "Restore the bow to the great hall before the contest" },
  { url: `${HALL}/issues/9`, action: "closed", qualifier: "not planned", title: "Weave a second shroud" },
  { url: "https://odysseus:nobody@github.com/ithaca/hall/issues/14", action: "commented", title: "Raft repair estimate" },
  { url: "https://tracker.ogygia-shipyard.example/tickets/4", action: "opened", title: "Order pine for the raft" },
];

/** One event per action, and per qualifier the tone table names. */
export const trackerEveryAction: readonly TrackerEvent[] = [
  { url: `${HALL}/issues/12`, action: "opened", title: "Suitors overstay in the great hall" },
  { url: `${HALL}/issues/7`, action: "closed", qualifier: "completed", title: "Count the suitors" },
  { url: `${HALL}/issues/9`, action: "closed", qualifier: "not planned", title: "Weave a second shroud" },
  { url: `${HALL}/issues/3`, action: "closed", qualifier: "duplicate", title: "Unweave the shroud at night" },
  { url: `${HALL}/issues/5`, action: "reopened", title: "Telemachus sails for Pylos" },
  { url: `${HALL}/pull/21`, action: "merged", title: "Restore the bow to the great hall" },
  { url: `${HALL}/issues/12`, action: "labeled", qualifier: "household", title: "Suitors overstay in the great hall" },
  { url: `${HALL}/issues/14`, action: "commented", title: "Raft repair estimate" },
  { url: `${HALL}/pull/22`, action: "reviewed", qualifier: "approved", title: "Line the twelve axes up" },
  { url: `${HALL}/pull/23`, action: "reviewed", qualifier: "changes requested", title: "Bar the hall doors" },
  { url: `${HALL}/pull/24`, action: "reviewed", title: "Hide the spears in the storeroom" },
];

const TWENTY_TITLES = [
  "Suitors overstay in the great hall",
  "Count the suitors",
  "Weave a second shroud",
  "Unweave the shroud at night",
  "Telemachus sails for Pylos",
  "Ask Nestor after Odysseus",
  "Sail on to Sparta",
  "Hear Menelaus on Proteus",
  "Watch the strait for the suitors' ship",
  "Feed the swine at Eumaeus' hut",
  "Shelter the beggar",
  "Argos knows his master",
  "Eurycleia sees the scar",
  "String the bow",
  "Line the twelve axes up",
  "Bar the hall doors",
  "Hide the spears in the storeroom",
  "Send word to Laertes",
  "Make peace with the suitors' families",
  "Move the bed? It cannot be moved",
] as const;

const CYCLE = ["opened", "labeled", "commented", "closed"] as const;

/** Twenty changes, the most one block carries, across two repositories, so two runs. */
export const trackerTwenty: readonly TrackerEvent[] = TWENTY_TITLES.map((title, i) => ({
  url: i < 12 ? `${HALL}/issues/${30 + i}` : `${VOYAGE}/pull/${i - 11}`,
  action: CYCLE[i % 4]!,
  ...(i % 4 === 1 ? { qualifier: "household" } : i % 4 === 3 ? { qualifier: "completed" } : {}),
  title,
}));

/** The widest fixed part a pill has: `reopened`, a qualifier past the 16 drawn whole, `PR 1234`, and a 200-character title. */
export const trackerLongest: TrackerEvent = {
  url: `${VOYAGE}/pull/1234`,
  action: "reopened",
  qualifier: "waiting on the harbour master",
  title: `Telemachus asks Nestor and then Menelaus whether anyone has word of his father, ${"and the hall waits ".repeat(8)}`.slice(0, 200),
};

/** A tracker whose host is longer than a phone's column. */
export const trackerLongHost: TrackerEvent = {
  url: "https://issues.records.harbour-master.palace-of-odysseus.ithaca.gov.example/browse/HALL-12",
  action: "opened",
  title: "Record the suitors' gifts",
};
