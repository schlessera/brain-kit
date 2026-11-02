/**
 * `brain sync pull` merges a conflicted stats history itself (#3243). Two
 * clones that each record a day append to `.stats-history.jsonl`; without
 * the `.gitattributes` union line (a brain made before 0.40.0 that never ran
 * `brain doctor --fix`) git conflicts on it, and nothing but an agent could
 * resolve it. The fixture brain has no `.gitattributes`, which is that brain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { brainWithRemote, cleanupFixtures, commitAndPush, git, otherClone, syncJson, write, type Brain } from "./sync-fixture";

const HISTORY = ".stats-history.jsonl";
const day = (date: string, at: string, documents: number) => JSON.stringify({ date, at, documents });

afterEach(cleanupFixtures);

/** A pushed history of one day, then a day recorded on another clone and pushed, and `ours` committed here. */
function bothRecorded(ours: string, theirs: string): Brain {
  const brain = brainWithRemote();
  expect(existsSync(join(brain.root, ".gitattributes"))).toBe(false);
  write(brain.root, HISTORY, `${day("2026-07-10", "2026-07-10T21:00:00Z", 40)}\n`);
  git(brain.root, "add", HISTORY);
  git(brain.root, "commit", "-qm", "the first recording");
  git(brain.root, "push", "-q", "origin", "main");
  const other = otherClone(brain);
  commitAndPush(other, { [HISTORY]: readFileSync(join(other, HISTORY), "utf8") + theirs }, "the other clone recorded");
  write(brain.root, HISTORY, readFileSync(join(brain.root, HISTORY), "utf8") + ours);
  git(brain.root, "commit", "-qam", "this clone recorded");
  return brain;
}

describe("a stats history both clones appended to (#3243)", () => {
  test("two clones' different days: merged by day, sorted, with no conflict left for judgment", async () => {
    const brain = bothRecorded(`${day("2026-07-12", "2026-07-12T21:00:00Z", 42)}\n`, `${day("2026-07-11", "2026-07-11T21:00:00Z", 41)}\n`);
    const { code, body } = await syncJson(brain.root, "pull");

    expect(code).toBe(0);
    expect(body.status).toBe("merged");
    expect(body.conflicts).toEqual([]);
    expect(body.mergedCaches).toContain(HISTORY);
    expect(readFileSync(join(brain.root, HISTORY), "utf8")).toBe(
      [day("2026-07-10", "2026-07-10T21:00:00Z", 40), day("2026-07-11", "2026-07-11T21:00:00Z", 41), day("2026-07-12", "2026-07-12T21:00:00Z", 42)].join("\n") + "\n"
    );
    // Committed: the merge is finished, nothing unmerged or staged is left behind.
    expect(git(brain.root, "status", "--porcelain")).toBe("");
    expect(git(brain.root, "rev-list", "--count", "origin/main..HEAD")).toBe("2");
  });

  test("one day both clones recorded resolves to the later recording", async () => {
    const brain = bothRecorded(`${day("2026-07-12", "2026-07-12T22:30:00Z", 43)}\n`, `${day("2026-07-12", "2026-07-12T21:00:00Z", 42)}\n`);
    const { code, body } = await syncJson(brain.root, "pull");

    expect(code).toBe(0);
    expect(body.conflicts).toEqual([]);
    expect(readFileSync(join(brain.root, HISTORY), "utf8")).toBe(
      [day("2026-07-10", "2026-07-10T21:00:00Z", 40), day("2026-07-12", "2026-07-12T22:30:00Z", 43)].join("\n") + "\n"
    );
  });

  test("a side that is not a history is left unmerged for judgment, never rewritten", async () => {
    const brain = bothRecorded("Penelope's loom count, by hand\n", `${day("2026-07-11", "2026-07-11T21:00:00Z", 41)}\n`);
    const { body } = await syncJson(brain.root, "pull");

    expect(body.status).toBe("conflicted");
    expect(body.conflicts).toEqual([HISTORY]);
    expect(body.mergedCaches).not.toContain(HISTORY);
    expect(git(brain.root, "ls-files", "--unmerged", "--", HISTORY)).not.toBe("");
  });
});
