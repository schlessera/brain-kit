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
import { classifyPrivateIndexChanges, createPrivateIndexCache, privateIndexCacheKey, privateIndexInert, type PrivateIndexChanges, type PrivateIndexDiffer, type PrivateIndexIdentity } from "../src/brain/private-index-cache";
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
  const create = (differ?: PrivateIndexDiffer) => {
    const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution,
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
  return { root, brain, turns, begin, oracle, reports, policy };
}

const indexOf = (hold: GovernedTurnHold) => hold.sandbox.providerMasks!.index!;

/** Every file of an index directory that holds `word` anywhere in its bytes: rows, free pages, FTS segments or WAL. */
function bytesHolding(dir: string, word: string): string[] {
  return readdirSync(dir).filter(name => readFileSync(join(dir, name)).includes(word));
}

/** What a search can return from an index, independent of row ids and build times. */
function snapshot(dir: string) {
  const db = new Database(join(dir, "brain.db"));
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
    expect(hold.privateIndex, "WARM_TURN_REUSES_THE_BASE").toEqual({ kind: "reused" });
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
    expect(hold.privateIndex, "AN_ADDITION_UPDATES_THE_BASE").toEqual({ kind: "updated", added: 1 });
    expect(search(f.brain, hold, "Scheria"), "THE_ADDED_DOCUMENT_IS_FOUND").toContain("notes/voyages/scheria.md");
    expect(bytesHolding(indexOf(hold), SENTINEL)).toEqual([]);
    return snapshot(indexOf(hold));
  });
  expect(updated, "UPDATED_INDEX_EQUALS_A_CLEAN_BUILD").toEqual(await f.oracle());
  // The updated base is bound to the newer checkpoint.
  await turn(f.begin("after"), hold => expect(hold.privateIndex, "THE_UPDATED_BASE_IS_REUSED").toEqual({ kind: "reused" }));
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

test("changes inside a masked folder or a hidden folder reuse the base and never reach it", async () => {
  const f = fixture();
  mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true });
  await turn(f.begin("first"), hold => expect(hold.privateIndex?.kind).toBe("built"));
  writeFileSync(join(f.brain, ".brain/scratch/plan.md"), NOTE("Plan", `${SENTINEL} in the scratch plan.`));
  writeFileSync(join(f.brain, "me/oath.md"), NOTE("Odysseus's private oath", `${SENTINEL} and ${KNEE} are both his now.`));
  writeFileSync(join(f.brain, "me/ithaca.md"), NOTE("Home", `${SENTINEL} waits in Ithaca.`));
  await turn(f.begin("masked-change"), hold => {
    expect(hold.privateIndex, "MASKED_CHANGES_REUSE_THE_BASE").toEqual({ kind: "reused" });
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

test("a worker's writes stay in its own copy, and a base changed outside the server is discarded", async () => {
  const f = fixture();
  await turn(f.begin("first"), hold => {
    const shell = Bun.spawnSync(workerCommand({ brainPath: f.brain, sandbox: hold.sandbox, env: { PATH }, command: ["/bin/sh", "-c",
      "printf Polyphemusmarker >> .brain-index/brain.db && printf x > .brain-index/extra"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(shell.exitCode, `THE_TURN_INDEX_IS_WRITABLE: ${shell.stderr.toString()}`).toBe(0);
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
    expect(hold.privateIndex, "A_CHANGED_BASE_IS_DISCARDED").toEqual({ kind: "built", reason: "the base changed outside the server" });
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
  ["a changed note", (brain: string) => writeFileSync(join(brain, "notes/eagle.md"), "x"), { kind: "rebuild", reason: "notes/eagle.md changed" }],
  ["a removed note", (brain: string) => rmSync(join(brain, "notes/eagle.md")), { kind: "rebuild", reason: "notes/eagle.md was removed" }],
  ["a note moved into the masked folder", (brain: string) => renameSync(join(brain, "notes/eagle.md"), join(brain, "me/eagle.md")), { kind: "rebuild", reason: "notes/eagle.md was removed" }],
  ["a new configuration file", (brain: string) => writeFileSync(join(brain, "brain.config.ts"), "export default {};"), { kind: "rebuild", reason: "brain.config.ts is not a document the index can add" }],
  ["a new hidden folder", (brain: string) => { mkdirSync(join(brain, ".brain")); writeFileSync(join(brain, ".brain/x.md"), "x"); }, { kind: "rebuild", reason: ".brain/x.md is not a document the index can add" }],
  ["a hidden file at the root", (brain: string) => writeFileSync(join(brain, ".gitignore"), "x"), { kind: "rebuild", reason: ".gitignore is not a document the index can add" }],
] as const)("a delta classifies %s", async (_what, change, expected) => {
  expect(await classify(none, change), "DELTA_CLASSIFIED").toEqual(expected as PrivateIndexChanges);
});

test("changes under a hidden folder present in both views are inert, since the build hides it", async () => {
  const scratch = (brain: string) => mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  expect(await classify(scratch, brain => { writeFileSync(join(brain, ".brain/scratch/plan.md"), "x"); writeFileSync(join(brain, ".brain/state.json"), "x"); }),
    "HIDDEN_FOLDER_CHANGES_INERT").toEqual({ kind: "unchanged" });
  // Replaced by a link, it would no longer be hidden: the build could follow it.
  expect(await classify(scratch, brain => { rmSync(join(brain, ".brain"), { recursive: true }); mkdirSync(join(brain, "notes/x")); symlinkSync("notes/x", join(brain, ".brain")); }),
    "HIDDEN_FOLDER_REPLACED_BY_A_LINK_REBUILDS").toEqual({ kind: "rebuild", reason: ".brain changed" });
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
  expect(swapped, "REPLACED_DIRECTORY_REBUILDS").toEqual({ kind: "rebuild", reason: "notes/trip/a.md was removed" });
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

test("the cache keeps a bounded number of bases and releases their checkpoints on eviction, idle expiry and close", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-private-index-bound-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "brain/notes"), { recursive: true }); writeFileSync(join(root, "brain/notes/eagle.md"), "x");
  const cache = createPrivateIndexCache({ differ: fixtureDiffer, report() {}, entries: 2, idleMs: 200 });
  const views: startup.WorkerStartupView[] = [];
  const prepare = async (policyHash: string) => {
    const view = retainableFixtureView(join(root, "brain")); views.push(view);
    const index = mkdtempSync(join(root, "index-"));
    try {
      return await cache.prepare({ identity: { brain: root, policyHash, folders: ["me"], maskPaths: [], command: ["brain"] }, startupView: view, index,
        signal: new AbortController().signal, build: async () => { writeFileSync(join(index, "brain.db"), policyHash); return { ok: true }; },
        update: async () => ({ ok: false, detail: "unused" }) });
    } finally { await view.cleanup(); rmSync(index, { recursive: true, force: true }); }
  };
  const live = (view: (typeof views)[number]) => existsSync(view.root);
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
  expect(readdirSync(tmpdir()).filter(name => name.startsWith(`brain-private-index-base-${process.pid}-`)), "CLOSE_REMOVES_EVERY_BASE").toEqual([]);
});
