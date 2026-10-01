import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { WsHost } from "../src/ws/host.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { stageShare } from "../src/share/staging.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const gpx = '<gpx version="1.1"><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.001"/></trkseg></trk></gpx>';
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(5); } throw Error("Track turn did not settle."); }

test("actual dispatch carries nonempty server-derived track evidence through first and queued turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-track-")); roots.push(root);
  const staged = await stageShare(root, { files: [new File([gpx], "shared-1", { type: "application/octet-stream" })] });
  const path = staged.files[0]!.path;
  const calls: StartTurnRequest[] = [], frames: ServerMessage[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const backend = makeFakeBackend({ id: "track-test", async getHistory() { return calls.map(req => ({ role: "user" as const, content: req.prompt, toolCalls: [] })); }, async startTurn(req) {
    calls.push(req);
    req.bridge.emit({ type: "session_info", sessionId: "track-session", isNew: calls.length === 1 });
    if (calls.length === 1) await held;
    req.bridge.emit({ type: "result", sessionId: "track-session", durationMs: 1, numTurns: 1, isError: false });
  } });
  const db = createUiDb(":memory:");
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) };
  host.clients.add(ws, "test-principal");
  const connection = { principal: testPrincipal(), authorization: testAuthorization() };
  const image = { mediaType: "image/png" as const, data: "YWJj" };
  try {
    await handleClientMessage(host, ws, { type: "chat_message", text: "Show this file", attachments: [image], files: [{ kind: "file", path }] }, connection);
    await until(() => calls.length === 1);
    expect(calls[0]!.prompt).toContain(path);
    expect(calls[0]!.prompt).toContain('"distance":{"value":111.');
    expect(calls[0]!.prompt).toContain('"mediaType":"application/octet-stream"');
    expect(calls[0]!.prompt).toContain("timestamps do not prove travel");
    expect(calls[0]!.attachments).toEqual([image]);
    await handleClientMessage(host, ws, { type: "chat_message", sessionId: "track-session", text: "Compare this file", attachments: [image], files: [{ kind: "file", path }], requestId: "queued-track" }, connection);
    expect(frames.some(f => f.type === "status" && f.status === "queued")).toBe(true);
    release();
    await until(() => calls.length === 2 && !host.coordinator.isTurnActive());
    expect(calls[1]!.attachments).toEqual([image]);
    expect(calls[1]!.prompt).toContain(path);
    expect(calls[1]!.prompt).toContain('"scope":"usable_sections"');
    expect(await readFile(join(root, path), "utf8")).toBe(gpx);
    await handleClientMessage(host, ws, { type: "session_resume", sessionId: "track-session" }, connection);
    const history = frames.findLast(f => f.type === "session_history");
    if (history?.type !== "session_history") throw Error("No replayed history.");
    expect(history.messages.map(m => m.content)).toEqual(["Show this file", "Compare this file"]);
    expect(history.messages.map(m => m.files?.[0]?.path)).toEqual([path, path]);
    expect(history.messages[0]!.files![0]!.summary!.measurements.distance.value!).toBeGreaterThan(100);
  } finally { release(); host.coordinator.reset(); host.close(); db.close(); }
});

test("the real socket parser refuses bad file references before a backend runs", async () => {
  let calls = 0;
  const backend = makeFakeBackend({ id: "refusal-test", async startTurn() { calls++; } });
  const db = createUiDb(":memory:");
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  const frames: ServerMessage[] = [], ws = { send: (raw: string) => frames.push(JSON.parse(raw)) };
  const handlers = createWsHandlers(host, testPrincipal());
  try {
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "bad kind", files: [{ kind: "image", path: "whatever" }] }) } as MessageEvent, ws);
    await until(() => frames.length > 0);
    expect(frames[0]).toMatchObject({ type: "error", code: "PARSE_ERROR" });
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "bad path", files: [{ kind: "file", path: "/etc/passwd" }] }) } as MessageEvent, ws);
    await until(() => frames.length > 1);
    expect(frames[1]).toMatchObject({ type: "error", code: "ATTACHMENT_REJECTED" });
    expect(calls).toBe(0);
  } finally { host.coordinator.reset(); host.close(); db.close(); }
});

import { writeFile } from "node:fs/promises";
import { resolveChatFiles, withTrackFiles } from "../src/tracks/read.js";

test("track Retry refuses changed original bytes before acceptance and retains eligibility for an exact retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "retry-track-")); roots.push(root);
  const originalBytes = gpx.replace("<trk>", "<!--original--><trk>");
  const changedBytes = originalBytes.replace("original", "modified");
  expect(changedBytes.length).toBe(originalBytes.length);
  const staged = await stageShare(root, { files: [new File([originalBytes], "loop.gpx")] });
  const path = staged.files[0]!.path;
  const files = await resolveChatFiles(root, [{ kind: "file", path }]);
  expect(files[0]!.sha256).toHaveLength(64); expect(files[0]!.summary!.counts.retained).toBe(2);
  const prompt = withTrackFiles("Show the original", files);
  const calls: StartTurnRequest[] = [], frames: ServerMessage[] = [];
  const backend = makeFakeBackend({ id: "retry-track", async startTurn(request) {
    calls.push(request);
    request.bridge.emit({ type: "session_info", sessionId: "retry-track-session", isNew: false });
    request.bridge.emit({ type: "result", sessionId: "retry-track-session", numTurns: 1, durationMs: 1, isError: false });
  } });
  const db = createUiDb(":memory:"); const catalog = createSessionCatalog(() => db);
  catalog.persistSessionStub("retry-track-session", "Show the original", null, backend.id);
  expect(catalog.saveRetryRequest!("retry-track-session", "failed-track", "test-principal", { type: "chat_message", text: "Show the original", files: [{ kind: "file", path }] }, prompt, { errorClass: "server_error", message: "Provider failed" })).toBe(true);
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog });
  const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) }; host.clients.add(ws, "test-principal");
  const connection = { principal: testPrincipal(), authorization: testAuthorization() };
  try {
    // Same geometry and metrics, different original bytes: only the fingerprint notices.
    await writeFile(join(root, path), changedBytes);
    await handleClientMessage(host, ws, { type: "retry_turn", sessionId: "retry-track-session", failedTurnId: "failed-track", requestId: "changed-file" }, connection);
    expect(calls).toHaveLength(0);
    expect(frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "refused" });
    expect((frames.at(-1) as { message?: string }).message).toContain("changed");
    expect(catalog.peekRetry!("retry-track-session")!.prompt).toBe(prompt);
    await rm(join(root, path));
    await handleClientMessage(host, ws, { type: "retry_turn", sessionId: "retry-track-session", failedTurnId: "failed-track", requestId: "expired-file" }, connection);
    expect(frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "refused" }); expect(calls).toHaveLength(0);
    await writeFile(join(root, path), originalBytes);
    await handleClientMessage(host, ws, { type: "retry_turn", sessionId: "retry-track-session", failedTurnId: "failed-track", requestId: "exact-file" }, connection);
    await until(() => calls.length === 1 && !host.coordinator.isTurnActive());
    expect(calls[0]!.prompt).toBe(prompt);
    const receipt = frames.find(f => f.type === "retry_receipt" && f.requestId === "exact-file");
    expect(receipt?.type === "retry_receipt" && receipt.files?.[0]?.sha256).toBe(files[0]!.sha256);
  } finally { host.coordinator.reset(); host.close(); db.close(); }
});

test("a native live follow-up receives validated track evidence and replay restores its nonempty file chip", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-track-")); roots.push(root);
  const staged = await stageShare(root, { files: [new File([gpx], "shared-1")] }); const path = staged.files[0]!.path;
  const transcript: import("@schlessera/brain-ui-sdk/protocol").SessionHistoryMessage[] = [];
  const followUps: import("@schlessera/brain-ui-sdk/server").FollowUpRequest[] = [];
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const backend = makeFakeBackend({ id: "native-track", capabilities: { followUp: true }, async getHistory() { return transcript; }, async startTurn(request) {
    request.bridge.emit({ type: "session_info", sessionId: "native-track-session", isNew: true }); transcript.push({ role: "user", content: request.prompt, toolCalls: [] });
    await held; transcript.push({ role: "assistant", content: "The original is available.", toolCalls: [] });
    request.bridge.emit({ type: "result", sessionId: "native-track-session", isError: false, durationMs: 1, numTurns: 1 });
  }, async followUp(request) { followUps.push(request); transcript.push({ role: "user", content: request.prompt, toolCalls: [] }); } });
  const db = createUiDb(":memory:"); const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  const frames: ServerMessage[] = [], ws = { send: (raw: string) => frames.push(JSON.parse(raw)) }; host.clients.add(ws, "test-principal");
  const connection = { principal: testPrincipal(), authorization: testAuthorization() };
  try {
    await handleClientMessage(host, ws, { type: "chat_message", text: "Wait for my track" }, connection); await until(() => transcript.length === 1);
    await handleClientMessage(host, ws, { type: "chat_message", text: "Use this original", sessionId: "native-track-session", files: [{ kind: "file", path }] }, connection);
    expect(followUps).toHaveLength(1); expect(followUps[0]!.prompt).toContain(path); expect(followUps[0]!.prompt).toContain('"retained":2'); expect(followUps[0]!.prompt).toContain('"sha256"');
    release(); await until(() => !host.coordinator.isTurnActive());
    await handleClientMessage(host, ws, { type: "session_resume", sessionId: "native-track-session" }, connection);
    const replay = frames.findLast(frame => frame.type === "session_history"); if (replay?.type !== "session_history") throw Error("No replay.");
    expect(replay.messages[1]!.content).toBe("Use this original"); expect(replay.messages[1]!.files).toHaveLength(1); expect(replay.messages[1]!.files![0]!.summary!.counts.retained).toBe(2);
  } finally { release(); host.coordinator.reset(); host.close(); db.close(); }
});

for (const withFile of [true, false]) {
  test(`a catalog without pre-reservation reads ${withFile ? "omits file Retry" : "retains text Retry"} on a real failed turn`, async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-track-")); roots.push(root);
    const staged = await stageShare(root, { files: [new File([gpx], "loop.gpx")] });
    const db = createUiDb(":memory:"); const catalog = createSessionCatalog(() => db);
    delete catalog.peekRetry;
    const calls: StartTurnRequest[] = [], frames: ServerMessage[] = [];
    const backend = makeFakeBackend({ id: "old-catalog", async startTurn(request) {
      calls.push(request);
      request.bridge.emit({ type: "session_info", sessionId: "catalog-session", isNew: true });
      request.bridge.emit({ type: "result", sessionId: "catalog-session", numTurns: 1, durationMs: 1, isError: true, outcome: "error", failure: { errorClass: "server_error", message: "Provider failed" } });
    } });
    const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog });
    const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) }; host.clients.add(ws, "test-principal");
    try {
      await handleClientMessage(host, ws, { type: "chat_message", text: "Use my evidence", ...(withFile ? { files: [{ kind: "file", path: staged.files[0]!.path }] } : {}) }, { principal: testPrincipal(), authorization: testAuthorization() });
      await until(() => calls.length === 1 && !host.coordinator.isTurnActive());
      const result = frames.findLast(frame => frame.type === "result");
      expect(result?.type).toBe("result");
      if (result?.type !== "result") throw Error("No actual failed-turn frame.");
      expect(result.failure?.errorClass).toBe("server_error");
      if (withFile) {
        expect(calls[0]!.prompt).toContain('"retained":2');
        expect(result.retryOfTurnId).toBeUndefined();
        expect(db.query("SELECT COUNT(*) AS n FROM retry_requests").get()).toEqual({ n: 0 });
      } else {
        expect(result.retryOfTurnId).toBeTruthy();
        expect(db.query("SELECT COUNT(*) AS n FROM retry_requests").get()).toEqual({ n: 1 });
      }
    } finally { host.coordinator.reset(); host.close(); db.close(); }
  });
}
