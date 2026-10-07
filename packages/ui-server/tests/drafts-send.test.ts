import { afterEach, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import type { ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { serverHelloSchema } from "@schlessera/brain-ui-sdk/schemas";
import { SESSION_DRAFT_LIMITS } from "@schlessera/brain-ui-sdk/protocol";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createPrincipal } from "../src/db/principals";
import { makeFakeBackend } from "./helpers/fake-backend";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

// An accepted chat message consumes exactly the draft revision it names, at
// the moment the host accepts it, over a real socket and the mounted routes.

const SECRET = "drafts-send-fixture-secret-0123456789";
const HeaderWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_BASE64 = Buffer.from(PNG).toString("base64");

/** A backend that names its session only when the test releases the turn. */
function heldBackend() {
  const starts: StartTurnRequest[] = [];
  const releases: Array<() => void> = [];
  let sessions = 0;
  const backend = makeFakeBackend({
    id: "fixture",
    async startTurn(req) {
      starts.push(req);
      await new Promise<void>((resolve) => releases.push(resolve));
      const sessionId = req.sessionId ?? `voyage-${++sessions}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId });
      req.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
    },
  });
  return { backend, starts, release: () => releases.shift()?.() };
}

async function harness() {
  const held = heldBackend();
  const t: HttpContractApp = await httpContractApp({
    registry: createStaticBackendRegistry([held.backend]),
    env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" },
  });
  cleanups.push(() => t.close());
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: t.app.fetch, websocket: t.app.websocket });
  cleanups.push(() => { server.stop(true); });
  const principal = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie); headers.set("origin", "http://localhost"); headers.set("host", "localhost");
    return t.fetch(path, { ...init, headers });
  };
  const put = async (draftId: string, ifMatch: number, key: string, body: { sessionId: string | null; text: string; attachmentIds: string[] }) =>
    call(`/api/drafts/${draftId}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": String(ifMatch), "idempotency-key": key }, body: JSON.stringify(body) });
  const upload = async (draftId: string, key: string) => (await (await call(`/api/drafts/${draftId}/attachments`, {
    method: "POST", headers: { "content-type": "image/png", "idempotency-key": key }, body: PNG,
  })).json() as { attachmentId: string }).attachmentId;
  const bind = (draftId: string, sessionId: string, requestId: string) => call(`/api/drafts/${draftId}/bind`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, requestId }),
  });

  const frames: ServerMessage[] = [];
  const ws = new HeaderWebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${server.port}` } });
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      frames.push(frame);
      if (frame.type === "server_hello") resolve();
    });
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  const until = async (condition: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) { if (condition()) return; await Bun.sleep(5); }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { t, held, call, put, upload, bind, frames, send: (frame: object) => ws.send(JSON.stringify(frame)), until };
}

test("server_hello advertises draft storage with its limits beside the boolean capabilities", async () => {
  const h = await harness();
  const hello = h.frames.find((f) => f.type === "server_hello");
  expect(hello).toMatchObject({ capabilities: { sessionDrafts: true }, sessionDraftLimits: SESSION_DRAFT_LIMITS });
  // A client built before #979 parses capabilities as booleans: the frame survives.
  expect(serverHelloSchema.safeParse(hello).success).toBe(true);
  expect(serverHelloSchema.safeParse({ ...hello, capabilities: { ...(hello as { capabilities: object }).capabilities, sessionDrafts: SESSION_DRAFT_LIMITS } }).success).toBe(false);
});

test("a delayed first-send acknowledgement keeps newer edits, and only that request can bind them to its session", async () => {
  const h = await harness();
  const image = await h.upload("draft-ithaca", "u-1");
  expect((await h.put("draft-ithaca", 0, "s-1", { sessionId: null, text: "Sail for Ithaca", attachmentIds: [image] })).status).toBe(200);
  expect((await h.put("draft-troy", 0, "t-1", { sessionId: null, text: "Leave Troy", attachmentIds: [] })).status).toBe(200);

  h.send({ type: "chat_message", text: "Sail for Ithaca", attachments: [{ data: PNG_BASE64, mediaType: "image/png" }],
    requestId: "request-ithaca", draftId: "draft-ithaca", draftRef: { draftId: "draft-ithaca", revision: 1 } });
  await h.until(() => h.held.starts.length === 1, "the turn to start");
  // Typed while the acknowledgement is still out: revision 2, image kept.
  expect((await h.put("draft-ithaca", 1, "s-2", { sessionId: null, text: "Sail for Ithaca, then rest", attachmentIds: [image] })).status).toBe(200);
  h.held.release();
  await h.until(() => h.frames.some((f) => f.type === "session_info"), "session_info");
  const info = h.frames.find((f) => f.type === "session_info") as Extract<ServerMessage, { type: "session_info" }>;
  expect(info).toMatchObject({ requestId: "request-ithaca", draftId: "draft-ithaca" });

  const kept = await (await h.call("/api/drafts/draft-ithaca")).json();
  expect(kept).toMatchObject({ revision: 2, sessionId: null, text: "Sail for Ithaca, then rest" });
  expect(kept.attachments).toHaveLength(1);
  expect(await (await h.call("/api/drafts/draft-troy")).json()).toMatchObject({ revision: 1, text: "Leave Troy" });

  // Only the accepted request's own draft binds to the session it started.
  expect(await (await h.bind("draft-ithaca", info.sessionId, "request-other")).json()).toMatchObject({ error: "DRAFT_NOT_ACCEPTED" });
  expect(await (await h.bind("draft-ithaca", "voyage-elsewhere", "request-ithaca")).json()).toMatchObject({ error: "DRAFT_NOT_ACCEPTED" });
  expect(await (await h.bind("draft-troy", info.sessionId, "request-ithaca")).json()).toMatchObject({ error: "DRAFT_NOT_ACCEPTED" });
  const bound = await h.bind("draft-ithaca", info.sessionId, "request-ithaca");
  expect(bound.status).toBe(200);
  expect(await bound.json()).toEqual({ revision: 3 });
  expect(await (await h.bind("draft-ithaca", info.sessionId, "request-ithaca")).json()).toEqual({ revision: 3 });
  expect(await (await h.call("/api/drafts/draft-ithaca")).json()).toMatchObject({ revision: 3, sessionId: info.sessionId, text: "Sail for Ithaca, then rest" });
  // A stale save from a device that still thinks the draft is unbound conflicts.
  const stale = await h.put("draft-ithaca", 3, "s-stale", { sessionId: null, text: "x", attachmentIds: [] });
  expect(stale.status).toBe(409);
});

test("an accepted send consumes its current revision and that draft's images, nothing else", async () => {
  const h = await harness();
  const mine = await h.upload("draft-ithaca", "u-1");
  const theirs = await h.upload("draft-troy", "u-2");
  expect((await h.put("draft-ithaca", 0, "s-1", { sessionId: null, text: "Sail for Ithaca", attachmentIds: [mine] })).status).toBe(200);
  expect((await h.put("draft-troy", 0, "t-1", { sessionId: null, text: "Leave Troy", attachmentIds: [theirs] })).status).toBe(200);
  h.send({ type: "chat_message", text: "Sail for Ithaca", attachments: [{ data: PNG_BASE64, mediaType: "image/png" }],
    requestId: "request-ithaca", draftId: "draft-ithaca", draftRef: { draftId: "draft-ithaca", revision: 1 } });
  await h.until(() => h.held.starts.length === 1, "the turn to start");
  // Not accepted yet: the draft is untouched while the turn is still unnamed.
  expect((await h.call("/api/drafts/draft-ithaca")).status).toBe(200);
  h.held.release();
  await h.until(() => h.frames.some((f) => f.type === "session_info"), "session_info");
  const gone = await h.call("/api/drafts/draft-ithaca");
  expect(gone.status).toBe(410);
  expect(await gone.json()).toMatchObject({ error: "DRAFT_DELETED", tombstoneRevision: 2 });
  expect(h.t.app.db.query("SELECT attachment_id FROM session_draft_attachments ORDER BY attachment_id").all()).toEqual([{ attachment_id: theirs }]);
  expect(await (await h.call("/api/drafts/draft-troy")).json()).toMatchObject({ revision: 1, text: "Leave Troy", attachments: [{ attachmentId: theirs }] });
  // A late autosave of the sent revision cannot bring it back.
  expect((await h.put("draft-ithaca", 1, "s-late", { sessionId: null, text: "Sail for Ithaca", attachmentIds: [] })).status).toBe(410);
});

test("a queued follow-up consumes its session's draft when queued; another session's draft and a stale ref stay", async () => {
  const h = await harness();
  // Start voyage-1 and hold it running.
  h.send({ type: "chat_message", text: "Sail for Ithaca", requestId: "r-1" });
  await h.until(() => h.held.starts.length === 1, "the first turn");
  h.held.release();
  await h.until(() => h.frames.some((f) => f.type === "result"), "the first result");
  h.send({ type: "chat_message", sessionId: "voyage-1", text: "Keep rowing", requestId: "r-2" });
  await h.until(() => h.held.starts.length === 2, "the resumed turn");

  expect((await h.put("draft-a", 0, "a-1", { sessionId: "voyage-1", text: "Then the Sirens", attachmentIds: [] })).status).toBe(200);
  expect((await h.put("draft-b", 0, "b-1", { sessionId: "voyage-2", text: "Elsewhere", attachmentIds: [] })).status).toBe(200);
  // Names voyage-1, but sent from voyage-2's draft: not this session's draft.
  h.send({ type: "chat_message", sessionId: "voyage-1", text: "Elsewhere", requestId: "r-3", draftRef: { draftId: "draft-b", revision: 1 } });
  // voyage-1's own draft, sent at its current revision.
  h.send({ type: "chat_message", sessionId: "voyage-1", text: "Then the Sirens", requestId: "r-4", draftRef: { draftId: "draft-a", revision: 1 } });
  await h.until(() => h.frames.filter((f) => f.type === "status" && f.status === "queued").length === 2, "both queued");
  expect((await h.call("/api/drafts/draft-a")).status).toBe(410);
  expect(await (await h.call("/api/drafts/draft-b")).json()).toMatchObject({ revision: 1, sessionId: "voyage-2" });
  h.held.release();
  await h.until(() => h.held.starts.length === 3, "the first queued turn");
  h.held.release();
  await h.until(() => h.held.starts.length === 4, "the second queued turn");
  h.held.release();
  await h.until(() => h.frames.filter((f) => f.type === "result").length === 4, "every result");
  expect(await (await h.call("/api/drafts/draft-b")).json()).toMatchObject({ revision: 1 });
});

test("a refused message consumes nothing", async () => {
  const h = await harness();
  expect((await h.put("draft-ithaca", 0, "s-1", { sessionId: null, text: "Sail", attachmentIds: [] })).status).toBe(200);
  // An invalid image is refused before routing: no acceptance, no consumption.
  h.send({ type: "chat_message", text: "Sail", attachments: [{ data: PNG_BASE64, mediaType: "image/tiff" }], requestId: "r-bad", draftRef: { draftId: "draft-ithaca", revision: 1 } });
  await h.until(() => h.frames.some((f) => f.type === "error"), "the refusal");
  expect(h.held.starts).toHaveLength(0);
  expect(await (await h.call("/api/drafts/draft-ithaca")).json()).toMatchObject({ revision: 1, text: "Sail" });
});

test("draft storage operations and a refused bind never start a turn", async () => {
  const h = await harness();
  const image = await h.upload("draft-quiet", "u");
  expect((await h.put("draft-quiet", 0, "s", { sessionId: null, text: "Hush", attachmentIds: [image] })).status).toBe(200);
  expect((await h.call("/api/drafts")).status).toBe(200);
  expect((await h.call("/api/drafts/draft-quiet")).status).toBe(200);
  expect(await (await h.bind("draft-quiet", "voyage-1", "r")).json()).toMatchObject({ error: "DRAFT_NOT_ACCEPTED" });
  expect((await h.call("/api/drafts/draft-quiet", { method: "DELETE", headers: { "if-match": "1" } })).status).toBe(204);
  await Bun.sleep(20);
  expect(h.held.starts).toHaveLength(0);
  // Only the connection's own hello and idle status: no session, turn or reply frame.
  expect(h.frames.filter((f) => !(f.type === "server_hello" || (f.type === "status" && f.status === "idle")))).toEqual([]);
});
