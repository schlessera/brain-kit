/**
 * A provider folder rule denies every turn until a recipient is proven
 * (#1665): the folder is masked, `.git` is hidden, and `.brain-index/` is the
 * turn's own filtered index (#1668). Real bubblewrap workers from production
 * admission; the index is built by the real CLI inside a masked worker.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const REPO = resolve(import.meta.dir, "../../..");
const CORPUS = join(REPO, "packages/core/fixtures/corpus");
const CLI = [process.execPath, join(REPO, "packages/core/src/cli/brain.ts")];
const PATH = `${resolve(process.execPath, "..")}:/usr/bin:/bin`;
/** A word only the masked folder contains. */
const SENTINEL = "Zakynthosmarker";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

function fixture() {
  // Inside the repository: the corpus config imports @schlessera/brain, and a
  // governed brain may not link node_modules, so resolution walks up to the
  // workspace install, which the worker's runtime read paths restore.
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  const root = mkdtempSync(join(REPO, "tmp", "odysseus-private-index-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  cpSync(CORPUS, brain, { recursive: true });
  rmSync(join(brain, ".brain-index"), { recursive: true, force: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"),
    "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\nOnly Anthropic may read Odysseus's own folder.\n");
  mkdirSync(join(brain, ".git")); writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "me/oath.md"), `---\ntype: note\ntitle: "Odysseus's private oath"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${SENTINEL} is the word Odysseus keeps to himself.\n`);
  // The real index, built on the host from every document, me/ included.
  const index = Bun.spawnSync([...CLI, "index", "--json"], { cwd: brain, env: { PATH, BRAIN_ROOT: brain, HOME: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(index.exitCode, index.stderr.toString()).toBe(0);
  const dbPath = join(root, "state/ui.db"); mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const reports: string[] = [];
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution,
    profile: "governed", maskPaths: [], index: async () => {}, report: message => reports.push(message), privateIndexCommand: CLI });
  return { root, brain, turns, reports };
}

function search(brain: string, sandbox: Parameters<typeof workerCommand>[0]["sandbox"], query: string): string[] {
  const run = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: { PATH, BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" },
    command: [...CLI, "search", query, "--json", "--limit", "50"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, `RESTRICTED_SEARCH_RAN: ${run.stderr.toString()}`).toBe(0);
  const parsed = JSON.parse(run.stdout.toString()) as { results?: { path: string }[] } | { path: string }[];
  return (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
}

test("a denied turn reads its provider folder as empty, has no history and searches a private index without it", async () => {
  const f = fixture();
  expect(search(f.brain, undefined, SENTINEL), "REAL_INDEX_HOLDS_THE_MASKED_DOCUMENT").toContain("me/oath.md");
  const hold = await f.turns.begin("restricted", new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    const masks = hold.sandbox.providerMasks!;
    expect(masks.folders, "EVERY_PROVIDER_FOLDER_MASKED_WITHOUT_A_PROVEN_RECIPIENT").toEqual(["me"]);
    expect(existsSync(join(masks.index, "brain.db")), "PRIVATE_INDEX_IN_ITS_OWN_DIRECTORY").toBe(true);
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/sh", "-c", `
      printf 'me=%s\\n' "$(ls -A me | wc -l)"
      cat me/oath.md 2>/dev/null && printf 'READ_MASKED\\n'
      printf 'git=%s\\n' "$(ls -A .git 2>/dev/null | wc -l)"
      if printf x > me/new.md 2>/dev/null; then printf 'WROTE_MASKED\\n'; fi
      if mv .brain-index .brain-index-moved 2>/dev/null; then printf 'INDEX_RENAMED\\n'; fi
      grep -c ${SENTINEL} .brain-index/brain.db 2>/dev/null || true
    `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, shell.stderr.toString()).toBe(0);
    expect(shell.stdout.toString(), "BASH_CANNOT_READ_MASKED_FOLDER_OR_HISTORY").toBe("me=0\ngit=0\n0\n");
    const results = search(f.brain, hold.sandbox, SENTINEL);
    expect(results.filter(path => path.startsWith("me/")), "PRIVATE_INDEX_LACKS_MASKED_DOCUMENTS").toEqual([]);
    expect(search(f.brain, hold.sandbox, "eagle"), "PRIVATE_INDEX_KEEPS_PERMITTED_DOCUMENTS").toContain("notes/quick-note-eagle.md");
    expect(f.reports.filter(report => report.includes("private search index")), "PRIVATE_INDEX_BUILT").toEqual([]);
    // The real index stays the full one, and the private one is writable.
    expect(search(f.brain, undefined, SENTINEL)).toContain("me/oath.md");
    const capture = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH, BRAIN_ROOT: f.brain, HOME: "/tmp", NO_COLOR: "1" },
      command: [...CLI, "index", "--json"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(capture.exitCode, `PRIVATE_INDEX_WRITABLE: ${capture.stderr.toString()}`).toBe(0);
  } finally { await hold.end(); }
  expect(existsSync(hold.sandbox.providerMasks!.index), "PRIVATE_INDEX_REMOVED_AFTER_THE_TURN").toBe(false);
});

test("the private index survives the real index being replaced under a running denied turn", async () => {
  const f = fixture();
  const hold = await f.turns.begin("restricted-live", new AbortController().signal);
  try {
    const worker = launchAgentWorker({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH, BRAIN_ROOT: f.brain, HOME: "/tmp", NO_COLOR: "1" },
      // The CLI paths ride as arguments so the launcher restores their runtime.
      command: ["/bin/sh", "-c", `printf 'ready\\n'; IFS= read -r go; exec "$@" search ${SENTINEL} --json --limit 50`, "sh", ...CLI] });
    const reader = (worker.stdout as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    expect(new TextDecoder().decode((await reader.next()).value), "LIVE_MASK_QUALIFIED_AND_STARTED").toBe("ready\n");
    // A rebuilt real index is published by rename, sidecars are recreated,
    // and another denied turn tries to move the directory.
    const real = join(f.brain, ".brain-index");
    for (const name of readdirSync(real)) if (name !== "brain.db") rmSync(join(real, name), { force: true });
    writeFileSync(join(real, ".rebuilt"), readFileSync(join(real, "brain.db"))); renameSync(join(real, ".rebuilt"), join(real, "brain.db"));
    const peer = await f.turns.begin("restricted-peer", new AbortController().signal);
    try {
      const moved = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: peer.sandbox, env: { PATH }, command: ["/bin/sh", "-c",
        "if mv .brain-index .brain-index-moved 2>/dev/null; then printf INDEX_RENAMED; fi"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
      expect(moved.stdout.toString(), "PEER_CANNOT_MOVE_THE_INDEX_DIRECTORY").toBe("");
    } finally { await peer.end(); }
    (worker.stdin as unknown as { write(text: string): void; end(): void }).write("go\n");
    (worker.stdin as unknown as { end(): void }).end();
    let text = ""; for (let next = await reader.next(); !next.done; next = await reader.next()) text += new TextDecoder().decode(next.value);
    let stderr = ""; for await (const chunk of worker.stderr as unknown as AsyncIterable<Uint8Array>) stderr += new TextDecoder().decode(chunk);
    expect(await worker.exited, `${stderr} ${text}`).toBe(0);
    const parsed = JSON.parse(text) as { results?: { path: string }[] } | { path: string }[];
    const paths = (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
    expect(paths.filter(path => path.startsWith("me/")), "PRIVATE_INDEX_SURVIVES_REAL_INDEX_REPLACEMENT").toEqual([]);
  } finally { await hold.end(); }
});

test.each([
  ["types: [identity]", "type identity"],
  ["paths: [me/*.md]", "me/*.md"],
  ["paths: [me/identity.md]", "me/identity.md"],
])("a provider selector hosted turns cannot mask refuses admission by name (%s)", async (selector, named) => {
  const f = fixture();
  writeFileSync(join(f.brain, "context/policies/governance.md"),
    `---\nschema_version: 1\nproviders: [{ ${selector}, allow: [anthropic] }]\n---\nOnly Anthropic may read Odysseus's identity.\n`);
  let refusal: unknown;
  try { await (await f.turns.begin("unsupported", new AbortController().signal)).end(); } catch (error) { refusal = error; }
  expect((refusal as Error)?.name, "UNSUPPORTED_SELECTOR_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain(named);
});
