/**
 * The rules a hosted agent worker's write areas follow, worded once.
 *
 * Internal to brain-kit: reached through
 * `@schlessera/brain-common/internal/worker-areas`, with no compatibility
 * promise (docs/decisions/public-export-boundary.md). Two packages state these
 * rules to the agent and neither may depend on the other: the ui-sdk's
 * sandbox note (`workerSandboxNote`) tells the agent before the turn starts,
 * and core's `brain` CLI refusal (`readOnlyBrainError`) tells it again when a
 * write hits the read-only brain. Both render from here, so the refusal
 * repeats the note's rule word for word (#1654).
 *
 * Each rule takes the area paths it names, so a caller renders it from the
 * paths it actually resolved rather than from a copy of them.
 */

import { join } from "node:path";

/** The brain's packaged commands precede the otherwise unchanged worker PATH. */
export function brainWorkerPath(brain: string, previous: string | undefined): string {
  return `${join(brain, "node_modules", ".bin")}:${previous ?? "/usr/local/bin:/usr/bin:/bin"}`;
}

/** Repo-relative persistent scratch directory: kept across turns, gitignored, the place to link. */
export const BRAIN_SCRATCH_DIR = ".brain/scratch";
/** Repo-relative directory for clones of other repositories; never indexed. */
export const BRAIN_WORKSPACES_DIR = "workspaces";
/** The places that make up a worker's turn temp. */
export const TURN_TEMP_PLACES = "`$BRAIN_WORKER_SCRATCH`, `/tmp` and the per-turn XDG directories";

/** Turn temp is never linked: the reader cannot open it, and it is gone at turn end. */
export const TURN_TEMP_RULE = "It is deleted when the turn ends: use it for intermediate work only, and never link to a file there.";

/** The turn-temp rule with the places it covers. */
export function turnTempRule(places: string = TURN_TEMP_PLACES): string {
  return `Turn temp is ${places}. ${TURN_TEMP_RULE}`;
}

/** Where a file the reader should open goes, and what a link may point at. */
export function linkRule(scratchDir: string | undefined): string {
  return scratchDir === undefined
    ? "A link in your answer must point into the brain."
    : `Anything the reader should open goes in \`${scratchDir}/\` and is linked from there: a link in your answer must point into the brain or \`${scratchDir}/\`.`;
}

/** Why a direct write into a read-only brain fails, and the way to change it instead. */
export const READ_ONLY_BRAIN_RULE =
  "The brain is read-only here: change it through `write_file`, `edit_file` and the curated brain tools.";
