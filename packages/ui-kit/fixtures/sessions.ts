// Working sessions: the chats Odysseus left while they were busy (D52 §4).
//
// One session per tracker state, in display order, so a story can show every
// word and tone and a test can count them. Times are host times relative to
// the pinned instant -- 06:40 on Ogygia -- and the ones a state does not print
// are absent, never guessed. `onOpen` is the story's: a fixture is data.

import type { WorkingSession } from "../src/chrome/SessionStrip.js";
import { REFERENCE_INSTANT } from "./time.js";

export type WorkingFixture = Omit<WorkingSession, "onOpen">;

/** The pinned "now", in epoch milliseconds, for every age the strip prints. */
export const WORKING_NOW = REFERENCE_INSTANT.getTime();

const minutesAgo = (n: number) => WORKING_NOW - n * 60_000;

/** `HH:MM` on Ogygia (UTC+2), whatever zone the browser runs in. */
export function ogygiaClock(ms: number): string {
  return new Date(ms + 2 * 3_600_000).toISOString().slice(11, 16);
}

export const workingSessions: WorkingFixture[] = [
  { id: "session:raft-lashing", label: "Raft lashing plan", state: "needs-you", need: "approval" },
  { id: "session:omen-inbox", label: "Omen inbox triage", state: "failed", outcome: "interrupted", startedAt: minutesAgo(31), endedAt: minutesAgo(28) },
  { id: "session:hermes", label: "Question for Hermes", state: "unconfirmed" },
  { id: "session:timber", label: "Raft timber tally", state: "running", startedAt: minutesAgo(2) },
  { id: "session:ships-log", label: "Ship's log summary", state: "queued", queueNote: "3 turns ahead of this one" },
  { id: "session:moly", label: "Moly field notes", state: "unknown" },
  { id: "session:harbour", label: "Harbour dues at Scheria", state: "cant-check", reason: "host unreachable" },
  { id: "session:penelope", label: "Letter to Penelope", state: "done", startedAt: minutesAgo(9), endedAt: minutesAgo(4) },
  { id: "session:photos", label: "Rename voyage photos", state: "cancelled", startedAt: minutesAgo(40), endedAt: minutesAgo(38) },
];

/** Pick by state, for the stories' smaller sets. */
export const workingByState = Object.fromEntries(workingSessions.map((s) => [s.state, s])) as Record<WorkingSession["state"], WorkingFixture>;

/** A title the pill must truncate and the sheet must still open. */
export const longWorkingSession: WorkingFixture = {
  id: "session:circe-route",
  label: "Compare Circe's sailing directions against the forecast from the house of the dead",
  state: "running",
  startedAt: minutesAgo(12),
};
