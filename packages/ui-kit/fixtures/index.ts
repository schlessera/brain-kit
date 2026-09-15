// The Odyssey fixture world -- one import for a story, one namespace each for
// a module that only needs part of it.
//
// Read `README.md` in this directory before adding anything. The short
// version: pin every date to `REFERENCE_DATE`, keep the tone serious, use real
// coordinates, and run `bun scripts/check-leakage.ts` before you finish.

export * from "./types.js";
export * from "./time.js";

export * as people from "./people.js";
export * as places from "./places.js";
export * as projects from "./projects.js";
export * as notes from "./notes.js";
export * as events from "./events.js";
export * as runs from "./runs.js";
export * as actions from "./actions.js";
export * as files from "./files.js";
export * as money from "./money.js";
export * as search from "./search.js";

import * as actionsNs from "./actions.js";
import * as eventsNs from "./events.js";
import * as filesNs from "./files.js";
import * as moneyNs from "./money.js";
import * as notesNs from "./notes.js";
import * as peopleNs from "./people.js";
import * as placesNs from "./places.js";
import * as projectsNs from "./projects.js";
import * as runsNs from "./runs.js";
import * as searchNs from "./search.js";

/**
 * The whole world under one name, for a story that composes a screen out of
 * four modules at once and would otherwise open with ten import lines.
 */
export const odyssey = {
  people: peopleNs,
  places: placesNs,
  projects: projectsNs,
  notes: notesNs,
  events: eventsNs,
  runs: runsNs,
  actions: actionsNs,
  files: filesNs,
  money: moneyNs,
  search: searchNs,
} as const;
