import { expectRejection } from "./helpers/expect-rejection.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CODE_CHANGE_PROGRAM } from "../src/brain/code-change-program.js";

const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args], { env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}
function fixture(format = "sha1") {
  const root = mkdtempSync("/var/tmp/odysseus-code-receipt-"), checkout = join(root, "checkout");
  mkdirSync(checkout); git(checkout, "init", "--object-format=" + format, "-q", "-b", "main");
  writeFileSync(join(checkout, "chart.md"), "Ithaca\n"); writeFileSync(join(checkout, "lost.md"), "Troy\n");
  writeFileSync(join(checkout, ".gitignore"), "build/\n");
  git(checkout, "add", "."); git(checkout, "commit", "-qm", "Set sail");
  return { root, checkout, close: () => rmSync(root, { recursive: true, force: true }) };
}
function capture(checkout: string, previous?: unknown) {
  const result = Bun.spawnSync(["python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, checkout, String(16 * 1024 * 1024)], { env, stdin: Buffer.from(JSON.stringify(previous ?? {})) });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}
test("receipt captures tracked edits, deletion and untracked files, excluding ignored output", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, "chart.md"), "Scheria\n"); unlinkSync(join(f.checkout, "lost.md"));
    writeFileSync(join(f.checkout, "new.md"), "The raft\n"); mkdirSync(join(f.checkout, "build"));
    writeFileSync(join(f.checkout, "build", "out.js"), "generated\n");
    const receipt = capture(f.checkout);
    expect(receipt.paths, "CODE_RECEIPT_EXACT_DIFF").toEqual([
      { path: "chart.md", kind: "modified", untracked: false },
      { path: "lost.md", kind: "deleted", untracked: false },
      { path: "new.md", kind: "added", untracked: true },
    ]);
    expect(receipt.ignore_changed).toBe(false);
    expect(receipt.tree_after).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.pack.length).toBeGreaterThan(0);
  } finally { f.close(); }
});

test("gitignore changes remain visible when they hide a new file", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, ".gitignore"), "build/\nhidden.md\n");
    writeFileSync(join(f.checkout, "hidden.md"), "Regenerable\n");
    const receipt = capture(f.checkout);
    expect(receipt.paths, "IGNORE_RULE_CHANGE_IS_REVIEWABLE").toEqual([{ path: ".gitignore", kind: "modified", untracked: false }]);
    expect(receipt.ignore_changed).toBe(true);
  } finally { f.close(); }
});

test("checkout hooks, filter programs and fsmonitor never run during capture", () => {
  const f = fixture();
  try {
    const canary = join(f.root, "executed");
    git(f.checkout, "config", "core.fsmonitor", `touch ${canary}`);
    git(f.checkout, "config", "filter.odyssey.clean", `touch ${canary}`);
    git(f.checkout, "config", "core.hooksPath", join(f.checkout, ".git/hooks"));
    writeFileSync(join(f.checkout, ".git/hooks/post-index-change"), `#!/bin/sh\ntouch '${canary}'\n`, { mode: 0o755 });

    writeFileSync(join(f.checkout, "chart.md"), "Scheria\n");
    expect(capture(f.checkout).paths).toContainEqual({ path: "chart.md", kind: "modified", untracked: false });
    expect(existsSync(canary), "GIT_PROGRAM_CANARY_NEVER_EXECUTED").toBe(false);
    writeFileSync(join(f.checkout, ".git/info/attributes"), "*.md filter=odyssey\n");
    const filtered = Bun.spawnSync(["python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, f.checkout, String(16 * 1024 * 1024)], { env, stdin: Buffer.from("{}") });
    expect(filtered.exitCode, "FILTER_CHECKOUT_REMAINS_RESTRICTED").not.toBe(0);
    expect(filtered.stderr.toString()).toContain("Filter and encoding receipts are unsupported");
    expect(existsSync(canary), "FILTER_PROGRAM_NEVER_EXECUTED").toBe(false);
  } finally { f.close(); }
});

import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { renameSync } from "node:fs";

test("durable checkout receipt replaces checkout rows while notes keep byte before-images", async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db");
  mkdirSync(join(brain, "workspaces"), { recursive: true });
  const checkout = join(brain, "workspaces", "argo"); renameSync(f.checkout, checkout);
  writeFileSync(join(brain, "note.md"), "Ithaca\n");
  const native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain);
  const db = createUiDb(dbPath), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance } });
  try {
    await journal.begin("sail", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null, workspaceReadOnly: false }, () => {});
    expect(journal.details("ithaca", "sail")?.codeChanges?.[0]?.state, "COVERAGE_STARTS_AFTER_DURABLE_RECEIPT").toBe("recording");
    writeFileSync(join(checkout, "chart.md"), "Scheria\n"); writeFileSync(join(brain, "note.md"), "Return to Ithaca\n");
    await journal.observe(); await journal.finish("sail");
    const details = journal.details("ithaca", "sail")!;
    expect(details.changes.map(item => item.path), "CHECKOUT_HAS_NO_FILE_ROWS").toEqual(["note.md"]);
    expect(details.changes[0]!.before?.hash, "NOTE_BEFORE_IMAGE_RETAINED").toBeString();
    expect(details.codeChanges, "ONE_COMPLETE_RECEIPT_PER_CHECKOUT").toHaveLength(1);
    expect(details.codeChanges![0]).toMatchObject({ state: "complete", paths: [{ path: "chart.md", kind: "modified", untracked: false }] });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs r JOIN turn_journal_code_receipts c ON r.hash=c.pack_hash AND r.turn_id=c.turn_id").get()).toEqual({ n: 1 });
  } finally { await journal.close(); maintenance.cleanup(); await native.close(); db.close(); f.close(); }
});

import { readFileSync, existsSync } from "node:fs";
import { CODE_CHANGE_PREVIEW_PROGRAM } from "../src/brain/code-change-program.js";
test("owned endpoint pack previews after checkout removal, and revert requires the exact fresh tree", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, "chart.md"), "Scheria\n");
    writeFileSync(join(f.checkout, "new.md"), "The raft\n"); unlinkSync(join(f.checkout, "lost.md"));
    const receipt = capture(f.checkout);
    writeFileSync(join(f.checkout, "chart.md"), "Later owner edit\n");
    const conflict = capture(f.checkout, { ...receipt, operation: "revert", expected_tree: receipt.tree_after });
    expect(conflict.status, "REVERT_REFUSES_LATER_TREE").toBe("conflict");
    expect(conflict.current.tree_after).not.toBe(receipt.tree_after);
    expect(conflict.currentPreview, "CONFLICT_SHOWS_ACTUAL_CURRENT_BYTES").toMatchObject({ inline: true, diff: expect.stringContaining("Later owner edit") });
    expect(readFileSync(join(f.checkout, "chart.md"), "utf8")).toBe("Later owner edit\n");
    writeFileSync(join(f.checkout, "chart.md"), "Scheria\n");
    expect(capture(f.checkout, { ...receipt, operation: "revert", expected_tree: receipt.tree_after }).status, "REVERT_RESTORES_EXACT_ENDPOINT").toBe("restored");
    expect(readFileSync(join(f.checkout, "chart.md"), "utf8")).toBe("Ithaca\n");
    expect(readFileSync(join(f.checkout, "lost.md"), "utf8")).toBe("Troy\n");
    expect(existsSync(join(f.checkout, "new.md"))).toBe(false);
    rmSync(f.checkout, { recursive: true });
    const preview = Bun.spawnSync(["python3", "-I", "-S", "-c", CODE_CHANGE_PREVIEW_PROGRAM], { env, stdin: Buffer.from(JSON.stringify(receipt)) });
    expect(preview.exitCode, preview.stderr.toString()).toBe(0);
    expect(JSON.parse(preview.stdout.toString()), "OWNED_ENDPOINTS_SURVIVE_SOURCE_DELETION").toMatchObject({ inline: true, diff: expect.stringContaining("+Scheria") });
  } finally { f.close(); }
});

test("index-added files are tracked while new files remain untracked", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, "staged.md"), "Athena\n"); git(f.checkout, "add", "staged.md");
    writeFileSync(join(f.checkout, "new.md"), "Penelope\n");
    expect(capture(f.checkout).paths, "INDEX_TRACKING_IS_PRESERVED").toEqual([
      { path: "new.md", kind: "added", untracked: true }, { path: "staged.md", kind: "added", untracked: false },
    ]);
  } finally { f.close(); }
});

import { launchFixtureAgentWorker, prepareFixtureWorkerSandbox } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
test("a sandboxed worker cannot read or write receipt storage or its endpoint packs", async () => {
  const f = fixture(), brain = join(f.root, "brain"), evidence = join(f.root, "private-evidence");
  mkdirSync(brain); mkdirSync(evidence); writeFileSync(join(evidence, "endpoint.pack"), "owned endpoints");
  const database = join(evidence, "journal.db"); writeFileSync(database, "receipt rows");
  const sandbox = prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [], maskPaths: [evidence] });
  try {
    const program = `import {readFileSync,writeFileSync} from "node:fs";const attempt=fn=>{try{fn();return true}catch{return false}};console.log(JSON.stringify([${JSON.stringify(database)},${JSON.stringify(join(evidence, "endpoint.pack"))}].map(path=>[attempt(()=>readFileSync(path)),attempt(()=>writeFileSync(path,"changed"))])));`;
    const worker = launchFixtureAgentWorker({ brainPath: brain, sandbox, env: {}, command: [process.execPath, "--no-env-file", "-e", program] });
    worker.stdin.end();
    const [code, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout as any).text(), new Response(worker.stderr as any).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout), "WORKER_CANNOT_REACH_RECEIPT_OR_ENDPOINTS").toEqual([[false, false], [false, false]]);
    expect(readFileSync(database, "utf8")).toBe("receipt rows");
    expect(readFileSync(join(evidence, "endpoint.pack"), "utf8")).toBe("owned endpoints");
  } finally { f.close(); }
});

for (const phase of ["before", "after"] as const) test(`process crash ${phase} receipt coverage preserves the durable boundary`, async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db");
  mkdirSync(join(brain, "workspaces"), { recursive: true }); renameSync(f.checkout, join(brain, "workspaces", "argo"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/code-receipt-crash.ts"), f.root, phase], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).not.toBe(0);
    if (phase === "after") expect(stdout, "EXCLUSION_REQUIRES_COMMITTED_RECEIPT_AND_PINNED_PACK").toContain("EXCLUSION_HAS_COMMITTED_RECEIPT_AND_PINNED_PACK");
    expect(child.signalCode, "RECEIPT_CRASH_IS_SIGKILL").toBe("SIGKILL");
    expect(stdout, "RECEIPT_CRASH_REACHED_EXACT_BARRIER").toContain(`CRASH_POINT ${phase}`);
    const db = createUiDb(dbPath), native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain);
    const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance } });
    try {
      await journal.ready;
      const details = journal.details("ithaca", "crash-sail")!;
      expect(details.summary.state, "INTERRUPTED_CODE_TURN_IS_NEVER_CLEAN").toBe("partial");
      expect(details.codeChanges?.length ?? 0, "COVERAGE_NEVER_PRECEDES_DURABLE_ENDPOINTS").toBe(phase === "after" ? 1 : 0);
      if (phase === "after") {
        expect(details.codeChanges![0]!.state).toBe("partial");
        rmSync(join(brain, "workspaces", "argo"), { recursive: true });
        expect(await journal.codePreview("ithaca", "crash-sail", "workspaces/argo"), "CRASH_RECOVERY_OWNS_ENDPOINT_OBJECTS").toMatchObject({ inline: true });
      } else expect(readFileSync(join(brain, "workspaces", "argo", "chart.md"), "utf8"), "BEFORE_RECEIPT_ORIGINAL_IS_UNTOUCHED").toBe("Ithaca\n");
    } finally { await journal.close(); maintenance.cleanup(); await native.close(); db.close(); }
  } finally { f.close(); }
});

import { cpSync } from "node:fs";
import { referencePoolDouble } from "./helpers/reference-pool-double.js";
test("managed checkout receipts capture at release and turn end without per-result Git or file rows", async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db");
  mkdirSync(brain); writeFileSync(join(brain, "note.md"), "Ithaca\n");
  const native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain);
  const allowance = 32 * 1024 * 1024;
  writeFileSync(join(f.checkout, "cargo.bin"), Buffer.alloc(17 * 1024 * 1024, 97));
  git(f.checkout, "add", "cargo.bin"); git(f.checkout, "commit", "-qm", "Stow the cargo");
  const pool = referencePoolDouble(join(f.root, "pool"), { operationBytes: allowance }), source = await pool.poolCreate(crypto.randomUUID(), "source", null, allowance);
  cpSync(f.checkout, source.path!, { recursive: true }); await pool.poolSeal(source.id);
  const tree = await pool.poolCreate(crypto.randomUUID(), "worktree", source.id, allowance);
  const unsupported = async () => { throw Error("No private reader in this fixture"); };
  const db = createUiDb(dbPath), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance },
    referencePool: { ...pool, poolReadCheckpoint: unsupported, poolStatCheckpoint: unsupported, poolListCheckpoint: unsupported } });
  try {
    const metadata = { sessionId: "ithaca", actor: "interactive" as const, model: null, profile: "governed" as const, policyHash: null, workspaceReadOnly: true };
    db.query("INSERT INTO reference_worktrees (id,principal_id,domain,repository,revision,source_root,allowance,state,created_at,accessed_at) VALUES (?,?,?,?,?,?,?,'active',0,0)").run(tree.id, "odysseus", "public", "file:///fixture/argo.git", "main", source.id, allowance);
    await journal.begin("sail", metadata, () => {}); await journal.begin("other", metadata, () => {});
    await journal.attachWorktree("sail", tree.id);
    const key = `reference-worktree://${tree.id}/`;
    expect(journal.worktrees("sail"), "MANAGED_CAPTURE_USES_POOL_ALLOWANCE_ABOVE_IN_BRAIN_BOUND").toEqual([tree.id]);
    expect(journal.summary("sail").changedFiles, "UNCHANGED_CHECKOUT_IS_NOT_A_CHANGE").toBe(0);
    const checkpoints = pool.events.filter(event => event.operation === "checkpoint").length;
    writeFileSync(join(tree.path!, "chart.md"), "Scheria\n"); await journal.observe();
    expect(pool.events.filter(event => event.operation === "checkpoint").length, "NO_GIT_CHECKPOINT_PER_TOOL_OBSERVATION").toBe(checkpoints);
    await journal.releaseWorktree("sail", tree.id);
    expect(journal.details("ithaca", "sail")!.codeChanges![0]).toMatchObject({ checkout: key, paths: [{ path: "chart.md", kind: "modified" }] });
    expect([journal.summary("sail").changedFiles, journal.summary("sail").changedFiles, journal.summary("sail").changedFiles], "RECEIPT_SUMMARY_READS_NEVER_MUTATE_CACHED_COUNTS").toEqual([1, 1, 1]);
    writeFileSync(join(tree.path!, "raft.md"), "The raft\n"); await journal.finish("sail");
    expect(journal.details("ithaca", "sail")!.codeChanges![0]).toMatchObject({ state: "complete", paths: [{ path: "chart.md", kind: "modified" }, { path: "raft.md", kind: "added" }] });
    expect(journal.details("ithaca", "sail")!.changes, "MANAGED_CHECKOUT_HAS_NO_FILE_ROWS").toEqual([]);
    expect(journal.summary("sail").changedFiles, "CHECKOUT_SUMMARY_COUNTS_CHANGED_PATHS").toBe(2);
    expect(journal.details("ithaca", "other")!.codeChanges, "CHECKOUT_EVIDENCE_BELONGS_ONLY_TO_HOLDING_TURN").toBeUndefined();
    expect(journal.summary("other").state, "OTHER_TURN_REMAINS_USABLE").toBe("recording");
    await journal.finish("other");
  } finally { await journal.close(); maintenance.cleanup(); await native.close(); db.close(); f.close(); }
});

test("inspection-only turns invoke no checkout maintenance and write no receipt", async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db");
  mkdirSync(brain); const native = createNativeJournalFixture(brain, f.root);
  const db = createUiDb(dbPath);
  let calls = 0;
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"),
    codeChanges: { maintenance: {}, prepare: async () => { calls++; throw Error("Inspection must not run checkout maintenance"); } } });
  try {
    await journal.begin("inspect", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null, workspaceReadOnly: true }, () => {});
    await journal.finish("inspect");
    expect(calls, "NO_WRITABLE_CHECKOUT_RUNS_NO_GIT").toBe(0);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_code_receipts").get()).toEqual({ n: 0 });
  } finally { await journal.close(); await native.close(); db.close(); f.close(); }
});

test("an unsupported writable checkout refuses only that turn and leaves inspection and notes usable", async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db");
  mkdirSync(join(brain, "workspaces"), { recursive: true }); const checkout = join(brain, "workspaces", "argo"); renameSync(f.checkout, checkout);
  const unsupported = join(brain, "workspaces", "zeus"); cpSync(checkout, unsupported, { recursive: true });
  writeFileSync(join(unsupported, ".gitattributes"), "*.md filter=lfs\n"); writeFileSync(join(brain, "note.md"), "Ithaca\n");
  const native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain), db = createUiDb(dbPath);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance } });
  const metadata = { sessionId: "ithaca", actor: "interactive" as const, model: null, profile: "governed" as const, policyHash: null };
  try {
    await expectRejection(journal.begin("writer", { ...metadata, workspaceReadOnly: false }, () => {}), undefined, "UNSUPPORTED_CHECKOUT_NEVER_GETS_UNCOVERED_WRITES");
    expect(journal.summary("writer").state).toBe("partial");
    expect(db.query("SELECT count(*) AS n FROM turn_journal_code_receipts WHERE turn_id='writer'").get(), "REFUSED_MULTI_CHECKOUT_ADMISSION_RELEASES_BASELINE_PINS").toEqual({ n: 0 });
    expect(journal.details("ithaca", "writer")!.missing.some(item => item.reason.includes("code_capture_failed")), "REFUSAL_CAUSE_IS_DURABLE_AND_OWNER_VISIBLE").toBe(true);
    await journal.begin("inspection", { ...metadata, workspaceReadOnly: true }, () => {});
    writeFileSync(join(brain, "note.md"), "Return to Ithaca\n"); await journal.finish("inspection");
    expect(journal.summary("inspection").state, "ONE_CHECKOUT_FAILURE_DOES_NOT_DISABLE_OTHER_TURNS").toBe("complete");
    expect(journal.details("ithaca", "inspection")!.changes.map(item => item.path)).toEqual(["note.md"]);
  } finally { await journal.close(); maintenance.cleanup(); await native.close(); db.close(); f.close(); }
});

test("receipt endpoint objects use the checkout's Git object format", () => {
  const f = fixture("sha256");
  try {
    writeFileSync(join(f.checkout, "chart.md"), "Scheria\n");
    const receipt = capture(f.checkout);
    expect(receipt.tree_after, "SHA256_ENDPOINTS_ARE_GIT_OBJECTS").toMatch(/^[0-9a-f]{64}$/);
    expect(capture(f.checkout, { ...receipt, operation: "revert", expected_tree: receipt.tree_after }).status).toBe("restored");
    expect(readFileSync(join(f.checkout, "chart.md"), "utf8")).toBe("Ithaca\n");
  } finally { f.close(); }
});

import { createTurnScope } from "../src/brain/turn-scope.js";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
for (const boundary of ["release", "finish"] as const) test(`checkout ${boundary} failure preserves the shared hold and other turns' workers`, async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db"); mkdirSync(brain); writeFileSync(join(brain, "note.md"), "Ithaca\n");
  const native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain), db = createUiDb(dbPath);
  const pool = referencePoolDouble(join(f.root, "pool")), source = await pool.poolCreate(crypto.randomUUID(), "source", null, 1024 * 1024);
  cpSync(f.checkout, source.path!, { recursive: true }); await pool.poolSeal(source.id);
  const tree = await pool.poolCreate(crypto.randomUUID(), "worktree", source.id, 1024 * 1024);
  const unsupported = async () => { throw Error("No private reader in this fixture"); };
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance }, referencePool: {
    ...pool, poolCheckpoint: (...args) => pool.poolCheckpoint(...args), poolReadCheckpoint: unsupported, poolStatCheckpoint: unsupported, poolListCheckpoint: unsupported,
  } });
  const metadata = { sessionId: "ithaca", actor: "interactive" as const, model: null, profile: "governed" as const, policyHash: null, workspaceReadOnly: true };
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  // Register the production periodic observer: its after(false) kills every
  // temporarily held worker, even when that worker belongs to another turn.
  const scope = createTurnScope(db, { brainPath: brain, journal, connected: () => true, changed: () => {}, space: () => ({ total: 1e12, free: 1e12 }) });
  const workerEvents: string[] = [], exited = Promise.withResolvers<number>();
  try {
    await journal.begin("sail", metadata, () => {}); await journal.begin("other", metadata, () => {}); await journal.attachWorktree("sail", tree.id);
    for (const id of ["sail", "other"]) await scope.begin(id, { sessionId: "ithaca", principalId: "athena", origin: "interactive", profile: "governed",
      policy: resolveGovernancePolicy({ schema_version: 1 }), source: "policy", hardTimeoutMs: 3600_000, current: () => true, stop: () => {} });
    scope.workerStarted("other", { exited: exited.promise, freeze: () => { workerEvents.push("freeze"); }, resume: () => { workerEvents.push("resume"); }, kill: () => { workerEvents.push("kill"); } } as Parameters<typeof scope.workerStarted>[1]);
    writeFileSync(join(tree.path!, "chart.md"), "Scheria\n"); writeFileSync(join(brain, "note.md"), "Return to Ithaca\n");
    pool.poolCheckpoint = async () => { throw Error("Checkout checkpoint refused"); };
    const error = await (boundary === "finish" ? journal.finish("sail") : journal.releaseWorktree("sail", tree.id)).then(() => undefined, error => error);
    expect(workerEvents, "CHECKOUT_FAILURE_RESUMES_OTHER_TURNS_WORKER").toEqual(["freeze", "resume"]);
    expect(error, "CHECKOUT_LOCAL_FAILURE_DOES_NOT_FAIL_SHARED_HOLD").toBeUndefined();
    expect(journal.summary("sail").state, "CHECKOUT_FAILURE_IMMEDIATELY_MARKS_TURN_PARTIAL").toBe("partial");
    expect(journal.details("ithaca", "sail")!.codeChanges![0]!.state, "CHECKOUT_FAILURE_IMMEDIATELY_MARKS_RECEIPT_PARTIAL").toBe("partial");
    if (boundary === "release") await journal.finish("sail");
    const details = journal.details("ithaca", "sail")!;
    expect(details.changes.map(item => item.path), "CODE_FAILURE_KEEPS_FINAL_NOTE_OBSERVATION").toEqual(["note.md"]);
    expect(details.changes[0]!.before?.hash, "CODE_FAILURE_KEEPS_NOTE_BEFORE_IMAGE").toBeString();
    expect(details.summary.state).toBe("partial"); expect(details.codeChanges![0]!.state).toBe("partial");
    expect(details.missing, "CHECKOUT_FAILURE_CAUSE_IS_DURABLE").toContainEqual(expect.objectContaining({ reason: expect.stringContaining("Checkout checkpoint refused") }));
    await journal.finish("other"); expect(journal.summary("other").state, "CODE_FAILURE_DOES_NOT_STOP_OTHER_TURN").toBe("complete");
  } finally { exited.resolve(0); await scope.finish("sail"); await scope.finish("other"); scope.close(); await journal.close(); maintenance.cleanup(); await native.close(); db.close(); f.close(); }
});

for (const direction of ["file to directory", "directory to file"] as const) test(`receipt captures and restores ${direction} replacements`, () => {
  const f = fixture(), path = join(f.checkout, "chart.md"), nested = join(path, "route", "raft.md");
  try {
    if (direction === "directory to file") {
      unlinkSync(path); mkdirSync(join(path, "route"), { recursive: true }); writeFileSync(nested, "Ithaca\n");
      git(f.checkout, "add", "."); git(f.checkout, "commit", "-qm", "Chart the route");
      rmSync(path, { recursive: true }); writeFileSync(path, "Scheria\n");
    } else {
      unlinkSync(path); mkdirSync(join(path, "route"), { recursive: true }); writeFileSync(nested, "Scheria\n");
    }
    const receipt = capture(f.checkout);
    expect(receipt.paths, "STRUCTURAL_REPLACEMENT_IS_DELETION_AND_ADDITION").toEqual([
      { path: "chart.md", kind: direction === "file to directory" ? "deleted" : "added", untracked: direction === "directory to file" },
      { path: "chart.md/route/raft.md", kind: direction === "file to directory" ? "added" : "deleted", untracked: direction === "file to directory" },
    ]);
    expect(capture(f.checkout, { ...receipt, operation: "revert", expected_tree: receipt.tree_after }).status).toBe("restored");
    expect(readFileSync(direction === "file to directory" ? path : nested, "utf8"), "STRUCTURAL_REPLACEMENT_RESTORES_ORIGINAL_BYTES").toBe("Ithaca\n");
    expect(capture(f.checkout).tree_after, "STRUCTURAL_REPLACEMENT_RESTORES_ORIGINAL_TREE").toBe(receipt.tree_before);
  } finally { f.close(); }
});

test("restoring a file replaced by a directory refuses to remove unrelated directory content", () => {
  const f = fixture(), path = join(f.checkout, "chart.md");
  try {
    unlinkSync(path); mkdirSync(path); writeFileSync(join(path, "raft.md"), "Scheria\n");
    const receipt = capture(f.checkout);
    writeFileSync(join(f.checkout, ".git", "info", "exclude"), "chart.md/cargo.bin\n");
    writeFileSync(join(path, "cargo.bin"), "Keep the cargo\n");
    const result = Bun.spawnSync(["python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, f.checkout, String(16 * 1024 * 1024)], {
      env, stdin: Buffer.from(JSON.stringify({ ...receipt, operation: "revert", expected_tree: receipt.tree_after })),
    });
    expect(result.exitCode, "NONEMPTY_STRUCTURAL_DIRECTORY_REFUSES_REPLACEMENT").not.toBe(0);
    expect(result.stderr.toString()).toContain("Directory not empty");
    expect(readFileSync(join(path, "cargo.bin"), "utf8"), "STRUCTURAL_RESTORE_PRESERVES_UNRELATED_BYTES").toBe("Keep the cargo\n");
  } finally { f.close(); }
});

test("receipt restores a file over an empty replacement directory", () => {
  const f = fixture(), path = join(f.checkout, "chart.md");
  try {
    unlinkSync(path); mkdirSync(path);
    const receipt = capture(f.checkout);
    expect(receipt.paths).toEqual([{ path: "chart.md", kind: "deleted", untracked: false }]);
    expect(capture(f.checkout, { ...receipt, operation: "revert", expected_tree: receipt.tree_after }).status).toBe("restored");
    expect(readFileSync(path, "utf8"), "EMPTY_DIRECTORY_REPLACEMENT_RESTORES_ORIGINAL_FILE").toBe("Ithaca\n");
    expect(capture(f.checkout).tree_after).toBe(receipt.tree_before);
  } finally { f.close(); }
});

function inBrainCodeJournal() {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db");
  mkdirSync(join(brain, "workspaces"), { recursive: true });
  const checkout = join(brain, "workspaces", "argo"); renameSync(f.checkout, checkout);
  const native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain), db = createUiDb(dbPath);
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance } });
  return { ...f, brain, dbPath, checkout, native, maintenance, db, journal, async close() { await journal.close(); maintenance.cleanup(); await native.close(); db.close(); f.close(); } };
}
const codeMetadata = { sessionId: "ithaca", actor: "interactive" as const, profile: "governed" as const, model: null, policyHash: null, workspaceReadOnly: false };

test("receipt-covered checkout growth pauses the live turn at its byte cap without retaining file bytes", async () => {
  const f = inBrainCodeJournal(), events: string[] = [], exited = Promise.withResolvers<number>();
  const scope = createTurnScope(f.db, { brainPath: f.brain, journal: f.journal, connected: () => true, changed: () => {}, space: () => ({ total: 1e12, free: 1e12 }) });
  try {
    await f.journal.begin("sail", codeMetadata, () => {});
    await scope.begin("sail", { sessionId: "ithaca", principalId: "athena", origin: "interactive", profile: "governed", policy: resolveGovernancePolicy({ schema_version: 1, scope: { max_bytes_written: 16 * 1024 * 1024 } }), source: "policy", hardTimeoutMs: 3600_000, current: () => true, stop: () => {} });
    scope.workerStarted("sail", { exited: exited.promise, freeze: () => { events.push("freeze"); }, resume: () => { events.push("resume"); }, kill: () => { events.push("kill"); } } as Parameters<typeof scope.workerStarted>[1]);
    writeFileSync(join(f.checkout, "cargo.bin"), Buffer.alloc(17 * 1024 * 1024, 65));
    await f.journal.observe();
    expect(scope.isPaused("sail"), "EXCLUDED_CHECKOUT_BYTES_ENFORCE_LIVE_SCOPE_CAP").toBe(true);
    expect(events).not.toContain("resume");
    const facts = f.journal.summary("sail").scope!;
    expect(facts.observedBytes).toBe(17 * 1024 * 1024);
    expect(facts.changedPaths, "EXCLUDED_CHECKOUT_PATHS_CHARGE_SCOPE").toBe(1);
    expect(facts.receipts[0]).toMatchObject({ state: "paused", dimension: "turn_bytes", cap: 16 * 1024 * 1024, count: 17 * 1024 * 1024 });
    expect(f.journal.details("ithaca", "sail")!.changes, "EXCLUDED_CHECKOUT_CONTENT_IS_NOT_RETAINED").toEqual([]);
    // A later observation of the unchanged file must not charge its bytes again.
    await f.journal.observe();
    expect(f.journal.summary("sail").scope!.observedBytes).toBe(17 * 1024 * 1024);
  } finally { exited.resolve(0); await scope.finish("sail"); scope.close(); await f.close(); }
});

import { symlinkSync } from "node:fs";
test("final capture refuses a checkout replaced with a parent symlink and retains no outside endpoint", async () => {
  const f = inBrainCodeJournal();
  try {
    await f.journal.begin("sail", codeMetadata, () => {});
    const baseline = f.journal.details("ithaca", "sail")!.codeChanges![0]!;
    renameSync(f.checkout, join(f.brain, "workspaces", "moored"));
    // The parent is itself a valid repository, so following the link would
    // capture unrelated source rather than failing merely for lack of .git.
    cpSync(join(f.brain, "workspaces", "moored", ".git"), join(f.brain, ".git"), { recursive: true });
    rmSync(join(f.brain, "workspaces", "moored"), { recursive: true });
    writeFileSync(join(f.brain, "outside.md"), "The Sirens\n");
    symlinkSync("..", f.checkout);
    await f.journal.finish("sail");
    const details = f.journal.details("ithaca", "sail")!;
    expect(details.summary.state, "SYMLINK_CHECKOUT_NEVER_BECOMES_COMPLETE").toBe("partial");
    expect(details.codeChanges![0]!.tree_after, "SYMLINK_CHECKOUT_RETAINS_ONLY_ADMITTED_ENDPOINT").toBe(baseline.tree_after);
    expect(details.codeChanges![0]!.paths).toEqual([]);
    expect(details.missing).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("not a real directory") }));
  } finally { await f.close(); }
});

import * as workerSdk from "@schlessera/brain-ui-sdk/internal";
import { spyOn } from "bun:test";
import { listCodeCheckouts } from "../src/brain/code-change-worker.js";
test("checkout discovery mounts only workspaces and cannot read checkpoint root env files", async () => {
  const f = inBrainCodeJournal(), original = workerSdk.runMaintenanceWorker;
  writeFileSync(join(f.brain, ".env"), "ARGO_SECRET=the-bow\\n"); writeFileSync(join(f.brain, ".env.local"), "ARGO_SECRET=the-raft\\n");
  const checkpoint = await f.native.manager.checkpoint("discovery");
  let probes = 0;
  const spy = spyOn(workerSdk, "runMaintenanceWorker").mockImplementation(async input => {
    probes++;
    const probe = await original({ ...input, command: ["/usr/bin/python3", "-I", "-S", "-c", 'import json,sys; result=[]\nfor path in sys.argv[1:]:\n try:\n  with open(path) as file: file.read(1)\n  result.append(True)\n except OSError: result.append(False)\nprint(json.dumps(result))', join(checkpoint.path, ".env"), join(checkpoint.path, ".env.local")] });
    expect(probe.exitCode, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout), "DISCOVERY_CANNOT_READ_ROOT_ENV_ALIASES").toEqual([false, false]);
    return original(input);
  });
  try {
    expect(await listCodeCheckouts(f.brain, checkpoint.path, f.maintenance)).toEqual(["workspaces/argo"]);
    expect(probes).toBe(1);
  } finally { spy.mockRestore(); await f.native.manager.release(checkpoint.id); await f.close(); }
});

test("checkout discovery refuses a symlinked workspaces directory before launch", async () => {
  const f = inBrainCodeJournal(), original = workerSdk.runMaintenanceWorker;
  renameSync(join(f.brain, "workspaces"), join(f.brain, "moored")); symlinkSync("moored", join(f.brain, "workspaces"));
  const checkpoint = await f.native.manager.checkpoint("discovery"), spy = spyOn(workerSdk, "runMaintenanceWorker").mockImplementation(original);
  try {
    await expectRejection(listCodeCheckouts(f.brain, checkpoint.path, f.maintenance), "not a real directory");
    expect(spy, "UNVERIFIED_WORKSPACES_NEVER_REACHES_MAINTENANCE").not.toHaveBeenCalled();
  } finally { spy.mockRestore(); await f.native.manager.release(checkpoint.id); await f.close(); }
});

test("a worker-forced release capture failure stops only its holding turn and rejects later writes", async () => {
  const f = fixture(), brain = join(f.root, "brain"), dbPath = join(f.root, "ui.db"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, f.root), maintenance = createFixtureMaintenanceHost(brain), db = createUiDb(dbPath);
  const pool = referencePoolDouble(join(f.root, "pool")), source = await pool.poolCreate(crypto.randomUUID(), "source", null, 1024 * 1024);
  cpSync(f.checkout, source.path!, { recursive: true }); await pool.poolSeal(source.id);
  const tree = await pool.poolCreate(crypto.randomUUID(), "worktree", source.id, 1024 * 1024);
  const unsupported = async () => { throw Error("No private reader in this fixture"); };
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: join(f.root, "objects"), codeChanges: { maintenance }, referencePool: {
    ...pool, poolReadCheckpoint: unsupported, poolStatCheckpoint: unsupported, poolListCheckpoint: unsupported,
  } });
  let current = true, stopped = "", worker: Awaited<ReturnType<typeof workerSdk.launchMaintenanceWorkerAsync>> | undefined;
  let stdoutDrain: Promise<void> | undefined, stderrDrain: Promise<string> | undefined;
  try {
    await journal.begin("sail", { ...codeMetadata, workspaceReadOnly: true }, error => { current = false; stopped = error.message; worker?.kill("SIGKILL"); });
    await journal.begin("other", { ...codeMetadata, workspaceReadOnly: true }, () => {});
    await journal.attachWorktree("sail", tree.id);
    // The real credential-free worker mutates only this fixture checkout.
    // Its pipe remains open so it can attempt another write unless stop kills it.
    worker = await workerSdk.launchMaintenanceWorkerAsync({ ...maintenance, brainPath: brain, credentials: false, env: { PATH: "/usr/bin:/bin" },
      readPaths: [tree.path!], writeDirectories: [tree.path!], tempKind: "git", tempDomain: { statePath: join(f.root, "productive-worker.db") },
      command: ["/bin/sh", "-c", 'printf unsupported > "$1/.gitmodules"; printf ready; while IFS= read -r command; do printf later > "$1/later.md"; done', "odysseus-worker", tree.path!] });
    const ready = Promise.withResolvers<string>();
    void worker.exited.then(() => ready.reject(Error("Worker ended before its unsupported-entry write")));
    stdoutDrain = (async () => { for await (const chunk of worker!.stdout) ready.resolve(new TextDecoder().decode(chunk)); })();
    stderrDrain = new Response(worker.stderr).text();
    expect(await ready.promise).toBe("ready");
    await journal.releaseWorktree("sail", tree.id);
    expect(current, "FAILED_RELEASE_ENDS_HOLDING_TURN").toBe(false);
    expect(stopped).toContain("Submodule receipts are unsupported");
    expect(await worker.exited, "FAILED_RELEASE_KILLS_PRODUCTIVE_WORKER").not.toBe(0);
    await worker.input("write again\n");
    await Promise.all([stdoutDrain, stderrDrain]); await worker.released();
    expect(existsSync(join(tree.path!, "later.md")), "ENDED_CODE_TURN_ACCEPTS_NO_LATER_WRITES").toBe(false);
    expect(journal.summary("sail").state).toBe("partial");
    expect(journal.summary("other").state, "FAILED_RELEASE_LEAVES_OTHER_TURN_USABLE").toBe("recording");
    await journal.finish("sail"); await journal.finish("other");
  } finally { worker?.kill("SIGKILL"); if (worker) { await worker.input(""); await Promise.allSettled([worker.exited, stdoutDrain, stderrDrain]); await worker.released(); } await journal.close(); maintenance.cleanup(); await native.close(); db.close(); f.close(); }
});

import { createCodeChangeHistory } from "../src/brain/code-change-history.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
test("code history rejects voice-turn receipts before dispatching a filesystem effect", async () => {
  const f = inBrainCodeJournal(), gate = createWriterGate(f.db, f.brain);
  try {
    await f.journal.begin("voice", { ...codeMetadata, actor: "voice" }, () => {});
    writeFileSync(join(f.checkout, "chart.md"), "Scheria\n"); await f.journal.finish("voice");
    let effects = 0;
    const history = createCodeChangeHistory(f.db, { brainPath: f.brain, journal: f.journal, gate, lock: createKeyedLock(), nativeManager: f.native.client, maintenance: f.maintenance,
      boundary: { run: async () => { effects++; return { exitCode: 0, stdout: JSON.stringify({ status: "restored" }), stderr: "" }; } } as unknown as Parameters<typeof createCodeChangeHistory>[1]["boundary"], isAuthorized: () => true });
    const id = crypto.randomUUID();
    await expectRejection(history.revert(id, "odysseus", "ithaca", "voice", "workspaces/argo"), "not available for a user history operation", "VOICE_CODE_HISTORY_REFUSES_ORIGINAL_VOICE_TURN");
    expect(effects, "VOICE_CODE_HISTORY_NEVER_DISPATCHES_EFFECT").toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_code_reverts WHERE id=?").get(id)).toEqual({ n: 0 });
    expect(readFileSync(join(f.checkout, "chart.md"), "utf8")).toBe("Scheria\n");
  } finally { await gate.settled(); await f.close(); }
});

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
test("large endpoint capture and previous-pack reads yield to the event loop without synchronous pack I/O", async () => {
  const f = inBrainCodeJournal();
  writeFileSync(join(f.checkout, "cargo.bin"), randomBytes(4 * 1024 * 1024));
  let ticks = 0, synchronousPackIO = 0;
  const originalWrite = fs.writeSync, originalSync = fs.fsyncSync, originalRead = fs.readSync;
  const large = (fd: number) => { try { return fs.fstatSync(fd).size >= 1024 * 1024; } catch { return false; } };
  const writeSpy = spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => { if (large(args[0])) synchronousPackIO++; return (originalWrite as any)(...args); }) as typeof fs.writeSync);
  const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => { if (large(fd)) synchronousPackIO++; return originalSync(fd); });
  const readSpy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => { if (large(args[0])) synchronousPackIO++; return (originalRead as any)(...args); }) as typeof fs.readSync);
  const timer = setInterval(() => ticks++, 1);
  try {
    await f.journal.begin("sail", codeMetadata, () => {});
    const firstTicks = ticks; writeFileSync(join(f.checkout, "chart.md"), "Scheria\n");
    await f.journal.finish("sail");
    expect(ticks, "LARGE_ENDPOINT_CAPTURE_SERVICES_EVENT_LOOP").toBeGreaterThan(firstTicks);
    expect(synchronousPackIO, "ENDPOINT_PACK_IO_NEVER_BLOCKS_SERVER_LOOP").toBe(0);
    const preview = await f.journal.codePreview("ithaca", "sail", "workspaces/argo");
    expect(preview).toMatchObject({ inline: true, diff: expect.stringContaining("Binary files") });
    expect(synchronousPackIO, "PREVIOUS_PACK_ENCODING_READS_ASYNCHRONOUSLY").toBe(0);
  } finally { clearInterval(timer); writeSpy.mockRestore(); syncSpy.mockRestore(); readSpy.mockRestore(); await f.close(); }
});
