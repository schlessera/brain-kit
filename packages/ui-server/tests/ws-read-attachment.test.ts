import { afterEach, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import type { AttachmentFile, ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { AttachmentReadResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createPrincipal } from "../src/db/principals";
import { makeFakeBackend } from "./helpers/fake-backend";
import { httpContractApp } from "./helpers/http-contract-app";
import { ithacaPermitPdf, PERMIT_FACT } from "./helpers/odysseus-pdf";

// read_attachment through a real composition root and socket (#3154): the ws
// bridge binds the turn's own session, so the agent reads what this
// conversation was sent and nothing else, and the first message carries
// references only.

const SECRET = "read-attachment-fixture-secret-0123456789";
const HeaderWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

test("a turn reads its own conversation's PDF page through the ws bridge, and no other conversation's", async () => {
  const starts: StartTurnRequest[] = [];
  const reads: AttachmentReadResult[] = [];
  let sessions = 0, other: string | undefined;
  // The bridge offers host reads to the two first-party backends only, as it does Apify and compute.
  const backend = makeFakeBackend({
    id: "claude",
    async getHistory() { return []; },
    async startTurn(req) {
      starts.push(req);
      const sessionId = req.sessionId ?? `voyage-${++sessions}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId });
      const ids = [...req.prompt.matchAll(/"id":"([a-f0-9-]{36})"/g)].map((m) => m[1]!);
      for (const id of [...ids, ...(other ? [other] : [])]) reads.push(await req.bridge.readAttachment!({ id, pages: "2" }));
      req.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const t = await httpContractApp({ registry: createStaticBackendRegistry([backend]),
    env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
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
  const upload = async (draftId: string, name: string, body: Uint8Array) => {
    const res = await call(`/api/drafts/${draftId}/files`, { method: "POST", headers: { "idempotency-key": `${draftId}-${name}`, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body: body as BodyInit });
    expect(res.status).toBe(201);
    return await res.json() as AttachmentFile;
  };
  const frames: ServerMessage[] = [];
  const ws = new HeaderWebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${server.port}` } });
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve) => ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    frames.push(frame);
    if (frame.type === "server_hello") resolve();
  }));
  const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
  const send = async (draftId: string, file: AttachmentFile) => {
    const saved = await call(`/api/drafts/${draftId}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": "0", "idempotency-key": `${draftId}-save` },
      body: JSON.stringify({ sessionId: null, attachmentIds: [], text: "What does the permit allow?", fileIds: [file.fileId] }) });
    expect(saved.status).toBe(200);
    const results = frames.filter((f) => f.type === "result").length;
    ws.send(JSON.stringify({ type: "chat_message", text: "What does the permit allow?", requestId: `${draftId}-send`, draftId,
      draftRef: { draftId, revision: 1 }, attachmentRefs: [{ kind: "attachment", fileId: file.fileId }] }));
    await until(() => frames.filter((f) => f.type === "result" || f.type === "error").length > results);
    const err = frames.findLast((f) => f.type === "error"); if (err) throw new Error(JSON.stringify(err));
  };

  const troy = await upload("draft-troy", "troy-permit.pdf", ithacaPermitPdf());
  await send("draft-troy", troy);
  other = troy.fileId;
  const ithaca = await upload("draft-ithaca", "ithaca-permit.pdf", ithacaPermitPdf());
  await send("draft-ithaca", ithaca);

  // The first message names the original and carries none of its contents.
  expect(starts[1]!.prompt).toContain(ithaca.fileId);
  expect(starts[1]!.prompt, "WS_READ_ABSENT_AT_SEND").not.toContain(PERMIT_FACT);
  // Turn 1 read its own file; turn 2 read its own and was refused the other conversation's.
  expect(reads.map((r) => [r.id, r.outcome])).toEqual([[troy.fileId, "read"], [ithaca.fileId, "read"], [troy.fileId, "refused"]]);
  expect(reads[1]!.text, "WS_READ_FACT").toContain(PERMIT_FACT);
  const recorded = t.app.db.query("SELECT file_id, session_id, outcome FROM attachment_reads ORDER BY rowid").all();
  expect(recorded).toEqual([{ file_id: troy.fileId, session_id: "voyage-1", outcome: "read" }, { file_id: ithaca.fileId, session_id: "voyage-2", outcome: "read" }]);
});
