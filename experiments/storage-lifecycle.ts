/** Manual, offline #1781 measurement. Only generated temporary stores are mutated. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packRepository } from "../packages/core/src/lib/git-storage.js";
import { createUiDb } from "../packages/ui-server/src/db/client.js";
import { createTurnJournal } from "../packages/ui-server/src/brain/turn-journal.js";

const root = mkdtempSync(join(tmpdir(), "odysseus-storage-lifecycle-"));
const brain = join(root, "brain"), remote = join(root, "remote.git"), objects = join(root, "objects");
mkdirSync(join(brain, "attachments"), { recursive: true });
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_DATE: "2026-07-12T12:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T12:00:00Z" }, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const allocated = (path: string): number => {
  const stat = lstatSync(path);
  return stat.blocks * 512 + (stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + allocated(join(path, name)), 0) : 0);
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// A PDF-shaped binary fixture, not a valid rendering fixture. Seeded bytes avoid
// a sparse-file or repeated-zero compression result masquerading as normal savings.
const pdf = Buffer.alloc(6_000_000);
let seed = 12;
for (let i = 0; i < pdf.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pdf[i] = seed & 255; }
pdf.write("%PDF-1.7\n");
const selected = join(brain, "attachments", "voyage.pdf"), changed = join(brain, "attachments", "sailing.pdf");
const dbPath = join(root, "ui.sqlite");
let db: ReturnType<typeof createUiDb> | undefined;
let journal: ReturnType<typeof createTurnJournal> | undefined;
try {
  writeFileSync(selected, pdf); writeFileSync(changed, pdf);
  writeFileSync(join(brain, "voyage.md"), "# Odysseus\n[Voyage](attachments/voyage.pdf)\n");
  git(brain, "init", "-b", "main");
  git(brain, "config", "user.name", "Odysseus"); git(brain, "config", "user.email", "odysseus@example.com");
  git(brain, "config", "gc.auto", "0");
  git(brain, "add", "."); git(brain, "commit", "-m", "Odysseus records the voyage");
  git(root, "clone", "--bare", "--no-hardlinks", brain, remote);
  const blob = git(brain, "rev-parse", "HEAD:attachments/voyage.pdf");
  db = createUiDb(dbPath);
  journal = createTurnJournal(db, { brainPath: brain, dbPath, objectsRoot: objects });
  journal.begin("voyage-removal", { sessionId: "odysseus", actor: "user", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  const snapshot = () => ({ pdfCount: [selected, changed].filter(existsSync).length,
    pdfBytes: [selected, changed].filter(existsSync).reduce((sum, p) => sum + lstatSync(p).size, 0),
    attachmentAllocated: allocated(join(brain, "attachments")), gitAllocated: allocated(join(brain, ".git")),
    journalObjectAllocated: allocated(objects), remoteAllocated: allocated(remote), gitObjects: git(brain, "count-objects", "-v") });
  const before = snapshot(), previewHash = hash(pdf);
  writeFileSync(changed, Buffer.concat([pdf, Buffer.from("\nAthena revises the route.\n")]));
  const changedSincePreview = hash(await Bun.file(changed).bytes()) !== previewHash;
  assert(changedSincePreview);
  // This demonstrates byte lifecycle, not a supported storage-removal API.
  rmSync(selected); journal.finish("voyage-removal");
  git(brain, "add", "attachments"); git(brain, "commit", "-m", "Odysseus removes one working-tree attachment");
  const afterRemoval = snapshot();
  const removal = journal.details("odysseus", "voyage-removal")!.changes.find(c => c.path === "attachments/voyage.pdf")!;
  assert.equal(removal.after, null);
  const retained = journal.version("odysseus", "voyage-removal", removal.sequence, "before")!.bytes(pdf.length);
  assert.equal(hash(retained), previewHash);
  assert(git(brain, "rev-list", "--objects", "--all").split("\n").some(line => line.startsWith(`${blob} `)));
  assert.equal(git(brain, "cat-file", "-s", blob), String(pdf.length));
  const refs = git(brain, "show-ref");
  const packed = packRepository(brain), afterPacking = snapshot();
  assert.equal(git(brain, "show-ref"), refs);
  assert.equal(git(brain, "cat-file", "-s", blob), String(pdf.length));
  assert.equal(git(remote, "cat-file", "-s", blob), String(pdf.length));
  assert.equal(afterPacking.remoteAllocated, before.remoteAllocated);
  console.log(JSON.stringify({ bun: Bun.version, git: git(root, "--version"), date: "2026-07-12",
    before, afterRemoval, afterPacking, packed, changedSincePreview,
    journalBeforeBytes: retained.length, reachableBlobBytes: pdf.length,
    remoteChanged: false, referenceStillPresent: (await Bun.file(join(brain, "voyage.md")).text()).includes("attachments/voyage.pdf") }, null, 2));
} finally { journal?.close(); db?.close(); rmSync(root, { recursive: true, force: true }); }
