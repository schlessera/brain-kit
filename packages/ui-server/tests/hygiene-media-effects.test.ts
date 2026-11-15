/**
 * The host side of the media review effects (#2781, Rollback A): capture
 * before mutation in the real change journal, per-file compensation with an
 * honest `partial`, Undo and restart recovery, over the real offline core CLI
 * and real files. Every assertion inspects the actual bytes. The brain
 * client runs the CLI directly (no worker boundary), so this suite runs on
 * any Linux host. Odysseus's cast; nothing reaches the network.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { hygieneMediaPlanSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { HygieneMediaPlan } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { journalStatement } from "../src/brain/journal-store.js";
import { createMediaEffects } from "../src/inbox/media-effects.js";
import { createHygieneReview } from "../src/inbox/hygiene-review.js";
import { createPrincipal } from "../src/db/principals.js";
import type { BrainClient } from "../src/brain/client.js";
import { createInboxStore } from "../src/inbox/store.js";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env.js";
import { createHygieneReviewRoutes } from "../src/routes/hygiene-review.js";
const createInboxStoreRead = (db: Parameters<typeof createInboxStore>[0], id: string) => { const item = createInboxStore(db).getItem(id); return item?.queue === "actions" ? item : null; };
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const CORE_CLI = resolve(import.meta.dir, "../../core/src/cli/brain.ts");
const LOOM = "photos/penelope-loom.png", NOTE = "journeys/return.md", SCRATCH = ".brain/scratch/2026-07-12/harbour-dawn.jpg";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const clean: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

function run(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, BRAIN_ROOT: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
function put(root: string, path: string, text: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

async function setup(options: { capBytes?: number; wrap?: (args: string[], real: (args: string[]) => unknown, signal?: AbortSignal) => unknown } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "brain-media-effects-host-"));
  const root = join(directory, "brain"); mkdirSync(root);
  run(root, "git", "init", "-q", "-b", "main");
  put(root, ".gitignore", ".brain/\nbrain.db*\n.brain-index/\n.bun/\n");
  put(root, "brain.config.json", "{}\n");
  put(root, "places/ithaca.md", "# Ithaca\n");
  run(root, "git", "add", "-A");
  run(root, "git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
  put(root, LOOM, "loom bytes");
  put(root, NOTE, "# Return\n\n![loom](../photos/penelope-loom.png)\n");
  const real = (args: string[]) => {
    const r = run(root, process.execPath, CORE_CLI, "hygiene", "--json", ...args);
    if (![0, 1].includes(r.code ?? -1)) throw new Error(`brain hygiene ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const cli = async (args: string[], signal?: AbortSignal) => options.wrap ? options.wrap(args, real, signal) : real(args);
  const dbPath = join(directory, "ui.sqlite"), db = createUiDb(dbPath), native = createNativeJournalFixture(root, directory);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: root, dbPath, objectsRoot: join(directory, "objects"), ...(options.capBytes ? { capBytes: options.capBytes } : {}) });
  await journal.ready;
  const gate = createWriterGate(db, root, { pollMs: 1 });
  let authorized = true;
  const reviewer = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  const effects = createMediaEffects(db, { brainPath: root, journal, gate, lock: createKeyedLock(), cli, authorized: id => authorized && (id === "odysseus" || id === reviewer.id) });
  const brain = { hygiene: async (args: readonly string[], opts?: { signal?: AbortSignal }) => cli([...args], opts?.signal) } as unknown as BrainClient;
  const review = createHygieneReview(db, { brain, media: effects });
  clean.push(async () => { await journal.close(); await native.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  let n = 0;
  async function plan(path: string, action: HygieneMediaPlan["action"], to?: string) {
    const finding = (real(["list"]) as { entries: Array<{ id: string; path: string; fingerprint: string }> }).entries.find(e => e.path === path)
      ?? (real(["reconcile"]), (real(["list"]) as { entries: Array<{ id: string; path: string; fingerprint: string }> }).entries.find(e => e.path === path))!;
    const raw = real(["media", action, finding.id, "--expect-fingerprint", finding.fingerprint, ...(to ? ["--to", to] : []), "--dry-run"]);
    return { finding, plan: hygieneMediaPlanSchema.parse(raw) };
  }
  async function apply(path: string, action: HygieneMediaPlan["action"], to?: string) {
    const { finding, plan: p } = await plan(path, action, to);
    expect(p.refusals).toEqual([]);
    return effects.apply({ id: `odysseus-media-${String(++n).padStart(4, "0")}`, principalId: "odysseus", findingId: finding.id, fingerprint: finding.fingerprint, plan: p });
  }
  return { root, directory, db, journal, effects, plan, apply, review, reviewer, brain, revoke() { authorized = false; }, undo: (sourceId: string) => effects.undo({ id: `${sourceId}-undo`, principalId: "odysseus", sourceId }) };
}

test("Delete captures the bytes first, removes the file, and Undo puts back the exact bytes", async () => {
  const f = await setup();
  const receipt = await f.apply(LOOM, "delete");
  expect(receipt, "MEDIA_DELETE_APPLIED").toMatchObject({ outcome: "applied", files: [{ path: LOOM, state: "removed" }], undo: { available: true } });
  expect(existsSync(join(f.root, LOOM))).toBe(false);
  const undone = await f.undo(receipt.journalId);
  expect(undone, "MEDIA_DELETE_UNDONE").toMatchObject({ outcome: "undone", files: [{ path: LOOM, state: "restored" }] });
  expect(read(f.root, LOOM), "MEDIA_DELETE_UNDO_BYTES").toBe("loom bytes");
  expect(f.effects.receipt(receipt.journalId, "odysseus")?.undo, "MEDIA_UNDO_ONCE").toEqual({ available: false, reason: "already-undone" });
});

test("Move rewrites the note; Undo restores the source, the note and removes the created folder", async () => {
  const f = await setup();
  const receipt = await f.apply(LOOM, "move", "places/ithaca/loom.png");
  expect(receipt.outcome).toBe("applied");
  expect(read(f.root, "places/ithaca/loom.png")).toBe("loom bytes");
  expect(read(f.root, NOTE), "MEDIA_MOVE_NOTE_BYTES").toBe("# Return\n\n![loom](../places/ithaca/loom.png)\n");
  const undone = await f.undo(receipt.journalId);
  expect(undone.outcome, "MEDIA_MOVE_UNDONE").toBe("undone");
  expect(read(f.root, LOOM)).toBe("loom bytes");
  expect(read(f.root, NOTE), "MEDIA_MOVE_UNDO_NOTE").toBe("# Return\n\n![loom](../photos/penelope-loom.png)\n");
  expect(existsSync(join(f.root, "places/ithaca")), "MEDIA_MOVE_UNDO_DIRECTORY").toBe(false);
});

test("Persist here edits the config; Undo restores its exact bytes", async () => {
  const f = await setup();
  const receipt = await f.apply(LOOM, "persist");
  expect(receipt.outcome).toBe("applied");
  expect(read(f.root, "brain.config.json"), "MEDIA_PERSIST_CONFIG").toBe('{ "media": { "track": ["photos/penelope-loom.png"] } }\n');
  expect((await f.undo(receipt.journalId)).outcome).toBe("undone");
  expect(read(f.root, "brain.config.json"), "MEDIA_PERSIST_UNDO_CONFIG").toBe("{}\n");
});

test("a conflicting exact-path ignore is removed in the same edit as the rule it conflicts with; Undo restores the config's exact bytes", async () => {
  // Ignored media is never a finding, so the conflict an effect meets is its copy's destination.
  const f = await setup();
  const config = '{ "media": { "ignore": ["places/ithaca/harbour-dawn.jpg", "*.psd"] } }\n';
  put(f.root, "brain.config.json", config);
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const { plan } = await f.plan(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg");
  expect(plan, "MEDIA_EXACT_IGNORE_PLAN").toMatchObject({ refusals: [], scope: "exact", ignoreAdjust: null, approvalDigest: null });
  const receipt = await f.apply(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg");
  expect(receipt.outcome).toBe("kept");
  expect(read(f.root, "brain.config.json"), "MEDIA_EXACT_IGNORE_CONFIG").toBe('{ "media": { "ignore": ["*.psd"], "track": ["places/ithaca/harbour-dawn.jpg"] } }\n');
  expect((await f.undo(receipt.journalId)).outcome).toBe("undone");
  expect(read(f.root, "brain.config.json"), "MEDIA_EXACT_IGNORE_UNDO_CONFIG").toBe(config);
  expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg"))).toBe(false);
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
});

test("Keep a permanent copy records the kept entry after the copy verifies; Undo removes the copy and keeps the original", async () => {
  const f = await setup();
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const pins = read(f.root, ".brain/scratch-pins/pins.json");
  const receipt = await f.apply(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg");
  expect(receipt, "MEDIA_KEEP_KEPT").toMatchObject({ outcome: "kept", copySha256: sha("dawn bytes") });
  expect(read(f.root, "places/ithaca/harbour-dawn.jpg")).toBe("dawn bytes");
  expect(read(f.root, "context/hygiene/kept.md"), "MEDIA_KEEP_ENTRY").toContain("- copy: `places/ithaca/harbour-dawn.jpg`");
  expect(read(f.root, SCRATCH), "MEDIA_KEEP_ORIGINAL").toBe("dawn bytes");
  expect(read(f.root, ".brain/scratch-pins/pins.json"), "MEDIA_KEEP_PINS").toBe(pins);
  expect((await f.undo(receipt.journalId)).outcome, "MEDIA_KEEP_UNDONE").toBe("undone");
  expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg"))).toBe(false);
  expect(read(f.root, "brain.config.json")).toBe("{}\n");
  expect(read(f.root, SCRATCH), "MEDIA_KEEP_UNDO_ORIGINAL").toBe("dawn bytes");
  expect(read(f.root, ".brain/scratch-pins/pins.json"), "MEDIA_KEEP_UNDO_PINS").toBe(pins);
  // The kept entry goes in the same Undo (rev 5 §5.7): the original is pending again, never reopened as copy-missing.
  expect(read(f.root, "context/hygiene/kept.md"), "MEDIA_KEEP_UNDO_UNKEPT").not.toContain("harbour-dawn");
  const entries = run(f.root, process.execPath, CORE_CLI, "hygiene", "--json", "list").stdout;
  const original = (JSON.parse(entries) as { entries: Array<{ path: string; state: string; invalidation: unknown }> }).entries.find(e => e.path === SCRATCH);
  expect(original, "MEDIA_KEEP_UNDO_OPEN").toMatchObject({ state: "open", invalidation: null });
  expect(read(f.root, "context/hygiene/open.md")).not.toContain("copy-missing");
});

test("a later ordinary sync commits the kept copy and its rule, and never the scratch original", async () => {
  const f = await setup();
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  expect((await f.apply(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg")).outcome).toBe("kept");
  run(f.root, "git", "config", "user.name", "Penelope"); run(f.root, "git", "config", "user.email", "penelope@example.test");
  const synced = run(f.root, process.execPath, CORE_CLI, "sync", "commit");
  expect(synced.code, `MEDIA_KEEP_SYNC_EXIT ${synced.stderr}`).toBe(0);
  expect(run(f.root, "git", "show", "HEAD:places/ithaca/harbour-dawn.jpg").stdout, "MEDIA_KEEP_SYNC_COPY").toBe("dawn bytes");
  expect(run(f.root, "git", "show", "HEAD:brain.config.json").stdout, "MEDIA_KEEP_SYNC_CONFIG").toBe('{ "media": { "track": ["places/ithaca/harbour-dawn.jpg"] } }\n');
  expect(run(f.root, "git", "ls-files", "--", ".brain").stdout, "MEDIA_KEEP_SYNC_NO_SCRATCH").toBe("");
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
});

test("a refused kept entry (step 6b) removes the copy and restores the config", async () => {
  const f = await setup({ wrap: (args, real) => args[0] === "keep-copy" ? { status: "refused", reason: "copy-changed" } : real(args) });
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const receipt = await f.apply(SCRATCH, "keep-copy", "places/harbour-dawn.jpg");
  expect(receipt, "MEDIA_KEEP_6B_COMPENSATED").toMatchObject({ outcome: "compensated", reason: "copy-changed" });
  expect(existsSync(join(f.root, "places/harbour-dawn.jpg")), "MEDIA_KEEP_6B_NO_COPY").toBe(false);
  expect(read(f.root, "brain.config.json")).toBe("{}\n");
  expect(existsSync(join(f.root, "context/hygiene/kept.md"))).toBe(false);
});

test("capture that cannot fit the journal refuses before any write", async () => {
  const f = await setup({ capBytes: 1024 * 1024 });
  const loom = "L".repeat(2 * 1024 * 1024);
  put(f.root, LOOM, loom);
  const receipt = await f.apply(LOOM, "delete");
  expect(receipt, "MEDIA_CAPTURE_CAPACITY").toMatchObject({ outcome: "refused", reason: "capture-capacity" });
  expect(sha(read(f.root, LOOM)), "MEDIA_CAPTURE_BEFORE_WRITE").toBe(sha(loom));
});

test("an interrupted apply is compensated per file, and a concurrent edit is left as a conflict (partial)", async () => {
  let concurrent = false;
  const f = await setup({ wrap: (args, real) => {
    if (args[0] !== "media" || args.includes("--dry-run")) return real(args);
    const result = real(args) as { status: string };
    if (result.status !== "applied") return result;
    if (concurrent) put(f.root, NOTE, "Penelope's own later edit\n");
    return { ...result, status: "interrupted", reason: "write-failed" };
  } });
  const whole = await f.apply(LOOM, "move", "places/loom.png");
  expect(whole, "MEDIA_COMPENSATED").toMatchObject({ outcome: "compensated" });
  expect(read(f.root, LOOM)).toBe("loom bytes");
  expect(read(f.root, NOTE)).toBe("# Return\n\n![loom](../photos/penelope-loom.png)\n");
  expect(existsSync(join(f.root, "places/loom.png"))).toBe(false);
  concurrent = true;
  const partial = await f.apply(LOOM, "move", "places/loom.png");
  expect(partial.outcome, "MEDIA_PARTIAL").toBe("partial");
  expect(partial.files.find(x => x.path === NOTE)?.state, "MEDIA_PARTIAL_CONFLICT").toBe("conflict");
  expect(read(f.root, NOTE), "MEDIA_PARTIAL_NO_OVERWRITE").toBe("Penelope's own later edit\n");
  expect(read(f.root, LOOM), "MEDIA_PARTIAL_SOURCE_RESTORED").toBe("loom bytes");
});

test("Undo refuses before any write when a file changed since, or when rollback data was evicted", async () => {
  const f = await setup();
  const moved = await f.apply(LOOM, "move", "places/loom.png");
  put(f.root, NOTE, "Telemachus edited this\n");
  expect(f.effects.receipt(moved.journalId, "odysseus")?.undo, "MEDIA_UNDO_CHANGED_SINCE").toEqual({ available: false, reason: "changed-since", path: NOTE });
  expect((await f.undo(moved.journalId)).outcome).toBe("refused");
  expect(read(f.root, "places/loom.png"), "MEDIA_UNDO_REFUSAL_WRITES_NOTHING").toBe("loom bytes");
  expect(read(f.root, NOTE)).toBe("Telemachus edited this\n");

  const g = await setup();
  const deleted = await g.apply(LOOM, "delete");
  for (const name of readdirSync(join(g.directory, "objects"))) if (name === sha("loom bytes")) rmSync(join(g.directory, "objects", name));
  expect(g.effects.receipt(deleted.journalId, "odysseus")?.undo, "MEDIA_UNDO_EVICTED").toEqual({ available: false, reason: "rollback-evicted" });
  expect((await g.undo(deleted.journalId)).outcome).toBe("refused");
  expect(existsSync(join(g.root, LOOM))).toBe(false);
});

test("a restart compensates an interrupted Move from its durable intent and never re-applies it", async () => {
  const f = await setup();
  const moved = await f.apply(LOOM, "move", "places/loom.png");
  // As if the server died after the files were written, before the outcome committed.
  await f.journal.writeOperation([journalStatement("UPDATE turn_journal_media_operations SET state='applying',pid=?,pid_start=? WHERE id=?", 2 ** 22 + 7, "0", moved.journalId)]);
  await f.effects.recover();
  expect(f.effects.receipt(moved.journalId, "odysseus"), "MEDIA_RECOVERY_COMPENSATED").toMatchObject({ outcome: "compensated", reason: "interrupted" });
  expect(read(f.root, LOOM)).toBe("loom bytes");
  expect(read(f.root, NOTE)).toBe("# Return\n\n![loom](../photos/penelope-loom.png)\n");
  expect(existsSync(join(f.root, "places/loom.png"))).toBe(false);
  await f.effects.recover();
  expect(read(f.root, LOOM), "MEDIA_RECOVERY_ONCE").toBe("loom bytes");
});

test("a revoked reviewer cannot apply, and an operation identity cannot be reused for another plan", async () => {
  const f = await setup();
  const { finding, plan } = await f.plan(LOOM, "delete");
  const persist = await f.plan(LOOM, "persist");
  const reused = { id: "odysseus-media-reused", principalId: "odysseus", findingId: finding.id, fingerprint: finding.fingerprint };
  expect((await f.effects.apply({ ...reused, plan: persist.plan })).outcome).toBe("applied");
  await expect(f.effects.apply({ ...reused, plan }), "MEDIA_IDENTITY_REUSE_REFUSED").rejects.toThrow("Operation identity belongs to another request");
  expect(read(f.root, LOOM), "MEDIA_IDENTITY_REUSE_WRITES_NOTHING").toBe("loom bytes");
  f.revoke();
  await expect(f.effects.apply({ id: "odysseus-media-revoked", principalId: "odysseus", findingId: finding.id, fingerprint: finding.fingerprint, plan })).rejects.toThrow("authority");
  expect(read(f.root, LOOM)).toBe("loom bytes");
});

test("review offers the media effects with their plans, applies one through the resolver, and resolves the card with its receipt", async () => {
  const f = await setup();
  // Notes without frontmatter would be selected first, as errors.
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md"));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  expect(card.options.map(o => o.id), "MEDIA_REVIEW_OPTIONS").toEqual(["media-persist", "media-persist-rule", "media-move", "media-delete", "leave-pending", "check", "later", "dismiss"]);
  const del = card.options.find(o => o.id === "media-delete")!;
  expect(del.media?.files, "MEDIA_REVIEW_PLANNED").toEqual([{ path: LOOM, role: "source", before: sha("loom bytes"), after: null, bytes: 10 }]);
  // Move needs a previewed destination first.
  await expect(f.review.resolver.resolveAsync(f.reviewer.id, { type: "inbox_resolve", itemId: card.id, optionId: "media-move" }), "MEDIA_REVIEW_PREVIEW_REQUIRED").rejects.toThrow("preview");
  const previewed = await f.review.preview(f.reviewer.id, { itemId: card.id, optionId: "media-move", expectedVersion: card.version, input: "places/loom.png" });
  expect(previewed.options.find(o => o.id === "media-move")?.media?.destination).toBe("places/loom.png");
  await f.review.resolver.resolveAsync(f.reviewer.id, { type: "inbox_resolve", itemId: card.id, optionId: "media-move" });
  const done = f.review.read();
  expect(read(f.root, "places/loom.png"), "MEDIA_REVIEW_MOVED").toBe("loom bytes");
  const resolved = createInboxStoreRead(f.db, card.id);
  expect(resolved?.status, "MEDIA_REVIEW_RESOLVED").toBe("resolved");
  expect(resolved?.hygiene?.outcome, "MEDIA_REVIEW_RECEIPT").toMatchObject({ status: "fixed", media: { outcome: "applied", action: "move", undo: { available: true } } });
  expect(done.review.fixed).toBe(1);
});

/** Two media findings in review, with nothing else selectable first. */
async function reviewWithTwo(f: Awaited<ReturnType<typeof setup>>) {
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md"));
  put(f.root, "photos/achilles-shield.jpg", "shield bytes");
  return (await f.review.command(f.reviewer.id, "start")).action!;
}
const resolveWith = (f: Awaited<ReturnType<typeof setup>>, itemId: string, optionId: string) => f.review.resolver.resolveAsync(f.reviewer.id, { type: "inbox_resolve", itemId, optionId });

test("undo-media from review undoes a resolved Delete, records the Undo on the card, and the finding returns on a successor card", async () => {
  const f = await setup();
  const card = await reviewWithTwo(f);
  const deleted = (card.hygiene!.finding as { path: string }).path;
  const bytes = read(f.root, deleted);
  await resolveWith(f, card.id, "media-delete");
  const resolved = createInboxStoreRead(f.db, card.id)!;
  expect(resolved.hygiene?.outcome).toMatchObject({ status: "fixed", media: { outcome: "applied", undo: { available: true } } });
  expect(existsSync(join(f.root, deleted))).toBe(false);
  expect(f.review.read().review.fixed).toBe(1);
  const second = f.review.read().action!;

  const result = await f.review.undoMedia(f.reviewer.id, resolved.hygiene!.outcome!.media!.journalId);
  expect(result.mediaUndo, "MEDIA_REVIEW_UNDO").toMatchObject({ outcome: "undone", files: [{ path: deleted, state: "restored" }] });
  expect(read(f.root, deleted), "MEDIA_REVIEW_UNDO_BYTES").toBe(bytes);
  const after = createInboxStoreRead(f.db, card.id)!;
  expect(after.status, "MEDIA_REVIEW_UNDO_CARD_TERMINAL").toBe("resolved");
  expect(after.hygiene?.outcome, "MEDIA_REVIEW_UNDO_CARD").toMatchObject({ status: "undone", media: { outcome: "undone", action: "delete" } });
  expect(result.review.fixed, "MEDIA_REVIEW_UNDO_COUNTER").toBe(0);
  // The same command again changes nothing.
  expect((await f.review.undoMedia(f.reviewer.id, resolved.hygiene!.outcome!.media!.journalId)).mediaUndo.outcome).toBe("undone");
  expect(createInboxStoreRead(f.db, card.id)!.version).toBe(after.version);

  // Leaving the other card pending selects the restored finding again, on a new card.
  await resolveWith(f, second.id, "leave-pending");
  const again = f.review.read().action;
  expect(again?.hygiene?.findingId, "MEDIA_REVIEW_UNDO_RESELECTED").toBe(card.hygiene!.findingId);
  expect(again?.id).not.toBe(card.id);
  expect(again?.status).toBe("pending");
});

test("undo-media while another card is pending, or after the pass ended, counts the restored file as awaiting review again (#2783)", async () => {
  const f = await setup();
  const card = await reviewWithTwo(f);
  expect(f.review.read().review.media, "MEDIA_REVIEW_COUNT_BEFORE").toEqual({ awaitingReview: 2, setAside: 0, kept: 0 });
  await resolveWith(f, card.id, "media-delete");
  const second = f.review.read().action!;
  expect(f.review.read().review.media).toEqual({ awaitingReview: 1, setAside: 0, kept: 0 });
  const journalId = createInboxStoreRead(f.db, card.id)!.hygiene!.outcome!.media!.journalId;
  // The other card stays the pending one, and the count the review shows is the CLI's again.
  const undone = await f.review.undoMedia(f.reviewer.id, journalId);
  expect(undone.mediaUndo.outcome).toBe("undone");
  expect(undone.action?.id, "MEDIA_REVIEW_UNDO_KEEPS_CARD").toBe(second.id);
  expect(undone.review.media, "MEDIA_REVIEW_UNDO_RECOUNTED").toEqual({ awaitingReview: 2, setAside: 0, kept: 0 });
  expect((await f.brain.hygiene!(["next"]) as { media: { awaitingReview: number } }).media.awaitingReview, "MEDIA_REVIEW_UNDO_CLI_COUNT").toBe(2);
  // After the pass: deleting the last one ends it, and its Undo is counted although nothing selects.
  await resolveWith(f, second.id, "media-delete");
  const third = f.review.read().action!;
  await resolveWith(f, third.id, "media-delete");
  expect(f.review.read().review.status).toBe("complete");
  expect(f.review.read().review.media).toEqual({ awaitingReview: 0, setAside: 0, kept: 0 });
  const last = await f.review.undoMedia(f.reviewer.id, createInboxStoreRead(f.db, third.id)!.hygiene!.outcome!.media!.journalId);
  expect(last.review.status, "MEDIA_REVIEW_UNDO_PASS_STAYS_COMPLETE").toBe("complete");
  expect(last.review.media, "MEDIA_REVIEW_UNDO_RECOUNTED_COMPLETE").toEqual({ awaitingReview: 1, setAside: 0, kept: 0 });
});

test("undo-media refuses before any write when a file changed since, and the card shows why", async () => {
  const f = await setup();
  const card = await reviewWithTwo(f);
  const deleted = (card.hygiene!.finding as { path: string }).path;
  await resolveWith(f, card.id, "media-delete");
  const journalId = createInboxStoreRead(f.db, card.id)!.hygiene!.outcome!.media!.journalId;
  put(f.root, deleted, "Penelope wove it again\n");
  const result = await f.review.undoMedia(f.reviewer.id, journalId);
  expect(result.mediaUndo, "MEDIA_REVIEW_UNDO_REFUSED").toMatchObject({ outcome: "refused", reason: "changed-since" });
  expect(read(f.root, deleted), "MEDIA_REVIEW_UNDO_REFUSAL_NO_WRITE").toBe("Penelope wove it again\n");
  expect(createInboxStoreRead(f.db, card.id)!.hygiene?.outcome, "MEDIA_REVIEW_UNDO_REFUSAL_CARD").toMatchObject({ status: "fixed", media: { outcome: "applied", undo: { available: false, reason: "changed-since", path: deleted } } });
  expect(result.review.fixed).toBe(1);
  // Another principal cannot reach this receipt.
  const other = createPrincipal(f.db, { authMethod: "password", label: "Telemachus", ttlSeconds: 86400 });
  await expect(f.review.undoMedia(other.id, journalId), "MEDIA_REVIEW_UNDO_OWNER").rejects.toThrow();
});

test("undo-media of a kept copy from review removes the copy, its rule and its kept entry, and the kept counter drops", async () => {
  const f = await setup();
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md")); rmSync(join(f.root, LOOM));
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  expect((card.hygiene!.finding as { path: string }).path).toBe(SCRATCH);
  const previewed = await f.review.preview(f.reviewer.id, { itemId: card.id, optionId: "media-keep-copy", expectedVersion: card.version, input: "places/ithaca/harbour-dawn.jpg" });
  expect(previewed.options.find(o => o.id === "media-keep-copy")?.media?.refusals).toEqual([]);
  await resolveWith(f, card.id, "media-keep-copy");
  expect(createInboxStoreRead(f.db, card.id)!.hygiene?.outcome?.status).toBe("kept");
  expect(f.review.read().review.kept).toBe(1);
  const result = await f.review.undoMedia(f.reviewer.id, createInboxStoreRead(f.db, card.id)!.hygiene!.outcome!.media!.journalId);
  expect(result.mediaUndo, "MEDIA_REVIEW_UNDO_KEPT").toMatchObject({ outcome: "undone", action: "keep-copy" });
  expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg"))).toBe(false);
  expect(read(f.root, "brain.config.json")).toBe("{}\n");
  expect(read(f.root, "context/hygiene/kept.md"), "MEDIA_REVIEW_UNDO_UNKEPT").not.toContain("harbour-dawn");
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  expect(result.review.kept, "MEDIA_REVIEW_UNDO_KEPT_COUNTER").toBe(0);
});

test("review previews a broader Persist rule with its current matches, applies it for the principal who approved it, and Undo restores the config", async () => {
  const f = await setup();
  const card = await reviewWithTwo(f);
  const rule = card.options.find(o => o.id === "media-persist-rule")!;
  expect(rule, "MEDIA_RULE_OPTION").toMatchObject({ label: "Persist with a broader rule…", input: { type: "string", example: "photos/*" }, effect: { operation: "media-persist" } });
  const previewed = await f.review.preview(f.reviewer.id, { itemId: card.id, optionId: "media-persist-rule", expectedVersion: card.version, input: "photos/*" });
  const option = previewed.options.find(o => o.id === "media-persist-rule")!;
  expect(option.media, "MEDIA_RULE_PLAN").toMatchObject({ scope: "pattern", pattern: "photos/*", refusals: [], configDiff: { track: { before: [], after: ["photos/*"] } } });
  expect(option.media?.matches?.track, "MEDIA_RULE_MATCHES").toMatchObject({ count: 2, changed: 2, anyFolder: false });
  expect(option.media?.approvalDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(option.effect, "MEDIA_RULE_APPROVED_BY").toMatchObject({ approvedBy: f.reviewer.id });
  // The plain Persist here option is unchanged: the exact path, no approval.
  expect(previewed.options.find(o => o.id === "media-persist")?.media, "MEDIA_RULE_EXACT_UNCHANGED").toMatchObject({ scope: "exact", approvalDigest: null });
  expect(read(f.root, "brain.config.json")).toBe("{}\n");
  await resolveWith(f, card.id, "media-persist-rule");
  expect(createInboxStoreRead(f.db, card.id)!.hygiene?.outcome, "MEDIA_RULE_APPLIED").toMatchObject({ status: "fixed", media: { outcome: "applied", action: "persist" } });
  expect(read(f.root, "brain.config.json"), "MEDIA_RULE_CONFIG").toBe('{ "media": { "track": ["photos/*"] } }\n');
  // The rule also covers the other current match: nothing is left to review.
  expect(f.review.read().action, "MEDIA_RULE_COVERS_MATCHES").toBeFalsy();
  const result = await f.review.undoMedia(f.reviewer.id, createInboxStoreRead(f.db, card.id)!.hygiene!.outcome!.media!.journalId);
  expect(result.mediaUndo.outcome).toBe("undone");
  expect(read(f.root, "brain.config.json"), "MEDIA_RULE_UNDO_CONFIG").toBe("{}\n");
});

test("a broader rule another principal previewed is a stale approval, and a match that appears after the preview is too; nothing is written", async () => {
  const f = await setup();
  const card = await reviewWithTwo(f);
  const other = createPrincipal(f.db, { authMethod: "password", label: "Telemachus", ttlSeconds: 86400 });
  await f.review.preview(other.id, { itemId: card.id, optionId: "media-persist-rule", expectedVersion: card.version, input: "photos/*" });
  await resolveWith(f, card.id, "media-persist-rule");
  expect(createInboxStoreRead(f.db, card.id)!.hygiene?.outcome, "MEDIA_RULE_OTHER_PRINCIPAL").toMatchObject({ status: "stale", reason: "stale-approval" });
  expect(read(f.root, "brain.config.json")).toBe("{}\n");

  const g = await setup();
  const next = await reviewWithTwo(g);
  await g.review.preview(g.reviewer.id, { itemId: next.id, optionId: "media-persist-rule", expectedVersion: next.version, input: "photos/*" });
  put(g.root, "photos/suitors.png", "suitor bytes");
  await resolveWith(g, next.id, "media-persist-rule");
  expect(createInboxStoreRead(g.db, next.id)!.hygiene?.outcome, "MEDIA_RULE_STALE_MATCHES").toMatchObject({ status: "stale", media: { outcome: "stale", reason: "stale-approval" } });
  expect(read(g.root, "brain.config.json")).toBe("{}\n");
});

test("a copy destination under a broader ignore is previewed with that ignore adjusted and what stops being ignored, then applied as approved", async () => {
  const f = await setup();
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md")); rmSync(join(f.root, LOOM));
  put(f.root, "brain.config.json", '{ "media": { "ignore": ["places/renders/*"] } }\n');
  put(f.root, "places/renders/ithaca-sketch.png", "sketch bytes");
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  const previewed = await f.review.preview(f.reviewer.id, { itemId: card.id, optionId: "media-keep-copy", expectedVersion: card.version, input: "places/renders/harbour-dawn.jpg" });
  const plan = previewed.options.find(o => o.id === "media-keep-copy")!.media!;
  expect(plan, "MEDIA_ADJUST_PLAN").toMatchObject({ refusals: [], scope: "exact", ignoreAdjust: "places/renders/*", configDiff: { ignore: { before: ["places/renders/*"], after: [] } } });
  expect(plan.matches?.ignore, "MEDIA_ADJUST_MATCHES").toMatchObject({ count: 1, changed: 1 });
  await resolveWith(f, card.id, "media-keep-copy");
  expect(createInboxStoreRead(f.db, card.id)!.hygiene?.outcome?.status, "MEDIA_ADJUST_KEPT").toBe("kept");
  expect(read(f.root, "brain.config.json"), "MEDIA_ADJUST_CONFIG").toBe('{ "media": { "ignore": [], "track": ["places/renders/harbour-dawn.jpg"] } }\n');
  expect(read(f.root, "places/renders/harbour-dawn.jpg")).toBe("dawn bytes");
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  const pins = read(f.root, ".brain/scratch-pins/pins.json");
  const undone = await f.review.undoMedia(f.reviewer.id, createInboxStoreRead(f.db, card.id)!.hygiene!.outcome!.media!.journalId);
  expect(undone.mediaUndo, "MEDIA_ADJUST_UNDONE").toMatchObject({ outcome: "undone", action: "keep-copy" });
  expect(read(f.root, "brain.config.json"), "MEDIA_ADJUST_UNDO_CONFIG").toBe('{ "media": { "ignore": ["places/renders/*"] } }\n');
  expect(existsSync(join(f.root, "places/renders/harbour-dawn.jpg")), "MEDIA_ADJUST_UNDO_COPY").toBe(false);
  expect(read(f.root, "places/renders/ithaca-sketch.png"), "MEDIA_ADJUST_UNDO_MATCH").toBe("sketch bytes");
  expect(read(f.root, "context/hygiene/kept.md"), "MEDIA_ADJUST_UNDO_UNKEPT").not.toContain("harbour-dawn");
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  expect(read(f.root, ".brain/scratch-pins/pins.json")).toBe(pins);
});

test("POST /hygiene/review routes undo-media: a refusal is a 200 result, a malformed body 400, an unknown receipt 500", async () => {
  const f = await setup();
  const card = await reviewWithTwo(f);
  const deleted = (card.hygiene!.finding as { path: string }).path;
  await resolveWith(f, card.id, "media-delete");
  const journalId = createInboxStoreRead(f.db, card.id)!.hygiene!.outcome!.media!.journalId;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("principal", { id: f.reviewer.id } as never); await next(); });
  app.route("/", createHygieneReviewRoutes(f.review));
  const post = async (body: unknown) => { const res = await app.request("/hygiene/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() as Record<string, unknown> }; };
  put(f.root, deleted, "Penelope wove it again\n");
  const refused = await post({ operation: "undo-media", journalId });
  expect(refused.status, "MEDIA_ROUTE_UNDO_REFUSED").toBe(200);
  expect(refused.body.mediaUndo).toMatchObject({ outcome: "refused", reason: "changed-since" });
  expect((await post({ operation: "undo-media" })).status, "MEDIA_ROUTE_UNDO_MALFORMED").toBe(400);
  expect((await post({ operation: "undo-media", journalId: `media-${"0".repeat(40)}` })).status, "MEDIA_ROUTE_UNDO_UNKNOWN").toBe(500);
  rmSync(join(f.root, deleted));
  const undone = await post({ operation: "undo-media", journalId });
  expect(undone, "MEDIA_ROUTE_UNDO").toMatchObject({ status: 200, body: { mediaUndo: { outcome: "undone" } } });
  expect(existsSync(join(f.root, deleted))).toBe(true);
});

/**
 * A dry-run scan held open until released or aborted, as the real client's
 * is while its CLI runs: an abort rejects it, as killing the CLI does.
 */
function heldScans() {
  const held: Array<{ args: string[]; signal?: AbortSignal; release: () => void }> = [];
  let hold = false;
  const wrap = (args: string[], real: (args: string[]) => unknown, signal?: AbortSignal) => {
    if (!hold || args[0] !== "media" || !args.includes("--dry-run")) return real(args);
    return new Promise((resolve, reject) => {
      const entry = { args, signal, release: () => resolve(real(args)) };
      held.push(entry);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { wrap, held, arm() { hold = true; }, stop() { hold = false; } };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 500 && !check(); i++) await Bun.sleep(2); expect(check()).toBe(true); };

test("one preview scan per server: the same principal's newer preview aborts the older scan, which stores nothing; another principal gets preview-busy", async () => {
  const hold = heldScans();
  const f = await setup({ wrap: hold.wrap });
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md"));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  // Previews from here on are held until released.
  hold.arm();
  const other = createPrincipal(f.db, { authMethod: "password", label: "Telemachus", ttlSeconds: 86400 });
  const request = (input: string, requestId: string) => ({ itemId: card.id, optionId: "media-move", expectedVersion: card.version, input, requestId });

  const first = f.review.preview(f.reviewer.id, request("places/first.png", "r-1"));
  await until(() => hold.held.length === 1);
  // Another principal is refused while the scan runs: a 200 result, with no scan started and nothing stored.
  const busy = await Promise.race([f.review.preview(other.id, request("places/other.png", "t-1")), Bun.sleep(3000).then(() => null)]);
  expect(busy, "PREVIEW_BUSY_ANSWERS_AT_ONCE").not.toBeNull();
  expect(hold.held[0]!.signal?.aborted, "PREVIEW_BUSY_NEVER_ABORTS_ANOTHER").toBe(false);
  expect(busy!.refusals, "PREVIEW_BUSY").toEqual([{ code: "preview-busy" }]);
  expect(busy!.requestId, "PREVIEW_BUSY_ECHO").toBe("t-1");
  expect(busy!.version).toBe(card.version);
  expect(hold.held.length).toBe(1);

  const second = f.review.preview(f.reviewer.id, request("places/loom.png", "r-2"));
  expect(hold.held[0]!.signal?.aborted, "PREVIEW_SUPERSEDE_ABORTS_SCAN").toBe(true);
  const superseded = await first;
  expect(superseded, "PREVIEW_SUPERSEDED").toMatchObject({ requestId: "r-1", refusals: [{ code: "preview-superseded" }], version: card.version });
  await until(() => hold.held.length === 2);
  hold.held[1]!.release();
  const current = await second;
  expect(current.requestId, "PREVIEW_ECHO").toBe("r-2");
  expect(current.refusals).toEqual([]);
  expect(current.media, "PREVIEW_MEDIA").toEqual({ width: null, height: null, durationMs: null });
  expect(current.options.find(o => o.id === "media-move")?.media?.destination, "PREVIEW_SUPERSEDED_STORES_NOTHING").toBe("places/loom.png");
  expect(current.version).toBe(card.version + 1);
  // Nothing was moved by any preview, and the scan slot is free again.
  expect(read(f.root, LOOM)).toBe("loom bytes");
  hold.stop();
  const free = await f.review.preview(other.id, { ...request("places/loom-2.png", "t-2"), expectedVersion: current.version });
  expect(free.refusals, "PREVIEW_SLOT_RELEASED").toEqual([]);
});

test("a preview whose Action would not fit the response limit is refused at its boundary plus one, admitted at it, and stores nothing", async () => {
  // Rewrites of 4 KiB targets make the stored Action large without any network or extra file.
  const pad = (plan: Record<string, unknown>) => ({ ...plan, rewrites: Array.from({ length: 3 }, (_, i) => ({ note: `journeys/day-${i}.md`, line: 1, kind: "image", before: "b".repeat(4096), after: "a".repeat(4096) })) });
  const f = await setup({ wrap: (args, real) => args[0] === "media" && args.includes("--dry-run") ? pad(real(args) as Record<string, unknown>) : real(args) });
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md"));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  const request = { itemId: card.id, optionId: "media-move", expectedVersion: card.version, input: "places/loom.png" };
  const probe = await createHygieneReview(f.db, { brain: f.brain, media: f.effects, previewResponseBytes: 1 }).preview(f.reviewer.id, request);
  expect(probe.refusals.length, "PREVIEW_LIMIT_CHECKED").toBe(1);
  const size = probe.refusals[0]!.observed!;
  expect(probe.refusals, "PREVIEW_LIMIT_REFUSED").toEqual([{ code: "inventory-too-large", limit: "preview", effective: 1, observed: size }]);
  expect(size).toBeGreaterThan(3 * 8192);
  const over = await createHygieneReview(f.db, { brain: f.brain, media: f.effects, previewResponseBytes: size - 1 }).preview(f.reviewer.id, request);
  expect(over.refusals, "PREVIEW_LIMIT_PLUS_ONE").toEqual([{ code: "inventory-too-large", limit: "preview", effective: size - 1, observed: size }]);
  expect(over.version, "PREVIEW_LIMIT_STORES_NOTHING").toBe(card.version);
  expect(over.options.find(o => o.id === "media-move")?.media).toBeUndefined();
  const at = await createHygieneReview(f.db, { brain: f.brain, media: f.effects, previewResponseBytes: size }).preview(f.reviewer.id, request);
  expect(at.refusals, "PREVIEW_LIMIT_BOUNDARY").toEqual([]);
  expect(at.version).toBe(card.version + 1);
  expect(Buffer.byteLength(JSON.stringify(createInboxStoreRead(f.db, card.id)), "utf8")).toBeLessThanOrEqual(size + 64);
  // The transport's limit is the ceiling: a larger setting does not raise it.
  const { PREVIEW_RESPONSE_LIMIT_BYTES } = await import("../src/inbox/hygiene-review.js");
  const { MAX_WS_MESSAGE_BYTES } = await import("../src/ws/shrink.js");
  expect(PREVIEW_RESPONSE_LIMIT_BYTES).toBe(MAX_WS_MESSAGE_BYTES);
});

test("POST /hygiene/review/preview: a named refusal is a 200 result, a throw 409, missing authority 403, a malformed requestId 400; nothing is written", async () => {
  const hold = heldScans();
  let fail = false;
  const f = await setup({ wrap: (args, real, signal) => { if (fail && args.includes("--dry-run")) throw new Error("storage went away"); return hold.wrap(args, real, signal); } });
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md"));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  const other = createPrincipal(f.db, { authMethod: "password", label: "Telemachus", ttlSeconds: 86400 });
  const app = (principalId: string) => {
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => { c.set("principal", { id: principalId } as never); await next(); });
    a.route("/", createHygieneReviewRoutes(f.review));
    return a;
  };
  const post = async (principalId: string, body: unknown) => { const res = await app(principalId).request("/hygiene/review/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() as Record<string, unknown> }; };
  const body = { itemId: card.id, optionId: "media-move", expectedVersion: card.version, input: "places/loom.png" };
  const config = read(f.root, "brain.config.json");

  hold.arm();
  const running = post(f.reviewer.id, { ...body, requestId: "r-1" });
  await until(() => hold.held.length === 1);
  const busy = await post(other.id, { ...body, requestId: "t-1" });
  expect(busy, "PREVIEW_ROUTE_BUSY").toMatchObject({ status: 200, body: { requestId: "t-1", refusals: [{ code: "preview-busy" }] } });
  hold.held[0]!.release();
  const ok = await running;
  expect(ok, "PREVIEW_ROUTE_OK").toMatchObject({ status: 200, body: { requestId: "r-1", refusals: [] } });
  hold.stop();

  const current = createInboxStoreRead(f.db, card.id)!;
  fail = true;
  const thrown = await post(f.reviewer.id, { ...body, expectedVersion: current.version });
  expect(thrown, "PREVIEW_ROUTE_THROW").toEqual({ status: 409, body: { error: "preview_refused" } });
  fail = false;
  const stranger = await post("no-such-principal", { ...body, expectedVersion: current.version });
  expect(stranger, "PREVIEW_ROUTE_AUTHORITY").toEqual({ status: 403, body: { error: "Unauthorized" } });
  expect((await post(f.reviewer.id, { ...body, expectedVersion: current.version, requestId: "bad id" })).status, "PREVIEW_ROUTE_BAD_REQUEST_ID").toBe(400);
  expect(createInboxStoreRead(f.db, card.id)!.version, "PREVIEW_ROUTE_NOTHING_STORED").toBe(current.version);
  expect(read(f.root, LOOM)).toBe("loom bytes");
  expect(read(f.root, "brain.config.json")).toBe(config);
});

/** As if the server died after the effect wrote, before its outcome committed. */
const crashAfterWrite = (f: Awaited<ReturnType<typeof setup>>, journalId: string) =>
  f.journal.writeOperation([journalStatement("UPDATE turn_journal_media_operations SET state='applying',pid=?,pid_start=? WHERE id=?", 2 ** 22 + 7, "0", journalId)]);

test("a restart compensates an interrupted Keep a permanent copy: the copy, its rule and its kept entry go, the original and pins stay, never re-applied", async () => {
  const f = await setup();
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const pins = read(f.root, ".brain/scratch-pins/pins.json");
  const kept = await f.apply(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg");
  expect(kept.outcome).toBe("kept");
  await crashAfterWrite(f, kept.journalId);
  await f.effects.recover();
  expect(f.effects.receipt(kept.journalId, "odysseus"), "MEDIA_RECOVERY_COPY_COMPENSATED").toMatchObject({ outcome: "compensated", reason: "interrupted" });
  expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg")), "MEDIA_RECOVERY_COPY_REMOVED").toBe(false);
  expect(read(f.root, "brain.config.json"), "MEDIA_RECOVERY_COPY_CONFIG").toBe("{}\n");
  expect(read(f.root, "context/hygiene/kept.md"), "MEDIA_RECOVERY_COPY_UNKEPT").not.toContain("harbour-dawn");
  expect(read(f.root, SCRATCH), "MEDIA_RECOVERY_COPY_ORIGINAL").toBe("dawn bytes");
  expect(read(f.root, ".brain/scratch-pins/pins.json"), "MEDIA_RECOVERY_COPY_PINS").toBe(pins);
  await f.effects.recover();
  expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg")), "MEDIA_RECOVERY_COPY_ONCE").toBe(false);
});

test("a restart after an interrupted Move leaves an edit made since as a conflict (partial) and restores everything else", async () => {
  const f = await setup();
  const moved = await f.apply(LOOM, "move", "places/loom.png");
  await crashAfterWrite(f, moved.journalId);
  // Telemachus edits the rewritten note before the server comes back.
  put(f.root, NOTE, "Telemachus wrote this after the move\n");
  await f.effects.recover();
  const receipt = f.effects.receipt(moved.journalId, "odysseus")!;
  expect(receipt.outcome, "MEDIA_RECOVERY_PARTIAL").toBe("partial");
  expect(receipt.files.find(x => x.path === NOTE)?.state, "MEDIA_RECOVERY_PARTIAL_CONFLICT").toBe("conflict");
  expect(read(f.root, NOTE), "MEDIA_RECOVERY_NO_OVERWRITE").toBe("Telemachus wrote this after the move\n");
  expect(read(f.root, LOOM), "MEDIA_RECOVERY_PARTIAL_SOURCE").toBe("loom bytes");
  expect(existsSync(join(f.root, "places/loom.png")), "MEDIA_RECOVERY_PARTIAL_DESTINATION").toBe(false);
});

/** A linked scratch original, kept as a copy, then the server dies before the outcome commits. */
async function keptThenCrashed() {
  const f = await setup();
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const pins = read(f.root, ".brain/scratch-pins/pins.json");
  const kept = await f.apply(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg");
  expect(kept.outcome).toBe("kept");
  await crashAfterWrite(f, kept.journalId);
  return { f, kept, pins };
}

test("a restart after an interrupted copy leaves a copy edited since as a conflict (partial) and restores everything else", async () => {
  const { f, kept, pins } = await keptThenCrashed();
  // Penelope retouches the copy before the server comes back.
  put(f.root, "places/ithaca/harbour-dawn.jpg", "Penelope retouched the dawn\n");
  await f.effects.recover();
  const receipt = f.effects.receipt(kept.journalId, "odysseus")!;
  expect(receipt.outcome, "MEDIA_RECOVERY_COPY_PARTIAL").toBe("partial");
  expect(receipt.files.find(x => x.path === "places/ithaca/harbour-dawn.jpg")?.state, "MEDIA_RECOVERY_COPY_CONFLICT").toBe("conflict");
  expect(read(f.root, "places/ithaca/harbour-dawn.jpg"), "MEDIA_RECOVERY_COPY_NO_OVERWRITE").toBe("Penelope retouched the dawn\n");
  expect(read(f.root, "brain.config.json"), "MEDIA_RECOVERY_COPY_PARTIAL_CONFIG").toBe("{}\n");
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  expect(read(f.root, ".brain/scratch-pins/pins.json")).toBe(pins);
  // Partial is final: a second restart changes nothing.
  await f.effects.recover();
  expect(read(f.root, "places/ithaca/harbour-dawn.jpg"), "MEDIA_RECOVERY_COPY_PARTIAL_ONCE").toBe("Penelope retouched the dawn\n");
});

test("a restart after an interrupted copy leaves a config edited since as a conflict (partial) and removes the copy", async () => {
  const { f, kept, pins } = await keptThenCrashed();
  const edited = '{ "media": { "track": ["places/ithaca/harbour-dawn.jpg", "places/sparta/*"] } }\n';
  put(f.root, "brain.config.json", edited);
  await f.effects.recover();
  const receipt = f.effects.receipt(kept.journalId, "odysseus")!;
  expect(receipt.outcome, "MEDIA_RECOVERY_CONFIG_PARTIAL").toBe("partial");
  expect(receipt.files.find(x => x.path === "brain.config.json")?.state, "MEDIA_RECOVERY_CONFIG_CONFLICT").toBe("conflict");
  expect(read(f.root, "brain.config.json"), "MEDIA_RECOVERY_CONFIG_NO_OVERWRITE").toBe(edited);
  expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg")), "MEDIA_RECOVERY_CONFIG_COPY_REMOVED").toBe(false);
  expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  expect(read(f.root, ".brain/scratch-pins/pins.json")).toBe(pins);
});

/**
 * Review keeps a copy, and the server dies after the effect committed `kept`
 * but before review recorded the outcome; `tamper` runs before the restart.
 */
type Tamper = (f: Awaited<ReturnType<typeof setup>>, relist: (edit: (entry: Record<string, unknown>) => Record<string, unknown>) => void) => void;
async function reviewKeptThenCrashed(tamper: Tamper) {
  let edit: ((entry: Record<string, unknown>) => Record<string, unknown>) | null = null;
  const f = await setup({ wrap: (args, real) => {
    const out = real(args) as { entries?: Array<Record<string, unknown>> };
    return args[0] === "list" && edit ? { ...out, entries: out.entries!.map(edit) } : out;
  } });
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md")); rmSync(join(f.root, LOOM));
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const dying = createHygieneReview(f.db, { brain: f.brain, media: { ...f.effects, apply: async (operation: Parameters<typeof f.effects.apply>[0]) => { await f.effects.apply(operation); throw new Error("the server died"); } } });
  const card = (await dying.command(f.reviewer.id, "start")).action!;
  await dying.preview(f.reviewer.id, { itemId: card.id, optionId: "media-keep-copy", expectedVersion: card.version, input: "places/ithaca/harbour-dawn.jpg" });
  await dying.resolver.resolveAsync(f.reviewer.id, { type: "inbox_resolve", itemId: card.id, optionId: "media-keep-copy" });
  const attempt = f.db.query("SELECT id FROM hygiene_effect_attempts WHERE status = 'started'").get() as { id: string } | null;
  expect(attempt, "MEDIA_RECOVER_KEPT_STARTED").not.toBeNull();
  expect(read(f.root, "places/ithaca/harbour-dawn.jpg")).toBe("dawn bytes");
  tamper(f, e => { edit = e; });
  const restarted = createHygieneReview(f.db, { brain: f.brain, media: f.effects });
  await restarted.recover();
  return { f, card, restarted, item: createInboxStoreRead(f.db, card.id)! };
}

test("recover() confirms a kept copy when its entry, fingerprint and copy SHA-256 all match", async () => {
  const { f, item, restarted } = await reviewKeptThenCrashed(() => {});
  expect(item.hygiene?.outcome, "MEDIA_RECOVER_KEPT").toMatchObject({ status: "kept", media: { outcome: "kept", copySha256: sha("dawn bytes") } });
  expect(item.status, "MEDIA_RECOVER_KEPT_RESOLVED").toBe("resolved");
  expect(restarted.read().review.kept, "MEDIA_RECOVER_KEPT_COUNTER").toBe(1);
  expect(read(f.root, "places/ithaca/harbour-dawn.jpg")).toBe("dawn bytes");
});

const tampers: Array<[string, Tamper]> = [
  // Only the recorded SHA-256 differs: the entry stays kept, as the copy's own bytes are never compared.
  ["copy-sha256", f => put(f.root, "context/hygiene/kept.md", read(f.root, "context/hygiene/kept.md").replace(/(- copy-sha256: )[0-9a-f]{64}/, `$1${"0".repeat(64)}`))],
  // Only the entry's fingerprint differs from the one the review admitted.
  ["fingerprint", f => put(f.root, "context/hygiene/kept.md", read(f.root, "context/hygiene/kept.md").replace(/(\*\*Fingerprint\*\*: )[0-9a-f]{12}/, `$1${"0".repeat(12)}`))],
  // Only the state differs: the CLI lists the entry as no longer kept, with the same fingerprint and SHA-256.
  ["entry state", (_f, relist) => relist(e => e.path === SCRATCH ? { ...e, state: "dismissed" } : e)],
  // The copy went before the restart, so reconcile reopened the original: the entry is no longer kept.
  ["copy, so the entry was reopened,", f => { rmSync(join(f.root, "places/ithaca/harbour-dawn.jpg")); run(f.root, process.execPath, CORE_CLI, "hygiene", "--json", "reconcile"); }],
];
for (const [what, tamper] of tampers) {
  test(`recover() reports receipt-unknown for a kept copy whose ${what} differs, and never re-copies it`, async () => {
    const { f, item, restarted } = await reviewKeptThenCrashed(tamper);
    expect(item.hygiene?.outcome, `MEDIA_RECOVER_KEPT_MISMATCH ${what}`).toMatchObject({ status: "check_failed", code: "receipt-unknown", media: { outcome: "kept" } });
    expect(item.status, `MEDIA_RECOVER_KEPT_NOT_RESOLVED ${what}`).not.toBe("resolved");
    expect(restarted.read().review.kept, `MEDIA_RECOVER_KEPT_NOT_COUNTED ${what}`).toBe(0);
    expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg")), `MEDIA_RECOVER_KEPT_NO_RECOPY ${what}`).toBe(!what.startsWith("copy,"));
    expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  });
}

// One fixture per case: four real repositories in one case outran its deadline on a loaded host.
const unknownKeptAnswers = [{ status: "kept-v2" }, { outcome: "kept" }];
for (const answer of unknownKeptAnswers) {
  test(`mixed versions: a keep-copy answer ${JSON.stringify(answer)} this server does not know as kept compensates the copy`, async () => {
    // The effect itself: only an exact `kept` answer keeps the copy.
    const e = await setup({ wrap: (args, real) => args[0] === "keep-copy" ? answer : real(args) });
    put(e.root, SCRATCH, "dawn bytes");
    put(e.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
    const receipt = await e.apply(SCRATCH, "keep-copy", "places/ithaca/harbour-dawn.jpg");
    expect(receipt.outcome, `MEDIA_MIXED_COMPENSATED ${JSON.stringify(answer)}`).toBe("compensated");
    expect(existsSync(join(e.root, "places/ithaca/harbour-dawn.jpg"))).toBe(false);
  });
  test(`mixed versions: a keep-copy answer ${JSON.stringify(answer)} this server does not know as kept is never resolved, and the copy is compensated`, async () => {
    // And through review, which never resolves the card on it.
    const f = await setup({ wrap: (args, real) => args[0] === "keep-copy" ? answer : real(args) });
    rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md")); rmSync(join(f.root, LOOM));
    put(f.root, SCRATCH, "dawn bytes");
    put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
    const card = (await f.review.command(f.reviewer.id, "start")).action!;
    await f.review.preview(f.reviewer.id, { itemId: card.id, optionId: "media-keep-copy", expectedVersion: card.version, input: "places/ithaca/harbour-dawn.jpg" });
    await resolveWith(f, card.id, "media-keep-copy");
    const item = createInboxStoreRead(f.db, card.id)!;
    expect(item.hygiene?.outcome, `MEDIA_MIXED_CHECK_FAILED ${JSON.stringify(answer)}`).toMatchObject({ status: "check_failed", media: { outcome: "compensated" } });
    expect(item.status, "MEDIA_MIXED_NOT_RESOLVED").not.toBe("resolved");
    expect(f.review.read().review.kept, "MEDIA_MIXED_NOT_COUNTED").toBe(0);
    expect(existsSync(join(f.root, "places/ithaca/harbour-dawn.jpg")), "MEDIA_MIXED_COPY_COMPENSATED").toBe(false);
    expect(read(f.root, "brain.config.json")).toBe("{}\n");
    expect(read(f.root, SCRATCH)).toBe("dawn bytes");
  });
}
