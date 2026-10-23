import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { providerFolderRoots, retainedFolderRoots } from "../src/brain/governance-policy";
import { ensureIndexDirectory, retireLegacyIndex } from "../src/brain/index-directory";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

const REAL = "REAL INDEX: Odysseus private identity, as indexed";
const PRIVATE = "PRIVATE INDEX: nothing from group/private";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-dir-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"),
    "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena reviews policy.\n");
  mkdirSync(join(brain, "group/private"), { recursive: true });
  writeFileSync(join(brain, "group/private/identity.md"), "Odysseus private identity.\n");
  const dbPath = join(root, "state/ui.db"); mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution,
    profile: "governed", maskPaths: [], index: async () => {}, report: () => {} });
  return { root, brain, turns };
}

/**
 * A restricted reader's namespace with one mount over `target`, holding until
 * stdin closes so a peer can act after the mount exists. This stands in for
 * the private index view a restricted turn gets; the peer is a real governed
 * worker from production admission.
 */
function reader(brain: string, source: string, target: string, file: string) {
  const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--bind", brain, brain,
    "--bind", source, join(brain, target), "--proc", "/proc", "--dev", "/dev", "--chdir", brain,
    "/bin/sh", "-c", `printf 'ready\\n'; IFS= read -r go; cat ${JSON.stringify(file)} 2>/dev/null || printf ABSENT`],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const out = child.stdout.getReader();
  return {
    async ready() {
      const first = await Promise.race([out.read(), Bun.sleep(5000).then(() => { throw Error("READER_NAMESPACE_READY_TIMEOUT"); })]);
      expect(new TextDecoder().decode((first as { value?: Uint8Array }).value)).toBe("ready\n");
    },
    async read() {
      child.stdin.write("go\n"); child.stdin.end();
      let text = ""; for (;;) { const chunk = await out.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      return text;
    },
  };
}

test("the retained topology adds the index directory exactly when provider folders exist", () => {
  expect(retainedFolderRoots({ providers: [] }), "NO_PROVIDER_FOLDERS_NO_RETENTION").toEqual([]);
  const policy = { providers: [{ paths: ["group/private/**", "me/*.md"], allow: ["anthropic"] }] } as Parameters<typeof retainedFolderRoots>[0];
  expect(providerFolderRoots(policy)).toEqual(["group/private"]);
  expect(retainedFolderRoots(policy), "INDEX_DIRECTORY_RETAINED_BESIDE_PROVIDER_FOLDERS").toEqual([".brain-index", "group/private"]);
});

test("a file mask over the old root-level index detaches when a governed peer replaces it", async () => {
  // Reproduces the #1668 finding on the layout this change retires: a peer
  // unlinking and recreating a loose index file detaches another namespace's
  // file mask, and the restricted reader sees the peer's (real) bytes.
  const f = fixture();
  writeFileSync(join(f.brain, "brain.db"), REAL); writeFileSync(join(f.root, "private.db"), PRIVATE);
  const restricted = reader(f.brain, join(f.root, "private.db"), "brain.db", "brain.db");
  await restricted.ready();
  const hold = await f.turns.begin("legacy-peer", new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    const peer = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
      `rm brain.db && printf %s ${JSON.stringify(REAL)} > brain.db`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(peer.exitCode, peer.stderr.toString()).toBe(0);
  } finally { await hold.end(); }
  expect(await restricted.read(), "LEGACY_FILE_MASK_DETACHED_BY_PEER_RECREATE").toBe(REAL);
});

test("a governed peer cannot replace the retained index directory under a private index view", async () => {
  const f = fixture();
  mkdirSync(join(f.brain, ".brain-index")); writeFileSync(join(f.brain, ".brain-index/brain.db"), REAL);
  mkdirSync(join(f.root, "private-index")); writeFileSync(join(f.root, "private-index/brain.db"), PRIVATE);
  const restricted = reader(f.brain, join(f.root, "private-index"), ".brain-index", ".brain-index/brain.db");
  await restricted.ready();
  const hold = await f.turns.begin("index-peer", new AbortController().signal);
  let peer: { exitCode: number | null; stdout: Buffer; stderr: Buffer };
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    // Every route that used to detach a mask over the index: renaming or
    // removing the directory and recreating it with the real bytes, then the
    // in-directory churn an index refresh performs.
    peer = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", `
      if mv .brain-index .brain-index-moved 2>/dev/null; then mkdir .brain-index; printf %s ${JSON.stringify(REAL)} > .brain-index/brain.db; echo INDEX_DIRECTORY_RENAMED; fi
      if [ -d .brain-index ] && rm -rf .brain-index 2>/dev/null && ! [ -d .brain-index ]; then mkdir .brain-index; printf %s ${JSON.stringify(REAL)} > .brain-index/brain.db; echo INDEX_DIRECTORY_REMOVED; fi
      rm -f .brain-index/brain.db && printf %s ${JSON.stringify(REAL)} > .brain-index/brain.db || echo CONTENT_NOT_WRITABLE
      printf %s ${JSON.stringify(REAL)} > .brain-index/brain.db-wal || echo SIDECAR_NOT_WRITABLE
    `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
  } finally { await hold.end(); }
  // Native publication installs a rebuilt database by renaming over it.
  writeFileSync(join(f.brain, ".brain-index/.maintenance-rebuilt"), REAL);
  renameSync(join(f.brain, ".brain-index/.maintenance-rebuilt"), join(f.brain, ".brain-index/brain.db"));
  expect(await restricted.read(), "PRIVATE_INDEX_VIEW_SURVIVES_PEER_AND_PUBLICATION").toBe(PRIVATE);
  expect(peer.exitCode, peer.stderr.toString()).toBe(0);
  expect(peer.stdout.toString(), "PEER_CANNOT_REPLACE_BUT_CAN_REFRESH_THE_INDEX").toBe("");
  expect(hold.sandbox.retainedFolders, "PEER_RETAINS_INDEX_DIRECTORY").toContain(".brain-index");
  expect(readFileSync(join(f.brain, ".brain-index/brain.db"), "utf8"), "REAL_INDEX_STILL_REFRESHED").toBe(REAL);
});

test("admission creates the index directory with the brain root's mode before retaining it", async () => {
  const f = fixture();
  const hold = await f.turns.begin("index-created", new AbortController().signal);
  try {
    const info = lstatSync(join(f.brain, ".brain-index"));
    expect(info.isDirectory(), "ADMISSION_CREATED_INDEX_DIRECTORY").toBe(true);
    expect(info.mode & 0o7777).toBe(statSync(f.brain).mode & 0o7777);
    expect(hold.sandbox.retainedFolders).toEqual([".brain-index", "group/private"]);
  } finally { await hold.end(); }
});

test("an existing server-owned index directory is repaired to the brain root's mode", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-mode-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o2775); mkdirSync(join(root, ".brain-index")); chmodSync(join(root, ".brain-index"), 0o755);
  ensureIndexDirectory(root);
  expect(statSync(join(root, ".brain-index")).mode & 0o7777, "INDEX_DIRECTORY_MODE_REPAIRED").toBe(0o2775);
});

test("an aliased index directory is refused, never replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-alias-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "elsewhere")); symlinkSync("elsewhere", join(root, ".brain-index"));
  expect(() => ensureIndexDirectory(root), "INDEX_DIRECTORY_ALIAS_REFUSED").toThrow("not a directory");
  expect(lstatSync(join(root, ".brain-index")).isSymbolicLink()).toBe(true);
  rmSync(join(root, ".brain-index")); writeFileSync(join(root, ".brain-index"), "Odysseus");
  expect(() => ensureIndexDirectory(root), "INDEX_DIRECTORY_FILE_REFUSED").toThrow("not a directory");
});

test("boot retirement deletes the legacy root-level family and keeps everything else", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-legacy-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["brain.db", "brain.db-wal", "brain.db-shm", "brain.db.embedding-lock.db"]) writeFileSync(join(root, name), REAL);
  writeFileSync(join(root, "outside.md"), "Penelope weaves.\n");
  symlinkSync("outside.md", join(root, "brain.db-journal"));
  mkdirSync(join(root, ".brain-index")); writeFileSync(join(root, ".brain-index/brain.db"), PRIVATE);
  mkdirSync(join(root, "brain.db.embedding-lock.db-wal"));
  const result = retireLegacyIndex(root);
  expect(result.removed.sort(), "LEGACY_FAMILY_REMOVED").toEqual(["brain.db", "brain.db-journal", "brain.db-shm", "brain.db-wal", "brain.db.embedding-lock.db"]);
  expect(result.kept, "LEGACY_DIRECTORY_KEPT").toEqual(["brain.db.embedding-lock.db-wal"]);
  expect(readFileSync(join(root, "outside.md"), "utf8"), "LINK_TARGET_UNTOUCHED").toBe("Penelope weaves.\n");
  expect(readFileSync(join(root, ".brain-index/brain.db"), "utf8"), "CURRENT_INDEX_UNTOUCHED").toBe(PRIVATE);
  expect(existsSync(join(root, "brain.db"))).toBe(false);
  expect(retireLegacyIndex(root).removed, "RETIREMENT_IDEMPOTENT").toEqual([]);
});
