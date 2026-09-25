/**
 * `brain briefing`'s stale section follows the taxonomy's staleness
 * thresholds (#415): `findStale`, the definition `brain audit` and
 * `brain stats` share, not a hard-coded 30 days on `context`.
 *
 * Briefing measures against the wall clock. The fixture dates are written
 * relative to a fixed NOW and briefing runs in-process with the clock pinned
 * to it, so a run that crosses UTC midnight cannot shift an age by a day.
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { generateBriefing } from "../src/cli/commands/briefing";
import { initContext } from "../src/lib/context";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const DAY = 86_400_000;
const NOW = new Date("2026-07-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

const brains: string[] = [];
afterAll(() => { for (const dir of brains) cleanup(dir); });

function doc(type: string, updated: string, status = "active"): string {
  return `---\ntype: ${type}\ntitle: "A ${type}"\ncreated: 2026-01-01\nupdated: ${updated}\ntags: [t]\nstatus: ${status}\n---\n\nBody.\n`;
}

/** Build and index a brain, run the briefing at NOW, return its stale section's lines. */
async function staleSection(config: string, files: Record<string, string>): Promise<string[]> {
  const root = makeTempBrain({ empty: true });
  brains.push(root);
  writeFileSync(join(root, "brain.config.ts"), config);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  const brain = await initContext({ root });
  setSystemTime(NOW);
  let stdout: string;
  try {
    stdout = generateBriefing(brain);
  } finally {
    setSystemTime();
  }
  const section = stdout.split("\n## Stale Documents\n")[1];
  if (section === undefined) return [];
  return section.split("\n## ")[0]!.split("\n").filter((line) => line.startsWith("- "));
}

const paths = (lines: string[]) => lines.map((line) => line.split(" | ")[1]);

describe("with a configured 10-day type", () => {
  const config = `export default { taxonomy: { types: { logbook: { dir: "logbook", staleDays: 10 } } } };\n`;
  const files = {
    "logbook/eleven.md": doc("logbook", daysAgo(11)),
    "logbook/nine.md": doc("logbook", daysAgo(9)),
    "logbook/thirty.md": doc("logbook", daysAgo(30)),
    "context/old.md": doc("context", daysAgo(45)),
    "context/shelved.md": doc("context", daysAgo(400), "archived"),
  };
  let lines: string[];
  beforeAll(async () => {
    lines = await staleSection(config, files);
  });

  test("a doc one day past its type's staleDays is listed", () => {
    expect(paths(lines)).toContain("logbook/eleven.md");
  });

  test("a doc inside its type's staleDays is not", () => {
    expect(paths(lines)).not.toContain("logbook/nine.md");
  });

  test("a context doc past the core 30 days still is", () => {
    expect(paths(lines)).toContain("context/old.md");
  });

  test("an archived doc never is, however old", () => {
    expect(paths(lines)).not.toContain("context/shelved.md");
  });

  test("most overdue first, each line in the existing form", () => {
    // Overdue by: logbook/thirty.md 20 days, context/old.md 15 (the oldest),
    // logbook/eleven.md 1.
    expect(paths(lines)).toEqual(["logbook/thirty.md", "context/old.md", "logbook/eleven.md"]);
    expect(lines[1]).toBe(`- ${daysAgo(45)} (45d ago) | context/old.md | A context`);
  });
});

test("a brain that sets context.staleDays: 60 does not list a 45-day-old context doc", async () => {
  const config = `export default { taxonomy: { types: { context: { dir: "context", staleDays: 60 } } } };\n`;
  const lines = await staleSection(config, {
    "context/old.md": doc("context", daysAgo(45)),
    "context/older.md": doc("context", daysAgo(61)),
  });
  // The section is there, so the absence below is about the threshold.
  expect(paths(lines)).toContain("context/older.md");
  expect(paths(lines)).not.toContain("context/old.md");
});
