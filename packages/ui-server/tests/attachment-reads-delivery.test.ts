import { afterEach, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import type { AttachmentFile, ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { SessionAttachmentReadsResponse } from "@schlessera/brain-ui-sdk/protocol";
// Namespace imports, so a host without the feature fails on an assertion, not at module load.
import * as protocol from "@schlessera/brain-ui-sdk/protocol";
import * as schemas from "@schlessera/brain-ui-sdk/schemas";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { makeFakeBackend } from "./helpers/fake-backend";
import { httpContractApp } from "./helpers/http-contract-app";
import { ithacaPermitPdf, PERMIT_FACT } from "./helpers/odysseus-pdf";

// Delivering recorded attachment reads to the browser (#3589): a client
// viewing a session gets the reads of the originals that session was sent,
// outcome and scope only, through `GET /api/sessions/:id/attachment-reads`;
// a read recorded during a live turn reaches declaring connections as one
// `attachment_read` frame. Nothing of it is provider context.

const SECRET = "attachment-reads-fixture-secret-0123456789";
/** The capability's wire name, spelled out: the contract is the string. */
const ATTACHMENT_READS = "attachmentReads";
const HeaderWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function harness() {
  const starts: StartTurnRequest[] = [];
  let sessions = 0;
  let readAlso: string | undefined;
  const backend = makeFakeBackend({
    id: "claude",
    async getHistory() { return []; },
    async startTurn(req) {
      starts.push(req);
      const sessionId = req.sessionId ?? `voyage-${++sessions}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId });
      const ids = [...req.prompt.matchAll(/"id":"([a-f0-9-]{36})"/g)].map((m) => m[1]!);
      for (const id of ids) await req.bridge.readAttachment!({ id, pages: "2" });
      // A read of another conversation's file is refused, and never recorded.
      if (readAlso) await req.bridge.readAttachment!({ id: readAlso });
      req.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const t = await httpContractApp({ registry: createStaticBackendRegistry([backend]),
    env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  cleanups.push(() => t.close());
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: t.app.fetch, websocket: t.app.websocket });
  cleanups.push(() => { server.stop(true); });

  const login = async (label: string) => {
    const principal = createPrincipal(t.app.db, { authMethod: "password", label, ttlSeconds: 3600 });
    const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
    const call = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie); headers.set("origin", "http://localhost"); headers.set("host", "localhost");
      return t.fetch(path, { ...init, headers });
    };
    /** A socket that declares `capabilities` in its client_hello. */
    const connect = async (capabilities: Record<string, boolean>) => {
      const frames: ServerMessage[] = [];
      const ws = new HeaderWebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${server.port}` } });
      cleanups.push(() => ws.close());
      await new Promise<void>((resolve) => ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        frames.push(frame);
        if (frame.type === "server_hello") resolve();
      }));
      ws.send(JSON.stringify({ type: "client_hello", protocolRev: 5, capabilities }));
      // The socket's messages are handled in order, so the pong follows the
      // hello's handler: the declared capabilities are recorded by then.
      const probeId = `hello-${crypto.randomUUID()}`;
      const ponged = new Promise<void>((resolve) => ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "pong" && frame.probeId === probeId) resolve();
      }));
      ws.send(JSON.stringify({ type: "ping", probeId }));
      await ponged;
      return { frames, send: (frame: object) => ws.send(JSON.stringify(frame)) };
    };
    return { principal, call, connect };
  };

  // A wall-clock deadline, not an iteration count: a turn spawns the PDF
  // extractor, which a loaded host can slow well past a couple of seconds.
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 20_000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(10);
    expect(condition()).toBe(true);
  };
  return { t, starts, login, until, readAlso: (id: string | undefined) => { readAlso = id; } };
}

test("a client viewing a session gets that session's recorded reads, live and on request, and nothing else", async () => {
  const h = await harness();
  const phone = await h.login("Odysseus phone");
  const viewer = await phone.connect({ [ATTACHMENT_READS]: true });
  const legacy = await phone.connect({});
  expect(viewer.frames.find((f) => f.type === "server_hello"), "READS_ADVERTISED").toMatchObject({ capabilities: { [ATTACHMENT_READS]: true } });
  expect((protocol as Record<string, unknown>).ATTACHMENT_READS_CAPABILITY).toBe(ATTACHMENT_READS);

  const upload = async (draftId: string, name: string) => {
    const res = await phone.call(`/api/drafts/${draftId}/files`, { method: "POST", headers: { "idempotency-key": `${draftId}-${name}`, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body: ithacaPermitPdf() as BodyInit });
    expect(res.status).toBe(201);
    return await res.json() as AttachmentFile;
  };
  const send = async (draftId: string, file: AttachmentFile) => {
    const saved = await phone.call(`/api/drafts/${draftId}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": "0", "idempotency-key": `${draftId}-save` },
      body: JSON.stringify({ sessionId: null, attachmentIds: [], text: "What does the permit allow?", fileIds: [file.fileId] }) });
    expect(saved.status).toBe(200);
    const results = viewer.frames.filter((f) => f.type === "result").length;
    viewer.send({ type: "chat_message", text: "What does the permit allow?", requestId: `${draftId}-send`, draftId,
      draftRef: { draftId, revision: 1 }, attachmentRefs: [{ kind: "attachment", fileId: file.fileId }] });
    await h.until(() => viewer.frames.filter((f) => f.type === "result" || f.type === "error").length > results);
    const err = viewer.frames.findLast((f) => f.type === "error"); if (err) throw new Error(JSON.stringify(err));
  };

  const troy = await upload("draft-troy", "troy-permit.pdf");
  await send("draft-troy", troy);
  h.readAlso(troy.fileId);
  const ithaca = await upload("draft-ithaca", "ithaca-permit.pdf");
  await send("draft-ithaca", ithaca);

  // Live: each recorded read reached the declaring connection as its own frame, without a reload.
  const live = viewer.frames.filter((f) => f.type === "attachment_read");
  expect(live.map((f) => schemas.serverMessageSchema.safeParse(f).success)).toEqual([true, true]);
  expect(live).toMatchObject([
    { sessionId: "voyage-1", read: { fileId: troy.fileId, outcome: "read", scope: { pages: [2, 2], pageCount: 3 } } },
    { sessionId: "voyage-2", read: { fileId: ithaca.fileId, outcome: "read", scope: { pages: [2, 2], pageCount: 3 } } },
  ]);
  // A connection that did not declare the flag never gets one.
  expect(legacy.frames.some((f) => f.type === "attachment_read")).toBe(false);
  // No text, and nothing of the frame is in what the provider saw.
  expect(JSON.stringify(live)).not.toContain(PERMIT_FACT);
  for (const start of h.starts) expect(start.prompt).not.toContain("attachment_read");

  // On request: the session's own reads, and not the other conversation's.
  const reads = async (sessionId: string) => {
    const res = await phone.call(`/api/sessions/${sessionId}/attachment-reads`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as SessionAttachmentReadsResponse;
    expect((schemas as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>).sessionAttachmentReadsResponseSchema!.safeParse(body).success).toBe(true);
    return body;
  };
  const voyage2 = await reads("voyage-2");
  expect(voyage2.sessionId).toBe("voyage-2");
  expect(voyage2.reads.map((r) => [r.fileId, r.outcome])).toEqual([[ithaca.fileId, "read"]]);
  expect(JSON.stringify(voyage2)).not.toContain(PERMIT_FACT);
  expect((await reads("voyage-1")).reads.map((r) => r.fileId)).toEqual([troy.fileId]);
  expect((await reads("voyage-unknown")).reads).toEqual([]);

  // A read row naming a file this session was never sent is not shown on it.
  h.t.app.db.prepare("INSERT INTO attachment_reads (file_id, session_id, turn_id, outcome, scope_json, created_at) VALUES (?, 'voyage-2', 'turn-stray', 'read', NULL, 1)").run(troy.fileId);
  expect((await reads("voyage-2")).reads.map((r) => r.fileId), "READS_SESSION_BOUNDARY").toEqual([ithaca.fileId]);
  // Nor does a read recorded for another session show on this one.
  expect((await reads("voyage-1")).reads.map((r) => r.fileId), "READS_OTHER_SESSION").toEqual([troy.fileId]);

  // Another login's principal: a usable one has this host's shared view; a
  // revoked one gets the auth envelope and nothing about the session.
  const laptop = await h.login("Penelope laptop");
  expect((await laptop.call("/api/sessions/voyage-2/attachment-reads")).status).toBe(200);
  revokePrincipal(h.t.app.db, laptop.principal.id, Date.now());
  const refused = await laptop.call("/api/sessions/voyage-2/attachment-reads");
  expect(refused.status).toBe(401);
  expect(JSON.stringify(await refused.json())).not.toContain(ithaca.fileId);
});
