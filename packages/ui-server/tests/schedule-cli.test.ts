/**
 * The real `brain schedule` CLI against a real mounted app over HTTP. The
 * operator review path runs under a pseudo-terminal (util-linux `script`),
 * because approval requires an interactive confirmation.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";

import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { PROMPT, SCOPE } from "./helpers/schedule-fixture.js";
import { createTestApp, type TestApp } from "./helpers/test-app.js";

const SECRET = "schedule-cli-fixture-cookie-secret-0123";
const CLI = join(import.meta.dir, "../../core/src/cli/brain.ts");
const BUN = Bun.which("bun")!;
let fixture: TestApp;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let ownerFile: string, agentFile: string, scopeFile: string;
let agentId: string;
let startedTurns = 0;
const scratch: string[] = [];
const outside = (name: string) => { const path = join(fixture.brainPath, "..", `${name}-${process.pid}-${scratch.length}.json`); scratch.push(path); return path; };

async function credentialFile(name: string, principalId: string): Promise<string> {
  const raw = decodeURIComponent((await generateSignedCookie("brain_ui_session", principalId, SECRET)).split(";")[0]!.split("=").slice(1).join("="));
  const path = outside(name);
  await writeFile(path, JSON.stringify({ server: origin, cookie: raw }), { mode: 0o600 });
  return path;
}

beforeAll(async () => {
  const backend = makeFakeBackend({ id: "fixture", startTurn: async () => { startedTurns++; } });
  fixture = await createTestApp({
    env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: Bun.password.hashSync("odysseus-fixture"), COOKIE_SECRET: SECRET,
      BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS: "https://inference.example" },
    appOptions: { observability: createRecordingObservability(), registry: createStaticBackendRegistry([backend], backend.id) },
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => fixture.app.fetch(request) });
  origin = server.url.origin;
  const owner = createPrincipal(fixture.app.db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const agent = createPrincipal(fixture.app.db, { authMethod: "delegated", label: "Telemachus agent", createdBy: owner.id, ttlSeconds: 3600 });
  agentId = agent.id;
  ownerFile = await credentialFile("owner", owner.id);
  agentFile = await credentialFile("agent", agent.id);
  scopeFile = outside("scope");
  await writeFile(scopeFile, JSON.stringify(SCOPE));
});
afterAll(async () => {
  server?.stop(true);
  for (const path of scratch) rmSync(path, { force: true });
  await fixture?.teardown();
});

interface CliResult { exit: number; stderr: string; body: any }

async function run(args: string[], credential?: string, target = origin): Promise<CliResult> {
  const child = Bun.spawn([BUN, CLI, "schedule", ...args, "--server", target, "--json", ...(credential ? ["--credential-file", credential] : [])], {
    cwd: fixture.brainPath, env: { PATH: process.env.PATH, BRAIN_ROOT: fixture.brainPath }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, stderr, body: stdout ? JSON.parse(stdout) : null };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Run under a pseudo-terminal, typing `answer` at the review prompt; stdout goes to a file. */
async function runTty(args: string[], credential: string, answer: string): Promise<CliResult & { review: string }> {
  const out = outside("tty");
  const command = [BUN, CLI, "schedule", ...args, "--server", origin, "--json", "--credential-file", credential].map(quote).join(" ");
  const script = Bun.which("script");
  if (!script) throw new Error("util-linux script(1) is required for the operator review test");
  const child = Bun.spawn([script, "-q", "-e", "-c", `${command} > ${quote(out)}`, "/dev/null"], {
    cwd: fixture.brainPath, env: { PATH: process.env.PATH, BRAIN_ROOT: fixture.brainPath, SHELL: "/bin/sh", TERM: "dumb" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(`${answer}\n`);
  child.stdin.flush();
  const [review, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  child.stdin.end();
  const text = existsSync(out) ? readFileSync(out, "utf8") : "";
  return { exit, stderr: "", review: review.replaceAll("\r\n", "\n"), body: text ? JSON.parse(text) : null };
}

const addArgs = (key: string, extra: string[] = []) => ["add", "--key", key, "--prompt", PROMPT, "--cron", "0 7 * * 1-5",
  "--time-zone", "Europe/Athens", "--scope-file", scopeFile, ...extra];

test("the operator reviews and approves on a terminal; the host record and file agree; replay is idempotent", async () => {
  const approved = await runTty(addArgs("ithaca-review-01", ["--approve"]), ownerFile, "approve");
  expect(approved.review).toContain("Fingerprint: ");
  expect(approved.review).toContain('"inferenceOrigins": [\n      "https://inference.example"');
  expect(approved.exit).toBe(0);
  expect(approved.body).toMatchObject({ ok: true, created: true, task: { state: "active", executionAvailable: false,
    blockedReason: "dispatch_disabled", zoneSource: "explicit", lastOccurrence: null, compensationPending: false } });
  expect(Object.keys(approved.body).sort()).toEqual(["created", "ok", "task"]);
  const id = approved.body.task.id as string;
  expect(existsSync(join(fixture.brainPath, "context/scheduled-tasks/definitions", `${id}.md`))).toBe(true);
  // A retry after a lost response returns the original receipt without review.
  const replay = await run(addArgs("ithaca-review-01", ["--approve"]), ownerFile);
  expect(replay).toMatchObject({ exit: 0, body: { ok: true, created: false, task: { id } } });
  const listed = await run(["list"], ownerFile);
  expect(listed.exit).toBe(0);
  expect(listed.body).toEqual({ ok: true, tasks: [replay.body.task], nextCursor: null });
  expect(startedTurns).toBe(0);
  expect(existsSync(join(fixture.brainPath, "brain.db"))).toBe(false);
});

test("no TTY or no affirmative answer means no grant", async () => {
  const declined = await runTty(addArgs("declined-01", ["--approve"]), ownerFile, "no");
  expect(declined.exit).toBe(1);
  expect(declined.body).toMatchObject({ ok: false, error: { code: "approval_required" } });
  const piped = await run(addArgs("piped-01", ["--approve"]), ownerFile);
  expect(piped.exit).toBe(1);
  expect(piped.body.error.code).toBe("approval_required");
  expect(fixture.app.db.query("SELECT COUNT(*) AS n FROM schedule_approvals a JOIN schedule_proposals p ON p.id = a.proposal_id WHERE p.request_key IN ('declined-01', 'piped-01')").get()).toEqual({ n: 0 });
});

test("a delegated credential proposes, cannot self-approve, and publishes after operator approval", async () => {
  const proposed = await runTty(addArgs("agent-01", ["--approve"]), agentFile, "approve");
  expect(proposed.exit).toBe(1);
  expect(proposed.body.error.code).toBe("unauthorized");
  const pending = await run(addArgs("agent-01"), agentFile);
  expect(pending.exit).toBe(1);
  expect(pending.body.error).toEqual({ code: "approval_required", message: expect.stringMatching(/proposal proposal_[0-9a-f]{32}/) });
  const row = fixture.app.db.query("SELECT id, fingerprint FROM schedule_proposals WHERE request_key = 'agent-01'").get() as { id: string; fingerprint: string };
  // The operator decision arrives through the host (here the approve route; the PWA/bridge review comes in #916/#917).
  const ownerCookie = `brain_ui_session=${encodeURIComponent(JSON.parse(readFileSync(ownerFile, "utf8")).cookie)}`;
  const decision = await fetch(`${origin}/api/schedules/proposals/${row.id}/approve`, { method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ fingerprint: row.fingerprint, decision: "approve" }) });
  expect(decision.status).toBe(200);
  const published = await run(addArgs("agent-01"), agentFile);
  expect(published).toMatchObject({ exit: 0, body: { created: true, task: { creatorPrincipalId: agentId } } });
  const agentList = await run(["list"], agentFile);
  expect(agentList.body.tasks.map((t: { id: string }) => t.id)).toEqual([published.body.task.id]);
});

test("cancel and due report exact envelopes and exit codes", async () => {
  const created = await runTty(addArgs("cancel-01", ["--approve"]), ownerFile, "approve");
  const id = created.body.task.id as string;
  const cancelled = await run(["cancel", id, "--key", "cancel-key-01"], ownerFile);
  expect(cancelled.exit).toBe(0);
  expect(cancelled.body).toMatchObject({ ok: true, changed: true, runningOccurrences: [], task: { id, state: "cancelled", nextDueAt: null } });
  expect(Object.keys(cancelled.body).sort()).toEqual(["changed", "ok", "runningOccurrences", "task"]);
  const again = await run(["cancel", id, "--key", "cancel-key-01"], ownerFile);
  expect(again).toMatchObject({ exit: 0, body: { changed: false, task: { id, state: "cancelled" } } });
  const listed = await run(["list", "--id", id], ownerFile);
  expect(listed.body.tasks).toHaveLength(1);
  expect(listed.body.tasks[0].state).toBe("cancelled");
  const due = await run(["due"], ownerFile);
  expect(due.exit).toBe(0);
  expect(due.body).toEqual({ ok: true, due: [], evaluatedAt: expect.stringMatching(/Z$/), nextCursor: null });
  expect((await run(["cancel", "task_missing", "--key", "k"], ownerFile))).toMatchObject({ exit: 1, body: { error: { code: "not_found" } } });
  expect((await run(["cancel", id, "--key", "cancel-key-01"], agentFile))).toMatchObject({ exit: 1, body: { error: { code: "not_found" } } });
});

test("argument, credential and conflict errors exit 1 with the shared envelope", async () => {
  for (const args of [["add", "--key", "x", "--prompt", "p", "--scope-file", scopeFile], ["add", "--key", "x", "--prompt", "p", "--at", "2026-07-13T07:00:00Z", "--cron", "0 7 * * *", "--scope-file", scopeFile],
    ["add", "--key", "x", "--prompt", "p", "--at", "2026-07-13T07:00:00Z", "--end-at", "2026-08-01T00:00:00Z", "--scope-file", scopeFile],
    ["list", "--offset", "2"], ["list", "--limit", "0"], ["frobnicate"], ["cancel", "--key", "k"]]) {
    const result = await run(args, ownerFile);
    expect({ args, exit: result.exit, code: result.body?.error?.code }).toEqual({ args, exit: 1, code: "invalid_request" });
  }
  expect((await run(addArgs("bad-zone").map((a) => (a === "Europe/Athens" ? "Atlantis/Ogygia" : a)), ownerFile)).body.error.code).toBe("invalid_request");
  expect((await run(["list", "--cursor", "forged.cursor"], ownerFile))).toMatchObject({ exit: 1, body: { error: { code: "invalid_cursor" } } });
  expect((await run(["list"]))).toMatchObject({ exit: 1, body: { error: { code: "unauthorized" } } });
  const other = outside("other");
  await writeFile(other, JSON.stringify({ server: "https://example.org", cookie: JSON.parse(readFileSync(ownerFile, "utf8")).cookie }), { mode: 0o600 });
  expect((await run(["list"], other))).toMatchObject({ exit: 1, body: { error: { code: "credential_file_invalid" } } });
  await runTty(addArgs("conflict-01", ["--approve"]), ownerFile, "approve");
  const conflict = await run(addArgs("conflict-01").map((a) => (a === "0 7 * * 1-5" ? "0 8 * * 1-5" : a)), ownerFile);
  expect(conflict).toMatchObject({ exit: 1, body: { error: { code: "key_conflict" } } });
});

test("unavailable, redirecting and malformed hosts exit 2 and never follow a redirect", async () => {
  const stopped = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const stoppedOrigin = stopped.url.origin;
  stopped.stop(true);
  const unavailable = await run(["due"], undefined, stoppedOrigin);
  expect(unavailable).toMatchObject({ exit: 2, body: { ok: false, error: { code: "server_unavailable" } } });
  let forwarded = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { forwarded++; return Response.json({ ok: true, due: [], evaluatedAt: "2026-07-12T06:00:00.000Z", nextCursor: null }); } });
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 307, headers: { location: `${target.url.origin}/api/schedules/due` } }) });
  const malformed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, due: "nothing" }) });
  const failing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("upstream down", { status: 502 }) });
  try {
    expect(await run(["due"], undefined, redirect.url.origin)).toMatchObject({ exit: 2, body: { error: { code: "invalid_response" } } });
    expect(forwarded).toBe(0);
    expect(await run(["due"], undefined, malformed.url.origin)).toMatchObject({ exit: 2, body: { error: { code: "invalid_response" } } });
    expect(await run(["due"], undefined, failing.url.origin)).toMatchObject({ exit: 2, body: { error: { code: "server_unavailable" } } });
  } finally { target.stop(true); redirect.stop(true); malformed.stop(true); failing.stop(true); }
});

test("a revoked credential is refused even with a matching receipt", async () => {
  const owner = createPrincipal(fixture.app.db, { authMethod: "password", label: "Eurycleia", ttlSeconds: 3600 });
  const file = await credentialFile("revoked", owner.id);
  const created = await runTty(addArgs("revoked-01", ["--approve"]), file, "approve");
  expect(created.exit).toBe(0);
  revokePrincipal(fixture.app.db, owner.id, Date.now());
  expect(await run(addArgs("revoked-01"), file)).toMatchObject({ exit: 1, body: { error: { code: "unauthorized" } } });
});
