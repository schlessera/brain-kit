// Pending follow-ups: what Odysseus typed while the agent was still busy with
// the raft (D52 §3, #1002). In send order, oldest first. None has a #1004
// label yet except the first, so the rest print the start of their text.

import type { PendingFollowUp } from "../src/chrome/PendingFollowUps.js";

export const pendingFollowUps: PendingFollowUp[] = [
  { id: "follow-up:winds", label: "Winds from Aeolus", text: "Also ask what Aeolus said about the west wind, and whether the bag can stay shut until we sight Ithaca." },
  { id: "follow-up:timber", text: "Count the timber again once Calypso's axe is back." },
  { id: "follow-up:water", text: "Add two more jars of water to the raft list." },
  { id: "follow-up:penelope", text: "Draft a short note to Penelope saying I am on my way." },
  { id: "follow-up:hermes", text: "Remind me what Hermes said about the moly." },
];

/** A prompt long enough that the popover must wrap and scroll, never widen. */
export const longFollowUp: PendingFollowUp = {
  id: "follow-up:route",
  text:
    "Before we leave Ogygia, compare the route Circe gave against the one Teiresias described in the house of the dead: " +
    "which islands each one passes, where the Sirens sit, whether we have to choose between Scylla and Charybdis on both, " +
    "and how many days of water each leg needs if the wind fails. Put the differences in a table, mark anything Teiresias " +
    "warned about, and do not change the raft list until I have read it.",
};
