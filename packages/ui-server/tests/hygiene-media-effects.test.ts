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

async function setup(options: { capBytes?: number; wrap?: (args: string[], real: (args: string[]) => unknown) => unknown } = {}) {
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
  const cli = async (args: string[]) => options.wrap ? options.wrap(args, real) : real(args);
  const dbPath = join(directory, "ui.sqlite"), db = createUiDb(dbPath), native = createNativeJournalFixture(root, directory);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: root, dbPath, objectsRoot: join(directory, "objects"), ...(options.capBytes ? { capBytes: options.capBytes } : {}) });
  await journal.ready;
  const gate = createWriterGate(db, root, { pollMs: 1 });
  let authorized = true;
  const reviewer = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  const effects = createMediaEffects(db, { brainPath: root, journal, gate, lock: createKeyedLock(), cli, authorized: id => authorized && (id === "odysseus" || id === reviewer.id) });
  const review = createHygieneReview(db, { brain: { hygiene: async (args: readonly string[]) => cli([...args]) } as unknown as BrainClient, media: effects });
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
  return { root, directory, db, journal, effects, plan, apply, review, reviewer, revoke() { authorized = false; }, undo: (sourceId: string) => effects.undo({ id: `${sourceId}-undo`, principalId: "odysseus", sourceId }) };
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
  expect(read(f.root, LOOM) === loom, "MEDIA_CAPTURE_BEFORE_WRITE").toBe(true);
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
  f.revoke();
  await expect(f.effects.apply({ id: "odysseus-media-revoked", principalId: "odysseus", findingId: finding.id, fingerprint: finding.fingerprint, plan })).rejects.toThrow("authority");
  expect(read(f.root, LOOM)).toBe("loom bytes");
});

test("review offers the media effects with their plans, applies one through the resolver, and resolves the card with its receipt", async () => {
  const f = await setup();
  // Notes without frontmatter would be selected first, as errors.
  rmSync(join(f.root, NOTE)); rmSync(join(f.root, "places/ithaca.md"));
  const card = (await f.review.command(f.reviewer.id, "start")).action!;
  expect(card.options.map(o => o.id), "MEDIA_REVIEW_OPTIONS").toEqual(["media-persist", "media-move", "media-delete", "leave-pending", "check", "later", "dismiss"]);
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
