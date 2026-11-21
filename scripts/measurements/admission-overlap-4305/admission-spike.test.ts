import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir, loadavg } from "node:os";
import { seedObservationTree, observationTreeOptions } from "../../../scripts/native-proof/observation-tree.ts";
import { requireWorkerHostAsync, prepareWorkerSandboxAsync } from "../../../packages/ui-sdk/src/server/worker-launcher.ts";
import { mountPointsUnder } from "../../../packages/ui-sdk/src/server/worker-sandbox.ts";
import { isWithin } from "../../../packages/common/src/safe-path.ts";
import * as git from "../../../packages/ui-sdk/src/server/maintenance-worker.ts";
import { createFixtureWorkerStartupView } from "../../../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.ts";
import { createGovernancePolicyReader } from "../../../packages/ui-server/src/brain/governance-policy.ts";
import { createUiDb } from "../../../packages/ui-server/src/db/client.ts";
import { openSqliteWriter } from "../../../packages/ui-server/src/db/write-worker.ts";
import * as batch from "./batch-procedures.ts";
import { overlap } from "./overlap-prototype.ts";

const root = fs.mkdtempSync(join(tmpdir(), "odysseus-admission-spike-")), brain = join(root, "brain");
const output: Record<string, unknown> = { kind: "offline-component-experiment", native: false, loadBefore: loadavg() };
const samples = 15;
let frozen: ReturnType<typeof createFixtureWorkerStartupView>;
let refs = 0;
const storage = { root: join(root, "views"), retain() { refs++; }, release() { refs--; } };
const time = async <T>(fn: () => T | Promise<T>) => { const started = performance.now(); const value = await fn(); return { ms: performance.now() - started, value }; };
const summary = (rows: number[]) => { const sorted = [...rows].sort((a,b) => a-b); return { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.ceil(sorted.length * .9) - 1], rows }; };
async function compare(name: string, before: () => unknown | Promise<unknown>, after: () => unknown | Promise<unknown>, count = samples) {
  const base: number[] = [], variant: number[] = [];
  const sample = async (fn: () => unknown | Promise<unknown>, rows: number[]) => {
    const measured = await time(fn); rows.push(measured.ms);
    const owned = measured.value as { cleanup?: () => unknown } | undefined;
    if (owned?.cleanup) await owned.cleanup();
  };
  for (let i = 0; i < count; i++) {
    // Alternate order to avoid consistently charging one variant for warmup.
    if (i % 2) { await sample(after, variant); await sample(before, base); }
    else { await sample(before, base); await sample(after, variant); }
  }
  output[name] = { before: summary(base), after: summary(variant), pairedSaving: summary(base.map((ms,i) => ms - variant[i]!)) };
}
const prep = () => { const policy = createGovernancePolicyReader(brain).load(); const mounts = mountPointsUnder(brain); return { policy, mounts }; };
beforeAll(() => {
  fs.mkdirSync(join(brain, "notes"), { recursive: true });
  fs.mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  fs.mkdirSync(join(brain, ".git/objects"), { recursive: true });
  fs.mkdirSync(join(brain, ".git/refs/heads"), { recursive: true });
  fs.mkdirSync(join(brain, ".git/info"), { recursive: true });
  fs.writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(join(brain, ".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  fs.writeFileSync(join(brain, ".gitignore"), "# Odysseus keeps generated scratch out of Git.\n");
  fs.writeFileSync(join(brain, ".git/info/exclude"), ".brain/scratch/\n");
  fs.writeFileSync(join(brain, "notes/ithaca.md"), "# Ithaca\nOdysseus returns on 2026-07-12.\n");
  fs.mkdirSync(storage.root);
  output.tree = seedObservationTree(brain, join(root, "objects"), observationTreeOptions(["--observation-timing", "--tree=large"])!);
  frozen = createFixtureWorkerStartupView(brain, { storage });
}, 600000);
afterAll(() => { frozen?.cleanup(); expect(refs).toBe(0); output.loadAfter = loadavg(); fs.writeFileSync(process.env.S9_RECEIPT_OUTPUT ?? join(import.meta.dir, "admission-results.json"), JSON.stringify(output, null, 2)); fs.rmSync(root, { recursive: true, force: true }); }, 600000);
const maintenance = () => ({ startupView: frozen, tempDomain: { statePath: join(root, "maintenance.db") } });
const sandbox = () => prepareWorkerSandboxAsync(brain, { profile: "governed", codeChanges: false, maintenance: maintenance() });

test("measure C1 read-only preparation overlapped with the real worker probe", async () => {
  await compare("C1", async () => { await requireWorkerHostAsync(brain); return prep(); }, () => overlap(() => requireWorkerHostAsync(brain), prep, () => {}));
}, 600000);
test("measure C2 two real admission writes batched at FULL on the write worker", async () => {
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  try {
    const channel = writer.channel(batch, undefined); await channel.ready;
    let n = 0;
    await compare("C2", async () => { const id = `separate-${n++}`; await channel.call("policy", id); await channel.call("manifest", id); }, async () => { await channel.call("batch", `batch-${n++}`); }, 40);
    expect(db.query("SELECT COUNT(*) AS n FROM turn_governance_policy").get()).toEqual({ n: 80 });
    expect(db.query("SELECT COUNT(*) AS n FROM governed_turn_manifests").get()).toEqual({ n: 80 });
  } finally { await writer.close(); db.close(); }
}, 600000);
test("measure C3 duplicate actual probes versus reusing a prior passed probe", async () => {
  // Deliberately unsafe process-cache prototype: the measurement is not a proposal to ship it.
  const pass = await requireWorkerHostAsync(brain);
  await compare("C3", async () => { await requireWorkerHostAsync(brain); return requireWorkerHostAsync(brain); }, async () => pass);
  await compare("C3SameTurn", async () => { await requireWorkerHostAsync(brain); return requireWorkerHostAsync(brain); }, () => requireWorkerHostAsync(brain));
}, 600000);
test("measure C4 observed mount queries versus one parsed admission snapshot", async () => {
  const read = fs.readFileSync; let queries = 0;
  const observed = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (path === "/proc/self/mountinfo") queries++;
    return Reflect.apply(read, fs, [path, ...args]);
  }) as typeof fs.readFileSync);
  try { const value = await sandbox(); expect(value.areas[0]!.mount.writable, JSON.stringify(value.areas[0])).toBe(true); }
  finally { observed.mockRestore(); }
  expect(queries).toBeGreaterThan(1);
  output.mountQueries = queries;
  const dirs = Array.from({ length: queries }, (_, i) => join(brain, [".brain/scratch", "workspaces", "context", "node_modules"][i % 4]!));
  const before = () => dirs.map(dir => mountPointsUnder(dir));
  const after = () => { const mounts = mountPointsUnder("/"); return dirs.map(dir => mounts.filter(mount => isWithin(dir, mount))); };
  expect(after()).toEqual(before());
  await compare("C4", before, after, 100);
}, 600000);
test("measure C5 sandbox preparation with actual Git and a cached Git pass", async () => {
  const original = git.brainGitSteps;
  const baseline = await sandbox(); expect(baseline.areas[0]!.mount.writable, JSON.stringify(baseline.areas[0])).toBe(true);
  await compare("C5", sandbox, async () => {
    const cached = spyOn(git, "brainGitSteps").mockImplementation(function* () { return 0; });
    try { const value = await sandbox(); expect(cached).toHaveBeenCalledTimes(1); expect(value.areas.map(a => a.mount)).toEqual(baseline.areas.map(a => a.mount)); }
    finally { cached.mockRestore(); }
  });
  expect(git.brainGitSteps).toBe(original);
  // Root .gitignore is unchanged; a Git-private exclude change still changes the verdict.
  const ignore = fs.readFileSync(join(frozen.root, ".gitignore"), "utf8");
  fs.writeFileSync(join(frozen.root, ".git/info/exclude"), "");
  try { expect((await sandbox()).areas[0]!.mount.writable, "INFO_EXCLUDE_INVALIDATES_IGNORE_ONLY_CACHE").toBe(false); }
  finally { fs.writeFileSync(join(frozen.root, ".git/info/exclude"), ".brain/scratch/\n"); }
  expect(fs.readFileSync(join(frozen.root, ".gitignore"), "utf8")).toBe(ignore);
}, 600000);
test("measure C6 acquiring a full offline startup copy versus no startup checkpoint", async () => {
  // This bypass intentionally violates immutable-input admission. It is an offline copy cost, never a Btrfs cost.
  await compare("C6", () => { const view = createFixtureWorkerStartupView(brain, { storage }); return view; }, () => ({ root: brain }), 3);
}, 600000);
