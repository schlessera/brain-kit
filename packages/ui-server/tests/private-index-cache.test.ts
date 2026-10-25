/**
 * A provider-restricted turn's private index is reused across turns only when
 * it provably equals a clean masked build of the turn's final view (#2833,
 * option C). Real bubblewrap workers from production admission; every index
 * is built by the real CLI inside a masked worker, and each reused or updated
 * one is compared with a clean build and read byte by byte.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test, type Mock } from "bun:test";
import { appendFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseNativeBrainDelta } from "../../ui-sdk/src/server/native-brain-delta";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import * as startup from "../../ui-sdk/src/server/worker-startup-view";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns, type GovernedTurnHold, type GovernedTurnRoute } from "../src/brain/governed-turn";
import type { KeyedLock } from "../../ui-sdk/src/server/keyed-lock";
import { classifyPrivateIndexChanges, createPrivateIndexCache, privateIndexBuildFolders, privateIndexCacheKey, privateIndexInert, type PrivateIndexAdvance, type PrivateIndexChanges, type PrivateIndexDiffer, type PrivateIndexIdentity } from "../src/brain/private-index-cache";
import { createProviderExposures } from "../src/brain/provider-exposure";
import { createNativeJournalFixture, fixtureDelta, inventory } from "./helpers/native-journal-fixture.js";
import type { NativeBrainDeltaCandidate } from "../../ui-sdk/src/server/native-brain-delta";

const REPO = resolve(import.meta.dir, "../../..");
const CORPUS = join(REPO, "packages/core/fixtures/corpus");
const CLI = [process.execPath, join(REPO, "packages/core/src/cli/brain.ts")];
const PATH = `${resolve(process.execPath, "..")}:/usr/bin:/bin`;
const ANTHROPIC = "https://api.anthropic.com";
/** Words only one document holds: the masked folder, a health note, and a note that later leaves the view. */
const SENTINEL = "Zakynthosmarker", KNEE = "Kneecapmarker", DOOMED = "Ogygiamarker";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

/**
 * A copied view whose copy lives until its last reference is released, as a
 * native checkpoint does; the plain fixture view removes its copy at once.
 */
function retainableFixtureView(brain: string): startup.WorkerStartupView {
  const inner = createFixtureWorkerStartupView(brain);
  let refs = 0;
  const storage = { root: inner.root, retain() { refs++; }, release() { if (--refs === 0) inner.cleanup(); } };
  return startup.retainWorkerStartupView({ brain: inner.brain, root: inner.root, storage, cleanup() {} });
}

/**
 * A private temporary directory for this test, under `/tmp` as the cache
 * requires: bun runs every file in one process, so other suites' turns keep
 * bases under the same process id in the shared one.
 */
function privateTmp(): string {
  const previous = process.env.TMPDIR, dir = mkdtempSync("/tmp/odysseus-private-index-tmp-");
  process.env.TMPDIR = dir;
  cleanup.push(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const NOTE = (title: string, body: string) => `---\ntype: note\ntitle: "${title}"\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [note]\n---\n\n${body}\n`;

/** The native delta's framing and parser over two copied views, as the kernel would send it. */
const fixtureDiffer: PrivateIndexDiffer = async (from, to, signal) => {
  const before = { uuid: "a1".repeat(16), transaction: "1", entries: inventory(from.root) };
  const after = { uuid: "b2".repeat(16), transaction: "2", entries: inventory(to.root) };
  const job = fixtureDelta(before, after, "brain");
  return { completed: job.completed, candidates: parseNativeBrainDelta(job.stream, { signal,
    before: { uuid: before.uuid, transaction: 1n }, after: { uuid: after.uuid, transaction: 2n } }) };
};

function fixture(providers = "[{ paths: [me/**], allow: [google] }]", options: { differ?: PrivateIndexDiffer; recipients?: boolean } = {}) {
  privateTmp();
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  const root = mkdtempSync(join(REPO, "tmp", "odysseus-private-index-cache-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  cpSync(CORPUS, brain, { recursive: true });
  rmSync(join(brain, ".brain-index"), { recursive: true, force: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  const policy = (rules: string, note = "Only Google may read Odysseus's own folder.") => writeFileSync(join(brain, "context/policies/governance.md"),
    `---\nschema_version: 1\nproviders: ${rules}\n---\n${note}\n`);
  policy(providers);
  mkdirSync(join(brain, ".git")); writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "me/oath.md"), NOTE("Odysseus's private oath", `${SENTINEL} is the word Odysseus keeps to himself.`));
  writeFileSync(join(brain, "health/knee-injury.md"), `${readFileSync(join(brain, "health/knee-injury.md"), "utf8")}\nThe healer's word is ${KNEE}.\n`);
  writeFileSync(join(brain, "notes/calypso.md"), NOTE("Seven years on Ogygia", `${DOOMED} names the island Odysseus left.`));
  const dbPath = join(root, "state/ui.db"); mkdirSync(join(root, "state"));
  const db = createUiDb(dbPath); cleanup.push(() => db.close());
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const reports: string[] = [];
  const exposures = options.recipients ? createProviderExposures(db) : undefined;
  const advances: PrivateIndexAdvance[][] = [];
  const create = (differ?: PrivateIndexDiffer) => {
    const turns = createGovernedTurns({ onPrivateIndexAdvance: results => advances.push(results), nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution,
      profile: "governed", maskPaths: [], index: async () => {}, report: message => reports.push(message), privateIndexCommand: CLI,
      ...(exposures ? { exposures } : {}), ...(differ ? { privateIndexDiffer: differ } : {}) });
    cleanup.push(() => turns.close());
    return turns;
  };
  (startup.prepareNativeWorkerStartupView as unknown as Mock<typeof startup.prepareNativeWorkerStartupView>).mockImplementation(async (path, _manager, signal) => {
    signal?.throwIfAborted(); return retainableFixtureView(path);
  });
  const turns = create(options.differ ?? fixtureDiffer);
  if (options.recipients) {
    // The copied fixture brain has no manager-acquired view; stand in for one.
    const managed = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
    cleanup.push(() => managed.mockRestore());
  }
  const begin = (turnId: string, route?: GovernedTurnRoute) => turns.begin(turnId, new AbortController().signal, "interactive", undefined, route);
  /** A clean masked build of the brain as it is now, from a server with no cache. */
  const oracle = async (route?: GovernedTurnRoute) => {
    const hold = await create().begin(`oracle-${Math.random()}`, new AbortController().signal, "interactive", undefined, route);
    try { expect(hold.privateIndex?.kind, "ORACLE_IS_A_CLEAN_BUILD").toBe("built"); return snapshot(indexOf(hold)); } finally { await hold.end(); }
  };
  /** The post-turn refresh, then the advance it starts. */
  const refreshed = async () => {
    const seen = advances.length;
    turns.refresh({} as KeyedLock);
    const deadline = Date.now() + 120_000;
    while (advances.length === seen) { if (Date.now() > deadline) throw new Error("no advance"); await Bun.sleep(20); }
    return advances.at(-1)!.map(result => result.kind === "dropped" || result.kind === "kept" || result.kind === "rebuilt" ? `${result.kind}: ${result.reason}` : result.kind);
  };
  return { root, brain, turns, begin, oracle, reports, policy, refreshed };
}

const indexOf = (hold: GovernedTurnHold) => hold.sandbox.providerMasks!.index!;

/**
 * Every file of an index directory that holds `word` anywhere in its bytes:
 * rows, free pages, FTS segments or WAL. FTS stores a term folded and
 * stemmed, and a segment shares a term's first bytes with the term before
 * it, so the scan looks for the word's folded middle in any case.
 */
function bytesHolding(dir: string, word: string): string[] {
  const middle = word.toLowerCase().slice(2, -2);
  return readdirSync(dir).filter(name => readFileSync(join(dir, name)).toString("latin1").toLowerCase().includes(middle));
}

/** What a search can return from an index, independent of row ids and build times. */
function snapshot(dir: string) {
  // Read-only: a writable close would delete the sidecars the worker's read-only mount needs.
  const db = new Database(join(dir, "brain.db"), { readonly: true });
  try {
    const all = (sql: string, ...values: string[]) => db.query(sql).all(...values);
    return {
      documents: all("SELECT path, title, type, status, relevance, summary, created, updated, content, content_hash FROM documents ORDER BY path"),
      chunks: all("SELECT d.path, c.chunk_index, c.heading, c.content FROM chunks c JOIN documents d ON d.id = c.document_id ORDER BY d.path, c.chunk_index"),
      links: all("SELECT d.path, l.target, t.path AS resolved FROM links l JOIN documents d ON d.id = l.source_id LEFT JOIN documents t ON t.id = l.target_id ORDER BY d.path, l.target"),
      tags: all("SELECT d.path, t.name FROM document_tags x JOIN documents d ON d.id = x.document_id JOIN tags t ON t.id = x.tag_id ORDER BY d.path, t.name"),
      search: Object.fromEntries(["eagle", "odysseus", "ithaca", "scheria", "ogygiamarker"].map(term => [term,
        all("SELECT d.path FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id WHERE chunks_fts MATCH ? GROUP BY d.path ORDER BY d.path", term)])),
    };
  } finally { db.close(); }
}

function search(brain: string, hold: GovernedTurnHold, query: string): string[] {
  const run = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox: hold.sandbox, env: { PATH, BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" },
    command: [...CLI, "search", query, "--json", "--limit", "50"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, `RESTRICTED_SEARCH_RAN: ${run.stderr.toString()}`).toBe(0);
  const parsed = JSON.parse(run.stdout.toString()) as { results?: { path: string }[] } | { path: string }[];
  return (Array.isArray(parsed) ? parsed : parsed.results ?? []).map(result => result.path);
}

/** Run one turn; check it before its index is discarded. */
async function turn<T>(hold: Promise<GovernedTurnHold>, check: (hold: GovernedTurnHold) => T | Promise<T>): Promise<T> {
  const held = await hold;
  try { return await check(held); } finally { await held.end(); }
}

test("a warm turn reuses the base, which is exactly what a clean build of its view holds", async () => {
  const f = fixture();
  const first = await turn(f.begin("first"), hold => {
    expect(hold.privateIndex?.kind, "FIRST_TURN_BUILDS").toBe("built");
    return snapshot(indexOf(hold));
  });
  await turn(f.begin("warm"), hold => {
    expect(hold.privateIndex?.kind, "WARM_TURN_REUSES_THE_BASE").toBe("reused");
    expect(bytesHolding(indexOf(hold), SENTINEL), "REUSED_INDEX_HOLDS_NO_MASKED_BYTES").toEqual([]);
    expect(snapshot(indexOf(hold)), "REUSED_INDEX_EQUALS_THE_FIRST_BUILD").toEqual(first);
    expect(search(f.brain, hold, "eagle"), "REUSED_INDEX_SEARCHES").toContain("notes/quick-note-eagle.md");
    expect(search(f.brain, hold, SENTINEL).filter(path => path.startsWith("me/")), "REUSED_INDEX_LACKS_MASKED_DOCUMENTS").toEqual([]);
  });
  expect(first, "REUSED_INDEX_EQUALS_A_CLEAN_BUILD").toEqual(await f.oracle());
});

test("a document added outside the masks updates the base in place, as a clean build would index it", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  mkdirSync(join(f.brain, "notes/voyages"));
  writeFileSync(join(f.brain, "notes/voyages/scheria.md"), NOTE("Landfall on Scheria", "Odysseus washes ashore on Scheria and meets Nausicaa. See [[calypso]]."));
  const updated = await turn(f.begin("added"), hold => {
    expect(hold.privateIndex, "AN_ADDITION_UPDATES_THE_BASE").toMatchObject({ kind: "updated", added: 1 });
    expect(search(f.brain, hold, "Scheria"), "THE_ADDED_DOCUMENT_IS_FOUND").toContain("notes/voyages/scheria.md");
    expect(bytesHolding(indexOf(hold), SENTINEL)).toEqual([]);
    return snapshot(indexOf(hold));
  });
  expect(updated, "UPDATED_INDEX_EQUALS_A_CLEAN_BUILD").toEqual(await f.oracle());
  // The updated base is bound to the newer checkpoint.
  await turn(f.begin("after"), hold => expect(hold.privateIndex?.kind, "THE_UPDATED_BASE_IS_REUSED").toBe("reused"));
});

test.each([
  ["changed", (brain: string) => writeFileSync(join(brain, "notes/calypso.md"), NOTE("Seven years on Ogygia", "The island is behind him now."))],
  ["removed", (brain: string) => rmSync(join(brain, "notes/calypso.md"))],
  ["moved into the masked folder", (brain: string) => renameSync(join(brain, "notes/calypso.md"), join(brain, "me/calypso.md"))],
] as const)("a document %s outside the masks takes a clean build, and none of its old bytes survive", async (what, change) => {
  const f = fixture();
  await turn(f.begin("first"), hold => {
    expect(hold.privateIndex?.kind).toBe("built");
    expect(bytesHolding(indexOf(hold), DOOMED).length, "THE_FIRST_BUILD_HOLDS_THE_DOCUMENT").toBeGreaterThan(0);
  });
  change(f.brain);
  const after = await turn(f.begin("after"), hold => {
    expect(bytesHolding(indexOf(hold), DOOMED), "NO_FILE_OF_THE_INDEX_HOLDS_THE_OLD_TEXT").toEqual([]);
    expect(hold.privateIndex?.kind, `A_DOCUMENT_${what.toUpperCase().replaceAll(" ", "_")}_REBUILDS`).toBe("built");
    return snapshot(indexOf(hold));
  });
  expect(after, "REBUILT_INDEX_EQUALS_A_CLEAN_BUILD").toEqual(await f.oracle());
});

test("after a turn adds notes, the post-turn advance brings the base up to the live brain, so the next turn reuses it", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  writeFileSync(join(f.brain, "notes/scheria.md"), NOTE("Landfall on Scheria", "Odysseus washes ashore on Scheria and meets Nausicaa. See [[calypso]]."));
  expect(await f.refreshed(), "THE_ADVANCE_ADDS_THE_NEW_NOTE").toEqual(["updated"]);
  const warm = await turn(f.begin("warm"), hold => {
    expect(hold.privateIndex?.kind, "THE_NEXT_TURN_REUSES_THE_ADVANCED_BASE").toBe("reused");
    expect(search(f.brain, hold, "Scheria"), "THE_ADVANCED_BASE_HOLDS_THE_NEW_NOTE").toContain("notes/scheria.md");
    expect(bytesHolding(indexOf(hold), SENTINEL), "NO_MASKED_BYTES").toEqual([]);
    return snapshot(indexOf(hold));
  });
  expect(warm, "THE_ADVANCED_BASE_EQUALS_A_CLEAN_BUILD").toEqual(await f.oracle());
  // Nothing changed since: the next advance only moves the checkpoint.
  expect(await f.refreshed(), "AN_UNCHANGED_BRAIN_REBINDS").toEqual(["rebound"]);
});

test.each([
  ["changed", (brain: string) => writeFileSync(join(brain, "notes/calypso.md"), NOTE("Seven years on Ogygia", "The island is behind him now."))],
  ["removed", (brain: string) => rmSync(join(brain, "notes/calypso.md"))],
  ["moved into the masked folder", (brain: string) => renameSync(join(brain, "notes/calypso.md"), join(brain, "me/calypso.md"))],
] as const)("a document %s outside the masks is rebuilt off the turn path, and none of its old bytes reach the next turn", async (_what, change) => {
  const f = fixture();
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  change(f.brain);
  expect((await f.refreshed())[0], "THE_ADVANCE_REBUILDS_CLEANLY").toMatch(/^rebuilt: notes\/calypso\.md /);
  const warm = await turn(f.begin("warm"), hold => {
    expect(bytesHolding(indexOf(hold), DOOMED), "NO_FILE_OF_THE_ADVANCED_INDEX_HOLDS_THE_OLD_TEXT").toEqual([]);
    expect(hold.privateIndex?.kind, "THE_NEXT_TURN_REUSES_THE_REBUILT_BASE").toBe("reused");
    return snapshot(indexOf(hold));
  });
  expect(warm, "THE_REBUILT_BASE_EQUALS_A_CLEAN_BUILD").toEqual(await f.oracle());
});

test("the advance drops a base it cannot prove, and the next turn builds from nothing", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  // Not a document: it may be configuration, which decides the masks.
  writeFileSync(join(f.brain, "notes/chart.txt"), "Ithaca lies west.");
  expect(await f.refreshed(), "A_CHANGE_BEYOND_DOCUMENTS_DROPS_THE_BASE").toEqual(["dropped: notes/chart.txt is not a document the index can add"]);
  await turn(f.begin("after"), hold => expect(hold.privateIndex, "THE_NEXT_TURN_BUILDS").toMatchObject({ kind: "built", reason: "no base yet" }));
  // A base changed outside the server is dropped, not advanced.
  const bases = readdirSync(tmpdir()).filter(name => name.startsWith(`brain-private-index-base-${process.pid}-`));
  Bun.spawnSync(["chmod", "u+w", join(tmpdir(), bases[0]!, "brain.db")]); appendFileSync(join(tmpdir(), bases[0]!, "brain.db"), "Polyphemusmarker");
  writeFileSync(join(f.brain, "notes/scheria.md"), NOTE("Scheria", "Nausicaa."));
  expect(await f.refreshed(), "A_TAMPERED_BASE_IS_DROPPED").toEqual(["dropped: the base changed outside the server"]);
  await turn(f.begin("tampered"), hold => {
    expect(bytesHolding(indexOf(hold), "Polyphemusmarker")).toEqual([]);
    expect(hold.privateIndex?.kind).toBe("built");
  });
});

test("changes inside a masked folder advance the base without reaching it", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  writeFileSync(join(f.brain, "me/ithaca.md"), NOTE("Home", `${SENTINEL} waits in Ithaca.`));
  expect(await f.refreshed(), "MASKED_CHANGES_REBIND").toEqual(["rebound"]);
  await turn(f.begin("warm"), hold => {
    expect(bytesHolding(indexOf(hold), SENTINEL), "NO_MASKED_BYTES").toEqual([]);
    expect(hold.privateIndex?.kind).toBe("reused");
  });
});

test("the byte scan finds text whose rows were deleted, and the folded term FTS keeps", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => {
    const dir = mkdtempSync(join(f.root, "control-"));
    for (const name of readdirSync(indexOf(hold))) cpSync(join(indexOf(hold), name), join(dir, name));
    const db = new Database(join(dir, "brain.db"));
    try {
      const { id } = db.query("SELECT id FROM documents WHERE path = 'notes/calypso.md'").get() as { id: number };
      db.run("DELETE FROM chunks WHERE document_id = ?", [id]);
      db.run("DELETE FROM documents WHERE id = ?", [id]);
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(db.query("SELECT COUNT(*) AS n FROM documents WHERE content LIKE ?").get(`%${DOOMED}%`), "ROWS_GONE").toEqual({ n: 0 });
    } finally { db.close(); }
    // Row deletion alone leaves the text in the file: the scan must see it.
    expect(bytesHolding(dir, DOOMED), "DELETED_ROWS_LEAVE_BYTES_THE_SCAN_FINDS").toContain("brain.db");
  });
  const folded = mkdtempSync(join(f.root, "folded-"));
  writeFileSync(join(folded, "segment"), Buffer.from(`\u0000ogygiamark\u0001`, "latin1"));
  expect(bytesHolding(folded, DOOMED), "A_FOLDED_STEMMED_TERM_IS_FOUND").toEqual(["segment"]);
});

test("changes inside a masked folder or an operational-state folder reuse the base and never reach it", async () => {
  const f = fixture();
  mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true });
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  writeFileSync(join(f.brain, ".brain/scratch/plan.md"), NOTE("Plan", `${SENTINEL} in the scratch plan.`));
  writeFileSync(join(f.brain, "me/oath.md"), NOTE("Odysseus's private oath", `${SENTINEL} and ${KNEE} are both his now.`));
  writeFileSync(join(f.brain, "me/ithaca.md"), NOTE("Home", `${SENTINEL} waits in Ithaca.`));
  await turn(f.begin("masked-change"), hold => {
    expect(hold.privateIndex?.kind, "MASKED_CHANGES_REUSE_THE_BASE").toBe("reused");
    expect(bytesHolding(indexOf(hold), SENTINEL), "NO_MASKED_BYTES").toEqual([]);
  });
});

test.each([
  ["the policy", "[{ paths: [me/**], allow: [google] }]", undefined, (f: ReturnType<typeof fixture>) => f.policy("[{ paths: [me/**], allow: [google] }]", "Google alone, and Odysseus says so twice.")],
  ["the masks", "[{ paths: [me/**], allow: [google] }, { paths: [health/**], allow: [anthropic] }]", ANTHROPIC, () => {}],
  ["the recipient", "[{ paths: [me/**], allow: [google] }]", ANTHROPIC, () => {}],
] as const)("a change of %s never reuses another identity's base", async (what, providers, firstOrigin, change) => {
  const f = fixture(providers, { recipients: true });
  const first = firstOrigin ? { inferenceOrigin: firstOrigin } : undefined;
  await turn(f.begin("first", first), hold => {
    expect(hold.privateIndex?.kind).toBe("built");
    if (what === "the masks") expect(bytesHolding(indexOf(hold), KNEE).length, "THE_RECIPIENT_MAY_SEE_HEALTH").toBeGreaterThan(0);
  });
  // Unchanged identity still reuses, so the next result is the change's alone.
  await turn(f.begin("same", first), hold => expect(hold.privateIndex?.kind, "SAME_IDENTITY_REUSES").toBe("reused"));
  change(f);
  await turn(f.begin("changed"), hold => {
    if (what === "the masks") {
      expect(hold.sandbox.providerMasks?.folders).toEqual(["health", "me"]);
      expect(bytesHolding(indexOf(hold), KNEE), "NEWLY_MASKED_TEXT_HAS_NO_BYTES").toEqual([]);
    }
    expect(hold.privateIndex?.kind, `A_CHANGE_OF_${what.toUpperCase().replaceAll(" ", "_")}_REBUILDS`).toBe("built");
  });
});

test("a worker cannot write its turn's private index, and a base changed outside the server is discarded", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => {
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/sh", "-c",
      "printf Polyphemusmarker >> .brain-index/brain.db; printf x > .brain-index/extra"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    // The host keeps it current with the turn's own applications (#2846).
    expect(shell.exitCode, "THE_TURN_INDEX_IS_READ_ONLY").not.toBe(0);
    expect(shell.stderr.toString().match(/Read-only file system/g)?.length, `BOTH_WRITES_REFUSED: ${shell.stderr.toString()}`).toBe(2);
  });
  await turn(f.begin("next"), hold => {
    expect(bytesHolding(indexOf(hold), "Polyphemusmarker"), "NO_WORKER_WRITE_REACHES_THE_NEXT_TURN").toEqual([]);
    expect(hold.privateIndex?.kind, "THE_BASE_SURVIVES_A_WORKER_WRITE").toBe("reused");
    expect(existsSync(join(indexOf(hold), "extra"))).toBe(false);
  });
  const bases = readdirSync(tmpdir()).filter(name => name.startsWith(`brain-private-index-base-${process.pid}-`));
  expect(bases.length, "ONE_HOST_OWNED_BASE").toBe(1);
  // The server's own identity could still reach it; the kernel's change stamps tell.
  const base = join(tmpdir(), bases[0]!), file = join(base, "brain.db");
  Bun.spawnSync(["chmod", "u+w", file]); appendFileSync(file, "Polyphemusmarker");
  await turn(f.begin("tampered"), hold => {
    expect(bytesHolding(indexOf(hold), "Polyphemusmarker"), "NO_TAMPERED_BYTES_REACH_A_TURN").toEqual([]);
    expect(hold.privateIndex, "A_CHANGED_BASE_IS_DISCARDED").toMatchObject({ kind: "built", reason: "the base changed outside the server" });
  });
});

test.each([
  ["the delta helper fails", (async () => ({ candidates: (async function* () {})(), completed: Promise.reject(new Error("send exited 1")) })) as PrivateIndexDiffer],
  ["the delta is truncated", (async (from, to, signal) => {
    const job = fixtureDelta({ uuid: "a1".repeat(16), transaction: "1", entries: inventory(from.root) }, { uuid: "b2".repeat(16), transaction: "2", entries: inventory(to.root) }, "brain");
    const raw = new Uint8Array(await new Response(job.stream).arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw.subarray(0, raw.length - 3)); controller.close(); } });
    return { completed: job.completed, candidates: parseNativeBrainDelta(stream, { signal, before: { uuid: "a1".repeat(16), transaction: 1n }, after: { uuid: "b2".repeat(16), transaction: 2n } }) };
  }) as PrivateIndexDiffer],
  ["the views cannot be compared", (async () => undefined) as PrivateIndexDiffer],
] as const)("incomplete change evidence takes a clean build (%s)", async (_what, differ) => {
  const f = fixture(undefined, { differ });
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  await turn(f.begin("next"), hold => expect(hold.privateIndex?.kind, "UNPROVEN_DELTA_REBUILDS").toBe("built"));
});

// --- Classification of one delta, without the CLI ---------------------------

function views(prepare: (brain: string) => void, change: (brain: string) => void, sealed?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-private-index-delta-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain");
  for (const path of ["notes", "me", ".git", ".brain-index"]) mkdirSync(join(brain, path), { recursive: true });
  writeFileSync(join(brain, "notes/eagle.md"), NOTE("Eagle", "An eagle over Ithaca."));
  writeFileSync(join(brain, "me/oath.md"), NOTE("Oath", SENTINEL));
  prepare(brain);
  const before = createFixtureWorkerStartupView(brain); cleanup.push(() => before.cleanup());
  change(brain);
  const after = createFixtureWorkerStartupView(brain); cleanup.push(() => after.cleanup());
  // A byte copy keeps no hardlink; a Btrfs checkpoint would.
  sealed?.(after.root);
  return { before, after };
}
/** Classify the fixture delta, or, given `stream`, exactly those candidates, as a send stream would name them. */
async function classify(prepare: (brain: string) => void, change: (brain: string) => void, stream?: NativeBrainDeltaCandidate[], sealed?: (root: string) => void) {
  const { before, after } = views(prepare, change, sealed);
  const delta = stream ? undefined : await fixtureDiffer(before, after, new AbortController().signal);
  async function* candidates() { if (delta) yield* delta.candidates; else yield* stream!; }
  return classifyPrivateIndexChanges({ before: before.root, after: after.root, candidates: candidates(), inert: privateIndexInert(["me"], { before: before.root, after: after.root }) });
}
const none = () => {};

test.each([
  ["nothing", none, { kind: "unchanged" }],
  ["the masked folder, the index directory and .git", (brain: string) => {
    writeFileSync(join(brain, "me/new.md"), "x"); writeFileSync(join(brain, ".brain-index/brain.db"), "x"); writeFileSync(join(brain, ".git/HEAD"), "x");
  }, { kind: "unchanged" }],
  ["a new note", (brain: string) => writeFileSync(join(brain, "notes/new.md"), "x"), { kind: "additions", paths: ["notes/new.md"] }],
  ["a new folder of notes and an image", (brain: string) => { mkdirSync(join(brain, "notes/trip")); writeFileSync(join(brain, "notes/trip/a.md"), "x"); writeFileSync(join(brain, "notes/trip/map.PNG"), "x"); },
    { kind: "additions", paths: ["notes/trip/a.md", "notes/trip/map.PNG"] }],
  ["a changed note", (brain: string) => writeFileSync(join(brain, "notes/eagle.md"), "x"), { kind: "rebuild", reason: "notes/eagle.md changed", documents: true }],
  ["a removed note", (brain: string) => rmSync(join(brain, "notes/eagle.md")), { kind: "rebuild", reason: "notes/eagle.md was removed", documents: true }],
  ["a note moved into the masked folder", (brain: string) => renameSync(join(brain, "notes/eagle.md"), join(brain, "me/eagle.md")), { kind: "rebuild", reason: "notes/eagle.md was removed", documents: true }],
  ["a new configuration file", (brain: string) => writeFileSync(join(brain, "brain.config.ts"), "export default {};"), { kind: "rebuild", reason: "brain.config.ts is not a document the index can add" }],
  ["a new operational-state folder", (brain: string) => { mkdirSync(join(brain, ".brain")); writeFileSync(join(brain, ".brain/x.md"), "x"); }, { kind: "rebuild", reason: ".brain/x.md is not a document the index can add" }],
  ["another hidden folder", (brain: string) => { mkdirSync(join(brain, ".config")); writeFileSync(join(brain, ".config/types.ts"), "x"); }, { kind: "rebuild", reason: ".config/types.ts is not a document the index can add" }],
  ["a folder's permissions", (brain: string) => Bun.spawnSync(["chmod", "700", join(brain, "notes")]), { kind: "rebuild", reason: "who may read notes changed" }],
  ["the root's permissions", (brain: string) => Bun.spawnSync(["chmod", "750", brain]), { kind: "rebuild", reason: "who may read the brain root changed" }],
  ["a hidden file at the root", (brain: string) => writeFileSync(join(brain, ".gitignore"), "x"), { kind: "rebuild", reason: ".gitignore is not a document the index can add" }],
] as const)("a delta classifies %s", async (_what, change, expected) => {
  expect(await classify(none, change), "DELTA_CLASSIFIED").toEqual(expected as PrivateIndexChanges);
});

test("changes under an operational-state folder present in both views are inert, since the build hides it", async () => {
  const scratch = (brain: string) => { mkdirSync(join(brain, ".brain/scratch"), { recursive: true }); mkdirSync(join(brain, ".brain-ui/inbox"), { recursive: true }); };
  expect(await classify(scratch, brain => { writeFileSync(join(brain, ".brain/scratch/plan.md"), "x"); writeFileSync(join(brain, ".brain/state.json"), "x"); writeFileSync(join(brain, ".brain-ui/inbox/item.md"), "x"); }),
    "STATE_FOLDER_CHANGES_INERT").toEqual({ kind: "unchanged" });
  // An extended attribute (an ACL) on a directory changes who may read it.
  expect(await classify(none, none, [{ paths: ["notes"], xattr: "notes" }]), "DIRECTORY_ACL_REBUILDS").toEqual({ kind: "rebuild", reason: "who may read notes changed" });
  expect(await classify(none, none, [{ paths: [], xattr: "" }]), "ROOT_ACL_REBUILDS").toEqual({ kind: "rebuild", reason: "who may read the brain root changed" });
  // Replaced by a link, it would no longer be hidden: the build could follow it.
  expect(await classify(scratch, brain => { rmSync(join(brain, ".brain"), { recursive: true }); mkdirSync(join(brain, "notes/x")); symlinkSync("notes/x", join(brain, ".brain")); }),
    "HIDDEN_FOLDER_REPLACED_BY_A_LINK_REBUILDS").toEqual({ kind: "rebuild", reason: ".brain changed" });
});

test("the build hides the operational-state folders a view has, outermost only", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-private-index-folders-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [".brain/private", ".brain-ui", ".config", "me", "notes"]) mkdirSync(join(root, path), { recursive: true });
  expect(privateIndexBuildFolders(["me", ".brain/private"], root), "STATE_FOLDERS_MASKED_IN_THE_BUILD").toEqual([".brain", ".brain-ui", "me"]);
  rmSync(join(root, ".brain-ui"), { recursive: true }); writeFileSync(join(root, ".brain-ui"), "x");
  expect(privateIndexBuildFolders(["me"], root), "ONLY_DIRECTORIES").toEqual([".brain", "me"]);
});

test("a delta naming one name of a file with two takes a clean build", async () => {
  // The stream names an inode once; its other name may be anywhere, masked folders included.
  const linked = await classify(none, brain => writeFileSync(join(brain, "notes/eagle-2.md"), "x"), undefined, root => {
    rmSync(join(root, "notes/eagle-2.md")); linkSync(join(root, "me/oath.md"), join(root, "notes/eagle-2.md"));
  });
  expect(linked, "SECOND_NAME_REBUILDS").toEqual({ kind: "rebuild", reason: "notes/eagle-2.md has another name" });
});

test("a renamed directory is expanded in both roots, so text that leaves the view rebuilds", async () => {
  // A send stream names only the directory; its contents move with it unnamed.
  const trip = (folder: string) => (brain: string) => { mkdirSync(join(brain, `${folder}/trip`)); writeFileSync(join(brain, `${folder}/trip/a.md`), "x"); };
  const rename = (from: string, to: string): NativeBrainDeltaCandidate[] => [{ paths: [from, to], rename: { from, to } }];
  const moved = await classify(trip("notes"), brain => renameSync(join(brain, "notes/trip"), join(brain, "me/trip")), rename("notes/trip", "me/trip"));
  expect(moved, "DIRECTORY_MOVED_INTO_MASKS_REBUILDS").toEqual({ kind: "rebuild", reason: "notes/trip was removed" });
  // Out of the masks: its contents are new to the view, and nothing leaves it.
  const revealed = await classify(trip("me"), brain => renameSync(join(brain, "me/trip"), join(brain, "notes/trip")), rename("me/trip", "notes/trip"));
  expect(revealed, "DIRECTORY_MOVED_OUT_OF_MASKS_ADDS").toEqual({ kind: "additions", paths: ["notes/trip/a.md"] });
  // Replaced under the same name, reported as a move to a temporary name.
  const swapped = await classify(trip("notes"), brain => { rmSync(join(brain, "notes/trip"), { recursive: true }); mkdirSync(join(brain, "notes/trip")); },
    rename("notes/trip", "o257-1-0"));
  expect(swapped, "REPLACED_DIRECTORY_REBUILDS").toEqual({ kind: "rebuild", reason: "notes/trip/a.md was removed", documents: true });
});

test("the cache identity covers the brain, policy, masks, recipient, mask paths and build command", () => {
  const identity: PrivateIndexIdentity = { brain: "/srv/odysseus", policyHash: "a".repeat(64), folders: ["me", "vault"], recipient: "anthropic", maskPaths: ["/state"], command: ["brain"] };
  const key = privateIndexCacheKey(identity);
  expect(privateIndexCacheKey({ ...identity, folders: ["vault", "me"] }), "FOLDER_ORDER_IS_NOT_IDENTITY").toBe(key);
  const changes: [string, Partial<PrivateIndexIdentity>][] = [["brain", { brain: "/srv/penelope" }], ["policy", { policyHash: "b".repeat(64) }],
    ["masks", { folders: ["me"] }], ["recipient", { recipient: "google" }], ["no recipient", { recipient: undefined }],
    ["mask paths", { maskPaths: [] }], ["command", { command: ["brain", "--other"] }]];
  for (const [what, change] of changes) expect(privateIndexCacheKey({ ...identity, ...change }), `KEY_COVERS_${what.toUpperCase().replaceAll(" ", "_")}`).not.toBe(key);
});

/** A cache over a tiny copied brain whose builds write one file; `gate` holds every delta. */
function bench(options: { entries?: number; idleMs?: number; report?: (message: string) => void } = {}) {
  privateTmp();
  const root = mkdtempSync(join(tmpdir(), "odysseus-private-index-bound-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "brain/notes"), { recursive: true }); writeFileSync(join(root, "brain/notes/eagle.md"), "x");
  const state = { gate: Promise.resolve(), holdRuns: false, acquired: 0, failAcquire: false };
  const cache = createPrivateIndexCache({ report: options.report ?? (() => {}), entries: options.entries ?? 2, idleMs: options.idleMs ?? 200,
    differ: async (from, to, signal) => {
      // A held delta still ends when the cache closes, as the native one does.
      await Promise.race([state.gate, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      return fixtureDiffer(from, to, signal);
    } });
  cleanup.push(() => cache.close());
  const views: startup.WorkerStartupView[] = [];
  const runner = (stdout: string) => (_view: startup.WorkerStartupView, index: string, signal: AbortSignal) => ({
    build: async () => { writeFileSync(join(index, "brain.db"), "rebuilt"); return { ok: true as const }; },
    update: async () => {
      // A held run ends only when its signal does, as a killed worker would.
      if (state.holdRuns) { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return { ok: false as const, detail: "killed" }; }
      appendFileSync(join(index, "brain.db"), "+added"); return { ok: true as const, stdout };
    } });
  const prepare = async (policyHash: string, input: { partial?: boolean; maskPaths?: string[]; stdout?: string } = {}) => {
    const view = retainableFixtureView(join(root, "brain")); views.push(view);
    const index = mkdtempSync(join(root, "index-"));
    try {
      return await cache.prepare({ identity: { brain: root, policyHash, folders: ["me"], maskPaths: input.maskPaths ?? [], command: ["brain"] }, startupView: view, index,
        signal: new AbortController().signal, update: async () => ({ ok: false, detail: "unused" }),
        runner: runner(input.stdout ?? '{"updated":0,"deleted":0,"added":1}'),
        build: async () => { writeFileSync(join(index, "brain.db"), policyHash); return input.partial ? { ok: false, detail: "timed out" } : { ok: true }; } });
    } finally { await view.cleanup(); rmSync(index, { recursive: true, force: true }); }
  };
  const live = (view: startup.WorkerStartupView) => existsSync(view.root);
  const bases = () => readdirSync(tmpdir()).filter(name => name.startsWith(`brain-private-index-base-${process.pid}-`));
  const advance = () => cache.advance(async signal => {
    signal.throwIfAborted(); state.acquired++;
    if (state.failAcquire) throw new Error("the manager is busy");
    const view = retainableFixtureView(join(root, "brain")); views.push(view); return view;
  });
  return { root, cache, views, prepare, live, bases, state, advance };
}

test("the cache keeps a bounded number of bases and releases their checkpoints on eviction, idle expiry and close", async () => {
  const { cache, views, prepare, live, bases } = bench();
  expect((await prepare("one")).kind).toBe("built");
  expect((await prepare("two")).kind).toBe("built");
  expect(views.map(live), "EACH_BASE_RETAINS_ITS_CHECKPOINT").toEqual([true, true]);
  expect((await prepare("three")).kind).toBe("built");
  expect(views.map(live), "THE_LEAST_RECENT_BASE_IS_EVICTED").toEqual([false, true, true]);
  expect((await prepare("three")).kind, "A_KEPT_BASE_IS_REUSED").toBe("reused");
  expect(views.map(live), "REUSE_MOVES_THE_BASE_TO_THE_NEWER_CHECKPOINT").toEqual([false, true, false, true]);
  await Bun.sleep(400);
  expect(views.map(live), "IDLE_BASES_RELEASE_THEIR_CHECKPOINTS").toEqual([false, false, false, false]);
  expect((await prepare("two")).kind, "AN_EXPIRED_BASE_REBUILDS").toBe("built");
  await cache.close();
  expect(views.map(live), "CLOSE_RELEASES_EVERY_CHECKPOINT").toEqual([false, false, false, false, false]);
  expect(bases(), "CLOSE_REMOVES_EVERY_BASE").toEqual([]);
});

test("concurrent keys keep the bound, and a base a turn is reconciling is neither evicted nor expired under it", async () => {
  const b = bench({ entries: 1, idleMs: 150 });
  expect((await b.prepare("one")).kind).toBe("built");
  let release!: () => void;
  b.state.gate = new Promise<void>(resolve => { release = resolve; });
  const slow = b.prepare("one");
  // Two other keys build and seal while "one" is being reconciled, and its
  // idle time runs out.
  expect((await Promise.all([b.prepare("two"), b.prepare("three")])).map(outcome => outcome.kind)).toEqual(["built", "built"]);
  await Bun.sleep(300);
  expect(b.live(b.views[0]!), "AN_ACTIVE_BASE_IS_NEITHER_EVICTED_NOR_EXPIRED").toBe(true);
  release();
  expect((await slow).kind, "THE_ACTIVE_BASE_STAYS_USABLE").toBe("reused");
  expect(b.bases().length, "THE_BOUND_HOLDS_ONCE_TURNS_FINISH").toBe(1);
});

test("an expiry skipped while a turn reconciles applies once that turn finishes", async () => {
  const b = bench({ idleMs: 150 });
  expect((await b.prepare("one")).kind).toBe("built");
  writeFileSync(join(b.root, "brain/notes/chart.txt"), "x");
  let release!: () => void;
  b.state.gate = new Promise<void>(resolve => { release = resolve; });
  // This turn rebuilds and gets only a partial index, so it never renews the base.
  const slow = b.prepare("one", { partial: true });
  await Bun.sleep(300);
  expect(b.live(b.views[0]!), "NOT_EXPIRED_WHILE_ACTIVE").toBe(true);
  release();
  expect((await slow).kind).toBe("partial");
  expect(b.live(b.views[0]!), "THE_SKIPPED_EXPIRY_APPLIES_AFTERWARDS").toBe(false);
  expect(b.bases(), "NO_BASE_OUTLIVES_ITS_EXPIRY").toEqual([]);
});

test("bases are kept only where no worker can see them, and a crashed server's are swept", async () => {
  const reports: string[] = [];
  const outside = mkdtempSync(join(REPO, "tmp", "odysseus-visible-tmp-")); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  const b = bench({ report: message => reports.push(message) });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = outside;
  try {
    expect((await b.prepare("one")).kind).toBe("built");
    expect(await b.prepare("one"), "NO_BASE_ON_A_WORKER_VISIBLE_TMPDIR").toMatchObject({ kind: "built", reason: "no hidden place to keep a base" });
    expect(readdirSync(outside).filter(name => name.startsWith("brain-private-index-base-")), "NOTHING_KEPT_THERE").toEqual([]);
    expect(reports.filter(report => report.startsWith("private index cache disabled")).length, "REPORTED_ONCE").toBe(1);
    // A masked operational-state path is hidden from every worker.
    expect((await b.prepare("two", { maskPaths: [outside] })).kind).toBe("built");
    expect((await b.prepare("two", { maskPaths: [outside] })).kind, "A_MASKED_PARENT_KEEPS_BASES").toBe("reused");
  } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  // A base whose server process is gone is removed by the next cache that looks; a live one stays.
  const sweeper = bench();
  const dead = Bun.spawnSync(["/bin/true"]).pid, orphan = join(tmpdir(), `brain-private-index-base-${dead}-odysseus`);
  const alive = join(tmpdir(), `brain-private-index-base-${process.ppid}-odysseus`);
  for (const dir of [orphan, alive]) mkdirSync(dir);
  expect((await sweeper.prepare("one")).kind).toBe("built");
  expect(existsSync(orphan), "A_DEAD_SERVERS_BASE_IS_SWEPT").toBe(false);
  expect(existsSync(alive), "A_LIVE_SERVERS_BASE_STAYS").toBe(true);
});

test("a turn arriving during an advance waits for it and reuses what it made", async () => {
  const b = bench();
  expect((await b.prepare("one")).kind).toBe("built");
  writeFileSync(join(b.root, "brain/notes/scheria.md"), "x");
  let release!: () => void;
  b.state.gate = new Promise<void>(resolve => { release = resolve; });
  const advancing = b.advance();
  await Bun.sleep(50);
  const arriving = b.prepare("one");
  await Bun.sleep(100);
  release();
  expect((await advancing).map(result => result.kind), "THE_ADVANCE_UPDATES").toEqual(["updated"]);
  expect((await arriving).kind, "THE_TURN_REUSES_THE_ADVANCED_BASE").toBe("reused");
  expect(readFileSync(join(tmpdir(), b.bases()[0]!, "brain.db"), "utf8"), "THE_ADVANCED_BASE_IS_THE_UPDATE").toBe("one+added");
});

test("an advance whose update rewrote rows keeps the old base, and close stops an advance in flight", async () => {
  const b = bench();
  expect((await b.prepare("one", { stdout: '{"updated":1,"deleted":0,"added":1}' })).kind).toBe("built");
  writeFileSync(join(b.root, "brain/notes/scheria.md"), "x");
  expect(await b.advance(), "UNPROVED_UPDATES_ARE_NOT_PROMOTED").toMatchObject([{ kind: "kept", reason: "the incremental index changed existing rows" }]);
  expect(readFileSync(join(tmpdir(), b.bases()[0]!, "brain.db"), "utf8"), "THE_OLD_BASE_STAYS").toBe("one");
  expect(b.live(b.views[0]!), "STILL_BOUND_TO_ITS_OWN_CHECKPOINT").toBe(true);
  b.state.gate = new Promise<void>(() => {});
  const stuck = b.advance();
  await Bun.sleep(50);
  await b.cache.close();
  expect(await stuck, "CLOSE_ENDS_THE_ADVANCE").toMatchObject([{ kind: "kept", reason: "closing" }]);
  expect(b.views.map(b.live), "CLOSE_RELEASES_EVERY_CHECKPOINT").toEqual(b.views.map(() => false));
  expect(b.bases(), "CLOSE_REMOVES_EVERY_BASE_AND_STAGING").toEqual([]);
});

test("advances share one checkpoint, move bases without renewing them, and fail safe without one", async () => {
  const reports: string[] = [];
  const b = bench({ idleMs: 1500, report: message => reports.push(message) });
  expect((await b.prepare("one")).kind).toBe("built");
  expect((await b.prepare("two")).kind).toBe("built");
  expect((await b.advance()).map(result => result.kind), "BOTH_BASES_ADVANCE").toEqual(["rebound", "rebound"]);
  expect(b.state.acquired, "ONE_CHECKPOINT_FOR_EVERY_BASE").toBe(1);
  expect(b.views.slice(0, 2).map(b.live), "A_REBOUND_BASE_RELEASES_ITS_OLD_CHECKPOINT_AT_ONCE").toEqual([false, false]);
  // Advancing is not using: a base no turn uses still expires, rebound or
  // promoted just before its time.
  await Bun.sleep(900);
  writeFileSync(join(b.root, "brain/notes/scheria.md"), "x");
  expect((await b.advance()).map(result => result.kind), "PROMOTED_TOO").toEqual(["updated", "updated"]);
  await Bun.sleep(800);
  await b.advance();
  expect(b.bases(), "UNUSED_BASES_EXPIRE_THROUGH_ADVANCES").toEqual([]);
  expect(b.views.map(b.live).filter(Boolean), "AND_RELEASE_THEIR_CHECKPOINTS").toEqual([]);
  expect((await b.prepare("four")).kind).toBe("built");
  await Bun.sleep(900);
  expect((await b.advance()).map(result => result.kind)).toEqual(["rebound"]);
  await Bun.sleep(800);
  await b.advance();
  expect(b.bases(), "A_REBOUND_BASE_IS_NOT_RENEWED").toEqual([]);
  // No checkpoint: the bases stay as they are, bound to their own.
  expect((await b.prepare("three")).kind).toBe("built");
  b.state.failAcquire = true;
  expect(await b.advance(), "NO_CHECKPOINT_NO_ADVANCE").toEqual([]);
  expect(reports.some(report => report.includes("the manager is busy")), "REPORTED").toBe(true);
  expect(b.bases().length, "THE_BASE_STAYS").toBe(1);
});

test("close stops an advance whose build is running", async () => {
  const b = bench();
  expect((await b.prepare("one")).kind).toBe("built");
  writeFileSync(join(b.root, "brain/notes/scheria.md"), "x");
  b.state.holdRuns = true;
  const running = b.advance();
  await Bun.sleep(100);
  await b.cache.close();
  expect(await running, "THE_RUN_IS_STOPPED").toMatchObject([{ kind: "kept", reason: "the incremental index failed: killed" }]);
  expect(b.bases(), "NOTHING_IS_KEPT").toEqual([]);
});

test("an external build command is identified by its files, not only its name", () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-private-index-command-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "brain"); writeFileSync(cli, "one");
  const identity: PrivateIndexIdentity = { brain: "/srv/odysseus", policyHash: null, folders: ["me"], maskPaths: [], command: [cli] };
  const key = privateIndexCacheKey(identity);
  expect(privateIndexCacheKey(identity), "STABLE").toBe(key);
  rmSync(cli); writeFileSync(cli, "two");
  expect(privateIndexCacheKey(identity), "A_REPLACED_COMMAND_IS_ANOTHER_IDENTITY").not.toBe(key);
});
