/**
 * Intake reconciliation and staging refuse a linked staging directory and
 * never follow a link swapped in while they run (#2907), as inbox cleanup and
 * the TTL prune already refuse one. Real filesystem, no guard: these are the
 * intakes a person's share, the CLI and the queue route make.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { stageShareAt } from "../src/share/staging.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const SENTINEL = "Penelope's loom: the shroud for Laertes, unpicked each night.\n";
const LINK_REFUSAL = /must not traverse a symlink|changed while it was in use/;

/** Every entry below a folder with its bytes (files) or kind, links not followed. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), name = path.slice(dir.length + 1);
    out[name] = entry.isFile() ? readFileSync(path, "utf8") : entry.isSymbolicLink() ? "link" : "dir";
  }
  return out;
}

function brainFixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-staging-no-follow-")), brain = join(root, "brain");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(brain, "vault"), { recursive: true });
  mkdirSync(join(brain, ".brain-ui"), { recursive: true });
  writeFileSync(join(brain, "vault/loom.md"), SENTINEL);
  return { brain, vault: join(brain, "vault"), staging: join(brain, SHARE_STAGING_DIR) };
}

function intakeFixture() {
  const f = brainFixture();
  const db = createUiDb(":memory:");
  cleanup.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, f.brain);
  cleanup.push(() => intake.close());
  const receipt = (id: string) => db.query("SELECT state FROM inbox_intake_receipts WHERE staging_id = ?").get(id) as { state: string } | null;
  const leave = (id: string, state: "cleanup" | "preparing") => db.query(
    "INSERT INTO inbox_intake_receipts (staging_id, source, principal_id, dedup_key, content_hash, created_at, reconcile_after, state) VALUES (?, 'cli', ?, ?, 'hash', 0, 0, ?)",
  ).run(id, principal.id, `cli:${id}`, state);
  return { ...f, db, principal, intake, receipt, leave };
}

for (const state of ["cleanup", "preparing"] as const) {
  test(`reconciling a ${state} receipt refuses a linked staging directory and keeps target and receipt`, async () => {
    const f = intakeFixture();
    const id = crypto.randomUUID();
    // The receipt's arrival name exists where the link leads, holding unrelated content.
    mkdirSync(join(f.vault, id));
    writeFileSync(join(f.vault, id, "loom.md"), SENTINEL);
    symlinkSync("../vault", f.staging);
    f.leave(id, state);
    const before = tree(f.vault);
    await expect(f.intake.reconcile(), "LINKED_ROOT_RECONCILE_REFUSED").rejects.toThrow(LINK_REFUSAL);
    expect(tree(f.vault), "LINK_TARGET_KEPT").toEqual(before);
    expect(f.receipt(id), "RECEIPT_KEPT").toEqual({ state: "cleanup" });
    // The next non-turn intake refuses too, instead of removing what the link names.
    await expect(f.intake.share({ text: "Odysseus strings the bow.", files: [] }, f.principal), "LINKED_ROOT_INTAKE_REFUSED").rejects.toThrow(LINK_REFUSAL);
    expect(tree(f.vault)).toEqual(before);
    expect(f.receipt(id)).toEqual({ state: "cleanup" });
    // Once the staging directory is real again, the kept receipt compensates.
    rmSync(f.staging);
    mkdirSync(join(f.staging, id), { recursive: true });
    writeFileSync(join(f.staging, id, "meta.json"), "{}\n");
    await f.intake.reconcile();
    expect(existsSync(join(f.staging, id)), "RETRY_CLEANS").toBe(false);
    expect(f.receipt(id), "RETRY_CLEARS_RECEIPT").toBeNull();
    expect(tree(f.vault)).toEqual(before);
  });

  test(`reconciling a ${state} receipt in an ordinary staging directory still cleans it`, async () => {
    const f = intakeFixture();
    const id = crypto.randomUUID();
    for (const name of [id, `.${id}.partial`]) {
      mkdirSync(join(f.staging, name, "nested"), { recursive: true });
      writeFileSync(join(f.staging, name, "nested/meta.json"), "{}\n");
    }
    // A link inside an owned arrival is removed itself, never followed.
    symlinkSync("../../vault", join(f.staging, id, "escape"));
    f.leave(id, state);
    await f.intake.reconcile();
    expect(readdirSync(f.staging), "OWNED_ARRIVAL_CLEANED").toEqual([]);
    expect(f.receipt(id), "RECEIPT_CLEARED").toBeNull();
    expect(readFileSync(join(f.vault, "loom.md"), "utf8"), "LINKED_CONTENT_KEPT").toBe(SENTINEL);
  });
}

test("a committed receipt is never compensated", async () => {
  const f = intakeFixture();
  const result = await f.intake.share({ text: "Odysseus strings the bow.", files: [] }, f.principal);
  await f.intake.reconcile();
  expect(f.receipt(result.result.id)).toEqual({ state: "committed" });
  expect(existsSync(join(f.staging, result.result.id, "meta.json"))).toBe(true);
});

test("staging refuses a staging directory that links inside the brain", async () => {
  const f = brainFixture();
  symlinkSync("../vault", f.staging);
  const before = tree(f.vault);
  await expect(stageShareAt(f.brain, { text: "Odysseus strings the bow.", files: [] }, crypto.randomUUID()), "LINKED_ROOT_STAGING_REFUSED")
    .rejects.toThrow(LINK_REFUSAL);
  expect(tree(f.vault), "NOTHING_STAGED_THROUGH_LINK").toEqual(before);
});

/** A letter whose bytes are read after the partial exists and before they are written. */
function letterThat(during: () => void): File {
  const letter = new File([SENTINEL], "letter.txt", { type: "text/plain" });
  Object.defineProperty(letter, "arrayBuffer", { value: async () => { during(); return new TextEncoder().encode("A letter for Odysseus.").buffer; } });
  return letter;
}

test("a staging directory swapped for a link while a file is read stages nothing through it", async () => {
  const f = brainFixture();
  mkdirSync(f.staging);
  const id = crypto.randomUUID();
  // The link leads to a folder that already holds this arrival's partial name.
  mkdirSync(join(f.vault, `.${id}.partial`));
  writeFileSync(join(f.vault, `.${id}.partial`, "loom.md"), SENTINEL);
  const before = tree(f.vault);
  const letter = letterThat(() => { renameSync(f.staging, join(f.brain, "old-inbox")); symlinkSync("../vault", f.staging); });
  await expect(stageShareAt(f.brain, { text: "A letter.", files: [letter] }, id), "ROOT_SWAP_REFUSED").rejects.toThrow(LINK_REFUSAL);
  expect(tree(f.vault), "ROOT_SWAP_WROTE_NOTHING_THROUGH_LINK").toEqual(before);
});

test("a partial directory swapped for a link while a file is read writes nothing through it", async () => {
  const f = brainFixture();
  mkdirSync(f.staging);
  const id = crypto.randomUUID(), partial = join(f.staging, `.${id}.partial`);
  const before = tree(f.vault);
  const letter = letterThat(() => { renameSync(partial, join(f.brain, "moved-partial")); symlinkSync("../../vault", partial); });
  await expect(stageShareAt(f.brain, { text: "A letter.", files: [letter] }, id), "PARTIAL_SWAP_REFUSED").rejects.toThrow(LINK_REFUSAL);
  expect(tree(f.vault), "PARTIAL_SWAP_WROTE_NOTHING_THROUGH_LINK").toEqual(before);
  // The failed staging removes the planted link itself, never its target.
  expect(existsSync(partial) || readdirSync(f.staging).length > 0, "PLANTED_LINK_UNLINKED").toBe(false);
  expect(readdirSync(join(f.brain, "moved-partial")), "MOVED_PARTIAL_UNTOUCHED").toEqual([]);
});

test("a manifest name planted as a link creates nothing where it points", async () => {
  const f = brainFixture();
  mkdirSync(f.staging);
  const id = crypto.randomUUID(), partial = join(f.staging, `.${id}.partial`);
  const before = tree(f.vault);
  const letter = letterThat(() => {
    symlinkSync("../../../vault/meta.json", join(partial, "meta.json"));
    symlinkSync("../../../vault/letter.txt", join(partial, "letter.txt"));
  });
  await expect(stageShareAt(f.brain, { text: "A letter.", files: [letter] }, id), "MANIFEST_LINK_REFUSED").rejects.toThrow();
  expect(tree(f.vault), "NO_FILE_CREATED_THROUGH_LINK").toEqual(before);
  expect(existsSync(join(f.staging, id)), "NOT_PUBLISHED").toBe(false);
});

test("a partial swapped for a link just before publication is not published", async () => {
  const f = brainFixture();
  mkdirSync(f.staging);
  const id = crypto.randomUUID(), partial = join(f.staging, `.${id}.partial`);
  const before = tree(f.vault);
  await expect(stageShareAt(f.brain, { text: "Odysseus strings the bow.", files: [] }, id, undefined, "cli", () => {
    renameSync(partial, join(f.brain, "moved-partial"));
    symlinkSync("../../vault", partial);
  }), "PUBLICATION_SWAP_REFUSED").rejects.toThrow(LINK_REFUSAL);
  expect(existsSync(join(f.staging, id)), "LINK_NOT_PUBLISHED").toBe(false);
  expect(tree(f.vault)).toEqual(before);
});
