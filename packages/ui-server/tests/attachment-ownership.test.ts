import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import type { AttachmentFile, ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { serverHelloSchema } from "@schlessera/brain-ui-sdk/schemas";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createDraftStore, DraftError } from "../src/drafts/store";
import { makeFakeBackend } from "./helpers/fake-backend";
import { storeOriginal } from "./helpers/attachment-fixture";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

// Ownership of composer originals through a real composition root and socket
// (#3153): exact draft bindings, lineage, the outgoing snapshot, acceptance
// transfer and the provider-facing reference block. Every claim about an
// original is checked by reading the file at the path the agent was given.

const SECRET = "attachment-ownership-fixture-secret-0123456789";
const HeaderWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
const PDF = readFileSync(join(import.meta.dir, "../../core/fixtures/corpus/studies/star-chart.pdf"));
const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="38.2" lon="20.7"/><trkpt lat="38.2" lon="20.701"/></trkseg></trk></gpx>';
const PNG = (() => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); for (let i = 8; i < b.length; i++) b[i] = (i * 7) & 0xff; return b; })();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function harness() {
  const starts: StartTurnRequest[] = [];
  let sessions = 0;
  const backend = makeFakeBackend({
    id: "fixture",
    async getHistory() { return starts.map((req) => ({ role: "user" as const, content: req.prompt, toolCalls: [] })); },
    async startTurn(req) {
      starts.push(req);
      const sessionId = req.sessionId ?? `voyage-${++sessions}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId });
      req.bridge.emit({ type: "result", sessionId, durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const t: HttpContractApp = await httpContractApp({
    registry: createStaticBackendRegistry([backend]),
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
  const upload = async (draftId: string, name: string, body: Uint8Array | string, type = "application/octet-stream") => {
    const res = await call(`/api/drafts/${draftId}/files`, { method: "POST", headers: { "idempotency-key": `${draftId}-${name}`, "content-type": type, "x-file-name": encodeURIComponent(name) }, body: body as BodyInit });
    if (res.status !== 201) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
    return await res.json() as AttachmentFile;
  };
  const save = (draftId: string, ifMatch: number, key: string, body: Record<string, unknown>) =>
    call(`/api/drafts/${draftId}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": String(ifMatch), "idempotency-key": key }, body: JSON.stringify({ sessionId: null, attachmentIds: [], ...body }) });
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
  const refs = (fileId: string) => (t.app.db.query("SELECT owner, owner_id FROM attachment_refs WHERE file_id = ? ORDER BY owner").all(fileId) as { owner: string; owner_id: string }[])
    .map((r) => `${r.owner}:${r.owner_id}`);
  return { t, starts, call, upload, save, frames, until, refs, send: (frame: object) => ws.send(JSON.stringify(frame)) };
}

/** The `<brain-attachments>` entries a prompt carries. */
function attachmentBlock(prompt: string): Array<{ id: string; path: string; kind: string; sha256: string; inline?: boolean }> {
  const match = /<brain-attachments>\n[^\n]*\n[^\n]*\n(.*)\n<\/brain-attachments>$/s.exec(prompt);
  if (!match) throw new Error("no attachment block");
  return JSON.parse(match[1]!);
}

test("server_hello advertises composer files with their bounds", async () => {
  const h = await harness();
  const hello = h.frames.find((f) => f.type === "server_hello");
  expect(hello).toMatchObject({ capabilities: { composerFiles: true }, attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 } });
  expect(serverHelloSchema.safeParse(hello).success).toBe(true);
});

test("a sent message hands the agent real originals by path; acceptance transfers them to the conversation", async () => {
  const h = await harness();
  const pdf = await h.upload("draft-ithaca", "ithaca-permit.pdf", PDF, "application/pdf");
  const text = await h.upload("draft-ithaca", "crew-list.txt", "Eurylochus\nPerimedes\n", "text/plain");
  const image = await h.upload("draft-ithaca", "harbour.png", PNG, "image/png");
  const track = await h.upload("draft-ithaca", "dock-walk.gpx", GPX);
  const ids = [pdf, text, image, track].map((f) => f.fileId);
  expect((await h.save("draft-ithaca", 0, "s-1", { text: "Which harbour fees apply?", fileIds: ids })).status).toBe(200);
  for (const id of ids) expect(h.refs(id)).toEqual(["draft:draft-ithaca"]);

  h.send({ type: "chat_message", text: "Which harbour fees apply?", requestId: "request-ithaca", draftId: "draft-ithaca",
    draftRef: { draftId: "draft-ithaca", revision: 1 },
    attachments: [{ data: Buffer.from(PNG).toString("base64"), mediaType: "image/png", fileId: image.fileId }],
    attachmentRefs: ids.map((fileId) => ({ kind: "attachment", fileId })) });
  await h.until(() => h.frames.some((f) => f.type === "session_info"), "session_info");
  const prompt = h.starts[0]!.prompt;
  expect(prompt.startsWith("Which harbour fees apply?\n\n<brain-track-files>\n")).toBe(true);
  expect(prompt).toContain("Contents have not been read.");
  // No contents are injected: the PDF's text never reaches the prompt.
  expect(prompt).not.toContain("Odysseus star chart");
  const block = attachmentBlock(prompt);
  expect(block.map((e) => [e.id, e.kind])).toEqual([[pdf.fileId, "pdf"], [text.fileId, "text"], [image.fileId, "image"], [track.fileId, "track"]]);
  expect(block.find((e) => e.kind === "image")?.inline).toBe(true);
  // The agent opens each path and gets the uploaded original, byte for byte.
  const originals: Record<string, Uint8Array | string> = { pdf: PDF, text: "Eurylochus\nPerimedes\n", image: PNG, track: GPX };
  for (const entry of block) {
    const onDisk = readFileSync(join(h.t.brainPath, entry.path));
    expect(sha(onDisk)).toBe(sha(originals[entry.kind]!));
    expect(entry.sha256).toBe(sha(onDisk));
  }
  // The validated track keeps its existing block, pointing at its original.
  expect(prompt).toContain(`"path":"${track.path}"`);
  expect(prompt).toContain('"scope":"usable_sections"');
  expect(h.starts[0]!.attachments).toHaveLength(1);

  // Accepted: the conversation now owns the originals; the draft is consumed.
  const sessionId = (h.frames.find((f) => f.type === "session_info") as { sessionId: string }).sessionId;
  await h.until(() => h.refs(pdf.fileId).length === 1 && h.refs(pdf.fileId)[0] === `message:${sessionId}`, "the message reference");
  for (const id of ids) expect(h.refs(id)).toEqual([`message:${sessionId}`]);
  expect((await h.call("/api/drafts/draft-ithaca")).status).toBe(410);
  // Later turns can still read the same original, and so can its owner.
  expect(sha(Buffer.from(await (await h.call(`/api/attachments/${pdf.fileId}`)).arrayBuffer()))).toBe(sha(PDF));

  // Replay shows the user's own text, with the originals as recorded.
  h.send({ type: "session_resume", sessionId });
  await h.until(() => h.frames.some((f) => f.type === "session_history"), "history");
  const history = h.frames.findLast((f) => f.type === "session_history") as Extract<ServerMessage, { type: "session_history" }>;
  expect(history.messages[0]!.content).toBe("Which harbour fees apply?");
  expect(history.messages[0]!.attachmentFiles?.map((f) => f.fileId)).toEqual(ids);
  // Legacy staged tracks stay in `files`; an attached track reports its evidence on its original.
  expect(history.messages[0]!.files).toBeUndefined();
  expect(history.messages[0]!.attachmentFiles?.find((f) => f.kind === "track")?.track?.path).toBe(track.path);
});

test("references the client cannot back are refused before a backend runs", async () => {
  const h = await harness();
  const mine = await h.upload("draft-ithaca", "crew-list.txt", "Eurylochus\n", "text/plain");
  const theirs = await h.upload("draft-troy", "horse.txt", "wooden\n", "text/plain");
  const unsaved = await h.upload("draft-ithaca", "unsaved.txt", "not yet\n", "text/plain");
  expect((await h.save("draft-ithaca", 0, "s-1", { text: "Sail", fileIds: [mine.fileId] })).status).toBe(200);
  expect((await h.save("draft-troy", 0, "t-1", { text: "Stay", fileIds: [theirs.fileId] })).status).toBe(200);
  // Cross-draft binding is refused at save, by lineage.
  const cross = await h.save("draft-ithaca", 1, "s-2", { text: "Sail", fileIds: [mine.fileId, theirs.fileId] });
  expect([cross.status, (await cross.json() as { error: string }).error]).toEqual([400, "ATTACHMENT_INVALID"]);

  const errors = () => h.frames.filter((f) => f.type === "error") as Array<{ code: string; requestId?: string; message: string }>;
  const attempt = async (requestId: string, frame: Record<string, unknown>) => {
    h.send({ type: "chat_message", text: "Sail", requestId, draftId: "draft-ithaca", ...frame });
    // Whichever comes first: a refusal, or a backend that should never have run.
    await h.until(() => errors().some((e) => e.requestId === requestId) || h.starts.length > 0, requestId);
    expect(h.starts).toHaveLength(0);
    return errors().find((e) => e.requestId === requestId)!;
  };
  const ref = (fileId: string) => ({ kind: "attachment", fileId });
  const draftRef = { draftId: "draft-ithaca", revision: 1 };
  expect(await attempt("no-draft", { attachmentRefs: [ref(mine.fileId)] })).toMatchObject({ code: "ATTACHMENT_REJECTED" });
  expect(await attempt("cross", { draftRef, attachmentRefs: [ref(theirs.fileId)] })).toMatchObject({ code: "ATTACHMENT_REJECTED" });
  expect(await attempt("unsaved", { draftRef, attachmentRefs: [ref(unsaved.fileId)] })).toMatchObject({ code: "ATTACHMENT_REJECTED" });
  expect(await attempt("unknown", { draftRef, attachmentRefs: [ref(crypto.randomUUID())] })).toMatchObject({ code: "ATTACHMENT_REJECTED" });
  expect(await attempt("frame", { draftRef, attachmentRefs: [ref(mine.fileId)],
    attachments: [{ data: Buffer.from(PNG).toString("base64"), mediaType: "image/png", fileId: theirs.fileId }] })).toMatchObject({ code: "ATTACHMENT_REJECTED" });
  // An altered original, and one replaced by a link to outside the store.
  const abs = join(h.t.brainPath, mine.path);
  chmodSync(abs, 0o644); writeFileSync(abs, "Polyphemus\n");
  expect(await attempt("altered", { draftRef, attachmentRefs: [ref(mine.fileId)] })).toMatchObject({ code: "ATTACHMENT_REJECTED", message: expect.stringContaining("changed") });
  const outside = join(h.t.root, "outside.txt");
  writeFileSync(outside, "Eurylochus\n");
  unlinkSync(abs); symlinkSync(outside, abs);
  expect(await attempt("symlink", { draftRef, attachmentRefs: [ref(mine.fileId)] })).toMatchObject({ code: "ATTACHMENT_REJECTED" });
  expect(h.starts).toHaveLength(0);
});

test("saved file bindings and the outgoing snapshot survive a restart; acceptance keeps newer edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-attachments-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "ui.db");
  let clock = 1_000_000;
  let db = createUiDb(dbPath);
  let store = createDraftStore(db, { now: () => clock });
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 365 * 24 * 3600 }).id;
  const sent = storeOriginal(dir, store, owner, "draft-ithaca", "ithaca-permit.pdf", PDF);
  const later = storeOriginal(dir, store, owner, "draft-ithaca", "crew-list.txt", "Eurylochus\n");
  // Send was pressed while editing continued: the snapshot owns `sent`, the
  // newer revision only `later`.
  store.save(owner, "draft-ithaca", { ifMatch: 0, idempotencyKey: "s1", sessionId: null, text: "Fees?", attachmentIds: [], fileIds: [sent.fileId] });
  store.save(owner, "draft-ithaca", { ifMatch: 1, idempotencyKey: "s2", sessionId: null, text: "And the crew?", attachmentIds: [], fileIds: [later.fileId],
    outgoing: { requestId: "request-fees", text: "Fees?", fileIds: [sent.fileId], state: "held" } });
  db.close();

  // A normal restart: the exact acknowledged revision and its bindings return.
  db = createUiDb(dbPath);
  store = createDraftStore(db, { now: () => clock });
  const restored = store.get(owner, "draft-ithaca");
  expect(restored).toMatchObject({ revision: 2, text: "And the crew?", outgoing: { requestId: "request-fees", fileIds: [sent.fileId], state: "held" } });
  expect(restored.files?.map((f) => [f.fileId, f.path])).toEqual([[later.fileId, later.path]]);
  expect(store.list(owner).drafts[0]).toMatchObject({ fileCount: 1 });

  // The held send is accepted against revision 1: the snapshot's file moves to
  // the conversation, the snapshot clears, and the newer revision stays.
  clock += 1_000;
  expect(store.accept({ draftRef: { draftId: "draft-ithaca", revision: 1 }, sessionId: "voyage-1", resumed: false, requestId: "request-fees", principalId: owner, fileIds: [sent.fileId] })).toBe("kept");
  const after = store.get(owner, "draft-ithaca");
  expect(after).toMatchObject({ revision: 2, text: "And the crew?" });
  expect(after).not.toHaveProperty("outgoing");
  expect(store.attachmentRef(sent.fileId, "message", "voyage-1")).toBe(true);
  expect(store.attachmentRef(sent.fileId, "outgoing", "draft-ithaca")).toBe(false);
  expect(store.attachmentRef(later.fileId, "draft", "draft-ithaca")).toBe(true);
  // Acceptance never binds a file of another draft, whatever the message named.
  const foreign = storeOriginal(dir, store, owner, "draft-troy", "horse.txt", "wooden\n");
  store.accept({ draftRef: { draftId: "draft-ithaca", revision: 2 }, sessionId: "voyage-1", resumed: true, principalId: owner, fileIds: [foreign.fileId] });
  expect(store.attachmentReferenced(foreign.fileId)).toBe(false);
  db.close();
});

test("the per-draft envelope counts images and refuses an oversized combined batch", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-attachments-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = createUiDb(":memory:");
  cleanups.push(() => db.close());
  const store = createDraftStore(db, { limits: { maxDraftFilesBytes: 30 } });
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 }).id;
  const a = storeOriginal(dir, store, owner, "draft-a", "a.txt", "x".repeat(20));
  const refused = (() => { try { storeOriginal(dir, store, owner, "draft-a", "b.txt", "y".repeat(20)); } catch (e) { return e; } })();
  expect(refused).toBeInstanceOf(DraftError);
  expect((refused as DraftError).body).toMatchObject({ error: "ATTACHMENT_TOO_LARGE", bound: "draftFiles", limit: 30 });
  // The old 8 MiB draft ceiling no longer bounds file originals.
  const roomy = createDraftStore(db, { limits: { maxDraftBytes: 10 } });
  const big = storeOriginal(dir, roomy, owner, "draft-b", "log.txt", "z".repeat(5_000));
  expect(roomy.save(owner, "draft-b", { ifMatch: 0, idempotencyKey: "s", sessionId: null, text: "log", attachmentIds: [], fileIds: [big.fileId] })).toMatchObject({ revision: 1 });
  expect(a.bytes).toBe(20);
});
