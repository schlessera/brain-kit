import { expect, test } from "bun:test";
import { DEFAULT_EXCLUDE } from "../packages/core/src/lib/config.ts";
import { SCRATCH_DIR } from "../packages/core/src/lib/scratch.ts";
import { buildTaxonomy } from "../packages/core/src/lib/taxonomy.ts";
import { BRAIN_SCRATCH_DIR, BRAIN_WORKSPACES_DIR } from "../packages/ui-sdk/src/server/worker-sandbox.ts";

// The worker binds these two directories writable (#1626). ui-sdk does not
// depend on core, so it names them itself; this keeps the two in step, and
// keeps the workspace area out of the index in every brain.
test("the worker's writable areas are core's scratch area and an always-excluded directory", () => {
  expect(BRAIN_SCRATCH_DIR).toBe(SCRATCH_DIR);
  expect(DEFAULT_EXCLUDE.dirs).toContain(BRAIN_WORKSPACES_DIR);
  // A brain's own exclusions add to the defaults; none can take `workspaces` out.
  const taxonomy = buildTaxonomy({ user: { exclude: { dirs: ["drafts"] } } });
  expect(taxonomy.isExcludedPath("drafts/odyssey.md")).toBe(true);
  expect(taxonomy.isExcludedPath(`${BRAIN_WORKSPACES_DIR}/ithaca/notes.md`)).toBe(true);
});
