/**
 * A turn's own applications reach its worker's same-turn reads (#2848) and,
 * under provider rules, its private index without any masked byte (#2846).
 * Production admission, the real bridge and the real updater worker; the
 * backend is a script that reads through the worker the turn admitted.
 */
import { afterEach, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { BackendBridge, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { launchAgentWorker, workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import * as startup from "../../ui-sdk/src/server/worker-startup-view";
import * as output from "../../ui-sdk/src/server/worker-native-output";
import { createFixtureWorkerStartupView, prepareFixtureNativeWorkerOutput } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { contentHash } from "../src/brain/application";
import { createIndexBatch, type IndexBatch } from "../src/brain/index-batch";
import { createTurnDataTree } from "../src/brain/turn-data-tree";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { handleClientMessage } from "../src/ws/dispatch";

const REPO = resolve(import.meta.dir, "../../..");
const CORPUS = join(REPO, "packages/core/fixtures/corpus");
const CLI = [process.execPath, join(REPO, "packages/core/src/cli/brain.ts")];
const PATH = `${resolve(process.execPath, "..")}:/usr/bin:/bin`;
const DATA = "/tmp/brain-worker-data";
/** Only the masked folder holds it; no byte of it may reach a masked turn's index. */
const SENTINEL = "Zakynthosmarker";
const NOTE = (title: string, body: string, type = "note") => `---\ntype: ${type}\ntitle: "${title}"\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\n${body}\n`;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

/** A copied view that lives until its last reference is released, as a native checkpoint does. */
function retainableFixtureView(brain: string): startup.WorkerStartupView {
  const inner = createFixtureWorkerStartupView(brain);
  let refs = 0;
  const storage = { root: inner.root, retain() { refs++; }, release() { if (--refs === 0) inner.cleanup(); } };
  return startup.retainWorkerStartupView({ brain: inner.brain, root: inner.root, storage, cleanup() {} });
}

const PROVIDERS = "[{ paths: [me/**], allow: [anthropic] }, { types: [health], allow: [anthropic] }]";

interface Fixture { root: string; brain: string; live: IndexBatch; liveIndexed: string[][] }

/** The corpus with a built live index, under a policy masking `me/` and type `health` when `masked`. */
function fixture(masked: boolean): Fixture {
  const previous = process.env.TMPDIR, tmp = mkdtempSync("/tmp/odysseus-turn-data-tmp-");
  process.env.TMPDIR = tmp;
  cleanup.push(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(tmp, { recursive: true, force: true }); });
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  const root = mkdtempSync(join(REPO, "tmp", "odysseus-turn-data-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  cpSync(CORPUS, brain, { recursive: true });
  rmSync(join(brain, ".brain-index"), { recursive: true, force: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), masked
    ? `---\nschema_version: 1\nproviders: ${PROVIDERS}\n---\nOnly Anthropic may read Odysseus's own folder and his health notes.\n`
    : "---\nschema_version: 1\n---\nOdysseus's brain has no provider rules.\n");
  writeFileSync(join(brain, "me/oath.md"), NOTE("Odysseus's private oath", `${SENTINEL} is the word Odysseus keeps to himself.`));
  writeFileSync(join(brain, "CLAUDE.md"), "Odysseus keeps his own counsel.\n");
  const index = Bun.spawnSync([...CLI, "index", "--json"], { cwd: brain, env: { PATH, BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(index.exitCode, index.stderr.toString()).toBe(0);
  const liveIndexed: string[][] = [];
  // The host's live batch: what it would index is recorded, never applied, so
  // the live index lags exactly what the tests queue.
  const live = createIndexBatch({ index: async paths => { liveIndexed.push([...paths]); } });
  (spyOn(startup, "prepareNativeWorkerStartupView") as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>)
    .mockImplementation(async (path, _manager, signal) => { signal?.throwIfAborted(); return retainableFixtureView(path); });
  cleanup.push(() => (startup.prepareNativeWorkerStartupView as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>).mockRestore());
  // Governed admission qualifies its maintenance worker through a copied stage.
  const staged = spyOn(output, "prepareNativeWorkerOutput").mockImplementation(prepareFixtureNativeWorkerOutput);
  cleanup.push(() => staged.mockRestore());
  return { root, brain, live, liveIndexed };
}

type Script = (turn: { bridge: BackendBridge; request: StartTurnRequest; brain: string; approve: <T>(pending: Promise<T>) => Promise<T>;
  /** The PNG the connected client paints for the next mask request. */
  paint: (png: Uint8Array) => void }) => Promise<void>;

/** One hosted turn through admission, run-session and the bridge; the script plays the backend. */
async function hostedTurn(f: Fixture, profile: "strict" | "governed", script: Script,
  turnsOptions: Partial<Parameters<typeof createGovernedTurns>[0]> = {}, host: Partial<ConstructorParameters<typeof WsHost>[0]> = {},
  /** Keep the server's turns, and their private index cache, across calls. */
  shared?: { turns?: ReturnType<typeof createGovernedTurns>; db?: ReturnType<typeof createUiDb>; execution?: ReturnType<typeof createHostExecution> }) {
  const dbPath = join(f.root, `ui-${crypto.randomUUID()}.db`), db = shared?.db ?? createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = shared?.execution ?? createHostExecution({ brainPath: f.brain, dbPath, exec: {} });
  if (!shared?.execution) execution.attach(db);
  const turns = shared?.turns ?? createGovernedTurns({ nativeManager: createNativeJournalFixture(f.brain, f.root).client, brainPath: f.brain, execution, profile,
    maskPaths: [], index: async () => {}, report() {}, privateIndexCommand: CLI, indexBatch: f.live, ...turnsOptions });
  if (shared) { shared.turns = turns; shared.db = db; shared.execution = execution; }
  const claude = createClaudeBackend({ brainPath: f.brain });
  let failure: unknown, ws: WsHost | undefined, painted: Uint8Array | undefined;
  /** Approve the one destructive application `pending` waits on, as the user would. */
  const approve = async <T>(pending: Promise<T>): Promise<T> => {
    const deadline = Date.now() + 10_000;
    while (!ws!.coordinator.pendingApprovals.size) { if (Date.now() > deadline) throw new Error("no approval requested"); await Bun.sleep(5); }
    for (const [id, entry] of ws!.coordinator.pendingApprovals) { ws!.coordinator.pendingApprovals.delete(id); entry.resolve({ behavior: "allow" }); }
    return pending;
  };
  const backend = { ...makeFakeBackend({ id: "claude", startTurn: async request => {
    try { await script({ bridge: request.bridge, request, brain: f.brain, approve, paint: png => { painted = png; } }); } catch (error) { failure = error; }
    request.bridge.emit({ type: "session_info", sessionId: `tree-${crypto.randomUUID()}`, isNew: true });
    request.bridge.emit({ type: "result", sessionId: "tree", durationMs: 1, numTurns: 1, isError: false });
  } }), brainApplicationPolicy: claude.brainApplicationPolicy };
  ws = new WsHost({ brainPath: f.brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); },
    indexBatch: f.live, applicationPlanner: { index: async () => {}, planAdd: async () => { throw new Error("NO_LIVE_PLANNING_IN_THIS_TEST"); } }, ...host });
  const authorization = testAuthorization(principal.id);
  // The browser that paints a requested mask.
  const client = { send(data: string) {
    const frame = JSON.parse(data);
    if (frame.type === "mask_request" && painted) void handleClientMessage(ws!, client, { type: "mask_response", requestId: frame.requestId, turnId: frame.turnId,
      maskPng: Buffer.from(painted).toString("base64") }, { principal, authorization, protocolRev: 3 });
  } };
  ws.clients.add(client, principal.id);
  try {
    await runSession(ws, { authorization, text: "Odysseus works on his notes.", attachments: [] });
    if (failure) throw failure;
  } finally { ws.close(); if (!shared) { await turns.close(); execution.release(); db.close(); } }
}

/** Run a command in a worker exactly as the turn's backend would launch it. */
function inWorker(request: StartTurnRequest, brain: string, command: string[]) {
  const sandbox = request.workerSandbox!;
  const run = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, ...(sandbox.profile !== "governed" && request.workerStartupView ? { startupView: request.workerStartupView } : {}),
    env: { PATH, BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" }, command }), { env: {}, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function search(request: StartTurnRequest, brain: string, query: string): string[] {
  const run = inWorker(request, brain, [...CLI, "search", query, "--json", "--limit", "50"]);
  expect(run.code, `IN_WORKER_SEARCH_RAN: ${run.stderr}`).toBe(0);
  const parsed = JSON.parse(run.stdout) as { results?: { path: string }[]; warnings?: string[] };
  expect(parsed.warnings?.filter(warning => /unable to open|not found/i.test(warning)) ?? [], "IN_WORKER_SEARCH_OPENED_ITS_INDEX").toEqual([]);
  return (parsed.results ?? []).map(result => result.path);
}

async function apply(bridge: BackendBridge, input: Record<string, unknown>) {
  const result = await bridge.applyBrain!(input as never);
  return result;
}

/** Every file of an index directory that holds `word` anywhere in its bytes: rows, free pages, FTS segments, WAL. */
function bytesHolding(dir: string, word: string): string[] {
  const middle = word.toLowerCase().slice(2, -2);
  return readdirSync(dir).filter(name => readFileSync(join(dir, name)).toString("latin1").toLowerCase().includes(middle));
}

/** What a search can return from an index, independent of row ids and build times. */
function snapshot(dir: string) {
  const db = new Database(join(dir, "brain.db"), { readonly: true });
  try {
    const all = (sql: string) => db.query(sql).all();
    return {
      documents: all("SELECT path, title, type, status, relevance, summary, created, updated, content, content_hash FROM documents ORDER BY path"),
      chunks: all("SELECT d.path, c.chunk_index, c.heading, c.content FROM chunks c JOIN documents d ON d.id = c.document_id ORDER BY d.path, c.chunk_index"),
      links: all("SELECT d.path, l.target, t.path AS resolved FROM links l JOIN documents d ON d.id = l.source_id LEFT JOIN documents t ON t.id = l.target_id ORDER BY d.path, l.target"),
      tags: all("SELECT d.path, t.name FROM document_tags x JOIN documents d ON d.id = x.document_id JOIN tags t ON t.id = x.tag_id ORDER BY d.path, t.name"),
    };
  } finally { db.close(); }
}

test("a strict turn's own applications reach its in-worker search and reads, while configuration stays frozen", async () => {
  const f = fixture(false);
  const eagle = readFileSync(join(f.brain, "notes/quick-note-eagle.md"), "utf8");
  await hostedTurn(f, "strict", async ({ bridge, request, brain }) => {
    const circe = NOTE("Circe", "Circemarker turns the crew into swine on Aeaea.");
    expect((await apply(bridge, { operation: "write", path: "notes/circe.md", content: circe, expectedBaseHash: null })).ok).toBe(true);
    const last = eagle.trimEnd().split("\n").at(-1)!;
    expect((await apply(bridge, { operation: "edit", path: "notes/quick-note-eagle.md", old_string: last, new_string: `${last}\nEaglerevisitmarker.`, expectedBaseHash: contentHash(eagle) })).ok).toBe(true);
    // Configuration as Markdown: the worker's instructions at the brain path stay as the turn started.
    expect((await apply(bridge, { operation: "write", path: "CLAUDE.md", content: "Odysseus obeys Poseidon.\n", expectedBaseHash: contentHash("Odysseus keeps his own counsel.\n") })).ok).toBe(true);
    expect((await apply(bridge, { operation: "write", path: "AGENTS.md", content: "Odysseus obeys Poseidon.\n", expectedBaseHash: null })).ok).toBe(true);
    await bridge.awaitIndex!("mcp__brain__brain_search");
    expect(search(request, brain, "Circemarker"), "IN_WORKER_SEARCH_FINDS_THE_APPLIED_NOTE").toContain("notes/circe.md");
    expect(search(request, brain, "Eaglerevisitmarker"), "IN_WORKER_SEARCH_FINDS_THE_APPLIED_EDIT").toContain("notes/quick-note-eagle.md");
    expect(request.workerSandbox?.dataTree, "STRICT_TURN_HAS_A_DATA_TREE").toBeDefined();
    const read = inWorker(request, brain, [...CLI, "read", "notes/circe.md"]);
    expect(read.stdout, `IN_WORKER_READ_RETURNS_THE_APPLIED_BYTES: ${read.stderr}`).toContain("Circemarker");
    const view = inWorker(request, brain, ["/bin/sh", "-c", `cat ${brain}/CLAUDE.md; test -e ${brain}/AGENTS.md && echo AGENTS_PRESENT; test -e ${brain}/notes/circe.md && echo CIRCE_PRESENT; cat ${DATA}/CLAUDE.md`]);
    expect(view.stdout, "CONFIGURATION_BYTES_STAY_FROZEN_AT_THE_BRAIN_PATH").toBe("Odysseus keeps his own counsel.\nOdysseus obeys Poseidon.\n");
    const write = inWorker(request, brain, ["/bin/sh", "-c", `printf x > ${DATA}/notes/raft-x.md; printf x > ${DATA}/.brain-index/x`]);
    expect(write.stderr.match(/Read-only file system/g)?.length, `DATA_TREE_AND_INDEX_READ_ONLY: ${write.stderr}`).toBe(2);
  });
});

test("a failed turn index update refuses the read, and the next read retries it", async () => {
  const f = fixture(false);
  const calls: string[][] = [];
  await hostedTurn(f, "strict", async ({ bridge }) => {
    expect((await apply(bridge, { operation: "write", path: "notes/aeolus.md", content: NOTE("Aeolus", "The bag of winds."), expectedBaseHash: null })).ok).toBe(true);
    const failed = await bridge.awaitIndex!("Bash").then(() => "resolved", (error: Error) => error.message);
    expect(failed, "A_FAILED_UPDATE_REFUSES_THE_READ").toContain("updating the index failed: the updater stopped");
    await bridge.awaitIndex!("Bash");
    expect(calls, "THE_NEXT_READ_RETRIES_THE_SAME_PATHS").toEqual([["notes/aeolus.md"], ["notes/aeolus.md"]]);
  }, { turnIndexUpdate: async (_tree, paths) => { calls.push([...paths]); if (calls.length === 1) throw new Error("the updater stopped"); } });
});

test("the turn index equals a clean build of its tree after writes, edits, an archive move and a watermark gap", async () => {
  const f = fixture(false);
  // Committed before the turn's checkpoint, not yet in the live index it copies.
  writeFileSync(join(f.brain, "notes/scylla.md"), NOTE("Scylla", "Scyllagapmarker waits on the cliff."));
  f.live.queue(["notes/scylla.md"]);
  await hostedTurn(f, "strict", async ({ bridge, request, brain, approve }) => {
    let body = NOTE("Ithaca", "Ithaca, first draft.");
    expect((await apply(bridge, { operation: "write", path: "notes/ithaca.md", content: body, expectedBaseHash: null })).ok).toBe(true);
    for (const round of [1, 2, 3]) {
      const next = body.replace(/draft[^.]*\./, `draft ${round}.`);
      expect((await apply(bridge, { operation: "write", path: "notes/ithaca.md", content: next, expectedBaseHash: contentHash(body) })).ok).toBe(true);
      body = next;
    }
    const plan = readFileSync(join(brain, "projects/active/raft/plan.md"), "utf8");
    const archived = await approve(apply(bridge, { operation: "archive", path: "projects/active/raft/plan.md", expectedBaseHash: contentHash(plan) }));
    expect(archived.ok, JSON.stringify(archived)).toBe(true);
    await bridge.awaitIndex!("mcp__brain__brain_search");
    expect(search(request, brain, "Scyllagapmarker"), "THE_WATERMARK_GAP_IS_INDEXED").toContain("notes/scylla.md");
    const tree = request.workerSandbox!.dataTree!;
    const clean = mkdtempSync(join(f.root, "clean-"));
    cpSync(tree.root, clean, { recursive: true });
    const built = Bun.spawnSync([...CLI, "index", "--json", "--force"], { cwd: clean, env: { PATH, BRAIN_ROOT: clean, HOME: "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    expect(snapshot(tree.index), "TURN_INDEX_EQUALS_A_CLEAN_BUILD_OF_ITS_TREE").toEqual(snapshot(join(clean, ".brain-index")));
    expect(existsSync(join(tree.root, "projects/active/raft/plan.md")), "ARCHIVE_SOURCE_LEFT_THE_TREE").toBe(false);
  });
});

test("the tree keeps this turn's bytes when a peer rewrites the live file", async () => {
  const f = fixture(false);
  await hostedTurn(f, "strict", async ({ bridge, request, brain }) => {
    const mine = NOTE("Penelope", "Penelope weaves by day.");
    expect((await apply(bridge, { operation: "write", path: "notes/penelope.md", content: mine, expectedBaseHash: null })).ok).toBe(true);
    writeFileSync(join(brain, "notes/penelope.md"), NOTE("Penelope", "A peer's suitor writes here."));
    await bridge.awaitIndex!("mcp__brain__brain_read");
    const read = inWorker(request, brain, [...CLI, "read", "notes/penelope.md"]);
    expect(read.stdout, "IN_WORKER_READ_IS_THIS_TURNS_BYTES").toContain("Penelope weaves by day.");
    expect(read.stdout).not.toContain("suitor");
    expect(readFileSync(join(request.workerSandbox!.dataTree!.root, "notes/penelope.md"), "utf8"), "TREE_HOLDS_THIS_TURNS_BYTES").toBe(mine);
  });
});

test("a Read of an applied file at the brain path is refused, in any spelling, and no Claude file tool reads the tree", async () => {
  const f = fixture(false);
  // Aliases the worker would resolve to the applied file: a final link and a directory link.
  symlinkSync("circe.md", join(f.brain, "notes/aeaea.md"));
  symlinkSync("notes", join(f.brain, "island"));
  await hostedTurn(f, "strict", async ({ bridge, brain }) => {
    expect((await apply(bridge, { operation: "write", path: "notes/circe.md", content: NOTE("Circe", "Aeaea."), expectedBaseHash: null })).ok).toBe(true);
    const refused = async (tool: string, input: Record<string, unknown>) => bridge.awaitIndex!(tool, input).then(() => undefined, (error: Error) => error.message);
    for (const spelling of [join(brain, "notes/circe.md"), `${brain}/notes/../notes/circe.md`, `${brain}//notes/./circe.md`,
      join(brain, "notes/aeaea.md"), join(brain, "island/circe.md"), `/proc/self/root${brain}/notes/circe.md`, "notes/circe.md"])
      expect(await refused("Read", { file_path: spelling }) ?? "admitted", `APPLIED_READ_REFUSED: ${spelling}`).toContain("mcp__brain__brain_read");
    expect(await refused("Read", { file_path: join(brain, "notes/quick-note-eagle.md") }), "UNCHANGED_READ_ADMITTED").toBeUndefined();
    expect(await refused("Grep", { pattern: "Circe", path: join(brain, "notes") }), "BRAIN_PATH_GREP_ADMITTED").toBeUndefined();
    for (const [tool, input] of [["Read", { file_path: `${DATA}/notes/circe.md` }], ["Grep", { pattern: "Circe", path: DATA }],
      ["Glob", { pattern: `${DATA}/notes/*.md` }], ["Glob", { pattern: "*.md", path: `/proc/self/root${DATA}` }]] as const)
      expect(await refused(tool, input) ?? "admitted", `NO_FILE_TOOL_READS_THE_TREE: ${tool} ${JSON.stringify(input)}`).toContain("does not read this turn's data tree");
  });
});

for (const profile of ["strict", "governed"] as const) {
  test(`a ${profile} masked turn's own applications reach its private index, and no masked byte ever does`, async () => {
    const f = fixture(true);
    const water = readFileSync(join(f.brain, "notes/quick-note-water.md"), "utf8");
    const eagle = readFileSync(join(f.brain, "notes/quick-note-eagle.md"), "utf8");
    const plan = readFileSync(join(f.brain, "projects/active/raft/plan.md"), "utf8");
    await hostedTurn(f, profile, async ({ bridge, request, brain, approve }) => {
      const index = request.workerSandbox!.providerMasks!.index!;
      // A permitted note reaches the private index.
      expect((await apply(bridge, { operation: "write", path: "notes/voyage.md", content: NOTE("Voyage", "Phaeacianmarker carries Odysseus home."), expectedBaseHash: null })).ok).toBe(true);
      // Into the masked folder: refused before any effect.
      expect((await apply(bridge, { operation: "write", path: "me/leak.md", content: NOTE("Leak", SENTINEL), expectedBaseHash: null })).code).toBe("provider_masked");
      // Outside it, with a type the recipient may not see.
      expect((await apply(bridge, { operation: "write", path: "notes/typed.md", content: NOTE("Typed", `${SENTINEL} in a health note.`, "health"), expectedBaseHash: null })).ok).toBe(true);
      // A peer retypes a note, and the turn edits it back to an allowed type.
      const retyped = water.replace("type: note", "type: health").replace(/\n$/, `\n${SENTINEL} under the knee.\n`);
      writeFileSync(join(brain, "notes/quick-note-water.md"), retyped);
      expect((await apply(bridge, { operation: "edit", path: "notes/quick-note-water.md", old_string: "type: health", new_string: "type: note", expectedBaseHash: contentHash(retyped) })).ok).toBe(true);
      // A peer copies masked text into a permitted note, and the turn edits it.
      const copied = eagle.replace(/\n$/, `\n${SENTINEL} copied by a peer.\n`);
      writeFileSync(join(brain, "notes/quick-note-eagle.md"), copied);
      expect((await apply(bridge, { operation: "edit", path: "notes/quick-note-eagle.md", old_string: "copied by a peer", new_string: "copied by a peer, edited", expectedBaseHash: contentHash(copied) })).ok).toBe(true);
      // An archive move of a document a peer changed.
      const peered = plan.replace(/\n$/, `\n${SENTINEL} in the plan.\n`);
      writeFileSync(join(brain, "projects/active/raft/plan.md"), peered);
      expect((await approve(apply(bridge, { operation: "archive", path: "projects/active/raft/plan.md", expectedBaseHash: contentHash(peered) }))).ok).toBe(true);
      // A capture whose host planner copies masked text: a masked turn plans on its own tree instead.
      const add = await apply(bridge, { operation: "add", content: "Odysseus remembers Ithaca.", type: "note", title: "Ithaca capture" });
      expect(add.ok, JSON.stringify(add)).toBe(true);
      await bridge.awaitIndex!("mcp__brain__brain_search");
      expect(search(request, brain, "Phaeacianmarker"), "MASKED_TURN_FINDS_ITS_OWN_APPLICATION").toContain("notes/voyage.md");
      expect(search(request, brain, SENTINEL), "MASKED_TURN_SEARCH_LACKS_THE_SENTINEL").toEqual([]);
      expect(bytesHolding(index, SENTINEL), "NO_SENTINEL_BYTE_IN_THE_PRIVATE_INDEX").toEqual([]);
      expect(request.workerSandbox!.dataTree === undefined, "ONLY_A_STRICT_WORKER_MOUNTS_THE_TREE").toBe(profile === "governed");
    }, {}, { applicationPlanner: { index: async () => {}, planAdd: async () => ({ path: "notes/ithaca-capture.md",
      content: NOTE("Ithaca capture", `${SENTINEL} from the real index.`), baseContent: null, outcome: {} }) } });
  });
}

/** A PNG whose bytes carry `marker` after the signature. */
const PNG_WITH = (marker: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(marker)]);
/** Only the masks a turn replaces or prunes hold it; no read in the turn may return it once they are gone. */
const OLD_MASK = "Charybdisoldmask";

/**
 * An image with an earlier mask, and an expired scratch sketch the next
 * scratch mask prunes. Returns the host's maintenance, which checks the
 * scratch ignore rule.
 */
function maskFixture(f: Fixture): Partial<ConstructorParameters<typeof WsHost>[0]> {
  mkdirSync(join(f.brain, "assets"), { recursive: true });
  writeFileSync(join(f.brain, "assets/raft.png"), PNG_WITH("raft"));
  writeFileSync(join(f.brain, "assets/raft-mask.png"), PNG_WITH(OLD_MASK));
  mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true });
  writeFileSync(join(f.brain, ".gitignore"), ".brain/scratch/\n");
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: f.brain }).exitCode).toBe(0);
  writeFileSync(join(f.brain, ".brain/scratch/sail.png"), PNG_WITH("sail"));
  writeFileSync(join(f.brain, ".brain/scratch/old-sketch.png"), PNG_WITH(OLD_MASK));
  utimesSync(join(f.brain, ".brain/scratch/old-sketch.png"), new Date(0), new Date(0));
  // Expired too, but a protected link names it, so the prune keeps it (#2876).
  writeFileSync(join(f.brain, ".brain/scratch/kept-sketch.png"), PNG_WITH("kept"));
  utimesSync(join(f.brain, ".brain/scratch/kept-sketch.png"), new Date(0), new Date(0));
  symlinkSync(".brain/scratch/kept-sketch.png", join(f.brain, "kept"));
  const policy = join(f.brain, "context/policies/governance.md");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("schema_version: 1\n", "schema_version: 1\nprotect: [kept]\n"));
  const view = createFixtureWorkerStartupView(f.brain);
  cleanup.push(() => view.cleanup());
  return { maintenance: { startupView: view, tempDomain: { statePath: join(view.storage.root, "maintenance-state.db") } } as never };
}

const bytesAt = (root: string, rel: string) => existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null;

/** Apply one painted mask through the bridge, as the backend's mask tool does. */
async function mask(bridge: BackendBridge, paint: (png: Uint8Array) => void, imagePath: string, maskPath: string, png: Uint8Array) {
  paint(png);
  const painted = await bridge.requestMask!(imagePath, "Mark the sail.");
  return bridge.applyImageMask!({ imagePath, maskPath, png: painted });
}

test("a strict turn's own image masks reach its tree before its next read, and the replaced and pruned bytes do not", async () => {
  const f = fixture(false);
  const host = maskFixture(f);
  await hostedTurn(f, "strict", async ({ bridge, request, brain, paint }) => {
    const tree = request.workerSandbox!.dataTree!;
    expect(bytesAt(tree.root, "assets/raft-mask.png")?.toString("latin1"), "THE_TREE_STARTS_WITH_THE_EARLIER_MASK").toContain(OLD_MASK);
    const replaced = await mask(bridge, paint, "assets/raft.png", "assets/raft-mask.png", PNG_WITH("Scyllanewmask"));
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    const scratch = await mask(bridge, paint, ".brain/scratch/sail.png", ".brain/scratch/sail-mask.png", PNG_WITH("Sirensailmask"));
    expect(scratch.ok, JSON.stringify(scratch)).toBe(true);
    expect(scratch.changes.map(change => change.path), "THE_PRUNE_REMOVED_THE_OLD_SKETCH").toContain(".brain/scratch/old-sketch.png");
    // The tree follows exactly what the live prune removed and kept.
    expect([existsSync(join(brain, ".brain/scratch/kept-sketch.png")), existsSync(join(tree.root, ".brain/scratch/kept-sketch.png"))],
      "THE_TREE_KEEPS_WHAT_THE_PRUNE_KEPT").toEqual([true, true]);
    expect([existsSync(join(brain, ".brain/scratch/old-sketch.png")), existsSync(join(tree.root, ".brain/scratch/old-sketch.png"))],
      "THE_TREE_DROPS_WHAT_THE_PRUNE_REMOVED").toEqual([false, false]);
    // The turn's next read waits for its index, which takes the same paths.
    await bridge.awaitIndex!("mcp__brain__brain_search");
    const read = inWorker(request, brain, ["/bin/sh", "-c", `cat ${DATA}/assets/raft-mask.png ${DATA}/.brain/scratch/sail-mask.png; `
      + `test -e ${DATA}/.brain/scratch/old-sketch.png && echo PRUNED_SKETCH_PRESENT; grep -rl ${OLD_MASK} ${DATA} ${DATA}/.brain; true`]);
    expect(read.stdout, `IN_WORKER_READ_SEES_THE_NEW_MASKS: ${read.stderr}`).toBe(Buffer.concat([PNG_WITH("Scyllanewmask"), PNG_WITH("Sirensailmask")]).toString());
    expect(bytesAt(tree.root, "assets/raft-mask.png"), "THE_TREE_HOLDS_THE_APPLIED_PNG").toEqual(PNG_WITH("Scyllanewmask"));
    // A Claude `Read` at the brain path would return the turn-start mask.
    const refusal = await bridge.awaitIndex!("Read", { file_path: join(brain, "assets/raft-mask.png") }).then(() => "admitted", (error: Error) => error.message);
    expect(refusal, "APPLIED_MASK_READ_REFUSED").toContain("mcp__brain__brain_read");
  }, {}, host);
});

test("a masked turn's image mask enters its tree under the provenance rule, and a peer-changed base does not", async () => {
  const f = fixture(true);
  const host = maskFixture(f);
  writeFileSync(join(f.brain, "assets/shield.png"), PNG_WITH("shield"));
  writeFileSync(join(f.brain, "assets/shield-mask.png"), PNG_WITH("shield turn-start"));
  await hostedTurn(f, "strict", async ({ bridge, request, brain, paint }) => {
    const tree = request.workerSandbox!.dataTree!;
    expect((await mask(bridge, paint, "assets/raft.png", "assets/raft-mask.png", PNG_WITH("Scyllanewmask"))).ok).toBe(true);
    expect(bytesAt(tree.root, "assets/raft-mask.png"), "MASKED_TURN_TREE_HOLDS_ITS_OWN_MASK").toEqual(PNG_WITH("Scyllanewmask"));
    // A peer replaced the mask after the turn started: its base is not what this turn saw.
    writeFileSync(join(brain, "assets/shield-mask.png"), PNG_WITH(OLD_MASK));
    expect((await mask(bridge, paint, "assets/shield.png", "assets/shield-mask.png", PNG_WITH("Shieldnewmask"))).ok).toBe(true);
    expect(existsSync(join(tree.root, "assets/shield-mask.png")), "A_PEER_BASED_MASK_LEAVES_THE_TREE").toBe(false);
    await bridge.awaitIndex!("mcp__brain__brain_search");
  }, {}, host);
});

test("the brain's MCP server on the read-only tree stays fresh across in-place index updates", async () => {
  const f = fixture(false);
  await hostedTurn(f, "strict", async ({ bridge, request, brain }) => {
    const worker = launchAgentWorker({ brainPath: brain, startupView: request.workerStartupView!, sandbox: request.workerSandbox!,
      env: { PATH, BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" }, command: [...CLI, "mcp"] });
    const waiting = new Map<number, (message: { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown }) => void>();
    let buffer = "", id = 0;
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); waiting.get(message.id)?.(message);
      }
    });
    const send = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>(done => {
      waiting.set(++id, done); worker.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    try {
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "odysseus", version: "0" } });
      worker.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      // One long-lived connection, opened before any update, as Claude's server is.
      const first = await send("tools/call", { name: "brain_search", arguments: { query: "eagle" } });
      expect(first.error ?? first.result?.isError, `MCP_SERVER_STARTS_ON_THE_READ_ONLY_TREE: ${JSON.stringify(first)}`).toBeFalsy();
      for (const round of [0, 1, 2]) {
        const marker = `Scyllaroundmarker${round}x`;
        expect((await apply(bridge, { operation: "write", path: `notes/scylla-${round}.md`, content: NOTE(`Scylla ${round}`, `${marker} between the rocks.`), expectedBaseHash: null })).ok).toBe(true);
        await bridge.awaitIndex!("mcp__brain__brain_search");
        const found = await send("tools/call", { name: "brain_search", arguments: { query: marker } });
        expect(found.result?.content?.[0]?.text ?? JSON.stringify(found), `SAME_CONNECTION_FINDS_ROUND_${round}`).toContain(`notes/scylla-${round}.md`);
      }
    } finally { worker.kill("SIGKILL"); await worker.exited; }
  });
});

test("a masked tree leaves out the masked folders, the operational state and the caches", async () => {
  const f = fixture(true);
  mkdirSync(join(f.brain, ".brain"), { recursive: true });
  writeFileSync(join(f.brain, ".brain/state.md"), NOTE("State", `${SENTINEL} in operational state.`));
  writeFileSync(join(f.brain, ".context-cache.jsonl"), `{"text":"${SENTINEL}"}\n`);
  mkdirSync(join(f.brain, ".brain-cache")); writeFileSync(join(f.brain, ".brain-cache/contexts.jsonl"), `{"text":"${SENTINEL}"}\n`);
  writeFileSync(join(f.brain, ".env"), "ODYSSEUS_SECRET=Nobody\n");
  await hostedTurn(f, "strict", async ({ request }) => {
    const tree = request.workerSandbox!.dataTree!;
    const present = (rel: string) => existsSync(join(tree.root, rel));
    expect(["me", "health", ".brain", ".context-cache.jsonl", ".brain-cache", ".env", ".git", "node_modules"].filter(present), "TREE_OMITS_WHAT_THE_TURN_CANNOT_SEE").toEqual([]);
    expect(present("notes/quick-note-eagle.md"), "TREE_HOLDS_THE_VISIBLE_DOCUMENTS").toBe(true);
    expect(tree.masked, "THE_UPDATER_SEES_THE_SAME_MASKS_AS_THE_BUILD").toEqual([".brain", "health", "me"]);
  });
});

test("a masked turn's updates never touch the reusable private index base", async () => {
  const f = fixture(true);
  const bases = () => readdirSync(tmpdir()).filter(name => name.startsWith("brain-private-index-base-")).map(name => join(tmpdir(), name));
  const digest = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
  const shared: NonNullable<Parameters<typeof hostedTurn>[5]> = {};
  try {
    await hostedTurn(f, "strict", async () => {}, {}, {}, shared);
    expect(bases().length, "ONE_BASE_SEALED").toBe(1);
    let admitted: Record<string, string> | undefined;
    await hostedTurn(f, "strict", async ({ bridge, request, brain }) => {
      admitted = digest(bases()[0]!);
      expect((await apply(bridge, { operation: "write", path: "notes/ithaca.md", content: NOTE("Ithaca", "Ithacabasemarker at home."), expectedBaseHash: null })).ok).toBe(true);
      await bridge.awaitIndex!("mcp__brain__brain_search");
      expect(search(request, brain, "Ithacabasemarker"), "THE_TURN_COPY_WAS_UPDATED").toContain("notes/ithaca.md");
    }, {}, {}, shared);
    // Admission may advance the base; the turn's own updates never do.
    expect(digest(bases()[0]!), "THE_BASE_IS_BYTE_IDENTICAL_AFTER_A_TURN_UPDATED_ITS_COPY").toEqual(admitted!);
  } finally { await shared.turns?.close(); shared.execution?.release(); shared.db?.close(); }
});

test("the tree leaves out .env link targets and, under any provider rule, the legacy caches; it is removed whole", async () => {
  const f = fixture(false);
  mkdirSync(join(f.brain, "settings"), { recursive: true });
  writeFileSync(join(f.brain, "settings/ithaca-credentials.txt"), "ODYSSEUS_SECRET=Nobody\n");
  symlinkSync("settings/ithaca-credentials.txt", join(f.brain, ".env"));
  writeFileSync(join(f.brain, ".context-cache.jsonl"), "{}\n");
  mkdirSync(join(f.brain, ".brain-cache")); writeFileSync(join(f.brain, ".brain-cache/contexts.jsonl"), "{}\n");
  mkdirSync(join(f.brain, "archive-sealed")); writeFileSync(join(f.brain, "archive-sealed/raft.md"), NOTE("Sealed", "Kept read-only."));
  chmodSync(join(f.brain, "archive-sealed"), 0o555);
  cleanup.push(() => chmodSync(join(f.brain, "archive-sealed"), 0o755));
  const view = await startup.prepareNativeWorkerStartupView(f.brain, undefined as never);
  try {
    // A recipient allowed every provider folder: no folder is masked, and
    // neither is `.brain-cache/`; a legacy root-level cache still is (#2725).
    const tree = createTurnDataTree({ brainPath: f.brain, view, maskPaths: [], mount: true, providerRules: true, update: async () => {} });
    const root = tree.mount!.root;
    expect(["settings/ithaca-credentials.txt", ".env", ".context-cache.jsonl"].filter(rel => existsSync(join(root, rel))), "TREE_OMITS_ENV_TARGETS_AND_LEGACY_CACHES").toEqual([]);
    expect(existsSync(join(root, ".brain-cache/contexts.jsonl")), "ALLOWED_TREE_KEEPS_THE_CACHE_DIRECTORY").toBe(true);
    expect(tree.mount!.masked, "THE_LEGACY_CACHES_ARE_MASKED_ON_THE_TREE_TOO").toEqual([]);
    expect(existsSync(join(root, "archive-sealed/raft.md")), "READ_ONLY_DIRECTORIES_ARE_COPIED").toBe(true);
    await tree.close();
    expect([existsSync(root), existsSync(tree.index)], "TREE_AND_INDEX_REMOVED_DESPITE_READ_ONLY_DIRECTORIES").toEqual([false, false]);
  } finally { await view.cleanup(); }
});
