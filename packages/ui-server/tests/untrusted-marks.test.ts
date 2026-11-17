/**
 * Files the user marks untrusted (#2673): the detector, the host's authority
 * and disclosure rules on direct HTTP requests, persistence, the rename rule
 * and the taint an interactive turn records when it reads a marked file.
 */
import { expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workerOutwardNote } from "@schlessera/brain-ui-sdk/internal";
import { inputTaintSource, outputTaintSource } from "../src/activity/ingestion-taint";
import { createPrincipal, type Principal } from "../src/db/principals";
import { queryGovernanceEvents } from "../src/governance/events";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { runCli } from "../../core/tests/cli-harness.ts";
import { createFixtureApp } from "./helpers/native-app-fixture.js";
import { httpContractApp } from "./helpers/http-contract-app";
import { makeFakeBackend } from "./helpers/fake-backend";

const brain = "/srv/odysseus/brain";
const LETTER = "inbox/letter-from-antinous.md";
const MOVED = "people/suitors/antinous-letter.md";
const MESSAGE = "inbox/message-from-eurymachus.md";

test("a file tool or search that reads a marked file is a user_marked source; other reads are not", () => {
  const marked = (path: string) => path === MESSAGE;
  for (const [tool, input] of [
    ["Read", { file_path: `${brain}/${MESSAGE}` }], ["Read", { file_path: `${brain}/./inbox/../${MESSAGE}` }],
    ["Edit", { file_path: `${brain}/${MESSAGE}` }], ["Grep", { pattern: "Ithaca", path: MESSAGE }],
    ["Glob", { pattern: "*.md", path: `./${MESSAGE}` }], ["read_file", { path: MESSAGE }], ["edit_file", { path: MESSAGE }],
    ["grep", { pattern: "Ithaca", path: MESSAGE }], ["mcp__brain__brain_read", { path: MESSAGE }],
  ] as const) expect(inputTaintSource(tool, input, brain, marked), `MARKED_SOURCE_${tool}_${JSON.stringify(input)}`).toBe("user_marked");
  for (const [tool, input] of [
    ["Read", { file_path: `${brain}/${LETTER}` }], ["Write", { file_path: `${brain}/${MESSAGE}` }],
    // A view the host cannot name, and paths outside the brain, are not matched against marks.
    ["Read", { file_path: `/home/odysseus/view/${MESSAGE}` }], ["Read", { file_path: `../${MESSAGE}` }],
    ["Grep", { pattern: "Ithaca", path: "inbox" }], ["Bash", { command: `ls ${MESSAGE}` }],
  ] as const) expect(inputTaintSource(tool, input, brain, marked), `MARKED_CLEAN_${tool}_${JSON.stringify(input)}`).toBeNull();
  // An untrusted area still names its own source first.
  expect(inputTaintSource("Read", { file_path: `${brain}/workspaces/${MESSAGE}` }, brain, () => true)).toBe("workspace_read");
  // A search from an ancestor directory taints when its output names the marked file.
  expect(outputTaintSource("Grep", `${brain}/notes/a.md\n${brain}/${MESSAGE}`, brain, marked), "MARKED_SEARCH_OUTPUT").toBe("user_marked");
  expect(outputTaintSource("grep", `${MESSAGE}:3: Ithaca`, brain, marked)).toBe("user_marked");
  expect(outputTaintSource("Glob", `${brain}/${LETTER}`, brain, marked)).toBeNull();
  // The capabilities note names marked files among the untrusted sources.
  for (const egress of [false, true]) expect(workerOutwardNote(egress, null), "NOTE_NAMES_MARKED_FILES").toContain("or of a file the user marked untrusted");
});

const SECRET = "untrusted-marks-fixture-secret-0123456789";
async function passwordApp() {
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  for (const path of [LETTER, MESSAGE]) {
    mkdirSync(join(t.brainPath, "inbox"), { recursive: true });
    writeFileSync(join(t.brainPath, path), `# ${path}\n\nA fictional message for Penelope, dated 2026-07-12.\n`);
  }
  const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Safari on iPhone", ttlSeconds: 3600 });
  const agent = createPrincipal(t.app.db, { authMethod: "delegated", createdBy: owner.id, label: "Telemachus agent", ttlSeconds: 3600 });
  expect(agent.kind).toBe("agent");
  const as = async (principal: Principal) => {
    const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
    return (path: string, init: RequestInit = {}) => t.fetch(path, { ...init, headers: { cookie, origin: "http://localhost", host: "localhost", "content-type": "application/json" } });
  };
  return { t, owner, agent, asOwner: await as(owner), asReader: await as(agent) };
}
const q = (path: string) => `?path=${encodeURIComponent(path)}`;
const mark = async (call: (path: string, init?: RequestInit) => Response | Promise<Response>, path: unknown) =>
  call("/api/files/untrusted", { method: "PUT", body: JSON.stringify({ path }) });

test("a reader with read access marks; only the owner clears; direct requests cannot bypass either", async () => {
  const { t, asOwner, asReader, agent } = await passwordApp();
  try {
    expect((await t.fetch(`/api/files/untrusted${q(MESSAGE)}`)).status, "MARK_ROUTES_NEED_AUTHENTICATION").toBe(401);
    const before = await asReader(`/api/files/untrusted${q(MESSAGE)}`);
    expect(await before.json()).toEqual({ path: MESSAGE, marked: false, canClear: false });

    const marked = await mark(asReader, MESSAGE);
    expect(marked.status, "READER_MARKS_READABLE_FILE").toBe(200);
    const body = await marked.json() as { status: string; mark: Record<string, unknown> };
    expect(body).toMatchObject({ status: "marked", mark: { path: MESSAGE, marked: true, missing: false, canClear: false } });
    expect(body.mark, "READER_RESPONSE_OMITS_MARKER").not.toHaveProperty("markedBy");
    expect(JSON.stringify(body)).not.toContain(agent.label);
    expect(await (await mark(asReader, `./${MESSAGE}`)).json(), "SAME_RECORD_RACE").toMatchObject({ status: "already_marked" });

    // Marking grants nothing: no file, no traversal, no other syntax.
    expect((await mark(asReader, "inbox/no-such-letter.md")).status, "MARK_REFUSES_MISSING_FILE").toBe(404);
    expect((await mark(asReader, "inbox")).status, "MARK_REFUSES_DIRECTORY").toBe(404);
    for (const path of ["../outside.md", "/etc/passwd", "inbox/a:b.md"]) expect((await mark(asReader, path)).status, `MARK_REFUSES_${path}`).toBe(400);
    expect((await mark(asReader, 7)).status).toBe(400);
    expect(t.app.db.query("SELECT path FROM untrusted_marks ORDER BY path").all(), "REFUSALS_WROTE_NOTHING").toEqual([{ path: MESSAGE }]);

    const refused = await asReader(`/api/files/untrusted${q(MESSAGE)}`, { method: "DELETE" });
    expect(refused.status, "NON_OWNER_CLEAR_REFUSED").toBe(403);
    expect(await refused.json()).toEqual({ error: "owner_required" });
    expect((await asOwner(`/api/files/untrusted${q(MESSAGE)}`)).status).toBe(200);
    const owned = await (await asOwner(`/api/files/untrusted${q(MESSAGE)}`)).json();
    expect(owned, "OWNER_SEES_MARKER_LABEL").toMatchObject({ marked: true, canClear: true, markedBy: { label: "Telemachus agent", you: false } });

    const cleared = await asOwner(`/api/files/untrusted${q(MESSAGE)}`, { method: "DELETE" });
    expect(await cleared.json(), "OWNER_CLEAR_SUCCEEDS").toEqual({ status: "cleared" });
    expect(await (await asOwner(`/api/files/untrusted${q(MESSAGE)}`, { method: "DELETE" })).json()).toEqual({ status: "already_cleared" });
    // Clearing grants no access: an unreadable path stays unreadable.
    expect((await asReader(`/api/files/untrusted${q("../outside.md")}`)).status).toBe(400);
    expect((await asReader(`/api/files/content${q(MESSAGE)}`)).status).toBe(200);

    await mark(asOwner, MESSAGE);
    expect(await (await asOwner(`/api/files/untrusted${q(MESSAGE)}`)).json(), "OWNER_SEES_BY_YOU").toMatchObject({ markedBy: { label: "Safari on iPhone", you: true } });
  } finally { await t.close(); }
});

test("a moved file keeps its old-path mark, shown to the owner alone; the new path is not marked", async () => {
  const { t, asOwner, asReader, owner, agent } = await passwordApp();
  try {
    // The reader marks the letter itself, then the letter moves.
    await mark(asReader, LETTER);
    await mark(asOwner, MESSAGE);
    mkdirSync(join(t.brainPath, "people/suitors"), { recursive: true });
    renameSync(join(t.brainPath, LETTER), join(t.brainPath, MOVED));

    const ownerList = await (await asOwner("/api/files/untrusted/list")).json() as { marks: Array<Record<string, unknown>>; canClear: boolean };
    expect(ownerList.canClear).toBe(true);
    expect(ownerList.marks.map(row => [row.path, row.missing]), "OWNER_LIST_MISSING_FIRST").toEqual([[LETTER, true], [MESSAGE, false]]);
    expect(ownerList.marks[0]).toMatchObject({ markedBy: { label: agent.label, you: false } });
    expect(await (await asOwner(`/api/files/untrusted${q(LETTER)}`)).json(), "OWNER_MISSING_DETAIL").toMatchObject({ path: LETTER, marked: true, missing: true, canClear: true });

    const readerResponse = await asReader("/api/files/untrusted/list");
    const readerText = await readerResponse.text();
    expect(JSON.parse(readerText), "READER_LIST_PRESENT_ONLY").toEqual({ canClear: false, marks: [{ path: MESSAGE, marked: true, markedAt: expect.any(Number), missing: false }] });
    expect(readerText, "READER_LIST_NO_MISSING_PATH").not.toContain("antinous");
    for (const label of [owner.label, agent.label, "markedBy", "\"you\""]) expect(readerText, `READER_LIST_NO_IDENTITY_${label}`).not.toContain(label);
    const readerDetail = await asReader(`/api/files/untrusted${q(LETTER)}`);
    expect(readerDetail.status, "READER_MISSING_DETAIL_REFUSED").toBe(404);
    expect(await readerDetail.text()).not.toContain("marked");

    // Rename ruling B: nothing follows the move.
    expect(await (await asOwner(`/api/files/untrusted${q(MOVED)}`)).json(), "NEW_PATH_NOT_MARKED").toMatchObject({ path: MOVED, marked: false });
    expect((await asReader(`/api/files/untrusted${q(LETTER)}`, { method: "DELETE" })).status, "READER_CANNOT_CLEAR_MISSING").toBe(403);
    expect(await (await asOwner(`/api/files/untrusted${q(LETTER)}`, { method: "DELETE" })).json(), "OWNER_CLEARS_MISSING").toEqual({ status: "cleared" });
    expect((await (await asOwner("/api/files/untrusted/list")).json() as { marks: unknown[] }).marks).toHaveLength(1);
  } finally { await t.close(); }
});

async function until(check: () => boolean, diagnostic: () => unknown) {
  const end = Date.now() + 10_000;
  while (!check()) { if (Date.now() > end) throw new Error(JSON.stringify(diagnostic())); await Bun.sleep(5); }
}

test("marks survive a restart and brain index --force; reading a marked file taints, clearing spares only new sessions", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-untrusted-marks-")), brainPath = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brainPath);
  mkdirSync(join(brainPath, "inbox"), { recursive: true });
  for (const path of [LETTER, MESSAGE]) writeFileSync(join(brainPath, path), `# ${path}\n\nA fictional message for Penelope, dated 2026-07-12.\n`);
  // Each prompt names the brain-relative file the fixture backend reads.
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    const sessionId = request.sessionId ?? `voyage-${request.turnId}`;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    const file = request.prompt.trim();
    request.bridge.emit({ type: "tool_use_start", sessionId, toolUseId: `read-${request.turnId}`, toolName: "Read" });
    request.bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: `read-${request.turnId}`, toolName: "Read", input: { file_path: join(brainPath, file) } });
    request.bridge.emit({ type: "tool_result", sessionId, toolUseId: `read-${request.turnId}`, output: "A fictional message for Penelope.", isError: false });
    request.bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const start = () => createFixtureApp({ config: resolveServerConfig({ BRAIN_PATH: brainPath, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test",
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  const call = (app: Awaited<ReturnType<typeof start>>, path: string, init: RequestInit = {}) =>
    app.fetch(new Request(new URL(path, "http://localhost"), { ...init, headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" } }));
  let app = await start();
  try {
    expect((await mark((path, init) => call(app, path, init), LETTER)).status).toBe(200);
    await app.close();
    renameSync(join(brainPath, LETTER), join(brainPath, "inbox/antinous-letter.md"));
    const indexed = await runCli(brainPath, ["index", "--force"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    app = await start();
    const list = await (await call(app, "/api/files/untrusted/list")).json() as { marks: Array<{ path: string; missing: boolean }> };
    expect(list.marks.map(row => [row.path, row.missing]), "MARK_SURVIVES_RESTART_AND_INDEX_FORCE").toEqual([[LETTER, true]]);
    renameSync(join(brainPath, "inbox/antinous-letter.md"), join(brainPath, LETTER));
    expect((await mark((path, init) => call(app, path, init), MESSAGE)).status).toBe(200);

    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus marks", ttlSeconds: 60 });
    const chat = async (text: string, sessionId?: string) => {
      const handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [];
      const ws = { send: (frame: string) => sent.push(frame), close() {}, readyState: 1 } as WSContext;
      await handlers.onOpen(undefined as never, ws);
      const before = sent.length;
      handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text, requestId: `marks-${Math.random()}`, ...(sessionId ? { sessionId } : {}) }) } as MessageEvent, ws);
      await until(() => sent.slice(before).some(frame => frame.includes("\"result\"")) && !app.wsHost.coordinator.isTurnActive(), () => sent);
      handlers.onClose({ code: 1000 } as CloseEvent, ws);
      const info = sent.map(frame => JSON.parse(frame) as { type: string; sessionId?: string }).find(frame => frame.type === "session_info" && frame.sessionId);
      return info!.sessionId!;
    };
    const taints = (sessionId: string) => queryGovernanceEvents(app.db, { sessionId, kinds: ["taint"], limit: 10 }).map(event => event.payload);

    const clean = await chat("notes/raft-reference.md");
    expect(taints(clean), "UNMARKED_READ_RECORDS_NOTHING").toEqual([]);
    const tainted = await chat(MESSAGE);
    const markedSignal = expect.objectContaining({ source: "user_marked", tool: "Read", detail: null,
      occurrence: expect.objectContaining({ id: expect.any(String), epochId: expect.any(String),
        exposureId: expect.any(String), operationId: expect.any(String), signalId: expect.any(String),
        detector: "explicit_untrusted_input", exposure: "interrupted_unknown",
        admission: { trusted: false, trustRevision: "0", policyHash: null }, provenance: null }) });
    const retained = taints(tainted);
    expect(retained, "MARKED_READ_TAINTS").toEqual([markedSignal]);
    // The retained old-path record applies again once a file returns to it.
    const returned = await chat(LETTER);
    expect(taints(returned), "RETURNED_FILE_MARKED_AGAIN").toEqual([markedSignal]);

    expect(await (await call(app, `/api/files/untrusted${q(MESSAGE)}`, { method: "DELETE" })).json()).toEqual({ status: "cleared" });
    const fresh = await chat(MESSAGE);
    expect(taints(fresh), "CLEARED_MARK_SPARES_NEW_SESSION").toEqual([]);
    await chat(MESSAGE, tainted);
    expect(taints(tainted), "CLEARED_MARK_KEEPS_EXISTING_TAINT").toEqual(retained);
    expect(app.wsHost.activity!.governanceWrites!.safety(null, tainted), "CLEARED_MARK_KEEPS_UNRESOLVED_OCCURRENCE")
      .toMatchObject({ restriction: "restricted", unresolvedCount: 1 });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
