import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

import { createBrainAccess } from "../src/brain-access";
import { makeIndexedBrain, type TempBrain } from "./helpers";

// pi's brain_update archives the way brain_archive does (#450): a primary or
// missing relevance becomes historical, whether it is the document's or passed
// in the same call; an explicit secondary stays.
const doc = (relevance: string | null) =>
  ["---", "title: Demo", "type: note", "status: active", ...(relevance ? [`relevance: ${relevance}`] : []), "updated: 2026-01-05", "---", "", "Body.", ""].join("\n");

let brain: TempBrain;
beforeAll(async () => {
  brain = await makeIndexedBrain({ "notes/demo.md": doc("primary") });
});
afterAll(() => brain.cleanup());

async function updateWithChanges(relevance: string | null, input: { status?: "active" | "archived" | "draft"; relevance?: "primary" | "secondary" | "historical" }) {
  writeFileSync(join(brain.root, "notes/demo.md"), doc(relevance));
  const { changes } = await createBrainAccess(brain.root).update({ path: "notes/demo.md", ...input });
  return { changes, relevance: parseFrontmatter(readFileSync(join(brain.root, "notes/demo.md"), "utf8")).data.relevance };
}

const update = async (...args: Parameters<typeof updateWithChanges>) => (await updateWithChanges(...args)).relevance;

test("archiving a primary document demotes it to historical and reports the change", async () => {
  const out = await updateWithChanges("primary", { status: "archived" });
  expect(out.relevance).toBe("historical");
  expect(out.changes).toEqual(["status", "relevance"]);
});

test("archiving a document with no relevance sets historical", async () => {
  expect(await update(null, { status: "archived" })).toBe("historical");
});

test("an explicit secondary survives archiving", async () => {
  expect(await update("secondary", { status: "archived" })).toBe("secondary");
});

test("a primary passed in the same call is demoted too, reported once", async () => {
  const out = await updateWithChanges("secondary", { status: "archived", relevance: "primary" });
  expect(out.relevance).toBe("historical");
  expect(out.changes).toEqual(["status", "relevance"]);
});

test("a secondary passed in the same call is kept", async () => {
  expect(await update("primary", { status: "archived", relevance: "secondary" })).toBe("secondary");
});

test("a status other than archived leaves relevance alone", async () => {
  expect(await update("primary", { status: "draft" })).toBe("primary");
});
