/**
 * Listing a broken link's repair handlers walks the tree once (#4777).
 *
 * `documentPath` walked the whole tree when it was not given the scanned
 * paths, and `suggestedNote` walked it again and then scanned the file list
 * once per file. The counter here is a spy on `fs.readdirSync`: one read of
 * the brain root is one walk.
 */
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { brainConfigSchema } from "../src/lib/config";
import type { BrainContext } from "../src/lib/context";
import { hygieneId } from "../src/lib/hygiene";
import { repairDetection, repairHandlers } from "../src/lib/hygiene-repair";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain } from "./cli-harness";

const DOC = "journeys/return-to-ithaca.md";
const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const note = (title: string, body: string, extra = "") =>
  `---\ntitle: '${title}'\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n${extra}---\n\n${body}\n`;

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const context = (root: string): BrainContext => ({
  root,
  dbPath: join(root, ".brain-index", "brain.db"),
  config: null,
  configPath: join(root, "brain.config.json"),
  modules: [],
  taxonomy: buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: {} }) }),
});

/** Count directory reads of `root` itself: one per tree walk. */
function countWalks(root: string): () => number {
  let walks = 0;
  const real = fs.readdirSync;
  const target = resolve(root);
  spies.push(
    spyOn(fs, "readdirSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && resolve(path) === target) walks++;
      return (real as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readdirSync)
  );
  return () => walks;
}

test("one repairHandlers call for a broken link walks the tree once and still suggests the unique slug", async () => {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  write(root, "brain.config.json", JSON.stringify({ taxonomy: {} }));
  write(root, DOC, note("Return to Ithaca", "Odysseus met [[lost/eumaeus-hut]] at the gate."));
  write(root, "places/eumaeus-hut.md", note("Eumaios hut", "The swineherd's hut."));
  for (let i = 0; i < 20; i++) write(root, `ledger/entry-${i}.md`, note(`Ledger ${i}`, "A day at sea."));
  const brain = context(root);
  const finding = (await repairDetection(brain, new Date("2026-07-12T12:00:00Z"))).findings.get(hygieneId("broken-link", DOC, "lost/eumaeus-hut"));
  expect(finding).toBeDefined();

  const walks = countWalks(root);
  const handlers = repairHandlers(brain, finding!);
  expect(walks()).toBe(1);
  expect(handlers.map((h) => h.name)).toEqual(["link-suggested", "link-note", "link-text"]);
  expect(handlers[0].suggestedPath).toBe("places/eumaeus-hut.md");
  expect(handlers[0].line).toBe(9);
});
