/**
 * One hygiene repair or check builds its in-memory projection once (#4776).
 *
 * `resolveHygiene` used to run a complete in-memory index three times (before
 * the repair, for the post-check and again inside `markResolved`), each with
 * the graph precompute nobody reads. These tests record every index run the
 * repair path makes, check that the detection after the targeted refresh is
 * the one a fresh complete build gives, and that a check builds once.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { brainConfigSchema } from "../src/lib/config";
import type { BrainContext } from "../src/lib/context";
import * as hygiene from "../src/lib/hygiene";
import { HYGIENE_DIR, hygieneId, readHygieneLog } from "../src/lib/hygiene";
import { checkHygiene, repairDetection, resolveHygiene } from "../src/lib/hygiene-repair";
import * as indexer from "../src/lib/indexer";
import type { IndexOptions } from "../src/lib/indexer/types";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const DOC = "journeys/return-to-ithaca.md";
const NOW = new Date("2026-07-12T12:00:00Z");
const RECEIPT = new RegExp(`^${HYGIENE_DIR}/repairs/[0-9a-f]{32}\\.md$`);

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const note = (title: string | null, body: string) =>
  `---\n${title === null ? "" : `title: '${title}'\n`}type: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\n\n${body}\n`;

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function brain(doc: string): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  write(root, "brain.config.json", JSON.stringify({ taxonomy: {} }));
  write(root, DOC, doc);
  write(root, "places/eumaeus-hut.md", note("Eumaios hut", "The swineherd's hut."));
  return root;
}

const context = (root: string): BrainContext => ({
  root,
  dbPath: join(root, ".brain-index", "brain.db"),
  config: null,
  configPath: join(root, "brain.config.json"),
  modules: [],
  taxonomy: buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: {} }) }),
});

/** Open the finding in the hygiene log, as `brain hygiene` does, and return its fingerprint. */
async function open(root: string, id: string): Promise<string> {
  const run = await runCli(root, ["hygiene", "reconcile", "--json"]);
  expect(run.code, run.stderr).toBe(0);
  const finding = JSON.parse(run.stdout).detected.find((f: { id: string }) => f.id === id);
  expect(finding, id).toBeDefined();
  return finding.fingerprint;
}

/** Markdown documents each recorded run read and wrote, in run order. */
let written: number[] = [];

/** Record every index run's options; the runs themselves are real. */
function recordIndexRuns(): IndexOptions[] {
  const runs: IndexOptions[] = [];
  written = [];
  const real = indexer.indexAll;
  spies.push(
    spyOn(indexer, "indexAll").mockImplementation(((db: Parameters<typeof real>[0], options: IndexOptions) => {
      runs.push(options);
      return real(db, options).then((stats) => {
        written.push(stats.added + stats.updated + stats.unchanged);
        return stats;
      });
    }) as typeof real)
  );
  return runs;
}

const CASES = [
  {
    name: "a link repair",
    doc: note("Return to Ithaca", "Odysseus met [[Eumaios hut stop]] at the gate."),
    id: hygieneId("broken-link", DOC, "Eumaios hut stop"),
    handler: "link-text",
    input: null as unknown,
  },
  {
    name: "a required-field repair",
    doc: note(null, "Odysseus came home."),
    id: hygieneId("required-field", DOC, "title"),
    handler: "required-field",
    input: "Return to Ithaca" as unknown,
  },
];

async function apply(root: string, c: (typeof CASES)[number]) {
  const brainContext = context(root);
  const expectFingerprint = await open(root, c.id);
  const preview = await resolveHygiene(brainContext, { id: c.id, handler: c.handler, input: c.input, expectFingerprint, dryRun: true }, { now: NOW });
  expect(preview.status).toBe("preview");
  return () => resolveHygiene(brainContext, { id: c.id, handler: c.handler, input: c.input, expectFingerprint, expectPreview: preview.previewToken }, { now: NOW });
}

describe("one projection per hygiene operation", () => {
  for (const c of CASES) {
    test(`${c.name} makes one complete build and one targeted run of the document and its receipt, all without the graph`, async () => {
      const root = brain(c.doc);
      const resolve = await apply(root, c);
      const runs = recordIndexRuns();
      const result = await resolve();
      expect(result.status).toBe("fixed");
      expect(runs.map((run) => (run.paths === undefined ? "complete" : "targeted"))).toEqual(["complete", "targeted"]);
      expect(runs.map((run) => run.graph)).toEqual([false, false]);
      expect(runs[1].paths?.[0]).toBe(DOC);
      expect(runs[1].paths?.[1]).toMatch(RECEIPT);
      expect(runs[1].paths).toHaveLength(2);
      // The refresh really was targeted: it read the two named files only.
      expect(written[0]).toBeGreaterThan(2);
      expect(written[1]).toBeLessThanOrEqual(2);
      expect(readHygieneLog(root).find((e) => e.id === c.id)).toMatchObject({ state: "resolved", resolvedBy: `handler:${c.handler}` });
    });

    test(`${c.name}: the post-check detection equals a fresh complete build of the same tree`, async () => {
      const root = brain(c.doc);
      const brainContext = context(root);
      const resolve = await apply(root, c);
      const real = hygiene.detectCandidates;
      const compared: Array<{ refreshed: unknown; fresh: unknown }> = [];
      let calls = 0;
      let nested = false;
      spies.push(
        spyOn(hygiene, "detectCandidates").mockImplementation((async (...args: Parameters<typeof real>) => {
          const detection = await real(...args);
          if (nested) return detection;
          calls++;
          if (calls === 2) {
            // The post-check: the tree now holds the repair and its receipt.
            const view = (d: { candidates: hygiene.HygieneCandidate[]; failedChecks: string[] }) => ({
              findings: [...hygiene.canonicalFindings(d.candidates).values()].map((f) => [f.id, f.fingerprint]).sort(),
              failedChecks: d.failedChecks,
            });
            nested = true;
            try {
              compared.push({ refreshed: view(detection), fresh: view(await repairDetection(brainContext, NOW)) });
            } finally {
              nested = false;
            }
          }
          return detection;
        }) as typeof real)
      );
      expect((await resolve()).status).toBe("fixed");
      expect(calls).toBe(2);
      expect(compared).toHaveLength(1);
      expect(compared[0].refreshed).toEqual(compared[0].fresh);
    });
  }

  test("a check of a finding no longer detected makes exactly one complete build", async () => {
    const root = brain(note("Return to Ithaca", "Odysseus met [[Eumaios hut stop]] at the gate."));
    const id = CASES[0].id;
    await open(root, id);
    write(root, DOC, note("Return to Ithaca", "Odysseus met [[Eumaios hut]] at the gate."));
    const runs = recordIndexRuns();
    const result = await checkHygiene(context(root), id, NOW);
    expect(result.status).toBe("not_detected");
    expect(runs).toHaveLength(1);
    expect(runs[0].paths).toBeUndefined();
    expect(runs[0].graph).toBe(false);
    expect(readHygieneLog(root).find((e) => e.id === id)).toMatchObject({ state: "resolved", resolvedBy: "check" });
  });
});
