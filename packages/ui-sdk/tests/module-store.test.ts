import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { collectModuleGenerations, currentModuleGeneration, holdModuleGeneration, moduleLockHash, publishModuleGeneration, validateModuleGeneration } from "../src/server/module-store.js";
import { prepareNativeWorkerStartupView, retainWorkerStartupView, workerModuleGeneration } from "../src/server/worker-startup-view.js";
import { prepareWorkerSandbox, workerCommand } from "../src/server/worker-launcher.js";
import { resolveWorkerProtection } from "../src/server/worker-protection.js";
const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-modules-")), brain = join(root, "brain"), store = join(root, "modules");
  fs.mkdirSync(brain); fs.mkdirSync(store); fs.mkdirSync(join(brain, "node_modules"));
  clean.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const info = Reflect.apply(original, fs, args);
    if (String(args[0]) === brain && args[1]?.bigint) return { ...info, dev: 99n, ino: 256n, isDirectory: () => true, isSymbolicLink: () => false };
    return info;
  }) as typeof fs.lstatSync); clean.push(() => stat.mockRestore());
  const actual = fs.statfsSync(brain), statfs = spyOn(fs, "statfsSync").mockReturnValue({ ...actual, type: 0x9123683e }); clean.push(() => statfs.mockRestore());
  const build = () => {
    const generation = randomUUID(), dir = join(store, generation), modules = join(dir, "node_modules");
    fs.mkdirSync(dir); fs.mkdirSync(modules); fs.mkdirSync(join(modules, "odysseus"));
    fs.writeFileSync(join(modules, "odysseus/index.js"), `export default '${generation}'`);
    const receipt = { generation, lockHash: moduleLockHash(Buffer.from(generation)), trigger: "scheduled maintain", installedAt: "2026-07-12T00:00:00Z" };
    return { dir, modules, receipt };
  };
  const manager = {
    async checkpoint(id: string) { const path = join(root, ".brain-native/checkpoints", id); fs.mkdirSync(path, { recursive: true });
      return { id, path, readOnly: true as const, sourceUuid: "0123456789abcdef0123456789abcdef", fsid: "00000000-0000-0000-0000-000000000001", uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" }; },
    async release(id: string) { return { id, state: "deleted" as const }; },
  };
  return { root, brain, store, build, manager };
}
test("publication is atomic and old and new startup owners retain their generation until final release", async () => {
  const f = fixture(), old = f.build(); publishModuleGeneration(f.brain, old.receipt);
  const view = await prepareNativeWorkerStartupView(f.brain, f.manager), worker = retainWorkerStartupView(view);
  const next = f.build(); publishModuleGeneration(f.brain, next.receipt);
  const newer = await prepareNativeWorkerStartupView(f.brain, f.manager);
  try {
    expect(workerModuleGeneration(worker)?.receipt.generation, "EXISTING_WORKER_KEEPS_GENERATION").toBe(old.receipt.generation);
    expect(workerModuleGeneration(newer)?.receipt.generation, "NEW_WORKER_SEES_ATOMIC_PUBLICATION").toBe(next.receipt.generation);
    expect(workerModuleGeneration(worker)?.mounts(f.brain)).toEqual(["--ro-bind", old.modules, join(f.brain, "node_modules")]);
    await view.cleanup(); expect(collectModuleGenerations(f.brain), "LIVE_HOLDER_PREVENTS_COLLECTION").toEqual([]);
    await worker.cleanup(); expect(collectModuleGenerations(f.brain), "RELEASED_GENERATION_COLLECTED_LATER").toEqual([old.receipt.generation]);
    expect(currentModuleGeneration(f.brain)).toEqual(next.receipt);
  } finally { await worker.cleanup(); await view.cleanup(); await newer.cleanup(); }
});
test("a failed full validation preserves the previous publication", () => {
  const f = fixture(), old = f.build(); publishModuleGeneration(f.brain, old.receipt);
  const next = f.build(); fs.symlinkSync(join(f.brain, "node_modules"), join(next.modules, "escape"));
  expect(() => publishModuleGeneration(f.brain, next.receipt), "ESCAPING_INSTALL_REFUSED").toThrow("symlink leaves");
  expect(currentModuleGeneration(f.brain), "FAILED_INSTALL_KEEPS_PREVIOUS").toEqual(old.receipt);
});
test("module validation refuses hardlinks and permits internal package-bin symlinks", () => {
  const f = fixture(), next = f.build(); fs.mkdirSync(join(next.modules, ".bin"));
  fs.symlinkSync("../odysseus/index.js", join(next.modules, ".bin/brain"));
  expect(() => validateModuleGeneration(next.dir)).not.toThrow();
  fs.linkSync(join(next.modules, "odysseus/index.js"), join(f.root, "alias"));
  expect(() => validateModuleGeneration(next.dir)).toThrow("unprotected file");
});
test("managed admission omits the module walk while small protected directories still refuse aliases", async () => {
  const f = fixture(), next = f.build(); publishModuleGeneration(f.brain, next.receipt);
  // A sentinel in the old in-brain tree must never be inventoried after activation.
  fs.symlinkSync("/missing", join(f.brain, "node_modules/old"));
  const view = await prepareNativeWorkerStartupView(f.brain, f.manager);
  const read = spyOn(fs, "readdirSync");
  try {
    const resolved = resolveWorkerProtection(f.brain, { paths: ["node_modules"], startupView: view });
    expect(resolved.reason, "NO_IN_BRAIN_MODULE_INVENTORY_WITH_STORE").toBeUndefined();
    expect(read.mock.calls.some(([path]) => String(path).includes(next.receipt.generation))).toBe(false);
    fs.mkdirSync(join(f.brain, ".git/hooks"), { recursive: true }); fs.symlinkSync("/missing", join(f.brain, ".git/hooks/hook"));
    expect(resolveWorkerProtection(f.brain, { paths: [".git/hooks"], startupView: view }).reason, "SMALL_PROTECTED_TREE_STILL_CHECKED").toContain("symlink");
  } finally { read.mockRestore(); await view.cleanup(); }
});
test("unactivated brains keep the existing module walk", () => {
  const f = fixture(); fs.symlinkSync("/missing", join(f.brain, "node_modules/escape"));
  expect(holdModuleGeneration(f.brain)).toBeUndefined();
  expect(resolveWorkerProtection(f.brain, { paths: ["node_modules"] }).reason, "FALLBACK_MODULE_WALK_RETAINED").toBeDefined();
});

test("a real sandbox resolves its pinned package and refuses writes to the generation", async () => {
  const f = fixture(), next = f.build(); publishModuleGeneration(f.brain, next.receipt);
  fs.writeFileSync(join(next.modules, "odysseus/package.json"), '{"name":"odysseus","main":"index.js"}');
  const view = await prepareNativeWorkerStartupView(f.brain, f.manager);
  try {
    const sandbox = prepareWorkerSandbox(f.brain, { profile: "governed", areas: [], maintenance: { startupView: view } });
    const program = `const fs=require("node:fs");if(require("odysseus").default!==${JSON.stringify(next.receipt.generation)})process.exit(41);try{fs.appendFileSync("node_modules/odysseus/index.js","attack");process.exit(42)}catch(e){if(e.code!=="EROFS")throw e}console.log("PINNED_PACKAGE_READ_ONLY");`;
    const argv = workerCommand({ brainPath: f.brain, sandbox, command: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: {} });
    const child = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString(), "REAL_SANDBOX_RESOLVES_READ_ONLY_GENERATION").toContain("PINNED_PACKAGE_READ_ONLY");
  } finally { await view.cleanup(); }
});

test("a directory sync failure after atomic publication retains the active generation", () => {
  const f = fixture(), next = f.build(), sync = fs.fsyncSync;
  const fault = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Error("Odysseus directory sync failure");
    return sync(fd);
  });
  try {
    expect(publishModuleGeneration(f.brain, next.receipt), "POST_PUBLICATION_FAILURE_IS_NAMED").toContain("durability is uncertain");
    expect(currentModuleGeneration(f.brain), "PUBLISHED_GENERATION_MUST_NOT_BE_REMOVED").toEqual(next.receipt);
  } finally { fault.mockRestore(); }
});
