import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeHostDockerArgs } from "../scripts/prove-native-host";
import { observationTreeOptions, seedObservationTree, traceObserverBootstrap } from "../scripts/native-proof/observation-tree";

test("large observation fixture validates parameter sizes and leaves default Docker arguments unchanged", () => {
  expect(observationTreeOptions(["--observation-timing"])).toBeUndefined();
  expect(observationTreeOptions(["--observation-timing", "--tree=large"])).toEqual({ workspaceEntries: 80000, dependencyEntries: 19000, journalObjects: 30000, checkouts: 40 });
  expect(observationTreeOptions(["--observation-timing", "--tree=large", "--workspace-entries=40000"])).toMatchObject({ workspaceEntries: 40000 });
  for (const bad of [["--tree=large"], ["--observation-timing", "--tree=small"], ["--observation-timing", "--tree=large", "--checkouts=0"],
    ["--observation-timing", "--tree=large", "--journal-objects=-1"]]) expect(() => observationTreeOptions(bad)).toThrow();
  const base = nativeHostDockerArgs("/repo", "/proof/run", "1000", "claude", false, false, "/bun", false, true);
  expect(base.filter(arg => arg.startsWith("--env=BRAIN_NATIVE_PROOF_TREE="))).toEqual([]);
  const sizes = { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 };
  expect(nativeHostDockerArgs("/repo", "/proof/run", "1000", "claude", false, false, "/bun", false, true, sizes))
    .toEqual([...base.slice(0, 6), `--env=BRAIN_NATIVE_PROOF_TREE=${JSON.stringify(sizes)}`, ...base.slice(6)]);
});

test("large tree seed is deterministic and records its generated entries and unavailable cold evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-timing-"));
  try {
    const sizes = { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 };
    mkdirSync(join(root, "brain", "node_modules"), { recursive: true });
    const before = readdirSync(root, { recursive: true }).length;
    const receipt = seedObservationTree(join(root, "brain"), join(root, "objects"), sizes);
    expect(receipt.generatedEntries, "ENTRY_RECEIPT_MATCHES_FILESYSTEM_DELTA").toBe(readdirSync(root, { recursive: true }).length - before);
    expect(receipt).toMatchObject({ ...sizes, generatedFiles: 17, generatedDirectories: 11, generatedEntries: 28,
      coldCache: { available: false, reason: "No isolated cache-drop proof; shared runner cache is never mutated" } });
    const first = readdirSync(join(root, "objects"));
    seedObservationTree(join(root, "second"), join(root, "second-objects"), sizes);
    expect(readdirSync(join(root, "second-objects"))).toEqual(first);
    expect(readFileSync(join(root, "brain/workspaces/ithaca-000/.gitignore"), "utf8")).toBe("node_modules/\n");
    expect(readFileSync(join(root, "brain/workspaces/ithaca-000/node_modules/ship-0/entry-0")).length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("observer bootstrap measures the first actual initialize and preserves failures", async () => {
  let now = 1000;
  const spans: { elapsedMs: number; outcome: string }[] = [];
  const initialize = traceObserverBootstrap(async (fail: boolean) => { now += 300; if (fail) throw Error("unavailable"); return "Ithaca"; }, span => spans.push(span), () => now);
  expect(await initialize(false)).toBe("Ithaca"); expect(await initialize(false)).toBe("Ithaca");
  expect(spans).toEqual([{ elapsedMs: 300, outcome: "completed" }]);
  const failed = traceObserverBootstrap(async () => { now += 200; throw Error("unavailable"); }, span => spans.push(span), () => now);
  await expect(failed()).rejects.toThrow("unavailable");
  expect(spans).toEqual([{ elapsedMs: 300, outcome: "completed" }, { elapsedMs: 200, outcome: "failed" }]);
});


test("directory counts also include implicitly created fixture parents", () => {
  const root = mkdtempSync(join(tmpdir(), "ithaca-parent-count-"));
  try {
    const receipt = seedObservationTree(join(root, "brain"), join(root, "objects"), { workspaceEntries: 8, dependencyEntries: 3, journalObjects: 4, checkouts: 2 });
    expect(receipt.generatedEntries).toBe(readdirSync(root, { recursive: true }).length);
    expect(receipt.generatedDirectories).toBe(13);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
