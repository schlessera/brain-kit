/**
 * Case 19 of the reference pool proof (#3513): storage efficiency of real
 * repository acquisition, refresh and managed worktrees on the owned pool.
 *
 * A generated Odysseus repository (many small files, incompressible charts,
 * a submodule gitlink and an LFS-style pointer) is acquired cold, read again,
 * refreshed unchanged and changed, refreshed under concurrent readers, and
 * checked out into two managed worktrees. A reflinked and a full copy of the
 * same checkout, and a copy onto another filesystem, compare the copy paths.
 *
 * Every step records the pool's own accounting (`chargedBytes`: unique
 * physical allocation across data, metadata and system, profile replication
 * included; `ownerBytes`: simple-quota first-owner charge per root) and an
 * independent extent census (`btrfs filesystem du`). Neither logical size nor
 * a sum of st_blocks is reported as unique usage. The report is
 * `reference-efficiency.json` next to the other receipts.
 */
import { expect } from "bun:test";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { NativePoolRecord, NativePoolStatus } from "../../packages/ui-sdk/src/server/native-brain-manager-protocol.js";
import type { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { createFixtureWorktrees } from "./reference-worktree-allocation.js";
import { settledWorktreeRelease } from "./reference-worktree-release.js";

const MIB = 1024 ** 2;
/** Generated workload: 40 books of 50 short lines, three 2 MiB charts, then one changed commit. */
export const EFFICIENCY_WORKLOAD = Object.freeze({ books: 40, lines: 50, charts: 3, chartBytes: 2 * MIB, changedLines: 50, addedChartBytes: 2 * MIB });

/**
 * Regression tolerances, set from the first hosted baseline (heavy feedback run
 * 42475041809 at 59caf001: kernel 7.0.0-1017-azure, btrfs-progs 6.6.3, Git 2.43.0,
 * Bun 1.4.2) with headroom for runner variance. Measured values are in comments.
 * They bound metadata growth; none of them is a promise of zero metadata cost.
 */
export const EFFICIENCY_TOLERANCES = Object.freeze({
  /** Repeat read and unchanged refresh: measured 0. */
  reuseBytes: 256 * 1024,
  /** Two worktrees from one source, pool-wide: measured 229,376. */
  worktreePairBytes: 1 * MIB,
  /** Changed refresh, pool-wide: measured 6,787,072 for 2 MiB added and 50 files changed. */
  changedRefreshBytes: 10 * MIB,
  /** Concurrent refresh of one changed file, pool-wide: measured 421,888. */
  concurrentRefreshBytes: 2 * MIB,
  /** Same-filesystem reflink copy, census exclusive: measured 0. */
  reflinkBytes: 256 * 1024,
  /** Cold acquisition elapsed: measured 1,265 ms. Concurrent refresh: measured 4,688 ms. */
  coldMs: 15_000, concurrentMs: 30_000,
});
const T = EFFICIENCY_TOLERANCES;

type Client = ReturnType<typeof createNativeBrainManagerClient>;
export interface EfficiencyContext {
  client: Client;
  artifacts: string;
  note: (kind: string, facts: Record<string, unknown>) => void;
  command: (argv: string[], permitFailure?: boolean) => string;
  sync: () => void;
}

interface Census { path: string; total: number; exclusive: number; shared: number }
interface Step {
  step: string; ms: number | null; chargedBytes: number; ownerBytes: number; globalBytes: number; pendingBytes: number; availableBytes: number;
  data: number; metadata: number; roots: { id: string; purpose: string; state: string; from: string | null; ownerBytes: number | null }[];
  census: Census[]; [extra: string]: unknown;
}

export async function runReferenceEfficiency(context: EfficiencyContext): Promise<void> {
  const { client, artifacts, note, command, sync } = context;
  const { createUiDb } = await import("../../packages/ui-server/src/db/client.js");
  const { createPrincipal } = await import("../../packages/ui-server/src/db/principals.js");
  const { createReferenceGrant } = await import("../../packages/ui-server/src/db/reference-grants.js");
  const { createReferenceSources, REFERENCE_SOURCE_DEFAULTS } = await import("../../packages/ui-server/src/brain/reference-source.js");
  const { createReferenceTransport } = await import("../../packages/ui-server/src/brain/reference-transport.js");
  const { referenceWorktreeDependents } = await import("../../packages/ui-server/src/brain/reference-worktrees.js");

  const srv = "/native-runtime/efficiency-srv", work = "/native-runtime/efficiency-work", state = "/native-runtime/case-19";
  for (const path of [srv, work, state]) mkdirSync(path, { recursive: true });
  const git = (cwd: string, ...args: string[]) => command(["git", "-C", cwd, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", "-c", "protocol.file.allow=always", ...args]);
  const incompressible = (path: string, bytes: number) => { const fd = openSync(path, "w"); try { for (let done = 0; done < bytes; done += MIB) writeSync(fd, randomBytes(Math.min(MIB, bytes - done))); } finally { closeSync(fd); } };
  const W = EFFICIENCY_WORKLOAD;

  // The generated repository: small files, incompressible charts, a submodule gitlink and an LFS-style pointer.
  git(work, "init", "-q", "-b", "main");
  for (let book = 0; book < W.books; book++) {
    mkdirSync(join(work, "odyssey", `book-${book}`), { recursive: true });
    for (let line = 0; line < W.lines; line++) writeFileSync(join(work, "odyssey", `book-${book}`, `line-${line}.md`), `Ithaca log: book ${book}, line ${line}.\n`);
  }
  mkdirSync(join(work, "charts"));
  for (let chart = 0; chart < W.charts; chart++) incompressible(join(work, "charts", `aegean-${chart}.bin`), W.chartBytes);
  writeFileSync(join(work, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(work, "charts", "ogygia.psd"), "version https://git-lfs.github.com/spec/v1\noid sha256:" + "0".repeat(64) + "\nsize 4096\n");
  git(work, "add", ".");
  // A gitlink without fetching anything: the submodule's commit is recorded, its objects are not.
  git(work, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},crew/telemachus`);
  writeFileSync(join(work, ".gitmodules"), "[submodule \"crew/telemachus\"]\n\tpath = crew/telemachus\n\turl = file:///native-runtime/absent-submodule.git\n");
  git(work, "add", ".gitmodules");
  git(work, "commit", "-q", "-m", "Odysseus charts the Aegean");
  command(["git", "clone", "-q", "--bare", work, join(srv, "aegean.git")]);
  const push = () => git(work, "push", "-q", join(srv, "aegean.git"), "main");

  const db = createUiDb(join(state, "ui.db"));
  let clock = Date.now();
  const now = () => clock, advance = () => { clock += REFERENCE_SOURCE_DEFAULTS.refreshMs + 1_000; };
  const records = async () => {
    const all: NativePoolRecord[] = [];
    for (let after: string | null = null; ;) { const page = await client.listPoolRecovery(after); all.push(...page.records); if (!page.next) return all; after = page.next; }
  };
  const census = (paths: string[]): Census[] => paths.length === 0 ? [] : command(["btrfs", "filesystem", "du", "-s", "--raw", ...paths]).trim().split("\n").slice(1).map(line => {
    const [total, exclusive, shared, ...name] = line.trim().split(/\s+/);
    return { path: name.join(" "), total: Number(total), exclusive: Number(exclusive), shared: Number(shared) };
  });
  const report: { schema: 1; basis: string; workload: typeof W; environment: Record<string, string>; steps: Step[]; findings: Record<string, unknown> } = {
    schema: 1, basis: "chargedBytes: pool accounting basis (btrfs-space-info-disk-used+simple-quota-owner); ownerBytes: simple-quota first-owner charge per root; census: btrfs filesystem du extent sharing",
    workload: W, environment: {
      kernel: command(["uname", "-r"]).trim(), btrfsProgs: command(["btrfs", "--version"]).split("\n")[0]!.trim(), git: command(["git", "--version"]).trim(),
      bun: Bun.version, candidate: process.env.BRAIN_PROOF_CANDIDATE ?? "unrecorded",
    }, steps: [], findings: {},
  };
  const save = () => writeFileSync(join(artifacts, "reference-efficiency.json"), JSON.stringify(report, null, 2));
  async function measure(step: string, ms: number | null, paths: string[] = [], extra: Record<string, unknown> = {}): Promise<Step> {
    sync();
    const status: NativePoolStatus = await client.poolStatus();
    expect(status.refusal, `REFERENCE_EFFICIENCY_POOL_QUALIFIED_${step}`).toBeNull();
    const a = status.accounting!;
    const roots = (await records()).filter(record => ["reserved", "writable", "sealed"].includes(record.state))
      .map(record => ({ id: record.id, purpose: record.purpose, state: record.state, from: record.from, ownerBytes: record.ownerBytes }));
    const row: Step = { step, ms, chargedBytes: a.chargedBytes, ownerBytes: a.ownerBytes, globalBytes: a.globalBytes, pendingBytes: a.pendingBytes,
      availableBytes: a.availableBytes, data: a.spaces.data.bytesUsed, metadata: a.spaces.metadata.bytesUsed, roots, census: census(paths), ...extra };
    report.steps.push(row); save(); note("efficiency", { step, ms, chargedBytes: row.chargedBytes, pendingBytes: row.pendingBytes, roots: roots.length });
    return row;
  }
  const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => { const began = performance.now(); const value = await work(); return [value, Math.round(performance.now() - began)]; };
  const owner = (step: Step, id: string) => step.roots.find(root => root.id === id)?.ownerBytes ?? null;
  // Writable roots carry no owner charge until sealed, so worktrees compare on the census's exclusive extents.
  const exclusive = (step: Step, path: string) => { const entry = step.census.find(value => value.path === path); expect(entry, `REFERENCE_EFFICIENCY_CENSUS_${step.step}`).toBeDefined(); return entry!.exclusive; };
  const pathOf = async (id: string) => (await records()).find(record => record.id === id)!.path!;
  const sourceRoots = async () => (await records()).filter(record => record.purpose === "source" && record.state === "sealed").map(record => record.id);

  try {
    const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 });
    createReferenceGrant(db, { brain: "ithaca", principalId: penelope.id, repositoryPrefix: `file://${srv}`, credential: null, createdBy: penelope.id, now: clock });
    const sources = createReferenceSources({ db, pool: client, transport: createReferenceTransport({ brainPath: "/brain-fixture/brain" }), brain: "ithaca", credentials: {}, now,
      dependents: rootId => referenceWorktreeDependents(db, rootId) });
    const worktrees = createFixtureWorktrees({ db, pool: client, sources, now }, note);
    const repository = `file://${srv}/aegean.git`, request = () => sources.request({ principalId: penelope.id, repository, revision: "main" });
    const baseline = await measure("baseline", null);

    // Cold acquisition: one new sealed source root holds Git objects and the checkout.
    const [cold, coldMs] = await timed(request);
    const coldRoot = await pathOf(cold.rootId);
    const objects = (root: string) => Object.fromEntries(command(["git", "-c", "safe.directory=*", "--git-dir", join(root, ".git"), "count-objects", "-v"]).trim().split("\n").map(line => line.split(": ") as [string, string]));
    const acquired = await measure("cold-acquisition", coldMs, [coldRoot, join(coldRoot, ".git"), join(coldRoot, "odyssey"), join(coldRoot, "charts")], { objects: objects(coldRoot) });
    const coldOwner = owner(acquired, cold.rootId)!;
    expect(coldOwner, "REFERENCE_EFFICIENCY_COLD_HOLDS_OBJECTS_AND_CHECKOUT").toBeGreaterThanOrEqual(2 * W.charts * W.chartBytes);
    expect(await sourceRoots(), "REFERENCE_EFFICIENCY_COLD_ONE_ROOT").toEqual([cold.rootId]);
    // Unsupported repository features are refused by shape, never fetched: the gitlink stays an empty directory and the LFS pointer stays text.
    const features = { submodule: command(["find", join(coldRoot, "crew", "telemachus"), "-mindepth", "1"]).trim(), lfs: readFileSync(join(coldRoot, "charts", "ogygia.psd"), "utf8").split("\n")[0] };
    report.findings.features = features;
    expect(features, "REFERENCE_EFFICIENCY_SUBMODULE_AND_LFS_NOT_FETCHED").toEqual({ submodule: "", lfs: "version https://git-lfs.github.com/spec/v1" });

    // Repeat read inside the refresh window: the same root, no new checkout and no new allocation.
    const [warm, warmMs] = await timed(request);
    const reread = await measure("repeat-read", warmMs);
    expect({ root: warm.rootId, roots: await sourceRoots() }, "REFERENCE_EFFICIENCY_REPEAT_READ_REUSES_ROOT").toEqual({ root: cold.rootId, roots: [cold.rootId] });
    expect(warmMs, "REFERENCE_EFFICIENCY_REPEAT_READ_FASTER_THAN_COLD").toBeLessThan(coldMs);
    expect(coldMs, "REFERENCE_EFFICIENCY_COLD_ELAPSED").toBeLessThanOrEqual(T.coldMs);
    expect(reread.chargedBytes - acquired.chargedBytes, "REFERENCE_EFFICIENCY_REPEAT_READ_ALLOCATES_NOTHING").toBeLessThanOrEqual(T.reuseBytes);

    // Unchanged refresh after the window: validated in place, no new root.
    advance();
    const [unchanged, unchangedMs] = await timed(request);
    const validated = await measure("unchanged-refresh", unchangedMs);
    expect({ root: unchanged.rootId, roots: await sourceRoots(), refreshed: unchanged.refreshedAt > cold.refreshedAt }, "REFERENCE_EFFICIENCY_UNCHANGED_REFRESH_IN_PLACE")
      .toEqual({ root: cold.rootId, roots: [cold.rootId], refreshed: true });
    expect(validated.chargedBytes - acquired.chargedBytes, "REFERENCE_EFFICIENCY_UNCHANGED_REFRESH_ALLOCATES_NOTHING").toBeLessThanOrEqual(T.reuseBytes);

    // Two managed worktrees snapshot the one source: they share its extents and charge almost nothing.
    const [first, firstMs] = await timed(() => worktrees.allocate({ principalId: penelope.id, repository, revision: "main" }));
    const second = await worktrees.allocate({ principalId: penelope.id, repository, revision: "main" });
    const [firstPath, secondPath] = [await pathOf(first.id), await pathOf(second.id)];
    const allocated = await measure("two-worktrees", firstMs, [coldRoot, firstPath, secondPath]);
    const worktreeGrowth = allocated.chargedBytes - validated.chargedBytes;
    report.findings.worktreeGrowthPerSource = worktreeGrowth / coldOwner;
    expect({ first: first.commit, second: second.commit, sources: await sourceRoots() }, "REFERENCE_EFFICIENCY_WORKTREES_FROM_ONE_SOURCE")
      .toEqual({ first: cold.commit, second: cold.commit, sources: [cold.rootId] });
    // An independent full copy of each worktree would add at least the source's charge twice.
    expect(worktreeGrowth, "REFERENCE_EFFICIENCY_WORKTREES_SHARE_SOURCE").toBeLessThan(coldOwner / 10);
    expect(worktreeGrowth, "REFERENCE_EFFICIENCY_WORKTREES_WITHIN_TOLERANCE").toBeLessThanOrEqual(T.worktreePairBytes);
    for (const path of [firstPath, secondPath]) expect(exclusive(allocated, path), "REFERENCE_EFFICIENCY_WORKTREE_EXCLUSIVE_SMALL").toBeLessThan(coldOwner / 10);
    const shared = allocated.census.find(entry => entry.path === firstPath)!;
    expect(shared.exclusive, "REFERENCE_EFFICIENCY_WORKTREE_EXTENTS_SHARED").toBeLessThan(shared.total / 10);

    // An isolated edit and a preserved local commit charge only the edited worktree.
    incompressible(join(firstPath, "charts", "aegean-0.bin"), W.chartBytes);
    writeFileSync(join(firstPath, "odyssey", "book-0", "line-0.md"), "Ithaca log, corrected by Penelope.\n");
    command(["git", "-c", "safe.directory=*", "--git-dir", join(firstPath, ".git"), "--work-tree", firstPath, "-c", "user.name=Penelope", "-c", "user.email=penelope@ithaca.example",
      "-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "Penelope corrects the log"]);
    const edited = await measure("isolated-edit", null, [firstPath, secondPath]);
    expect(exclusive(edited, firstPath) - exclusive(allocated, firstPath), "REFERENCE_EFFICIENCY_EDIT_CHARGES_ITS_WORKTREE").toBeGreaterThanOrEqual(W.chartBytes);
    expect(Math.abs(exclusive(edited, secondPath) - exclusive(allocated, secondPath)), "REFERENCE_EFFICIENCY_EDIT_LEAVES_SIBLING").toBeLessThanOrEqual(64 * 1024);
    expect(owner(edited, cold.rootId), "REFERENCE_EFFICIENCY_EDIT_LEAVES_SOURCE").toBe(owner(allocated, cold.rootId));
    expect(readFileSync(join(secondPath, "odyssey", "book-0", "line-0.md"), "utf8"), "REFERENCE_EFFICIENCY_EDIT_ISOLATED").toBe("Ithaca log: book 0, line 0.\n");
    // Repacking in a worktree rewrites its objects as new extents: the sharing with its source is lost, not copied for free.
    const inSecond = (...args: string[]) => command(["git", "-c", "safe.directory=*", "--git-dir", join(secondPath, ".git"), "--work-tree", secondPath, "-c", "core.hooksPath=/dev/null", ...args]);
    inSecond("repack", "-q", "-a", "-d", "-f");
    const repacked = await measure("worktree-repack", null, [secondPath], { objects: objects(secondPath) });
    const repackLoss = exclusive(repacked, secondPath) - exclusive(edited, secondPath);
    // A linked Git worktree inside a managed worktree shares its object store but checks every file out as new extents.
    inSecond("worktree", "add", "-q", "--detach", join(secondPath, "linked"), "HEAD");
    const linked = await measure("linked-git-worktree", null, [secondPath, join(secondPath, "linked")]);
    const linkedGrowth = exclusive(linked, secondPath) - exclusive(repacked, secondPath);
    report.findings.sharingLoss = { repackLoss, linkedGrowth };
    expect(repackLoss, "REFERENCE_EFFICIENCY_REPACK_LOSES_SHARING").toBeGreaterThanOrEqual(W.charts * W.chartBytes);
    expect(linkedGrowth, "REFERENCE_EFFICIENCY_LINKED_WORKTREE_CHECKS_OUT_NEW_EXTENTS").toBeGreaterThanOrEqual(W.charts * W.chartBytes);
    expect(owner(linked, cold.rootId), "REFERENCE_EFFICIENCY_SHARING_LOSS_STAYS_IN_ITS_WORKTREE").toBe(owner(allocated, cold.rootId));
    // The managed release reads the commit as unpreserved work; this proof then releases both roots itself.
    const held = { record: (await records()).find(record => record.id === first.id)!, row: worktrees.inventory().find(entry => entry.row.id === first.id)!.row };
    const retained = await settledWorktreeRelease({ db, worktrees, records, note }, held,
      (await worktrees.release({ worktreeId: first.id, principalId: penelope.id })).cleanup, "REFERENCE_EFFICIENCY_LOCAL_COMMIT");
    report.findings.localCommitCleanup = retained;
    expect(retained, "REFERENCE_EFFICIENCY_LOCAL_COMMIT_RETAINED").toMatchObject({ work: "unpreserved", eligible: false });
    for (const record of await records()) if (record.purpose === "checkpoint" && record.state === "sealed" && [first.id, second.id].includes(record.from ?? "")) await client.poolRelease(record.id);
    for (const id of [first.id, second.id]) expect(["deleted", "reclaimed"], "REFERENCE_EFFICIENCY_WORKTREE_RELEASED").toContain((await client.poolRelease(id)).state);
    db.query("DELETE FROM reference_worktrees").run();
    const parked = await measure("worktrees-released", null);

    // Changed refresh: the staging root snapshots the previous one, so only new objects and changed files allocate.
    for (let line = 0; line < W.changedLines; line++) writeFileSync(join(work, "odyssey", "book-1", `line-${line}.md`), `Ithaca log: book 1, line ${line}, revised.\n`);
    incompressible(join(work, "charts", "scheria.bin"), W.addedChartBytes);
    git(work, "add", "."); git(work, "commit", "-q", "-m", "Odysseus reaches Scheria"); push();
    advance();
    const [changed, changedMs] = await timed(request);
    const changedRoot = await pathOf(changed.rootId);
    // The superseded root has already left its view, so the census covers the new root only.
    const refreshed = await measure("changed-refresh", changedMs, [changedRoot], { objects: objects(changedRoot) });
    expect(changed.rootId, "REFERENCE_EFFICIENCY_CHANGED_REFRESH_NEW_ROOT").not.toBe(cold.rootId);
    const refreshOwner = owner(refreshed, changed.rootId)!;
    report.findings.changedRefreshPerCold = refreshOwner / coldOwner;
    // The new chart is stored once as a Git object and once checked out; nothing inherited is copied.
    expect(refreshOwner, "REFERENCE_EFFICIENCY_CHANGED_REFRESH_CHARGES_NEW_DATA").toBeGreaterThanOrEqual(2 * W.addedChartBytes);
    expect(refreshOwner, "REFERENCE_EFFICIENCY_CHANGED_REFRESH_NOT_A_RECLONE").toBeLessThan(coldOwner / 2);
    expect(refreshed.chargedBytes - parked.chargedBytes, "REFERENCE_EFFICIENCY_CHANGED_REFRESH_GROWTH_BOUNDED").toBeLessThanOrEqual(T.changedRefreshBytes);

    // Concurrent readers during one refresh join it: exactly one new root, every reader on it.
    writeFileSync(join(work, "odyssey", "book-2", "line-0.md"), "Ithaca log: book 2, line 0, the Phaeacians listen.\n");
    git(work, "commit", "-q", "-am", "The Phaeacians listen"); push();
    advance();
    const before = await sourceRoots();
    let peak = 0; const sample = setInterval(() => { client.poolStatus().then(value => { peak = Math.max(peak, value.accounting?.pendingBytes ?? 0); }, () => {}); }, 50);
    const [readers, concurrentMs] = await timed(() => Promise.all(Array.from({ length: 4 }, request)));
    clearInterval(sample);
    const joined = await measure("concurrent-refresh", concurrentMs, [], { peakPendingBytes: peak });
    const added = (await sourceRoots()).filter(id => !before.includes(id));
    expect({ added: added.length, readers: new Set(readers.map(lease => lease.rootId)).size }, "REFERENCE_EFFICIENCY_CONCURRENT_REFRESH_ONE_ROOT").toEqual({ added: 1, readers: 1 });
    expect(joined.chargedBytes - refreshed.chargedBytes, "REFERENCE_EFFICIENCY_CONCURRENT_REFRESH_SMALL").toBeLessThanOrEqual(T.concurrentRefreshBytes);
    expect(concurrentMs, "REFERENCE_EFFICIENCY_CONCURRENT_REFRESH_ELAPSED").toBeLessThanOrEqual(T.concurrentMs);

    // Copy paths: a same-filesystem reflink shares extents; a full copy and a cross-filesystem copy do not.
    const current = await pathOf(readers[0]!.rootId);
    const reflinked = await client.poolCreate(crypto.randomUUID(), "staging", null, 32 * MIB), copied = await client.poolCreate(crypto.randomUUID(), "staging", null, 32 * MIB);
    const copyBase = await measure("copy-roots-created", null);
    const [, reflinkMs] = await timed(async () => command(["cp", "-a", "--reflink=always", `${current}/charts`, `${current}/odyssey`, reflinked.path!]));
    const [, copyMs] = await timed(async () => command(["cp", "-a", "--reflink=never", `${current}/charts`, `${current}/odyssey`, copied.path!]));
    const across = "/native-runtime/efficiency-across";
    mkdirSync(across);
    const crossReflink = Bun.spawnSync(["cp", "-a", "--reflink=always", `${current}/charts`, across], { stdout: "pipe", stderr: "pipe" });
    rmSync(across, { recursive: true, force: true }); mkdirSync(across);
    command(["cp", "-a", "--reflink=auto", `${current}/charts`, across]);
    const acrossBytes = Number(command(["du", "-s", "-B1", across]).split(/\s/)[0]);
    const copies = await measure("copy-paths", null, [reflinked.path!, copied.path!], { reflinkMs, copyMs, crossFilesystem: { reflinkExit: crossReflink.exitCode, reflinkError: crossReflink.stderr.toString().trim().slice(-200), autoAllocatedBytes: acrossBytes } });
    const reflinkOwner = exclusive(copies, reflinked.path!), copyOwner = exclusive(copies, copied.path!);
    report.findings.copyPaths = { basis: "census exclusive bytes", reflinkOwner, copyOwner, crossFilesystemAllocated: acrossBytes };
    expect(copyOwner, "REFERENCE_EFFICIENCY_FULL_COPY_CHARGES_DATA").toBeGreaterThanOrEqual(W.charts * W.chartBytes + W.addedChartBytes);
    expect(reflinkOwner, "REFERENCE_EFFICIENCY_REFLINK_SHARES_DATA").toBeLessThanOrEqual(T.reflinkBytes);
    expect(copies.chargedBytes - copyBase.chargedBytes, "REFERENCE_EFFICIENCY_COPY_PATHS_GROWTH").toBeGreaterThanOrEqual(copyOwner);
    expect({ reflink: crossReflink.exitCode !== 0, fallbackFull: acrossBytes >= W.charts * W.chartBytes }, "REFERENCE_EFFICIENCY_CROSS_FILESYSTEM_COPIES").toEqual({ reflink: true, fallbackFull: true });
    rmSync(across, { recursive: true, force: true });
    for (const id of [reflinked.id, copied.id]) expect(["deleted", "reclaimed"], "REFERENCE_EFFICIENCY_COPY_ROOT_RELEASED").toContain((await client.poolRelease(id)).state);

    // Release and source deletion: leases first, then revocation withdraws every root; credit only on observed reclamation.
    for (const lease of [cold, warm, unchanged, changed, ...readers]) lease.release();
    db.query("UPDATE reference_grants SET revoked_at = 1").run();
    await sources.revoke({ grantIds: [], principalIds: [penelope.id] });
    for (let attempt = 0; attempt < 200 && (db.query("SELECT count(*) AS n FROM reference_roots").get() as { n: number }).n; attempt++) await Bun.sleep(10);
    await worktrees.close(); await sources.close();
    let released = await measure("released", null);
    for (let attempt = 0; attempt < 20 && released.chargedBytes - baseline.chargedBytes > 4 * MIB; attempt++) { await Bun.sleep(250); released = await measure("released", null); }
    report.findings.residualBytes = released.chargedBytes - baseline.chargedBytes;
    expect(await sourceRoots(), "REFERENCE_EFFICIENCY_SOURCES_WITHDRAWN").toEqual([]);
    expect(released.chargedBytes - baseline.chargedBytes, "REFERENCE_EFFICIENCY_RECLAIMED").toBeLessThanOrEqual(4 * MIB);
  } finally {
    save();
    db.close();
  }
}
