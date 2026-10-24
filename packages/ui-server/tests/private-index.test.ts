/**
 * A provider folder rule denies every turn until a recipient is proven
 * (#1665): the folder is masked, `.git` is hidden, and `.brain-index/` is the
 * turn's own filtered index (#1668). Real bubblewrap workers from production
 * admission; the index is built by the real CLI inside a masked worker.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, spyOn, test, type Mock } from "bun:test";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker, workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import * as startup from "../../ui-sdk/src/server/worker-startup-view";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
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

function fixture(providers = "[{ paths: [me/**], allow: [anthropic] }]", profile: "governed" | "strict" = "governed", prepare?: (brain: string) => void) {
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
    `---\nschema_version: 1\nproviders: ${providers}\n---\nOnly Anthropic may read Odysseus's own folder.\n`);
  mkdirSync(join(brain, ".git")); writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "me/identity.md"), `${readFileSync(join(brain, "me/identity.md"), "utf8")}\nHis identity word is ${SENTINEL}.\n`);
  writeFileSync(join(brain, "me/oath.md"), `---\ntype: note\ntitle: "Odysseus's private oath"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${SENTINEL} is the word Odysseus keeps to himself.\n`);
  prepare?.(brain);
  // The real index, built on the host from every document, me/ included.
  const index = Bun.spawnSync([...CLI, "index", "--json"], { cwd: brain, env: { PATH, BRAIN_ROOT: brain, HOME: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(index.exitCode, index.stderr.toString()).toBe(0);
  const dbPath = join(root, "state/ui.db"); mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const reports: string[] = [];
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution,
    profile, maskPaths: [], index: async () => {}, report: message => reports.push(message), privateIndexCommand: CLI });
  return { root, brain, turns, reports, execution };
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
    expect(existsSync(join(masks.index!, "brain.db")), "PRIVATE_INDEX_IN_ITS_OWN_DIRECTORY").toBe(true);
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
  expect(existsSync(hold.sandbox.providerMasks!.index!), "PRIVATE_INDEX_REMOVED_AFTER_THE_TURN").toBe(false);
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
  ["types: [identity]"],
  ["paths: [me/**/*]"],
])("a selector that maps exactly onto a folder masks it in a denied turn (%s)", async selector => {
  const f = fixture(`[{ ${selector}, allow: [anthropic] }]`);
  const hold = await f.turns.begin("translated", new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    expect(hold.sandbox.providerMasks?.folders, "SELECTOR_TRANSLATED_TO_ITS_FOLDER").toEqual(["me"]);
    expect(hold.sandbox.retainedFolders, "TRANSLATED_FOLDER_RETAINED").toEqual([".brain-index", "me"]);
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/sh", "-c", `
      printf 'me=%s\\n' "$(ls -A me | wc -l)"
      cat me/identity.md 2>/dev/null && printf 'READ_IDENTITY\\n'
      grep -rl ${SENTINEL} . 2>/dev/null || true
    `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, shell.stderr.toString()).toBe(0);
    expect(shell.stdout.toString(), "BASH_CANNOT_READ_THE_TYPED_DOCUMENT").toBe("me=0\n");
    expect(search(f.brain, hold.sandbox, SENTINEL).filter(path => path.startsWith("me/")), "PRIVATE_INDEX_LACKS_THE_TYPED_DOCUMENT").toEqual([]);
    expect(search(f.brain, hold.sandbox, "eagle"), "PRIVATE_INDEX_KEEPS_PERMITTED_DOCUMENTS").toContain("notes/quick-note-eagle.md");
  } finally { await hold.end(); }
  // A writer admitted once no turn holds the gate, such as the post-turn index
  // refresh, still plans the translated folder, so the next turn admits.
  const refresh = await f.execution.gate()!.acquire("shared", "index refresh", {});
  try {
    expect(refresh.folderPaths, "LATER_WRITER_PLANS_THE_TRANSLATED_FOLDER").toContain("me");
    await (await f.turns.begin("next", new AbortController().signal)).end();
  } finally { refresh.release(); }
});

test("the first type-selector turn after server start waits for a writer started with the server, rather than refusing (#2832)", async () => {
  // A fresh fixture is a fresh server: no turn has translated the type yet.
  const f = fixture("[{ types: [identity], allow: [anthropic] }]");
  const gate = f.execution.gate()!, acquire = gate.acquire.bind(gate);
  // Admitted with the server, before the turn: its plan cannot hold me/.
  const boot = await gate.acquire("shared", "brain CLI version");
  expect(boot.folderPaths, "SERVER_START_WRITER_PLANS_NO_TYPE_FOLDER").toEqual([]);
  // The boot writer finishes a little after the turn reaches it. A turn that
  // refuses, or checks without waiting, never lets it finish first.
  let releasedAt: number | undefined;
  const hook = spyOn(gate, "acquire").mockImplementation(async (...args) => {
    const hold = await acquire(...args), wait = hold.waitForPeerFolderPlans?.bind(hold);
    return wait ? Object.assign(hold, { waitForPeerFolderPlans: (...values: Parameters<typeof wait>) => {
      setTimeout(() => { releasedAt = performance.now(); boot.release(); }, 300);
      return wait(...values);
    } }) : hold;
  });
  let hold: Awaited<ReturnType<typeof f.turns.begin>> | undefined, refusal: unknown;
  try {
    try { hold = await f.turns.begin("first-after-start", new AbortController().signal); } catch (error) { refusal = error; }
    const admittedAt = performance.now();
    expect(refusal, "FIRST_PROVIDER_POLICY_TURN_AFTER_START_ADMITTED").toBeUndefined();
    expect(releasedAt !== undefined && admittedAt >= releasedAt, "ADMITTED_ONLY_ONCE_THE_SERVER_START_WRITER_FINISHED").toBe(true);
    expect(hold!.sandbox.profile, hold!.sandbox.fallbackReason).toBe("governed");
    expect(hold!.sandbox.retainedFolders, "TYPE_FOLDER_RETAINED").toEqual([".brain-index", "me"]);
  } finally { hook.mockRestore(); boot.release(); await hold?.end(); }
});

test("a folder nested inside another masked folder launches under the outer mask alone", async () => {
  // Bubblewrap cannot create me/sub inside the empty read-only tmpfs over me,
  // so a second mask for it would fail every launch (#2718).
  const f = fixture("[{ paths: [me/**, me/sub/**], allow: [anthropic] }]", "governed", brain => {
    mkdirSync(join(brain, "me/sub"));
    writeFileSync(join(brain, "me/sub/x.md"), `---\ntype: note\ntitle: "Odysseus's buried oath"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${SENTINEL} lies under the olive tree.\n`);
    writeFileSync(join(brain, "me/y.md"), `---\ntype: note\ntitle: "Odysseus's scar"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${SENTINEL} marks the boar's scar.\n`);
  });
  expect(search(f.brain, undefined, SENTINEL), "REAL_INDEX_HOLDS_THE_NESTED_DOCUMENT").toContain("me/sub/x.md");
  const hold = await f.turns.begin("nested-masks", new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe("governed");
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/bash", "-c", `
      printf 'me=%s\\n' "$(ls -A me | wc -l)"
      cat me/sub/x.md 2>/dev/null && printf 'READ_NESTED\\n'
      cat me/y.md 2>/dev/null && printf 'READ_OUTER\\n'
      grep -rl ${SENTINEL} . 2>/dev/null || true
    `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, `NESTED_MASK_LAUNCHES: ${shell.stderr.toString()}`).toBe(0);
    expect(shell.stdout.toString(), "BASH_CANNOT_READ_NESTED_OR_OUTER_MASKED_DOCUMENTS").toBe("me=0\n");
    // The launcher qualifies the concrete mounts before the payload starts.
    const worker = launchAgentWorker({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/true"] });
    expect(await worker.exited, "NESTED_MASK_QUALIFIED_BEFORE_PAYLOAD").toBe(0);
    expect(hold.sandbox.providerMasks?.folders, "NESTED_FOLDER_COVERED_BY_ITS_ANCESTOR").toEqual(["me"]);
    expect(hold.sandbox.retainedFolders, "NESTED_FOLDER_NOT_RETAINED_SEPARATELY").toEqual([".brain-index", "me"]);
    expect(search(f.brain, hold.sandbox, SENTINEL).filter(path => path.startsWith("me/")), "PRIVATE_INDEX_LACKS_NESTED_DOCUMENTS").toEqual([]);
  } finally { await hold.end(); }
});

test.each([
  ["types: [note]", "type note (the inbox type"],
  ["types: [index]", "type index (it has no folder)"],
  ["types: [voyage]", "type voyage (not a type this brain defines)"],
  ["paths: [me/*.md]", "me/*.md"],
  ["paths: [me/identity.md]", "me/identity.md"],
])("a provider selector that does not map exactly onto folders refuses admission by name (%s)", async (selector, named) => {
  const f = fixture(`[{ ${selector}, allow: [anthropic] }]`);
  let refusal: unknown;
  try { await (await f.turns.begin("unsupported", new AbortController().signal)).end(); } catch (error) { refusal = error; }
  expect((refusal as Error)?.name, "UNSUPPORTED_SELECTOR_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain(named);
});

/** Begin a turn; if admitted, read `path` through real bubblewrap Bash. */
async function readThroughTurn(f: ReturnType<typeof fixture>, path: string): Promise<{ refusal?: Error; read: string; profile?: string }> {
  let hold;
  try { hold = await f.turns.begin("hardlink", new AbortController().signal); } catch (error) { return { refusal: error as Error, read: "" }; }
  try {
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, startupView: hold.startupView, env: { PATH },
      command: ["/bin/bash", "-c", `cat ${path} 2>/dev/null || true`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, shell.stderr.toString()).toBe(0);
    return { read: shell.stdout.toString(), profile: hold.sandbox.profile };
  } finally { await hold.end(); }
}

test.each([
  ["paths: [me/**]", "governed", "everywhere"],
  ["types: [identity]", "governed", "everywhere"],
  ["paths: [me/**]", "strict", "everywhere"],
  // Removed from the live brain after the checkpoint: only the view the
  // strict turn runs on holds it.
  ["paths: [me/**]", "strict", "checkpoint only"],
] as const)("a hardlink out of a masked folder under a non-Markdown name refuses admission by name (%s, %s, %s)", async (selector, profile, where) => {
  const f = fixture(`[{ ${selector}, allow: [anthropic] }]`, profile);
  // The same inode as a masked document, under a name the frontmatter check
  // never reads. A hardlinked file in a retained folder already moves a
  // governed turn to the strict checkpoint, and a Btrfs checkpoint keeps the
  // hardlink; the fixture's byte copy would not, so the view recreates it.
  if (where === "everywhere") linkSync(join(f.brain, "me/oath.md"), join(f.brain, "notes/x.txt"));
  (startup.prepareNativeWorkerStartupView as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>).mockImplementation(async (brain, _manager, signal) => {
    signal?.throwIfAborted();
    const view = createFixtureWorkerStartupView(brain);
    rmSync(join(view.root, "notes/x.txt"), { force: true });
    linkSync(join(view.root, "me/oath.md"), join(view.root, "notes/x.txt"));
    return view;
  });
  const { refusal, read, profile: ran } = await readThroughTurn(f, "notes/x.txt");
  expect(read.includes(SENTINEL), `MASKED_BYTES_UNREADABLE_THROUGH_THE_HARDLINK (${ran} turn)`).toBe(false);
  expect(refusal?.name, `HARDLINK_OUT_OF_MASKED_FOLDER_REFUSED: the turn read ${JSON.stringify(read.slice(0, 80))}`).toBe("ProviderPolicyRefusedError");
  expect(refusal?.message).toContain("notes/x.txt is a hardlink to me/oath.md");
});

test("a governed turn refuses a hardlink that only its private index's checkpoint holds", async () => {
  const f = fixture();
  // Gone from the live brain by the time the governed worker is qualified,
  // but the private index is built from the checkpoint, where it remains.
  (startup.prepareNativeWorkerStartupView as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>).mockImplementation(async (brain, _manager, signal) => {
    signal?.throwIfAborted();
    const view = createFixtureWorkerStartupView(brain);
    linkSync(join(view.root, "me/oath.md"), join(view.root, "notes/x.md"));
    return view;
  });
  let refusal: Error | undefined, indexed: string[] = [];
  try {
    const hold = await f.turns.begin("hardlink-checkpoint", new AbortController().signal);
    try { indexed = search(f.brain, hold.sandbox, SENTINEL); } finally { await hold.end(); }
  } catch (error) { refusal = error as Error; }
  expect(refusal?.name, `GOVERNED_CHECKPOINT_HARDLINK_REFUSED: the private index held ${JSON.stringify(indexed)}`).toBe("ProviderPolicyRefusedError");
  expect(refusal?.message).toContain("notes/x.md is a hardlink to me/oath.md");
});

test("symbolic links out of a masked folder and hardlinks within it admit, and the target stays masked", async () => {
  const f = fixture();
  symlinkSync("../me/oath.md", join(f.brain, "notes/oath-link.txt"));
  linkSync(join(f.brain, "me/oath.md"), join(f.brain, "me/alias.txt"));
  (startup.prepareNativeWorkerStartupView as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>).mockImplementation(async (brain, _manager, signal) => {
    signal?.throwIfAborted();
    const view = createFixtureWorkerStartupView(brain);
    rmSync(join(view.root, "me/alias.txt"));
    linkSync(join(view.root, "me/oath.md"), join(view.root, "me/alias.txt"));
    return view;
  });
  const { refusal, read } = await readThroughTurn(f, "notes/oath-link.txt");
  expect(refusal, "SYMLINK_AND_INTERNAL_HARDLINK_ADMIT").toBeUndefined();
  expect(read, "SYMLINK_TARGET_STILL_MASKED").toBe("");
});

test("a type refuses admission while a document of it lies outside its folder", async () => {
  const f = fixture("[{ types: [identity], allow: [anthropic] }]");
  writeFileSync(join(f.brain, "notes/stray-identity.md"), `---\ntype: identity\ntitle: "Odysseus's second name"\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\n${SENTINEL} again.\n`);
  let refusal: unknown;
  try { await (await f.turns.begin("stray", new AbortController().signal)).end(); } catch (error) { refusal = error; }
  expect((refusal as Error)?.name, "STRAY_TYPED_DOCUMENT_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("type identity (notes/stray-identity.md declares it outside me)");
});

test("a type refuses admission when another type's folder lies inside its own", async () => {
  const f = fixture("[{ types: [identity], allow: [anthropic] }]");
  const config = join(f.brain, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace(`study: { dir: "studies" },`, `study: { dir: "studies" },\n      biography: { dir: "me/basics" },`));
  let refusal: unknown;
  try { await (await f.turns.begin("nested", new AbortController().signal)).end(); } catch (error) { refusal = error; }
  expect((refusal as Error)?.name, "NESTED_TYPE_REFUSED").toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("type identity (its folder holds type biography (me/basics))");
});

test("the taxonomy worker cannot leave a selected document in the turn's private index", async () => {
  const f = fixture("[{ types: [identity], allow: [anthropic] }]");
  // Configuration code runs in that worker, which sees only literal folders
  // masked; here it copies the typed document into whatever index it gets.
  const config = join(f.brain, "brain.config.ts");
  writeFileSync(config, `import { copyFileSync } from "node:fs";\nif (process.argv.includes("config")) try { copyFileSync(\`\${process.env.BRAIN_ROOT}/me/identity.md\`, \`\${process.env.BRAIN_ROOT}/.brain-index/copied.md\`); } catch {}\n${readFileSync(config, "utf8")}`);
  const hold = await f.turns.begin("hostile-taxonomy", new AbortController().signal);
  try {
    expect(hold.sandbox.providerMasks?.folders).toEqual(["me"]);
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/sh", "-c",
      `test -e .brain-index/copied.md && printf 'COPIED\\n'; grep -rl ${SENTINEL} . 2>/dev/null; printf 'searched\\n'`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, shell.stderr.toString()).toBe(0);
    expect(shell.stdout.toString(), "TAXONOMY_WORKER_OUTPUT_DISCARDED").toBe("searched\n");
  } finally { await hold.end(); }
});

test("a checkpoint refreshed during admission is judged again before the turn runs on it", async () => {
  const f = fixture("[{ types: [identity], allow: [anthropic] }]", "strict");
  rmSync(join(f.brain, ".brain"), { recursive: true, force: true }); rmSync(join(f.brain, "workspaces"), { recursive: true, force: true });
  let views = 0;
  // Host setup creates the writable roots after the first checkpoint, and a
  // peer retypes a note to identity before the refreshed one is taken.
  (startup.prepareNativeWorkerStartupView as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>).mockImplementation(async (brain, _manager, signal) => {
    signal?.throwIfAborted();
    const view = createFixtureWorkerStartupView(brain);
    if (views++ === 0) {
      mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true }); mkdirSync(join(f.brain, "workspaces"), { recursive: true });
      writeFileSync(join(f.brain, "notes/retyped.md"), `---\ntype: identity\ntitle: "Odysseus's other name"\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\n${SENTINEL} too.\n`);
    }
    return view;
  });
  let refusal: unknown;
  try { await (await f.turns.begin("refreshed", new AbortController().signal)).end(); } catch (error) { refusal = error; }
  expect(views, "CHECKPOINT_REFRESHED_DURING_ADMISSION").toBeGreaterThan(1);
  expect((refusal as Error)?.name, `REFRESHED_CHECKPOINT_JUDGED_AGAIN: ${String(refusal)}`).toBe("ProviderPolicyRefusedError");
  expect(String((refusal as Error).message)).toContain("type identity (notes/retyped.md declares it outside me)");
});

test.each(["governed", "strict"] as const)("a denied %s turn reads the committed generated-text caches as empty", async profile => {
  const f = fixture(undefined, profile);
  // Cached generated text of a masked document, as an `--embeddings` run commits it (#2692).
  writeFileSync(join(f.brain, ".context-cache.jsonl"), `${JSON.stringify({ key: "oath", context: `${SENTINEL} context of me/oath.md` })}\n`);
  writeFileSync(join(f.brain, ".asset-cache.jsonl"), `${JSON.stringify({ key: "avatar", description: `${SENTINEL} description of me/avatar.png` })}\n`);
  const hold = await f.turns.begin(`caches-${profile}`, new AbortController().signal);
  try {
    expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe(profile);
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, startupView: hold.startupView, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/sh", "-c",
      `for cache in .context-cache.jsonl .asset-cache.jsonl; do test -c "$cache" && printf '%s=masked\\n' "$cache"; printf '%s\\n' "$(cat "$cache" | grep -c ${SENTINEL})"; done`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, shell.stderr.toString()).toBe(0);
    expect(shell.stdout.toString(), "BASH_CANNOT_READ_CACHED_MASKED_TEXT").toBe(".context-cache.jsonl=masked\n0\n.asset-cache.jsonl=masked\n0\n");
  } finally { await hold.end(); }
  expect(readFileSync(join(f.brain, ".context-cache.jsonl"), "utf8"), "REAL_CACHE_UNCHANGED").toContain(SENTINEL);
});

test("a live governed launch qualifies the cache masks before its payload starts", async () => {
  const f = fixture();
  writeFileSync(join(f.brain, ".context-cache.jsonl"), `${JSON.stringify({ key: "oath", context: `${SENTINEL} context of me/oath.md` })}\n`);
  const hold = await f.turns.begin("caches-live", new AbortController().signal);
  try {
    const worker = launchAgentWorker({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH },
      command: ["/bin/sh", "-c", `printf '%s\\n' "$(cat .context-cache.jsonl | grep -c ${SENTINEL})"`] });
    let text = ""; for await (const chunk of worker.stdout as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(chunk);
    let stderr = ""; for await (const chunk of worker.stderr as unknown as AsyncIterable<Uint8Array>) stderr += new TextDecoder().decode(chunk);
    expect(await worker.exited, stderr).toBe(0);
    expect(text, "LIVE_CACHE_MASK_QUALIFIED").toBe("0\n");
  } finally { await hold.end(); }
});
