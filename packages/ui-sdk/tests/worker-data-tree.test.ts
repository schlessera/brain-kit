/**
 * A strict turn's data tree (#2848): read-only at a fixed path, its index
 * read-only over `.brain-index/` unless the host's updater writes it, the
 * provider masks repeated on it, and brain tools pointed at it while
 * configuration stays at the frozen brain path.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataTreeMounts } from "../src/server/worker-protection";
import { prepareWorkerSandbox, workerCommand } from "../src/server/worker-launcher";
import { WORKER_DATA_ROOT, workerSandboxNote, type WorkerDataTree } from "../src/server/worker-sandbox";
import { createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function layout() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-data-tree-")); roots.push(root);
  const brain = join(root, "brain"), tree = join(root, "tree"), index = join(root, "index");
  for (const dir of [join(brain, "notes"), join(tree, ".brain-index"), join(tree, "notes"), index]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(brain, "notes/raft.md"), "---\ntype: note\n---\nOdysseus lashes the raft.\n");
  return { root, brain, tree, index };
}

test("the tree and its index mount read-only; only the host's updater writes the index", () => {
  const { brain, tree, index } = layout();
  expect(dataTreeMounts(brain, WORKER_DATA_ROOT, { root: tree, index }), "AGENT_SEES_A_READ_ONLY_TREE_AND_INDEX")
    .toEqual(["--ro-bind", tree, WORKER_DATA_ROOT, "--ro-bind", index, join(WORKER_DATA_ROOT, ".brain-index")]);
  expect(dataTreeMounts(brain, WORKER_DATA_ROOT, { root: tree, index, indexWritable: true }).slice(3), "UPDATER_WRITES_THE_INDEX")
    .toEqual(["--bind", index, join(WORKER_DATA_ROOT, ".brain-index")]);
});

test("a tree under provider rules repeats the masks: folders read empty and the caches read as nothing", () => {
  const { brain, tree, index } = layout();
  mkdirSync(join(tree, "me")); writeFileSync(join(tree, ".context-cache.jsonl"), "{}\n");
  expect(dataTreeMounts(brain, WORKER_DATA_ROOT, { root: tree, index, masked: ["me", "health"] }).slice(6), "MASKS_REPEATED_ON_THE_TREE").toEqual([
    "--ro-bind", "/dev/null", join(WORKER_DATA_ROOT, ".context-cache.jsonl"),
    "--tmpfs", join(WORKER_DATA_ROOT, "me"), "--remount-ro", join(WORKER_DATA_ROOT, "me"),
  ]);
  expect(dataTreeMounts(brain, WORKER_DATA_ROOT, { root: tree, index }).length, "NO_PROVIDER_RULES_NO_MASKS").toBe(6);
});

test("a tree must be an unaliased directory outside the brain, holding the index mount point", () => {
  const { root, brain, tree, index } = layout();
  const inside = join(brain, "tree"); mkdirSync(join(inside, ".brain-index"), { recursive: true });
  expect(() => dataTreeMounts(brain, WORKER_DATA_ROOT, { root: inside, index }), "TREE_INSIDE_THE_BRAIN_REFUSED").toThrow("outside the brain");
  expect(() => dataTreeMounts(brain, WORKER_DATA_ROOT, { root: tree, index: join(tree, "notes") }), "INDEX_INSIDE_THE_TREE_REFUSED").toThrow("outside its data tree");
  const bare = join(root, "bare"); mkdirSync(bare);
  expect(() => dataTreeMounts(brain, WORKER_DATA_ROOT, { root: bare, index }), "INDEX_MOUNT_POINT_REQUIRED").toThrow(".brain-index is missing");
});

test("a strict worker's brain tools read the tree; configuration stays at the frozen brain path", () => {
  const { brain, tree, index } = layout();
  const view = createFixtureWorkerStartupView(brain);
  try {
    const dataTree: WorkerDataTree = { root: tree, index };
    const sandbox = { ...prepareWorkerSandbox(brain, { profile: "strict", areas: [] }), dataTree };
    const argv = workerCommand({ brainPath: brain, startupView: view, sandbox, env: { BRAIN_ROOT: brain }, command: ["/bin/true"] });
    const env = (name: string) => argv.flatMap((arg, at) => arg === "--setenv" && argv[at + 1] === name ? [argv[at + 2]] : []).at(-1);
    expect(env("BRAIN_ROOT"), "BRAIN_TOOLS_USE_THE_TREE").toBe(WORKER_DATA_ROOT);
    expect(env("BRAIN_WORKER_DATA_ROOT"), "THE_TREE_IS_THE_DATA_ROOT").toBe(WORKER_DATA_ROOT);
    expect(env("BRAIN_WORKER_CONFIG_ROOT"), "CONFIGURATION_FROM_THE_FROZEN_BRAIN_PATH").toBe(brain);
    expect(argv.join(" "), "THE_TREE_IS_MOUNTED").toContain(`--ro-bind ${tree} ${WORKER_DATA_ROOT}`);
    expect(argv.join(" "), "THE_VIEW_STAYS_AT_THE_BRAIN_PATH").toContain(`--ro-bind ${view.root} ${brain}`);
    const governed = { ...prepareWorkerSandbox(brain, { profile: "governed", areas: [] }), dataTree };
    expect(() => workerCommand({ brainPath: brain, sandbox: governed, env: {}, command: ["/bin/true"] }), "A_GOVERNED_WORKER_READS_THE_LIVE_BRAIN").toThrow("immutable startup view");
    expect(() => workerCommand({ brainPath: brain, sandbox, env: {}, command: ["/bin/true"] }), "A_TREE_NEEDS_THE_FROZEN_VIEW").toThrow("immutable startup view");
  } finally { view.cleanup(); }
});

test("the sandbox note names the data path, and a masked turn's index is read-only", () => {
  const { brain, tree, index } = layout();
  const strict = prepareWorkerSandbox(brain, { profile: "strict", areas: [] });
  expect(workerSandboxNote(strict), "NO_TREE_NO_DATA_PATH").not.toContain(WORKER_DATA_ROOT);
  const note = workerSandboxNote({ ...strict, dataTree: { root: tree, index }, providerMasks: { folders: ["me"], index } });
  expect(note, "NOTE_NAMES_THE_DATA_PATH").toContain(`\`${WORKER_DATA_ROOT}/\`: the documents as the turn started plus every change this turn applied`);
  expect(note, "NOTE_SAYS_THE_PRIVATE_INDEX_IS_READ_ONLY").toContain("It is read-only: the host adds this turn's own applications to it");
  expect(note).not.toContain("write to it");
});
