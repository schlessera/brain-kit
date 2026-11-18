/**
 * Where a turn's data tree goes (#2911). A view the native manager acquired
 * gets its tree from that manager, on the managed volume, filled only by
 * reflinks; a copy that cannot share extents fails instead of allocating a
 * full one, and only the manager removes the tree. The manager and Btrfs are
 * doubled: the manager's own rules are proven in the ui-sdk suite and on the
 * native host.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as startup from "../../ui-sdk/src/server/worker-startup-view";
import { prepareNativeWorkerStartupView } from "../../ui-sdk/src/server/worker-startup-view";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
import { createTurnDataTree, TURN_TREE_EFFECT_BYTES, turnTreeAllowance } from "../src/brain/turn-data-tree";
import { usePrivateTmpdir } from "./helpers/private-tmpdir.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const NOTE = "---\ntype: note\ntitle: \"The voyage home\"\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\nOdysseus sails for Ithaca.\n";

/** A managed store with one brain; `tree` decides whether its manager can place turn trees. */
async function fixture(options: { tree?: boolean } = {}) {
  const store = fs.mkdtempSync(join(tmpdir(), "odysseus-tree-placement-")), brain = join(store, "brain");
  cleanups.push(() => fs.rmSync(store, { recursive: true, force: true }));
  fs.mkdirSync(join(brain, "notes"), { recursive: true });
  fs.writeFileSync(join(brain, "notes/voyage.md"), NOTE);
  fs.mkdirSync(join(brain, ".brain-index"));
  const db = new Database(join(brain, ".brain-index/brain.db"));
  db.run("CREATE TABLE odysseus (crew TEXT)"); db.run("INSERT INTO odysseus VALUES ('Eurylochus')"); db.close();
  const actual = fs.statfsSync(store), statfs = spyOn(fs, "statfsSync").mockReturnValue({ ...actual, type: 0x9123683e });
  cleanups.push(() => statfs.mockRestore());
  const calls: string[] = [];
  const manager = {
    async checkpoint(id: string) {
      const path = join(store, ".brain-native", "checkpoints", id); fs.cpSync(brain, path, { recursive: true });
      return { id, path, readOnly: true as const, sourceUuid: "0123456789abcdef0123456789abcdef", fsid: "00000000-0000-0000-0000-000000000001",
        uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" };
    },
    async release(id: string) { fs.rmSync(join(store, ".brain-native", "checkpoints", id), { recursive: true, force: true }); return { id, state: "deleted" as const }; },
    async prepareStage(): Promise<never> { throw Error("no stage in this fixture"); },
    async inspectStage(): Promise<never> { throw Error("no stage in this fixture"); },
    async releaseStage(id: string) { return { id, state: "deleted" as const }; },
    ...(options.tree === false ? {} : {
      async prepareTurnTree(id: string, allowanceBytes: number) {
        calls.push(`prepare ${allowanceBytes}`);
        const path = join(store, ".brain-native", "trees", id); fs.mkdirSync(path, { recursive: true });
        return { id, path, allowanceBytes };
      },
      async releaseTurnTree(id: string) {
        calls.push("release");
        fs.rmSync(join(store, ".brain-native", "trees", id), { recursive: true, force: true });
        return { id, state: "deleted" as const };
      },
    }),
  };
  const view = await prepareNativeWorkerStartupView(brain, manager);
  cleanups.push(() => view.cleanup());
  // Reflinks are what is asked for; a host without Btrfs copies for the test.
  const copy = fsp.copyFile, flags: number[] = [];
  let refuse: string | undefined;
  const spy = spyOn(fsp, "copyFile").mockImplementation((async (from: string, to: string, mode = 0) => {
    flags.push(mode);
    if (refuse) throw Object.assign(Error(`Odysseus's copy refused: ${refuse}`), { code: refuse });
    await copy(from, to, (mode & ~fs.constants.COPYFILE_FICLONE_FORCE) | fs.constants.COPYFILE_FICLONE);
  }) as typeof fsp.copyFile);
  cleanups.push(() => spy.mockRestore());
  // A temporary copy would land in the temp directory, where other processes
  // create trees of their own: list one only this fixture writes to (#4252).
  const tmp = usePrivateTmpdir("odysseus-tree-placement-tmp-");
  cleanups.push(() => tmp.restore());
  const tmpTrees = () => {
    expect(tmpdir(), "TREES_ARE_LISTED_IN_THIS_FIXTURES_OWN_TEMP_DIRECTORY").toBe(tmp.path);
    return fs.readdirSync(tmpdir()).filter(name => name.startsWith("brain-turn-data-"));
  };
  const before = new Set(tmpTrees());
  return { store, brain, view, calls, flags, refuse(code?: string) { refuse = code; },
    newTmpTrees: () => tmpTrees().filter(name => !before.has(name)),
    create: () => createTurnDataTree({ brainPath: brain, view, maskPaths: [], mount: true, update: async () => {}, plan: async () => ({}) }) };
}

test("a managed view's tree is the manager's directory on the volume, filled only by reflinks", async () => {
  const f = await fixture(), tree = await f.create();
  const base = join(f.store, ".brain-native", "trees");
  expect(tree.mount!.root.startsWith(base + "/") && tree.mount!.root.endsWith("/data"), "TREE_ON_THE_MANAGED_VOLUME").toBe(true);
  expect(tree.index, "INDEX_BESIDE_THE_TREE").toBe(join(dirname(tree.mount!.root), "index"));
  expect(fs.readFileSync(join(tree.mount!.root, "notes/voyage.md"), "utf8")).toBe(NOTE);
  expect(fs.existsSync(join(tree.index, "brain.db"))).toBe(true);
  expect(f.flags.length, "DOCUMENTS_AND_INDEX_COPIED").toBe(2);
  expect(f.flags.every(mode => (mode & fs.constants.COPYFILE_FICLONE_FORCE) === fs.constants.COPYFILE_FICLONE_FORCE), "REFLINK_REQUIRED_NOT_REQUESTED").toBe(true);
  // Two view entries (notes/ and its note) and one index file.
  expect(f.calls, "ALLOWANCE_CHARGES_INDEX_AND_EFFECTS").toEqual([`prepare ${turnTreeAllowance(3, fs.statSync(join(f.brain, ".brain-index/brain.db")).size)}`]);
  expect(turnTreeAllowance(2, 0) % 4096).toBe(0);
  expect(f.newTmpTrees(), "NO_TEMPORARY_COPY").toEqual([]);
  await tree.close();
  expect(f.calls.at(-1), "THE_MANAGER_REMOVES_THE_TREE").toBe("release");
  expect(fs.existsSync(tree.mount!.root)).toBe(false);
});

test.each(["EOPNOTSUPP", "EXDEV"])("a copy that cannot share extents fails the turn instead of copying: %s", async code => {
  const f = await fixture();
  f.refuse(code);
  await expect(f.create(), "NO_FULL_COPY_FALLBACK").rejects.toThrow("cannot share the startup view's extents");
  expect(f.calls.at(-1), "FAILED_TREE_RELEASED").toBe("release");
  expect(f.newTmpTrees(), "NO_TEMPORARY_COPY").toEqual([]);
  expect(fs.readdirSync(join(f.store, ".brain-native", "trees"))).toEqual([]);
});

test("a managed view whose manager cannot place a tree is refused, not given a temporary copy", async () => {
  const f = await fixture({ tree: false });
  await expect(f.create(), "MANAGED_VIEW_NEEDS_MANAGED_TREE").rejects.toThrow("no full-copy fallback");
  expect(f.newTmpTrees()).toEqual([]);
});

test("a turn's effects past the tree's allowance stop entering it and its index reads refuse", async () => {
  const f = await fixture(), tree = await f.create();
  try {
    tree.commit([{ path: "notes/ithaca.md", content: NOTE, base: null }]);
    await tree.barrier();
    expect(fs.existsSync(join(tree.mount!.root, "notes/ithaca.md"))).toBe(true);
    tree.commit([{ path: "notes/epic.md", content: new Uint8Array(TURN_TREE_EFFECT_BYTES), base: null }]);
    expect(fs.existsSync(join(tree.mount!.root, "notes/epic.md")), "EFFECT_PAST_ALLOWANCE_NOT_WRITTEN").toBe(false);
    await expect(tree.barrier(), "EFFECT_PAST_ALLOWANCE_REFUSES_INDEX_READS").rejects.toThrow("allowance");
  } finally { await tree.close(); }
});

test("a view no manager acquired keeps the temporary copy, even where another check treats it as managed", async () => {
  const store = fs.mkdtempSync(join(tmpdir(), "odysseus-tree-unmanaged-")), brain = join(store, "brain");
  cleanups.push(() => fs.rmSync(store, { recursive: true, force: true }));
  fs.mkdirSync(join(brain, "notes"), { recursive: true }); fs.writeFileSync(join(brain, "notes/voyage.md"), NOTE);
  const view = createFixtureWorkerStartupView(brain);
  cleanups.push(() => view.cleanup());
  // Policy suites stand a copied view in for a managed one this way.
  const managed = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  cleanups.push(() => managed.mockRestore());
  expect(startup.nativeTurnTreeManager(view), "UNACQUIRED_VIEW_HAS_NO_TREE_MANAGER").toBeUndefined();
  const tree = await createTurnDataTree({ brainPath: brain, view, maskPaths: [], mount: true, update: async () => {}, plan: async () => ({}) });
  try { expect(tree.mount!.root.startsWith(join(tmpdir(), "brain-turn-data-")), "UNACQUIRED_VIEW_TREE_IS_TEMPORARY").toBe(true); }
  finally { await tree.close(); }
});
