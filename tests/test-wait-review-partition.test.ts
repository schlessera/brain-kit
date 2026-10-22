// The test-wait review partition must stay recomputable from what it cites.
//
// `docs/process/evidence/test-wait-review-partition.json` pins the 122
// source-family review rows of the #1855 accounting, the 46 rows that delivered
// observations already cover, and the 76 remaining rows split across #2630,
// #2631 and #2632 by a fixed file-path rule. Each count was once a sentence in
// an issue comment that nobody could reproduce. This test recomputes every one
// of them from the operational basis and the cited observation artifacts, binds
// each artifact to the squash that delivered it, and checks every review's pin
// against the file as it was at the reviewed checkout. A hand-edited row, a
// moved boundary, a drifted artifact or a stale pin is a red build. It reads
// Git objects, which CI's full-history checkout provides.

import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const EVIDENCE = join(import.meta.dir, "..", "docs", "process", "evidence");
const read = (file: string) => readFileSync(join(EVIDENCE, file));
const json = (file: string) => JSON.parse(read(file).toString());
const sha256 = (file: string) => createHash("sha256").update(read(file)).digest("hex");
const sorted = (rows: Iterable<number>) => [...new Set(rows)].sort((a, b) => a - b);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A file's bytes at a commit. CI checks out full history, so a missing object is a failure, not a skip. */
function blobAt(commit: string, file: string): Buffer {
  const shown = Bun.spawnSync(["git", "show", `${commit}:${file}`], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  if (shown.exitCode !== 0) throw new Error(`git show ${commit}:${file}: ${shown.stderr.toString().trim()}`);
  return shown.stdout;
}

const partition = json("test-wait-review-partition.json");
const basis = json(partition.source.basisArtifact.split("/").pop());

/** Resolve `a.b[].c` against a parsed artifact; arrays reached at the end are flattened. */
function resolveRows(document: unknown, path: string): number[] {
  let values: unknown[] = [document];
  for (const segment of path.split(".")) {
    const each = segment.endsWith("[]");
    const key = each ? segment.slice(0, -2) : segment;
    values = values.flatMap((value) => {
      const next = (value as Record<string, unknown>)[key];
      if (next === undefined) throw new Error(`${path}: missing ${key}`);
      return each ? (next as unknown[]) : [next];
    });
  }
  return sorted(values.flat().map((value) => {
    const row = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(row)) throw new Error(`${path}: ${JSON.stringify(value)} is not a row index`);
    return row as number;
  }));
}

/** The shared rule from #2630, #2631 and #2632: first match wins. */
function inventoryFor(file: string, nativeSubstrings: string[]): number {
  if (file.startsWith("packages/ui-react/tests/") || file.startsWith("packages/ui-kit/tests/") || file.includes("scrape/tests/browser")) return 2632;
  if (nativeSubstrings.some((part) => file.includes(part))) return 2631;
  return 2630;
}

const NATIVE = ["fixtures/", "-child.ts", "-probe.ts", "worker", "helpers/host-processes", "maintenance-temp", "exec-wrapper", "subscription", "runtime-probe", "boot"];

describe("test-wait review partition", () => {
  const selected = basis.sourceRows.filter((row: { runtimeClassification: string }) =>
    partition.selection.runtimeClassifications.includes(row.runtimeClassification));

  test("is bound to the unchanged operational basis", () => {
    expect(sha256("test-wait-operational-basis.json")).toBe(partition.source.basisSha256);
    expect(basis.source).toBe(partition.source.basisFrozenSource);
  });

  test("pins exactly the 122 selected basis rows", () => {
    expect(selected.length).toBe(122);
    expect(partition.rows.map((row: { index: number; file: string }) => [row.index, row.file]))
      .toEqual(selected.map((row: { index: number; file: string }) => [row.index, row.file]));
  });

  test("recomputes the 46-row delivered union from the cited artifacts", () => {
    const delivered = new Set<number>();
    for (const component of partition.deliveredUnion.components) {
      expect(sha256(component.artifact), component.artifact).toBe(component.sha256);
      // The artifact is the one its delivering squash merged, not a later edit with a matching hash.
      expect(hash(blobAt(component.squash, `docs/process/evidence/${component.artifact}`)), component.artifact).toBe(component.sha256);
      const document = json(component.artifact);
      for (const { path, rows } of component.paths) {
        expect(resolveRows(document, path), `${component.artifact}#${path}`).toEqual(rows);
        for (const row of rows) delivered.add(row);
      }
    }
    const marked = partition.rows.filter((row: { status: string }) => row.status === "delivered").map((row: { index: number }) => row.index);
    expect(sorted(delivered)).toEqual(marked);
    expect(delivered.size).toBe(46);
    expect(partition.deliveredUnion.total).toBe(46);

    // The 38 published at #1959 is the same union before #1954's artifacts.
    const before = new Set(partition.deliveredUnion.components
      .filter((component: { pr: number }) => component.pr !== 1954)
      .flatMap((component: { paths: { rows: number[] }[] }) => component.paths.flatMap((path) => path.rows)));
    expect(before.size).toBe(38);
  });

  test("assigns each of the 76 remaining rows to exactly one inventory by the shared rule", () => {
    expect(partition.partitionRule.rules[1].substrings).toEqual(NATIVE);
    const review = partition.rows.filter((row: { status: string }) => row.status === "review");
    expect(review.length).toBe(76);
    for (const row of review) expect(row.issue, `row ${row.index} ${row.file}`).toBe(inventoryFor(row.file, NATIVE));
    const listed = [2630, 2631, 2632].flatMap((issue) => partition.partition[issue]);
    expect(sorted(listed)).toEqual(review.map((row: { index: number }) => row.index));
    expect(listed.length).toBe(new Set(listed).size);
    for (const issue of [2630, 2631, 2632]) {
      expect(partition.partition[issue]).toEqual(review.filter((row: { issue: number }) => row.issue === issue).map((row: { index: number }) => row.index));
      expect(partition.counts.byIssue[issue]).toBe(partition.partition[issue].length);
    }
  });

  test("records exactly one complete review for each remaining row", () => {
    const review = partition.rows.filter((row: { status: string }) => row.status === "review");
    expect(partition.reviews.map((entry: { index: number; issue: number }) => [entry.index, entry.issue]))
      .toEqual(review.map((row: { index: number; issue: number }) => [row.index, row.issue]));
    const followUps = new Map<number, string>();
    for (const { issue, rows } of partition.followUps) for (const row of rows) followUps.set(row, issue);

    for (const entry of partition.reviews) {
      const where = `row ${entry.index}`;
      const { pinned, ownership, classification, observation } = entry;
      expect(pinned.checkout, where).toBe(partition.reviewMethod.checkout);
      expect(pinned.file, where).toBe(review.find((row: { index: number }) => row.index === entry.index).file);
      const blob = blobAt(pinned.checkout, pinned.file);
      expect(hash(blob), where).toBe(pinned.fileSha256);
      expect(pinned.enclosing, where).toBeTruthy();
      expect(pinned.callers.length, where).toBeGreaterThan(0);
      expect(classification.basis, where).toBeTruthy();
      expect(["source", "control-flow inference", "observation"], where).toContain(classification.basisType);

      if (classification.kind === "retired") {
        expect(pinned.line, where).toBeNull();
        expect(ownership.retired?.commit, where).toMatch(/^[0-9a-f]{40}$/);
      } else {
        expect(blob.toString().split("\n")[pinned.line - 1]?.trim(), where).toBe(pinned.source.trim());
      }
      // An observed run is never inferred, and its instrumentation was undone.
      expect(observation !== null, where).toBe(classification.basisType === "observation");
      if (observation) {
        expect(observation.command, where).toBeTruthy();
        expect(observation.checkout, where).toBe(partition.reviewMethod.checkout);
        expect(observation.restoredSha256, where).toEqual(observation.sourceSha256);
        expect(typeof observation.calls, where).toBe("number");
        expect(Array.isArray(observation.elapsedMs), where).toBe(true);
        expect(observation.calls === 0 || observation.elapsedMs.length > 0, where).toBe(true);
        expect(observation.guards, where).toBeTruthy();
        expect(observation.result, where).toBeTruthy();
      }
      if (classification.kind !== "observed" && classification.kind !== "retired") {
        expect(classification.noElapsedMinimumImplied, where).toBe(true);
      }
      if (entry.issue === 2630 && /failure ceiling|watchdog/.test(classification.kind)) expect(classification.raceWinner, where).toBeTruthy();
      if (entry.issue === 2631 && /hold|keepalive/.test(classification.kind)) expect(classification.holdEnd, where).toBeTruthy();
      if (entry.issue === 2632 && classification.kind !== "retired") {
        expect(classification.browserClock?.dependsOn, where).toBeTruthy();
        expect(typeof classification.browserClock?.jsTimerControlAdvances, where).toBe("boolean");
      }
      expect(entry.followUp ?? null, where).toBe(followUps.get(entry.index) ?? null);
    }
  });
});
