import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import matter from "gray-matter";

import { createBrainAccess } from "../src/brain-access";
import { makeIndexedBrain, type TempBrain } from "./helpers";

// pi's brain_update archives the way brain_archive does (#450): a primary or
// missing relevance becomes historical, an explicit secondary stays.
const doc = (relevance: string | null) =>
  ["---", "title: Demo", "type: note", "status: active", ...(relevance ? [`relevance: ${relevance}`] : []), "updated: 2026-01-05", "---", "", "Body.", ""].join("\n");

let brain: TempBrain;
beforeAll(async () => {
  brain = await makeIndexedBrain({ "notes/demo.md": doc("primary") });
});
afterAll(() => brain.cleanup());

async function update(relevance: string | null, input: { status?: "active" | "archived" | "draft"; relevance?: "primary" | "secondary" | "historical" }) {
  writeFileSync(join(brain.root, "notes/demo.md"), doc(relevance));
  await createBrainAccess(brain.root).update({ path: "notes/demo.md", ...input });
  return matter(readFileSync(join(brain.root, "notes/demo.md"), "utf8"), {}).data.relevance;
}

test("archiving a primary document demotes it to historical", async () => {
  expect(await update("primary", { status: "archived" })).toBe("historical");
});

test("archiving a document with no relevance sets historical", async () => {
  expect(await update(null, { status: "archived" })).toBe("historical");
});

test("an explicit secondary survives archiving", async () => {
  expect(await update("secondary", { status: "archived" })).toBe("secondary");
});

test("a relevance set in the same call wins", async () => {
  expect(await update("primary", { status: "archived", relevance: "primary" })).toBe("primary");
});

test("a status other than archived leaves relevance alone", async () => {
  expect(await update("primary", { status: "draft" })).toBe("primary");
});
