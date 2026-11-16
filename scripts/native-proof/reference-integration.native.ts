/**
 * Integrated shared-reference and managed-worktree proof (#2751). Runs only
 * inside reference-pool-fixture.py, on its owned Btrfs store and reference
 * pool. For each installed backend, the real app (as the unprivileged app user)
 * acquires an offline fictional repository of 1,200 files through the backend's
 * reference tool, a production worker inspects it, and a managed worktree is
 * requested, edited, renewed and released; its retained work reaches the
 * host-only hygiene review and the owner removes it there.
 */
import { expect } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { serveNativeBrainManager } from "../../packages/ui-sdk/src/server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { hostOutputStagingLimits } from "../../packages/ui-sdk/src/server/worker-state-limits.js";
import type { NativePoolRecord } from "../../packages/ui-sdk/src/server/native-brain-manager-protocol.js";
import { journalDatabasePath } from "../../packages/ui-server/src/db/journal-database.js";
import { referenceWorktreeJournalPath } from "../../packages/ui-server/src/brain/reference-worktree-journal.js";
import { bytes } from "../../tests/helpers/provider-history.js";
import { INTEGRATION_STEPS, INTEGRATION_TURNS, stepKey } from "./reference-integration-steps.js";

const SOURCE = "/repo", MIB = 1024 ** 2, APP_UID = 1000, POOL = "/reference-pool";
const ARTIFACTS = process.env.BRAIN_REFERENCE_POOL_ARTIFACTS ?? "/proof";
const BACKENDS = (process.env.BRAIN_REFERENCE_INTEGRATION_BACKENDS ?? "claude,pi").split(",") as ("claude" | "pi")[];
const receipts: unknown[] = [];
function note(kind: string, facts: Record<string, unknown>) {
  receipts.push({ kind, ...facts });
  writeFileSync(join(ARTIFACTS, "reference-integration-receipts.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify({ kind, ...facts }).slice(0, 4000));
}
function command(argv: string[], options: { cwd?: string } = {}): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", ...options });
  expect(result.exitCode, `${argv.join(" ")}: ${result.stderr.toString()}`).toBe(0);
  return result.stdout.toString();
}
async function until(check: () => boolean, label: string, deadlineMs = 60_000) {
  const end = performance.now() + deadlineMs;
  while (!check()) { if (performance.now() > end) throw Error(`Wait deadline exceeded: ${label}`); await Bun.sleep(25); }
}
const fsid = (path: string) => command(["btrfs", "filesystem", "show", "--raw", path]).split("uuid: ")[1]!.split(/\s/)[0]!;
const subvolUuid = (path: string) => command(["/usr/bin/python3", "-I", "-S", "-c",
  "import os,sys,fcntl\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\nb=bytearray(504)\nfcntl.ioctl(fd,0x81f8943c,b,True)\nprint(bytes(b[296:312]).hex())", path]).trim();

// The brain: a small Odysseus notebook with the real installed CLI.
mkdirSync("/native-runtime", { mode: 0o755, recursive: true });
const brain = "/brain-fixture/brain";
for (const path of ["notes", "node_modules/.bin", ".brain/scratch", "context/policies"]) mkdirSync(join(brain, path), { recursive: true });
writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/\n");
writeFileSync(join(brain, "brain.config.ts"), 'export default {profile:{name:"Odysseus",cliTitle:"Odysseus notebook"}};\n');
writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca\nupdated: 2026-07-12\n---\nOdysseus keeps the chart of the way home.\n");
const cli = join(brain, "node_modules/.bin/brain");
writeFileSync(cli, `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(SOURCE, "packages/core/src/cli/brain.ts"))});\n`); chmodSync(cli, 0o755);
command(["git", "init", "--quiet", brain]);
// A user-owned workspace repository with unfinished work: never a managed worktree, never cleaned.
const workspace = join(brain, "workspaces/argo");
mkdirSync(workspace, { recursive: true });
command(["git", "init", "--quiet", "-b", "main", workspace]);
writeFileSync(join(workspace, "log.md"), "Argo log: the crew rows past Scylla.\n");
const workspaceLog = () => existsSync(join(workspace, "log.md")) ? readFileSync(join(workspace, "log.md"), "utf8") : null;

// The offline fictional repository: 24 books of 50 lines, served from a local path.
const srv = "/native-runtime/srv", work = "/native-runtime/ithaca-work", bare = join(srv, "ithaca.git");
/** A loose ref overrides the packed one: point the remote's main at a commit, or at one it cannot deliver. */
const advertise = (commit: string) => writeFileSync(join(bare, "refs/heads/main"), `${commit}\n`);
const UNDELIVERABLE = "1".repeat(40);
const repository = `file://${bare}`;
mkdirSync(srv, { recursive: true }); mkdirSync(work, { recursive: true });
const gitIn = (cwd: string, ...args: string[]) => command(["git", "-C", cwd, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args]);
gitIn(work, "init", "-q", "-b", "main");
for (let book = 0; book < 24; book++) {
  mkdirSync(join(work, "odyssey", `book-${book}`), { recursive: true });
  for (let line = 0; line < 50; line++) writeFileSync(join(work, "odyssey", `book-${book}`, `line-${line}.md`), `Ithaca chart: book ${book}, line ${line}.\n`);
}
gitIn(work, "add", "."); gitIn(work, "commit", "-q", "-m", "Odysseus charts the way home");
const first = gitIn(work, "rev-parse", "HEAD").trim();
writeFileSync(join(work, "odyssey", "harbour.md"), "Phorcys harbour, charted after the landing.\n");
gitIn(work, "add", "."); gitIn(work, "commit", "-q", "-m", "Odysseus charts the harbour");
const second = gitIn(work, "rev-parse", "HEAD").trim();
command(["git", "clone", "-q", "--bare", work, bare]);
const fileCount = Number(command(["sh", "-c", `git --git-dir ${bare} ls-tree -r --name-only ${first} | wc -l`]).trim());
note("fixture-repository", { repository, first, second, files: fileCount });
expect(fileCount, "INTEGRATED_FIXTURE_REPOSITORY_OVER_1000_FILES").toBeGreaterThan(1000);

// The native manager owns the brain store and the separate reference pool volume.
const staging = hostOutputStagingLimits({});
const socket = "/native-runtime/manager.sock";
const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-store-loop", fsid: fsid("/brain-fixture"), brainUuid: subvolUuid(brain),
  socketPath: socket, appUid: APP_UID, appGid: APP_UID, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
  capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * MIB, operationTimeoutMs: 20_000,
  referencePool: { storePath: POOL, devicePath: "/dev/brain-pool-loop", fsid: fsid(POOL), combinedLimitBytes: 256 * MIB, operationLimitBytes: 32 * MIB,
    emergencyBytes: 4 * MIB, physicalFloorBytes: 64 * MIB, headroomLedgerPath: "/native-backing/ledger/headroom.json", maxIdentities: 256 } });
const manager = createNativeBrainManagerClient({ socketPath: socket, timeoutMs: 20_000 });
const ready = await manager.ready();
note("native-ready", { ready });
const qualified = await manager.poolStatus();
note("pool-qualified", { status: qualified });
expect(qualified.qualified, "INTEGRATED_POOL_QUALIFIED").toBe(true);
const records = async () => {
  const all: NativePoolRecord[] = [];
  for (let after: string | null = null; ;) { const page = await manager.listPoolRecovery(after); all.push(...page.records); if (!page.next) return all; after = page.next; }
};
const { serializeSigned } = await import(join(SOURCE, "node_modules/hono/dist/utils/cookie.js"));

async function run(backend: "claude" | "pi") {
  const tag = backend.toUpperCase();
  const dir = join(ARTIFACTS, `appdata-${backend}`);
  for (const path of ["home", "agent", "pi"]) mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, "agent/settings.json"), "{}");
  // Each backend starts from the first commit with a healthy remote.
  advertise(first);
  command(["chown", "-R", `${APP_UID}:${APP_UID}`, dir, brain, srv]);
  const child = Bun.spawn(["/usr/bin/setpriv", `--reuid=${APP_UID}`, `--regid=${APP_UID}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    process.execPath, "--preload", join(SOURCE, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "reference-integration-child.ts"),
    SOURCE, dir, brain, socket, backend, repository], {
    cwd: SOURCE, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "pi"), NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  let exited = false; void child.exited.then(() => { exited = true; });
  const events = () => existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  let ws: WebSocket | undefined;
  try {
    await until(() => existsSync(join(dir, "ready.json")) || exited, `${backend} app ready`, 60_000);
    if (exited) throw Error(`INTEGRATED_${tag}_APP_BOOT: ${existsSync(join(dir, "boot-error.txt")) ? readFileSync(join(dir, "boot-error.txt"), "utf8") : await errors}`);
    const app = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"));
    note(`${backend}-ready`, { app });
    expect(app.referenceTools, `INTEGRATED_${tag}_APP_COMPOSES_REFERENCE_TOOLS`).toBe(true);
    const origin = `http://127.0.0.1:${app.port}`;
    const cookie = await serializeSigned("brain_ui_session", app.principalId, app.secret);
    const json = (path: string, body: unknown) => fetch(origin + path, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    // The owner grants the private repository location through the supported route.
    const granted = await json(`/api/auth/principals/${app.principalId}/reference-grants`, { repositoryPrefix: `file://${srv}` });
    const grant = await granted.json();
    note(`${backend}-grant`, { status: granted.status, grant });
    expect(granted.status, `INTEGRATED_${tag}_OWNER_GRANT_CREATED`).toBe(201);

    const frames: any[] = [], approvals: any[] = [];
    ws = new (WebSocket as any)(origin.replace("http", "ws") + "/ws", { headers: { cookie, origin } }) as WebSocket;
    ws.addEventListener("message", message => {
      const frame = { ...JSON.parse(String(message.data)), receiptAt: performance.now() };
      frames.push(frame); appendFileSync(join(ARTIFACTS, `frames-${backend}.jsonl`), JSON.stringify(frame) + "\n");
      // A gated tool waits for the user's card: the user approves it once, per use.
      if (frame.type === "tool_approval_request") { approvals.push({ toolName: frame.toolName, kind: frame.kind ?? "tool" }); ws!.send(JSON.stringify({ type: "tool_approval", toolUseId: frame.toolUseId, turnId: frame.turnId })); }
    });
    await until(() => frames.some(frame => frame.type === "server_hello"), "server hello");
    ws.send(JSON.stringify({ type: "client_hello", protocolRev: 3, capabilities: { followUpQueue: true } }));
    let sessionId: string | undefined;
    const turns: Record<string, { turnId: string; journal: any }> = {};
    for (const key of INTEGRATION_TURNS) {
      if (key === "corrects") {
        // Source moves on: the remote's main gains a commit, past the refresh cooldown.
        advertise(second);
        await Bun.sleep(2_500);
      }
      if (key === "returns") {
        // A remote outage: main names a commit the remote cannot deliver, so the fetch fails
        // with a transport error, not a denial. Source falls back to its last commit, stale.
        advertise(UNDELIVERABLE);
        await Bun.sleep(2_500);
      }
      const requestId = `odysseus-${backend}-${key}`, begin = performance.now();
      ws.send(JSON.stringify({ type: "chat_message", text: `Odysseus ${key} the Ithaca chart on 2026-07-12.`, requestId, sessionId }));
      await until(() => frames.some(frame => frame.type === "session_info" && frame.requestId === requestId) || frames.some(frame => frame.type === "error" && frame.requestId === requestId), `${key} ack`);
      const ack = frames.find(frame => frame.type === "session_info" && frame.requestId === requestId);
      if (!ack) throw Error(`INTEGRATED_${tag}_${key.toUpperCase()}_ADMITTED: ${JSON.stringify(frames.filter(frame => frame.requestId === requestId))}`);
      expect(ack.workerProfile?.actualProfile, `INTEGRATED_${tag}_GOVERNED_PROFILE`).toBe("governed");
      sessionId = ack.sessionId;
      await until(() => frames.some(frame => (frame.type === "result" || frame.type === "error") && frame.receiptAt >= begin && (frame.sessionId ?? sessionId) === sessionId), `${key} result`, 120_000);
      await until(() => frames.some(frame => frame.type === "turn_journal" && frame.turnId === ack.turnId && frame.journal?.state === "complete"), `${key} journal complete`, 30_000);
      // The next turn starts only after this one settled: no follow-up queue in between.
      await until(() => frames.some(frame => frame.type === "status" && frame.status === "idle" && frame.turnId === ack.turnId
        && frame.receiptAt >= frames.find(other => other.type === "turn_journal" && other.turnId === ack.turnId && other.journal?.state === "complete")!.receiptAt), `${key} settled`, 30_000);
      const terminal = frames.findLast(frame => (frame.type === "result" || frame.type === "error") && frame.receiptAt >= begin);
      expect(frames.filter(frame => frame.type === "text_delta" && frame.turnId === ack.turnId && /stopped|froze|freeze/.test(frame.text)), `INTEGRATED_${tag}_${key.toUpperCase()}_NOT_STOPPED_BY_SCOPE`).toEqual([]);
      const journal = frames.findLast(frame => frame.type === "turn_journal" && frame.turnId === ack.turnId)!.journal;
      turns[key] = { turnId: ack.turnId, journal };
      note(`${backend}-turn`, { key, turnId: ack.turnId, outcome: terminal?.outcome ?? terminal?.type, journal });
      expect(terminal?.type === "result" && terminal.outcome !== "error", `INTEGRATED_${tag}_${key.toUpperCase()}_SUCCEEDED ${JSON.stringify(terminal)}`).toBe(true);
    }
    const steps = Object.fromEntries(events().filter(row => row.kind === "integration_step").map(row => [stepKey(row.turn, row.index), row.value]));
    note(`${backend}-steps`, { steps, approvals });
    for (const key of INTEGRATION_TURNS) for (const index of INTEGRATION_STEPS[key]!.keys())
      expect(steps[stepKey(key, index)], `INTEGRATED_${tag}_STEP_RECORDED ${stepKey(key, index)}`).toBeDefined();

    // Acquisition and inspection: a private source at the first commit, read by a worker, charging no changed path.
    const acquired = steps["inspects#0"];
    expect({ ok: acquired.ok, domain: acquired.source?.domain, commit: acquired.source?.commit, freshness: acquired.source?.freshness, worker: acquired.source?.path?.startsWith("/tmp/brain-reference/private/") },
      `INTEGRATED_${tag}_SOURCE_ACQUIRED_THROUGH_TOOL`).toEqual({ ok: true, domain: "private", commit: first, freshness: "fresh", worker: true });
    // A command's output, without the trailing newline Pi's bash tool drops.
    const output = (key: string) => String(steps[key]).trimEnd();
    expect(output("inspects#1"), `INTEGRATED_${tag}_WORKER_INSPECTS_1200_FILES`).toBe("1200\nIthaca chart: book 23, line 49.");
    const requested = steps["inspects#2"], clean = steps["inspects#3"];
    expect({ ok: requested.ok, action: requested.action, commit: requested.worktree?.startingCommit, state: requested.worktree?.state, path: requested.worktree?.path },
      `INTEGRATED_${tag}_WORKTREE_REQUESTED`).toEqual({ ok: true, action: "request", commit: first, state: "active", path: `/tmp/brain-worktrees/${requested.worktree?.id}` });
    expect(output("inspects#4"), `INTEGRATED_${tag}_WORKER_READS_WORKTREE`).toBe("1200\nIthaca chart: book 1, line 1.");
    expect({ ok: steps["inspects#5"].ok, state: steps["inspects#5"].worktree?.state }, `INTEGRATED_${tag}_CLEAN_WORKTREE_RELEASED`).toEqual({ ok: true, state: "released" });
    expect({ changedFiles: turns.inspects!.journal.changedFiles, changedPaths: turns.inspects!.journal.scope?.changedPaths, coverage: turns.inspects!.journal.scope?.coverage },
      `INTEGRATED_${tag}_ACQUISITION_CONSUMES_NO_CHANGED_PATH`).toEqual({ changedFiles: 0, changedPaths: 0, coverage: "observed_versions" });

    // Moving source, fixed worktree: the edit is journaled and counted, and renewal is explicit.
    expect({ ok: steps["corrects#0"].ok, action: steps["corrects#0"].action, id: steps["corrects#0"].worktree?.id }, `INTEGRATED_${tag}_WORKTREE_ACCESSED`)
      .toEqual({ ok: true, action: "access", id: requested.worktree.id });
    expect({ commit: steps["corrects#1"].source?.commit, freshness: steps["corrects#1"].source?.freshness }, `INTEGRATED_${tag}_SOURCE_MOVED_ON_REQUEST`)
      .toEqual({ commit: second, freshness: "fresh" });
    expect(output("corrects#2"), `INTEGRATED_${tag}_WORKTREE_EDITED_SOURCE_READ_ONLY`)
      .toBe("WORKTREE_EDITED\nPhorcys harbour, charted after the landing.\nWORKTREE_FIXED\nSOURCE_READ_ONLY");
    const renewed = steps["corrects#3"];
    expect({ ok: renewed.ok, action: renewed.action }, `INTEGRATED_${tag}_WORKTREE_RENEWED`).toEqual({ ok: true, action: "renew" });
    expect(Date.parse(renewed.worktree.lastActivityAt) > Date.parse(requested.worktree.lastActivityAt) && Date.parse(renewed.worktree.expiresAt) > Date.parse(requested.worktree.expiresAt),
      `INTEGRATED_${tag}_RENEWAL_ADVANCES_CLOCK`).toBe(true);
    expect({ changedFiles: turns.corrects!.journal.changedFiles, changedPaths: turns.corrects!.journal.scope?.changedPaths },
      `INTEGRATED_${tag}_WORKTREE_EDITS_SCOPE_COUNTED`).toEqual({ changedFiles: 2, changedPaths: 2 });

    // Stale fallback and release.
    const stale = steps["returns#0"];
    expect({ ok: stale.ok, commit: stale.source?.commit, freshness: stale.source?.freshness, error: typeof stale.source?.error, refreshedAt: stale.source?.refreshedAt },
      `INTEGRATED_${tag}_SOURCE_STALE_FALLBACK`).toEqual({ ok: true, commit: second, freshness: "stale", error: "string", refreshedAt: steps["corrects#1"].source.refreshedAt });
    expect({ ok: steps["returns#1"].ok, state: steps["returns#1"].worktree?.state }, `INTEGRATED_${tag}_WORKTREE_RELEASED`).toEqual({ ok: true, state: "released" });

    // Retained work reaches the host-only review queue; the owner disposes of it there.
    const opened = await json("/api/hygiene/review", { operation: "start" });
    const review = await opened.json();
    note(`${backend}-review`, { status: opened.status, review });
    expect(opened.status, `INTEGRATED_${tag}_REVIEW_STARTED`).toBe(200);
    const itemId = review.action?.id, finding = review.action?.hygiene?.finding?.path;
    expect(review.privateDetailAccess, `INTEGRATED_${tag}_OWNER_OFFERED_DETAILS`).toEqual({ itemId });
    expect(finding, `INTEGRATED_${tag}_RETAINED_WORKTREE_REVIEWED`).toBe(`reference-worktree://${requested.worktree.id}`);
    for (const secret of [srv, "ithaca.git", first, second, "argos", "book-0"])
      expect(JSON.stringify(review).includes(secret), `INTEGRATED_${tag}_REVIEW_CARD_OPAQUE ${secret}`).toBe(false);
    const details = await fetch(origin + `/api/hygiene/review/details/${itemId}`, { headers: { cookie } });
    const detail = await details.json();
    note(`${backend}-review-details`, { status: details.status, detail });
    expect(details.status, `INTEGRATED_${tag}_OWNER_READS_DETAILS`).toBe(200);
    ws.send(JSON.stringify({ type: "inbox_resolve", itemId, optionId: "delete-worktree" }));
    const db = new Database(join(dir, "ui.db"), { readonly: true });
    const receipt = (id: string) => db.query("SELECT state, trigger FROM reference_worktree_cleanups WHERE worktree_id = ?").get(id) as { state: string; trigger: string } | null;
    try {
      await until(() => receipt(requested.worktree.id)?.state === "reclaimed" && receipt(clean.worktree.id)?.state === "reclaimed", "worktree reclamation", 60_000).catch(() => {});
      const pool = await records();
      const cleanup = { reviewed: receipt(requested.worktree.id), clean: receipt(clean.worktree.id),
        reviewedRecord: pool.find(record => record.id === requested.worktree.id)?.state ?? null, cleanRecord: pool.find(record => record.id === clean.worktree.id)?.state ?? null };
      note(`${backend}-cleanup`, cleanup);
      expect(cleanup, `INTEGRATED_${tag}_WORKTREES_RECLAIMED`).toEqual({ reviewed: { state: "reclaimed", trigger: "review" }, clean: { state: "reclaimed", trigger: "automatic" },
        reviewedRecord: "reclaimed", cleanRecord: "reclaimed" });
    } finally { db.close(); }
    // Core keeps its own Markdown hygiene ledger; no worktree finding or disposition ever enters it.
    const ledger = existsSync(join(brain, "context/hygiene")) ? readdirSync(join(brain, "context/hygiene")).map(name => readFileSync(join(brain, "context/hygiene", name), "utf8")).join("\n") : "";
    note(`${backend}-hygiene-ledger`, { bytes: ledger.length });
    expect([requested.worktree.id, clean.worktree.id, "reference-worktree", "managed-worktree"].filter(value => ledger.includes(value)), `INTEGRATED_${tag}_FINDINGS_HOST_ONLY`).toEqual([]);
    expect({ log: workspaceLog(), git: existsSync(join(workspace, ".git")), reviewed: JSON.stringify(review).includes("argo") },
      `INTEGRATED_${tag}_USER_WORKSPACE_UNTOUCHED`).toEqual({ log: "Argo log: the crew rows past Scylla.\n", git: true, reviewed: false });

    // Provider history across the lifecycle and the source's freshness changes.
    if (backend === "pi") {
      const requests = readFileSync(join(dir, "pi-requests.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const answers = readFileSync(join(dir, "pi-answers.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const bodies = requests.map(request => JSON.parse(request.raw));
      note("pi-provider-history", { requests: requests.length, turns: requests.map(request => `${request.turn}#${request.step}`) });
      for (let index = 1; index < bodies.length; index++) {
        const previous = bodies[index - 1], next = bodies[index];
        // The provider-history guards' rule: every byte stays, and only cache breakpoints may move.
        expect(bytes(next.tools), `INTEGRATED_PI_TOOLS_STABLE ${index}`).toBe(bytes(previous.tools));
        expect(bytes(next.system), `INTEGRATED_PI_SYSTEM_STABLE ${index}`).toBe(bytes(previous.system));
        expect(bytes(next.messages.slice(0, previous.messages.length)), `INTEGRATED_PI_HISTORY_PREFIX_PRESERVED ${index}`).toBe(bytes(previous.messages));
        const answer = next.messages[previous.messages.length];
        expect({ role: answer?.role, content: (answer?.content ?? []).map((block: any) => ({ type: block.type, ...(block.type === "tool_use" ? { id: block.id, name: block.name, input: block.input } : { text: block.text }) })) },
          `INTEGRATED_PI_ANSWER_KEPT ${index}`).toEqual(answers[index - 1].answer);
      }
    } else {
      const surfaces = events().filter(row => row.kind === "claude_turn_surface");
      note("claude-turn-surface", { surfaces });
      expect(surfaces.map(row => row.turn), "INTEGRATED_CLAUDE_EVERY_TURN_ASSEMBLED").toEqual([...INTEGRATION_TURNS]);
      expect(new Set(surfaces.map(row => row.systemPrompt)).size, "INTEGRATED_CLAUDE_SYSTEM_OPTION_STABLE").toBe(1);
      expect(new Set(surfaces.map(row => row.roster)).size, "INTEGRATED_CLAUDE_MCP_ROSTER_STABLE").toBe(1);
      expect(surfaces[0].names, "INTEGRATED_CLAUDE_REFERENCE_TOOLS_REGISTERED").toEqual(expect.arrayContaining(["reference_source", "reference_worktree"]));
    }
    return { turns, steps, worktree: requested.worktree.id, clean: clean.worktree.id };
  } finally {
    ws?.close();
    if (!exited) child.kill("SIGTERM");
    const code = await child.exited;
    writeFileSync(join(ARTIFACTS, `app-${backend}.log`), `exit ${code}\n--- stdout\n${await output}\n--- stderr\n${await errors}`);
    note(`${backend}-app-exit`, { code });
  }
}

try {
  const results: Record<string, unknown> = {};
  for (const backend of BACKENDS) {
    const result = await run(backend);
    // After the app closes: the journal names exactly the two intentional worktree edits, in the worktree scope.
    const db = new Database(join(ARTIFACTS, `appdata-${backend}`, "ui.db"), { readonly: true });
    try {
      db.query("ATTACH DATABASE ? AS journal").run(journalDatabasePath(join(ARTIFACTS, `appdata-${backend}`, "ui.db")));
      const rows = (turnId: string) => db.query("SELECT path, scope FROM turn_journal_changes WHERE turn_id = ? ORDER BY path").all(turnId) as { path: string; scope: string }[];
      const journal = { inspects: rows(result.turns.inspects!.turnId), corrects: rows(result.turns.corrects!.turnId), returns: rows(result.turns.returns!.turnId) };
      note(`${backend}-journal`, journal);
      const tag = backend.toUpperCase();
      expect(journal.inspects, `INTEGRATED_${tag}_ACQUISITION_NOT_JOURNALED`).toEqual([]);
      expect(journal.corrects, `INTEGRATED_${tag}_WORKTREE_EDITS_JOURNALED`).toEqual([
        { path: referenceWorktreeJournalPath(result.worktree, "odyssey/argos.md"), scope: "reference_worktree" },
        { path: referenceWorktreeJournalPath(result.worktree, "odyssey/book-0/line-0.md"), scope: "reference_worktree" }]);
      expect(journal.returns, `INTEGRATED_${tag}_RELEASE_NOT_JOURNALED`).toEqual([]);
    } finally { db.close(); }
    results[backend] = { worktree: result.worktree, clean: result.clean, turns: result.turns };
  }
  const left = (await records()).filter(record => record.purpose !== "checkpoint" && record.state !== "reclaimed" && record.purpose === "worktree");
  note("integrated-complete", { backends: BACKENDS, results, worktreesLeft: left });
  expect(left, "INTEGRATED_NO_WORKTREE_LEFT").toEqual([]);
} finally {
  await service.close();
}
