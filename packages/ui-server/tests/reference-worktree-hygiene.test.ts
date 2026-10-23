import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createUiDb } from "../src/db/client";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { createReferenceGrant } from "../src/db/reference-grants";
import { createReferenceSources } from "../src/brain/reference-source";
import type { ReferenceTransport } from "../src/brain/reference-transport";
import { createReferenceWorktrees, referenceWorktreeDependents } from "../src/brain/reference-worktrees";
import { createReferenceWorktreeHygiene } from "../src/brain/reference-worktree-hygiene";
import { createHygieneReview, HygieneAuthorityError } from "../src/inbox/hygiene-review";
import { createInboxStore } from "../src/inbox/store";
import type { BrainClient } from "../src/brain/client";
import { referencePoolDouble } from "./helpers/reference-pool-double";

const BRAIN = "ithaca-brain", DAY = 86_400, TOKEN = "fixture-reference-token";
const PUBLIC = "https://github.com/odysseus/ithaca", PRIVATE = "https://github.com/odysseus/penelope-loom";
let root: string, db: Database, clock: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "reference-worktree-hygiene-")); db = createUiDb(":memory:"); clock = Date.now(); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
const days = (count: number) => { clock += count * DAY * 1000; };

type NextResult = { finding: ({ id: string; fingerprint: string; path: string } & Record<string, unknown>) | null; counts: Record<string, unknown> };
type Listed = { entries: { id: string; path: string; state: string; issue: string; fingerprint: string; invalidation: { changed: string[] } | null }[] };

async function fixture() {
  const tips = new Map([[PUBLIC, "1".repeat(40)], [PRIVATE, "2".repeat(40)]]);
  const transport: ReferenceTransport = {
    async resolve({ repository, token }) {
      const tip = tips.get(repository.canonical);
      if (!tip || (repository.canonical === PRIVATE && token !== TOKEN)) return { ok: false, reason: "denied", detail: "fatal: repository not found" };
      return { ok: true, commit: tip, ref: "refs/heads/main" };
    },
    async fetch({ repository, root: target }) {
      writeFileSync(join(target, "odyssey.md"), "Sing, Muse, of the man of many ways.\n");
      writeFileSync(join(target, "secret-route.md"), "The route past Scylla.\n");
      return { commit: tips.get(repository.canonical)! };
    },
    async checkout() {},
  };
  const pool = referencePoolDouble(join(root, "pool"));
  const sources = createReferenceSources({ db, pool, transport, brain: BRAIN, credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN }, now: () => clock,
    dependents: rootId => referenceWorktreeDependents(db, rootId) });
  const worktrees = createReferenceWorktrees({ db, pool, sources, now: () => clock, coverage: async () => {} });
  const core = await import("@schlessera/brain/internal");
  const hygiene = createReferenceWorktreeHygiene({ db, worktrees, core: async () => core, now: () => clock, brainPath: root });
  const path = (id: string) => pool.records.get(id)!.path!;
  // The owner, and the delegated agent whose worktrees the owner reviews.
  const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 365 * DAY });
  const telemachus = createPrincipal(db, { authMethod: "delegated", label: "Telemachus", createdBy: penelope.id, ttlSeconds: 365 * DAY });
  for (const principal of [penelope, telemachus])
    createReferenceGrant(db, { brain: BRAIN, principalId: principal.id, repositoryPrefix: "https://github.com/odysseus", credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", createdBy: penelope.id, now: Date.now() });
  /** A released worktree holding one edit. */
  async function retained(repository = PUBLIC, principalId = penelope.id) {
    const tree = await worktrees.allocate({ principalId, repository, revision: "main" });
    writeFileSync(join(path(tree.id), "odyssey.md"), "Penelope unweaves the shroud.\n");
    await worktrees.release({ worktreeId: tree.id, principalId });
    return tree;
  }
  const next = async () => (await hygiene.run(["next"])) as NextResult;
  const list = async () => (await hygiene.run(["list"])) as Listed;
  const findings = () => db.query("SELECT id, state, kind, worktree_id FROM reference_worktree_findings ORDER BY id").all() as { id: string; state: string; kind: string; worktree_id: string }[];
  const receipt = (id: string) => db.query("SELECT state, trigger FROM reference_worktree_cleanups WHERE worktree_id = ?").get(id) as { state: string; trigger: string } | null;
  async function previewed(finding: NonNullable<NextResult["finding"]>) {
    const preview = (await hygiene.run(["resolve", "--handler", "delete-worktree", "--input", "null", "--expect-fingerprint", finding.fingerprint, "--dry-run", "--", finding.id])) as { status: string; previewToken: string };
    expect(preview.status).toBe("preview");
    const apply = (context = {}) => hygiene.run(["resolve", "--handler", "delete-worktree", "--input", "null", "--expect-fingerprint", finding.fingerprint, "--expect-preview", preview.previewToken, "--", finding.id], context);
    return { preview, apply };
  }
  /** A CLI with an empty Markdown backlog that refuses every write: worktree operations must never reach it. */
  const calls: string[][] = [];
  const brain = { hygiene: async (args: string[]) => {
    calls.push(args);
    if (args[0] === "next") return { finding: null, counts: { eligibleRemaining: 0, fixed: 0, dismissed: 0, snoozed: 0, nextSnoozeDueAt: null, informationalNotShown: 0 } };
    if (args[0] === "list") return { entries: [] };
    throw new Error(`unexpected CLI call ${args.join(" ")}`);
  } } as unknown as BrainClient;
  const review = () => createHygieneReview(db, { brain, worktrees: hygiene, now: () => clock });
  return { pool, sources, worktrees, hygiene, path, penelope, telemachus, retained, next, list, findings, receipt, previewed, calls, review };
}
const worktreeOf = (finding: { path: string }) => finding.path.slice("reference-worktree://".length);

describe("detection and dispositions", () => {
  test("repeated scans keep one canonical finding until its evidence changes", async () => {
    const f = await fixture();
    const tree = await f.retained();
    const first = await f.next();
    // A later, fresh assessment of unchanged work is the same evidence.
    days(1);
    expect(await f.hygiene.run(["check", "--", first.finding!.id])).toMatchObject({ status: "still_detected" });
    const again = await f.next();
    expect(first.finding?.id).toMatch(/^managed-worktree-/);
    expect({ rows: f.findings().length, id: again.finding?.id, fingerprint: again.finding?.fingerprint }, "REFERENCE_WORKTREE_HYGIENE_ONE_FINDING")
      .toEqual({ rows: 1, id: first.finding?.id, fingerprint: first.finding?.fingerprint });
    expect(first.finding?.path).toBe(`reference-worktree://${tree.id}`);
    expect(first.counts).toMatchObject({ eligibleRemaining: 1 });
  });

  test("a private worktree's finding, preview and list name no repository, revision, commit or path", async () => {
    const f = await fixture();
    const tree = await f.retained(PRIVATE, f.telemachus.id);
    const finding = (await f.next()).finding!;
    const preview = await f.hygiene.run(["resolve", "--handler", "delete-worktree", "--input", "null", "--expect-fingerprint", finding.fingerprint, "--dry-run", "--", finding.id]);
    const card = (await f.review().command(f.penelope.id, "start")).action;
    const shown = JSON.stringify({ finding, preview, list: await f.list(), card });
    for (const secret of ["penelope-loom", "odysseus/", "2222222222", "odyssey.md", "secret-route", f.telemachus.id])
      expect(shown.includes(secret), `REFERENCE_WORKTREE_HYGIENE_PRIVATE_OPAQUE ${secret}`).toBe(false);
    expect(shown).toContain(tree.id);
    expect(finding).toMatchObject({ worktree: { domain: "private", changedPaths: 1 } });
  });

  test("a dismissal holds through unrelated changes, is never removal consent and reopens when its own evidence changes", async () => {
    const f = await fixture();
    const one = await f.retained(), two = await f.retained();
    const target = (await f.next()).finding!;
    expect(await f.hygiene.run(["dismiss", "--expect-fingerprint", target.fingerprint, "--", target.id])).toMatchObject({ status: "dismissed" });
    const dismissed = worktreeOf(target), other = dismissed === one.id ? two.id : one.id;
    expect({ pool: f.pool.records.get(dismissed)?.state, receipt: f.receipt(dismissed) }, "REFERENCE_WORKTREE_DISMISSAL_NEVER_REMOVES").toEqual({ pool: "writable", receipt: null });
    // Another worktree changing, time passing and reconciliation are unrelated evidence.
    writeFileSync(join(f.path(other), "telemachus.md"), "A new voyage.\n");
    await f.worktrees.reassess(other, { remove: true });
    days(10); await f.worktrees.reconcile(); await f.next();
    expect(f.findings().find(row => row.id === target.id)?.state, "REFERENCE_WORKTREE_DISMISSAL_PERSISTS").toBe("dismissed");
    expect({ pool: f.pool.records.get(dismissed)?.state, receipt: f.receipt(dismissed) }, "REFERENCE_WORKTREE_DISMISSAL_STILL_NO_REMOVAL").toEqual({ pool: "writable", receipt: null });
    // Its own work changing invalidates the dismissal, naming the changed field.
    writeFileSync(join(f.path(dismissed), "odyssey.md"), "Penelope weaves again.\n");
    await f.worktrees.reassess(dismissed, { remove: true });
    expect((await f.list()).entries.find(entry => entry.id === target.id), "REFERENCE_WORKTREE_DISMISSAL_INVALIDATED").toMatchObject({ state: "open", invalidation: { changed: ["work"] } });
  });

  test("a snooze returns when due; unknown work is kept and charged with no removal offered", async () => {
    const f = await fixture();
    await f.retained();
    const finding = (await f.next()).finding!;
    expect(await f.hygiene.run(["snooze", "--expect-fingerprint", finding.fingerprint, "--until", new Date(clock + DAY * 1000).toISOString(), "--", finding.id])).toMatchObject({ status: "snoozed" });
    expect((await f.next()).finding).toBeNull();
    days(2);
    expect((await f.next()).finding?.id, "REFERENCE_WORKTREE_SNOOZE_RETURNS").toBe(finding.id);
    // A worktree whose baseline is gone cannot establish its work.
    const lost = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    db.query("UPDATE reference_worktrees SET baseline = NULL WHERE id = ?").run(lost.id);
    await f.worktrees.release({ worktreeId: lost.id, principalId: f.penelope.id });
    expect(f.pool.records.get(lost.id)?.state, "REFERENCE_WORKTREE_UNKNOWN_NOT_AUTOMATICALLY_REMOVED").toBe("writable");
    const unknown = (await f.list()).entries.find(entry => entry.path === `reference-worktree://${lost.id}`)!;
    const shown = (await f.hygiene.run(["next", "--finding", unknown.id, "--dry-run"])) as { finding: { handlers: { name: string }[]; fingerprint: string } };
    expect(shown.finding.handlers.map(handler => handler.name), "REFERENCE_WORKTREE_UNKNOWN_NO_REMOVAL_OFFERED").toEqual(["manual"]);
    expect(await f.hygiene.run(["resolve", "--handler", "delete-worktree", "--input", "null", "--expect-fingerprint", shown.finding.fingerprint, "--expect-preview", "0".repeat(32), "--", unknown.id]),
      "REFERENCE_WORKTREE_UNKNOWN_NEVER_REMOVED").toMatchObject({ status: "refused" });
    // Not through the service either, whatever premise a caller brings.
    expect(await f.worktrees.remove(lost.id, { trigger: "review", premise: "any", expect: () => null }), "REFERENCE_WORKTREE_UNKNOWN_WORK_REFUSED").toMatchObject({ status: "refused" });
    expect(f.pool.records.get(lost.id)?.state, "REFERENCE_WORKTREE_UNKNOWN_KEPT_AND_CHARGED").toBe("writable");
  });
});

describe("revalidated removal", () => {
  test("an unchanged reviewed removal deletes exactly that worktree and resolves its finding", async () => {
    const f = await fixture();
    const one = await f.retained(), two = await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    const target = worktreeOf(finding), other = target === one.id ? two.id : one.id;
    const source = f.pool.records.get(target)!.from!;
    expect(await apply(), "REFERENCE_WORKTREE_REVIEWED_REMOVAL").toMatchObject({ status: "fixed" });
    expect({ target: f.pool.records.get(target)?.state, other: f.pool.records.get(other)?.state, source: f.pool.records.get(source)?.state, receipt: f.receipt(target) })
      .toEqual({ target: "reclaimed", other: "writable", source: "sealed", receipt: { state: "reclaimed", trigger: "review" } });
    expect([...f.pool.records.values()].filter(record => record.purpose === "checkpoint" && record.from === target && record.state === "sealed"), "REFERENCE_WORKTREE_REMOVAL_RELEASES_CHECKPOINTS").toEqual([]);
    expect(f.findings().find(row => row.id === finding.id)?.state).toBe("resolved");
  });

  test("an edit after the preview makes the approval stale", async () => {
    const f = await fixture();
    await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    writeFileSync(join(f.path(worktreeOf(finding)), "odyssey.md"), "Odysseus strings the bow.\n");
    expect(await apply(), "REFERENCE_WORKTREE_STALE_APPROVAL_REFUSED_EDIT").toMatchObject({ status: "stale" });
    expect(f.pool.records.get(worktreeOf(finding))?.state).toBe("writable");
  });

  test("an edit that keeps the size and restores the modification time still makes the approval stale", async () => {
    const f = await fixture();
    await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    const file = join(f.path(worktreeOf(finding)), "odyssey.md"), before = statSync(file);
    writeFileSync(file, "Penelope reweaves the shroud.\n".slice(0, before.size).padEnd(before.size, "."));
    utimesSync(file, before.atime, before.mtime);
    expect(await apply(), "REFERENCE_WORKTREE_STALE_APPROVAL_REFUSED_SAME_SIZE_EDIT").toMatchObject({ status: "stale" });
    expect(f.pool.records.get(worktreeOf(finding))?.state).toBe("writable");
  });

  test("work that is only partly established is unknown: kept, charged and never removable", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(f.path(tree.id), "odyssey.md"), "Penelope unweaves the shroud.\n");
    // The changed file is unreadable in every later checkpoint, so its contents cannot be compared.
    const checkpoint = f.pool.poolCheckpoint;
    f.pool.poolCheckpoint = async (id, from, signal) => {
      const record = await checkpoint(id, from, signal);
      if (from === tree.id && db.query("SELECT 1 FROM reference_worktrees WHERE baseline = ?").get(id) === null) chmodSync(join(record.path!, "odyssey.md"), 0);
      return record;
    };
    const released = await f.worktrees.release({ worktreeId: tree.id, principalId: f.penelope.id });
    expect(released.cleanup).toMatchObject({ work: "unpreserved", changedPaths: 1, unverifiedPaths: 1 });
    const finding = (await f.next()).finding!;
    expect({ title: finding.title, handlers: (finding.handlers as { name: string }[]).map(handler => handler.name) }, "REFERENCE_WORKTREE_PARTLY_UNKNOWN_NOT_OFFERED")
      .toEqual({ title: "A managed worktree's work or owner cannot be established", handlers: ["manual"] });
    expect(await f.worktrees.remove(tree.id, { trigger: "review", premise: "any", expect: () => null }), "REFERENCE_WORKTREE_PARTLY_UNKNOWN_NEVER_REMOVED").toMatchObject({ status: "refused" });
    expect(f.pool.records.get(tree.id)?.state).toBe("writable");
  });

  test("a grant that lands while a removal assesses the worktree keeps it", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(f.path(tree.id), "odyssey.md"), "Changed before expiry.\n");
    days(4); await f.worktrees.reconcile();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    // A second service instance grants the worktree while the first one assesses it for removal.
    const other = createReferenceWorktrees({ db, pool: f.pool, sources: f.sources, now: () => clock, coverage: async () => {} });
    const generation = await other.openGeneration({ principalId: f.penelope.id, turnId: "turn-race", profile: "governed" });
    const checkpoint = f.pool.poolCheckpoint;
    let raced = false;
    f.pool.poolCheckpoint = async (id, from, signal) => {
      const record = await checkpoint(id, from, signal);
      if (from === tree.id && !raced && db.query("SELECT 1 FROM reference_worktrees WHERE baseline = ?").get(id) === null) {
        raced = true;
        // Its native grant completes; its reply, and so its host record, is still on the way.
        await f.pool.poolAccess(tree.id, generation.id);
      }
      return record;
    };
    expect(await apply(), "REFERENCE_WORKTREE_CONCURRENT_GRANT_NOT_DELETED").toMatchObject({ status: "stale" });
    expect({ raced, pool: f.pool.records.get(tree.id)?.state, access: f.pool.records.get(tree.id)?.access, receipt: f.receipt(tree.id) })
      .toEqual({ raced: true, pool: "writable", access: generation.id, receipt: null });
    await other.closeGeneration(generation.id); await other.close();
  });

  test("a removal and a grant of one worktree never interleave, whichever service instance runs them", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(f.path(tree.id), "odyssey.md"), "Changed before expiry.\n");
    days(4); await f.worktrees.reconcile();
    const { apply } = await f.previewed((await f.next()).finding!);
    const other = createReferenceWorktrees({ db, pool: f.pool, sources: f.sources, now: () => clock, coverage: async () => {} });
    const generation = await other.openGeneration({ principalId: f.penelope.id, turnId: "turn-serial", profile: "governed" });
    const access = f.pool.poolAccess, checkpoint = f.pool.poolCheckpoint;
    let granted: () => void = () => {};
    const grantedAt = new Promise<void>(resolve => { granted = resolve; });
    f.pool.poolAccess = async (...args) => { granted(); return access(...args); };
    let grant: Promise<unknown> | undefined;
    f.pool.poolCheckpoint = async (id, from, signal) => {
      const record = await checkpoint(id, from, signal);
      if (from === tree.id && !grant && db.query("SELECT 1 FROM reference_worktrees WHERE baseline = ?").get(id) === null) {
        // The other instance asks for the worktree while this removal assesses it, and gets a turn only after it.
        grant = other.access({ worktreeId: tree.id, principalId: f.penelope.id, generation: generation.id }).catch(error => error);
        await Promise.race([grantedAt, Bun.sleep(200)]);
      }
      return record;
    };
    expect(await apply(), "REFERENCE_WORKTREE_INSTANCES_SERIALIZE").toMatchObject({ status: "fixed" });
    expect({ grant: await grant, pool: f.pool.records.get(tree.id)?.state })
      .toMatchObject({ grant: { code: "released" }, pool: "reclaimed" });
    await other.closeGeneration(generation.id); await other.close();
  });

  test("a grant whose removal was admitted while it awaited is withdrawn, not recorded", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    days(4); await f.worktrees.reconcile();
    const resumable = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(f.path(resumable.id), "odyssey.md"), "Changed before expiry.\n");
    days(4); await f.worktrees.reconcile();
    const generation = await f.worktrees.openGeneration({ principalId: f.penelope.id, turnId: "turn-withdrawn", profile: "governed" });
    const access = f.pool.poolAccess;
    f.pool.poolAccess = async (id, held, signal) => {
      const record = await access(id, held, signal);
      db.query(`INSERT INTO reference_worktree_cleanups (worktree_id, trigger, state, premise, started_at) VALUES (?, 'review', 'started', 'elsewhere', ?)`).run(id, clock);
      return record;
    };
    await expect(f.worktrees.access({ worktreeId: resumable.id, principalId: f.penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_GRANT_WITHDRAWN_AFTER_REMOVAL_ADMITTED")
      .rejects.toMatchObject({ code: "released" });
    const row = db.query("SELECT state, holder FROM reference_worktrees WHERE id = ?").get(resumable.id);
    expect({ row, access: f.pool.records.get(resumable.id)?.access }).toEqual({ row: { state: "expired", holder: null }, access: null });
    expect(f.pool.records.get(tree.id)?.state).toBe("reclaimed");
    await f.worktrees.closeGeneration(generation.id);
  });

  test("a resumed expired worktree refuses the stale approval", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(f.path(tree.id), "odyssey.md"), "Changed before expiry.\n");
    days(4); await f.worktrees.reconcile();
    const { apply } = await f.previewed((await f.next()).finding!);
    const generation = await f.worktrees.openGeneration({ principalId: f.penelope.id, turnId: "turn-resume", profile: "governed" });
    await f.worktrees.access({ worktreeId: tree.id, principalId: f.penelope.id, generation: generation.id });
    await f.worktrees.closeGeneration(generation.id);
    expect(await apply(), "REFERENCE_WORKTREE_STALE_APPROVAL_REFUSED_RESUMED").toMatchObject({ status: "stale" });
    // The service refuses an active worktree whatever premise a caller brings.
    expect(await f.worktrees.remove(tree.id, { trigger: "review", premise: "any", expect: () => null }), "REFERENCE_WORKTREE_RESUMED_NEVER_REMOVED").toMatchObject({ status: "refused" });
    expect(f.pool.records.get(tree.id)?.state).toBe("writable");
  });

  test("a worktree whose native root was replaced under its identity is never removed through the old approval", async () => {
    const f = await fixture();
    await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    f.pool.records.get(worktreeOf(finding))!.root!.uuid = "b".repeat(32);
    expect(await apply(), "REFERENCE_WORKTREE_STALE_APPROVAL_REFUSED_REPLACED").toMatchObject({ status: "stale" });
    expect(f.pool.records.get(worktreeOf(finding))?.state).toBe("writable");
  });

  test("a worktree a live or unknown worker holds is never removed", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await f.worktrees.openGeneration({ principalId: f.penelope.id, turnId: "turn-live", profile: "governed" });
    await f.worktrees.access({ worktreeId: tree.id, principalId: f.penelope.id, generation: generation.id });
    await f.worktrees.release({ worktreeId: tree.id, principalId: f.penelope.id });
    expect(await f.worktrees.remove(tree.id, { trigger: "review", premise: "any", expect: () => null }), "REFERENCE_WORKTREE_LIVE_HOLDER_NEVER_REMOVED").toMatchObject({ status: "refused" });
    // A holder in another PID namespace has unknown liveness.
    db.query("UPDATE reference_worktree_generations SET owner_pid_namespace = 'elsewhere' WHERE id = ?").run(generation.id);
    expect(await f.worktrees.remove(tree.id, { trigger: "review", premise: "any", expect: () => null }), "REFERENCE_WORKTREE_UNKNOWN_HOLDER_NEVER_REMOVED").toMatchObject({ status: "refused" });
    expect(f.pool.records.get(tree.id)?.state).toBe("writable");
  });

  test("the reviewer's authority is read again immediately before the effect", async () => {
    const f = await fixture();
    await f.retained();
    const reviewer = createPrincipal(db, { authMethod: "password", label: "Eurycleia", ttlSeconds: 365 * DAY });
    const review = f.review();
    const card = (await review.command(reviewer.id, "start")).action!;
    // Authority ends while the removal assesses the worktree.
    const list = f.pool.listPoolRecovery;
    f.pool.listPoolRecovery = async (...args) => { revokePrincipal(db, reviewer.id, Date.now()); return list(...args); };
    // Selecting the next card after an effect may refuse the revoked reviewer too.
    await review.resolver.resolveAsync(reviewer.id, { type: "inbox_resolve", itemId: card.id, optionId: "delete-worktree" }).catch(() => {});
    const id = worktreeOf(card.hygiene!.finding as { path: string });
    expect({ pool: f.pool.records.get(id)?.state, receipt: f.receipt(id), outcome: (createInboxStore(db).getItem(card.id) as { hygiene?: { outcome?: { status: string } } } | null)?.hygiene?.outcome?.status },
      "REFERENCE_WORKTREE_REMOVAL_REVALIDATES_AUTHORITY").toEqual({ pool: "writable", receipt: null, outcome: "stale" });
  });
});

describe("receipts and recovery", () => {
  test("a removal is credited only after the pool observes reclamation", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    const source = f.pool.records.get(tree.id)!.from!;
    const release = f.pool.poolRelease;
    // Shared extents linger: the pool reports the worktree deleted, not yet reclaimed.
    f.pool.poolRelease = async (id, signal) => { const record = await release(id, signal); if (id === tree.id) record.state = "deleted"; return record; };
    await f.worktrees.release({ worktreeId: tree.id, principalId: f.penelope.id });
    expect(f.receipt(tree.id), "REFERENCE_WORKTREE_CREDIT_AFTER_RECLAMATION").toEqual({ state: "deleted", trigger: "automatic" });
    expect(referenceWorktreeDependents(db, source), "REFERENCE_WORKTREE_SOURCE_PROTECTED_UNTIL_RECLAIMED").toBe(true);
    f.pool.records.get(tree.id)!.state = "reclaimed";
    await f.worktrees.reconcile();
    expect(f.receipt(tree.id)).toEqual({ state: "reclaimed", trigger: "automatic" });
    expect(referenceWorktreeDependents(db, source)).toBe(false);
  });

  test("a clean worktree whose automatic removal could not run is removed by the next reconciliation", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    // The pool's records cannot be read at release, so the removal is refused before any receipt.
    const list = f.pool.listPoolRecovery;
    f.pool.listPoolRecovery = async () => { throw new Error("the manager is restarting"); };
    const released = await f.worktrees.release({ worktreeId: tree.id, principalId: f.penelope.id });
    expect({ state: released.state, pool: f.pool.records.get(tree.id)?.state, receipt: f.receipt(tree.id) }).toEqual({ state: "released", pool: "writable", receipt: null });
    f.pool.listPoolRecovery = list;
    await f.worktrees.reconcile();
    expect({ pool: f.pool.records.get(tree.id)?.state, receipt: f.receipt(tree.id) }, "REFERENCE_WORKTREE_CLEAN_REMOVAL_RETRIED_BY_RECONCILE")
      .toEqual({ pool: "reclaimed", receipt: { state: "reclaimed", trigger: "automatic" } });
  });

  test("a failed removal keeps identity, baseline and charge, ends access and reappears for review", async () => {
    const f = await fixture();
    // Expired, not released: only the removal itself can end its access.
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(f.path(tree.id), "odyssey.md"), "Changed before expiry.\n");
    days(4); await f.worktrees.reconcile();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    const release = f.pool.poolRelease;
    f.pool.poolRelease = async (id, signal) => { if (id === tree.id) throw new Error(`EBUSY: ${f.path(id)}/odyssey.md is open`); return release(id, signal); };
    const failure = await apply() as { status: string; code: string; reason: string };
    expect(failure, "REFERENCE_WORKTREE_REMOVAL_FAILURE_REPORTED").toMatchObject({ status: "check_failed", code: "cleanup-failed" });
    expect(failure.reason.includes(root) || failure.reason.includes("odyssey.md"), "REFERENCE_WORKTREE_FAILURE_REASON_OPAQUE").toBe(false);
    const baseline = (db.query("SELECT baseline FROM reference_worktrees WHERE id = ?").get(tree.id) as { baseline: string }).baseline;
    expect({ pool: f.pool.records.get(tree.id)?.state, baseline: f.pool.records.get(baseline)?.state, receipt: f.receipt(tree.id)?.state },
      "REFERENCE_WORKTREE_FAILED_REMOVAL_RETAINED").toEqual({ pool: "writable", baseline: "sealed", receipt: "failed" });
    const generation = await f.worktrees.openGeneration({ principalId: f.penelope.id, turnId: "turn-after-failure", profile: "governed" });
    await expect(f.worktrees.access({ worktreeId: tree.id, principalId: f.penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_FAILED_REMOVAL_FINAL")
      .rejects.toMatchObject({ code: "released" });
    await f.worktrees.closeGeneration(generation.id);
    // The worktree's one finding now says the removal failed; repeated scans keep it once, and review retries the removal.
    const failed = (await f.next()).finding!;
    await f.next();
    expect({ id: failed.id, issue: failed.title, rows: f.findings().map(row => row.kind) }, "REFERENCE_WORKTREE_FAILURE_REAPPEARS_ONCE")
      .toEqual({ id: finding.id, issue: "Removing a managed worktree failed", rows: ["cleanup-failed"] });
    expect(failed.fingerprint, "REFERENCE_WORKTREE_FAILURE_INVALIDATES_THE_APPROVAL").not.toBe(finding.fingerprint);
    f.pool.poolRelease = release;
    expect(await (await f.previewed(failed)).apply(), "REFERENCE_WORKTREE_FAILED_REMOVAL_RETRIED").toMatchObject({ status: "fixed" });
    expect({ pool: f.pool.records.get(tree.id)?.state, baseline: f.pool.records.get(baseline)?.state }).toEqual({ pool: "reclaimed", baseline: "reclaimed" });
  });

  test("after a failed removal, check again refreshes the evidence without removing anything", async () => {
    const f = await fixture();
    const tree = await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    const release = f.pool.poolRelease;
    f.pool.poolRelease = async (id, signal) => { if (id === tree.id) throw new Error("busy"); return release(id, signal); };
    await apply();
    f.pool.poolRelease = release;
    const failed = (await f.next()).finding!;
    writeFileSync(join(f.path(tree.id), "telemachus.md"), "A late voyage.\n");
    expect(await f.hygiene.run(["check", "--", failed.id])).toMatchObject({ status: "still_detected" });
    const refreshed = (await f.next()).finding!;
    expect({ changed: refreshed.fingerprint !== failed.fingerprint, pool: f.pool.records.get(tree.id)?.state }, "REFERENCE_WORKTREE_FAILED_EVIDENCE_REFRESHED")
      .toEqual({ changed: true, pool: "writable" });
    expect(await (await f.previewed(refreshed)).apply()).toMatchObject({ status: "fixed" });
  });

  test("review recovery never reports a failed removal whose reply was lost as fixed", async () => {
    const f = await fixture();
    const tree = await f.retained();
    const release = f.pool.poolRelease;
    f.pool.poolRelease = async (id, signal) => { if (id === tree.id) throw new Error("busy"); return release(id, signal); };
    // The removal fails and then its reply to the review is lost.
    const lossy = { ...f.hygiene, run: async (args: string[], context?: object) => {
      const result = await f.hygiene.run(args, context);
      if (args[0] === "resolve" && !args.includes("--dry-run")) throw new Error("the reply was lost");
      return result;
    } };
    const brain = { hygiene: async (args: string[]) => args[0] === "next"
      ? { finding: null, counts: { eligibleRemaining: 0, fixed: 0, dismissed: 0, snoozed: 0, nextSnoozeDueAt: null, informationalNotShown: 0 } } : { entries: [] } } as unknown as BrainClient;
    const review = createHygieneReview(db, { brain, worktrees: lossy, now: () => clock });
    const card = (await review.command(f.penelope.id, "start")).action!;
    await review.resolver.resolveAsync(f.penelope.id, { type: "inbox_resolve", itemId: card.id, optionId: "delete-worktree" });
    expect(f.receipt(tree.id)?.state).toBe("failed");
    await createHygieneReview(db, { brain, worktrees: f.hygiene, now: () => clock }).recover();
    const outcome = (createInboxStore(db).getItem(card.id) as { hygiene?: { outcome?: { status: string } } } | null)?.hygiene?.outcome?.status;
    expect({ outcome, fixed: review.read().review.fixed, pool: f.pool.records.get(tree.id)?.state }, "REFERENCE_WORKTREE_RECOVERY_NEVER_FIXES_A_FAILED_REMOVAL")
      .toEqual({ outcome: "stale", fixed: 0, pool: "writable" });
  });

  test("a lost reply to a removal the pool committed is read back, not reported as a failure", async () => {
    const f = await fixture();
    await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    const release = f.pool.poolRelease;
    f.pool.poolRelease = async (id, signal) => { await release(id, signal); if (id === worktreeOf(finding)) throw new Error("the reply was lost"); return f.pool.records.get(id)!; };
    expect(await apply(), "REFERENCE_WORKTREE_LOST_REPLY_READ_BACK").toMatchObject({ status: "fixed" });
    expect(f.receipt(worktreeOf(finding))).toEqual({ state: "reclaimed", trigger: "review" });
  });

  test("a removal whose outcome cannot be read back is never reported gone", async () => {
    const f = await fixture();
    const tree = await f.retained();
    const finding = (await f.next()).finding!;
    const { apply } = await f.previewed(finding);
    // The release reply is lost and the pool cannot be read either.
    const release = f.pool.poolRelease, list = f.pool.listPoolRecovery;
    f.pool.poolRelease = async (id, signal) => { if (id === tree.id) { f.pool.listPoolRecovery = async () => { throw new Error("unreachable"); }; throw new Error("lost"); } return release(id, signal); };
    expect(await apply()).toMatchObject({ status: "check_failed" });
    expect(f.receipt(tree.id)?.state).toBe("started");
    expect(await f.hygiene.run(["check", "--", finding.id]), "REFERENCE_WORKTREE_UNRESOLVED_REMOVAL_STILL_DETECTED").toMatchObject({ status: "still_detected" });
    // Once the pool answers, the outcome is read back: it never deleted, so the removal was interrupted.
    f.pool.poolRelease = release; f.pool.listPoolRecovery = list;
    expect(await f.hygiene.run(["check", "--", finding.id])).toMatchObject({ status: "still_detected" });
    expect({ receipt: f.receipt(tree.id)?.state, pool: f.pool.records.get(tree.id)?.state, kind: f.findings()[0]?.kind }).toEqual({ receipt: "interrupted", pool: "writable", kind: "cleanup-failed" });
  });

  test("a deleted file is work that review can remove, not unestablished work", async () => {
    const f = await fixture();
    const tree = await f.worktrees.allocate({ principalId: f.penelope.id, repository: PUBLIC, revision: "main" });
    rmSync(join(f.path(tree.id), "secret-route.md"));
    const released = await f.worktrees.release({ worktreeId: tree.id, principalId: f.penelope.id });
    expect(released.cleanup, "REFERENCE_WORKTREE_DELETION_IS_ESTABLISHED_WORK").toMatchObject({ work: "unpreserved", changedPaths: 1, unverifiedPaths: 0 });
    expect(await (await f.previewed((await f.next()).finding!)).apply()).toMatchObject({ status: "fixed" });
  });

  test("a restart after a committed removal recovers its outcome without deleting again; an interrupted one reappears for review", async () => {
    const f = await fixture();
    const done = await f.retained(), interrupted = await f.retained();
    for (const tree of [done, interrupted]) db.query(`INSERT INTO reference_worktree_cleanups (worktree_id, trigger, state, premise, started_at) VALUES (?, 'review', 'started', 'fp', ?)`).run(tree.id, clock);
    // The first removal reached the pool before the restart; the second never did.
    await f.pool.poolRelease(done.id);
    const releases: string[] = [], release = f.pool.poolRelease;
    f.pool.poolRelease = async (id, signal) => { releases.push(id); return release(id, signal); };
    const next = createReferenceWorktrees({ db, pool: f.pool, sources: f.sources, now: () => clock, coverage: async () => {} });
    await next.recover();
    const state = (id: string) => f.receipt(id)!.state;
    expect({ done: state(done.id), interrupted: state(interrupted.id), releases: releases.filter(id => [done.id, interrupted.id].includes(id)) },
      "REFERENCE_WORKTREE_LOST_REPLY_NOT_REPLAYED").toEqual({ done: "reclaimed", interrupted: "interrupted", releases: [] });
    const core = await import("@schlessera/brain/internal");
    const hygiene = createReferenceWorktreeHygiene({ db, worktrees: next, core: async () => core, now: () => clock, brainPath: root });
    const listed = (await hygiene.run(["list"])) as Listed;
    expect(listed.entries.find(entry => entry.path === `reference-worktree://${interrupted.id}`), "REFERENCE_WORKTREE_INTERRUPTED_REAPPEARS")
      .toMatchObject({ state: "open", issue: "Removing a managed worktree failed" });
    expect(f.pool.records.get(interrupted.id)?.state).toBe("writable");
    await next.close();
  });
});

describe("human-started review", () => {
  test("the owner reviews a delegated agent's worktree finding in the same queue, and only humans operate it", async () => {
    const f = await fixture();
    const tree = await f.retained(PUBLIC, f.telemachus.id);
    const review = f.review();
    await expect(review.command(f.telemachus.id, "start"), "REFERENCE_WORKTREE_AGENT_CANNOT_REVIEW").rejects.toBeInstanceOf(HygieneAuthorityError);
    const read = await review.command(f.penelope.id, "start");
    expect(read.action?.hygiene?.finding, "REFERENCE_WORKTREE_IN_REVIEW_QUEUE").toMatchObject({ path: `reference-worktree://${tree.id}`, category: "managed-worktree" });
    expect(read.action!.options.map(option => option.id)).toEqual(["delete-worktree", "check", "later", "dismiss"]);
    expect(read.action!.options[0]!.preview?.path).toBe(`reference-worktree/${tree.id}`);
    await review.resolver.resolveAsync(f.penelope.id, { type: "inbox_resolve", itemId: read.action!.id, optionId: "delete-worktree" });
    expect(createInboxStore(db).getItem(read.action!.id)?.status, "REFERENCE_WORKTREE_OWNER_REVIEWS_DELEGATED").toBe("resolved");
    expect(f.pool.records.get(tree.id)?.state).toBe("reclaimed");
    expect(f.calls.some(args => ["resolve", "check", "dismiss", "snooze"].includes(args[0]!)), "REFERENCE_WORKTREE_NEVER_SENT_TO_THE_CLI").toBe(false);
  });

  test("selection reassesses its winner, so a card never offers a repair its preview would find stale", async () => {
    const f = await fixture();
    const tree = await f.retained();
    await f.next();
    // The work becomes unestablished after it was last assessed.
    db.query("UPDATE reference_worktrees SET baseline = NULL WHERE id = ?").run(tree.id);
    const card = (await f.review().command(f.penelope.id, "start")).action!;
    expect({ title: card.payload.title, options: card.options.map(option => option.id) }, "REFERENCE_WORKTREE_SELECTION_USES_FRESH_EVIDENCE")
      .toEqual({ title: "A managed worktree's work or owner cannot be established", options: ["check", "later", "dismiss"] });
  });

  test("a dismissal through review never removes the worktree", async () => {
    const f = await fixture();
    const tree = await f.retained();
    const review = f.review();
    const read = await review.command(f.penelope.id, "start");
    await review.resolver.resolveAsync(f.penelope.id, { type: "inbox_resolve", itemId: read.action!.id, optionId: "dismiss" });
    expect(createInboxStore(db).getItem(read.action!.id)?.status).toBe("dismissed");
    await f.worktrees.reconcile();
    expect({ pool: f.pool.records.get(tree.id)?.state, receipt: f.receipt(tree.id) }, "REFERENCE_WORKTREE_REVIEW_DISMISSAL_NOT_CONSENT").toEqual({ pool: "writable", receipt: null });
  });
});
