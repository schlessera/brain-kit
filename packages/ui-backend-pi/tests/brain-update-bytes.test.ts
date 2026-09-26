import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { createBrainAccess } from "../src/brain-access";
import { makeIndexedBrain, type TempBrain } from "./helpers";

// pi's brain_update goes through core's frontmatter edit (#449): one field
// changes, every other byte of the frontmatter stays.
const SOURCE = [
  "---",
  "# keep this comment line",
  'title: "Demo"  # and this one',
  "type: note",
  "tags: [one,two]",
  "updated: 2026-01-05",
  "status: active",
  "---",
  "",
  "Body.",
  "",
].join("\n");

let brain: TempBrain;
beforeAll(async () => {
  brain = await makeIndexedBrain({ "notes/demo.md": SOURCE });
});
afterAll(() => brain.cleanup());

test("setting one field leaves the rest of the frontmatter byte-identical", async () => {
  await createBrainAccess(brain.root).update({ path: "notes/demo.md", status: "draft" });
  const today = new Date().toISOString().slice(0, 10);
  expect(readFileSync(join(brain.root, "notes/demo.md"), "utf8")).toBe(
    SOURCE.replace("status: active", "status: draft").replace("updated: 2026-01-05", `updated: ${today}`)
  );
});
