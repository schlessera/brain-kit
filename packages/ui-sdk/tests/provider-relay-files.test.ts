/**
 * The Gemini Files lifecycle through the CLI provider relay (#2738): the
 * upload start, the byte upload to an upload URL the host validated and
 * registered, the poll and delete of handles this relay's own uploads created,
 * and a generation that names them. A worker-chosen upload URL, a foreign
 * handle and a blocked budget are refused before contact; files a turn leaves
 * behind are deleted when its relay stops.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { startProviderRelay, type ProviderRelay, type ProviderRelayOptions, type ProviderRelayReceipt, type ProviderRelayRefusal } from "../src/server/provider-relay.js";

const HOST_KEY = "odysseus-host-gemini";
interface Seen { method: string; path: string; headers: Record<string, string>; bytes: number }
let upstream: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
/** Where the fictional provider says the bytes go; a test may point it elsewhere. */
let uploadUrl: () => string;
let fileCounter = 0;

beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const bytes = (await request.arrayBuffer()).byteLength;
    seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), bytes });
    if (url.pathname === "/upload/v1beta/files" && !url.search) return Response.json({}, { headers: { "x-goog-upload-url": uploadUrl() } });
    if (url.pathname === "/upload/v1beta/files") {
      const name = `files/ithaca-${++fileCounter}`;
      return Response.json({ file: { name, uri: `${upstream.url.origin}/v1beta/${name}`, mimeType: "video/mp4", state: "ACTIVE" } },
        { headers: { "x-goog-upload-status": "final" } });
    }
    const handle = /^\/v1beta\/(files\/[a-z0-9-]+)$/.exec(url.pathname)?.[1];
    if (handle && request.method === "GET") return Response.json({ name: handle, state: "ACTIVE" });
    if (handle && request.method === "DELETE") return Response.json({});
    if (url.pathname.endsWith(":generateContent")) {
      return Response.json({ candidates: [{ content: { parts: [{ text: "00:10 The fleet leaves Troy." }] } }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 12 } });
    }
    return new Response("not found", { status: 404 });
  } });
});
afterAll(() => upstream.stop(true));
beforeEach(() => {
  seen.length = 0;
  uploadUrl = () => `${upstream.url.origin}/upload/v1beta/files?upload_id=ithaca-session&upload_protocol=resumable`;
});

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function open(options: Partial<ProviderRelayOptions> = {}) {
  const receipts: ProviderRelayReceipt[] = [], refusals: ProviderRelayRefusal[] = [];
  const relay: ProviderRelay = startProviderRelay({ credential: name => name === "GEMINI_API_KEY" ? HOST_KEY : undefined,
    origins: new Map([["GEMINI_API_KEY", [upstream.url.origin]]]),
    observe: receipt => { if (receipt.outcome !== "dispatched") receipts.push(receipt); }, refused: refusal => refusals.push(refusal), ...options });
  // node:http over the socket: an in-process Bun fetch to its own Unix server stalls.
  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string | Uint8Array) =>
    new Promise<Answer>((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(body);
      const outgoing = httpRequest({ socketPath: relay.socketPath, method, path, headers: { "x-brain-provider": "gemini",
        "x-brain-provider-key": "GEMINI_API_KEY", "x-brain-provider-origin": upstream.url.origin, "x-goog-api-key": "brain-provider-relay-placeholder",
        ...headers, ...(payload ? { "content-length": String(payload.byteLength) } : {}) } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
  const start = () => send("POST", "/upload/v1beta/files", { "content-type": "application/json", "x-goog-upload-protocol": "resumable",
    "x-goog-upload-command": "start", "x-goog-upload-header-content-length": "5", "x-goog-upload-header-content-type": "video/mp4" },
  JSON.stringify({ file: { mimeType: "video/mp4" } }));
  /** The bytes, sent where the relay's rewritten upload URL says. */
  const upload = (url: string, bytes = "troy!") => {
    const target = new URL(url);
    return send("POST", `${target.pathname}${target.search}`, { "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0",
      "x-brain-provider-origin": target.origin }, bytes);
  };
  const generate = (fileUri: string) => send("POST", "/v1beta/models/gemini-3-flash-preview:generateContent", { "content-type": "application/json" },
    JSON.stringify({ contents: [{ role: "user", parts: [{ fileData: { fileUri, mimeType: "video/mp4" } }, { text: "What happens first?" }] }] }));
  return { relay, receipts, refusals, send, start, upload, generate };
}

describe("the Files lifecycle a relayed brain video watch needs", () => {
  test("start, upload, poll, generate and delete reach the upstream with the host key, and each attempt is recorded", async () => {
    const { relay, receipts, send, start, upload, generate } = open();
    try {
      const started = await start();
      expect(started.status).toBe(200);
      const relayUrl = String(started.headers["x-goog-upload-url"]);
      // The worker never learns the provider's own upload URL.
      expect(relayUrl, "RELAY_REWRITES_UPLOAD_URL").toMatch(new RegExp(`^${upstream.url.origin}/upload/v1beta/files\\?brain_upload=[0-9a-f-]{36}$`));
      const uploaded = await upload(relayUrl);
      expect(uploaded.status).toBe(200);
      const file = JSON.parse(uploaded.body).file as { name: string; uri: string };
      expect((await send("GET", `/v1beta/${file.name}`)).status, "OWNED_HANDLE_POLLED").toBe(200);
      const answer = await generate(file.uri);
      expect(answer.status, "OWNED_FILE_GENERATES").toBe(200);
      expect((await send("DELETE", `/v1beta/${file.name}`)).status, "OWNED_HANDLE_DELETED").toBe(200);
      expect(seen.map(request => `${request.method} ${request.path}`), "LIFECYCLE_REACHES_UPSTREAM").toEqual([
        "POST /upload/v1beta/files",
        "POST /upload/v1beta/files?upload_id=ithaca-session&upload_protocol=resumable",
        `GET /v1beta/${file.name}`,
        "POST /v1beta/models/gemini-3-flash-preview:generateContent",
        `DELETE /v1beta/${file.name}`,
      ]);
      expect(seen.map(request => request.headers["x-goog-api-key"]), "HOST_KEY_ON_EVERY_LIFECYCLE_REQUEST").toEqual(Array(seen.length).fill(HOST_KEY));
      expect(seen[1]!.bytes, "UPLOAD_BYTES_FORWARDED").toBe(5);
      expect(seen[1]!.headers["x-goog-upload-command"]).toBe("upload, finalize");
      expect(receipts.map(receipt => [receipt.operation, receipt.outcome]), "LIFECYCLE_ATTEMPTS_RECORDED").toEqual([
        ["files", "completed"], ["files", "completed"], ["files", "completed"], ["completions", "completed"], ["files", "completed"],
      ]);
      expect(receipts[3]).toMatchObject({ model: "gemini-3-flash-preview", usage: { inputTokens: 300, outputTokens: 12 } });
      // A deleted handle is no longer the turn's.
      expect((await send("GET", `/v1beta/${file.name}`)).status, "DELETED_HANDLE_RELEASED").toBe(403);
    } finally { await relay.stop(); }
  });

  test("a worker-chosen upload URL is refused before contact", async () => {
    const { relay, refusals, upload, start } = open();
    try {
      await start();
      seen.length = 0;
      for (const url of [
        `${upstream.url.origin}/upload/v1beta/files?upload_id=ithaca-session&upload_protocol=resumable`,
        `${upstream.url.origin}/upload/v1beta/files?brain_upload=00000000-0000-4000-8000-000000000000`,
        `${upstream.url.origin}/upload/v1beta/files`,
      ]) expect((await upload(url)).status, url).toBe(403);
      expect(seen, "WORKER_UPLOAD_URL_NEVER_CONTACTED").toEqual([]);
      expect(refusals.map(refusal => refusal.reason)).toEqual(["route_not_allowed", "upload_not_registered", "route_not_allowed"]);
    } finally { await relay.stop(); }
  });

  test("an upload URL the provider points at another origin is never registered", async () => {
    uploadUrl = () => "https://sirens.invalid/upload/v1beta/files?upload_id=lure";
    const { relay, refusals, start } = open();
    try {
      const started = await start();
      expect(started.status, "FOREIGN_UPLOAD_URL_REJECTED").toBe(502);
      expect(started.headers["x-goog-upload-url"]).toBeUndefined();
      expect(refusals).toMatchObject([{ reason: "upload_url_rejected" }]);
    } finally { await relay.stop(); }
  });

  test("a poll, delete or generation naming a handle this relay did not create is refused before contact", async () => {
    const { relay, refusals, send, generate } = open();
    try {
      expect((await send("GET", "/v1beta/files/penelope-loom")).status, "FOREIGN_POLL_REFUSED").toBe(403);
      expect((await send("DELETE", "/v1beta/files/penelope-loom")).status, "FOREIGN_DELETE_REFUSED").toBe(403);
      expect((await generate(`${upstream.url.origin}/v1beta/files/penelope-loom`)).status, "FOREIGN_FILE_GENERATION_REFUSED").toBe(403);
      // Not a general GET or DELETE route either.
      expect((await send("GET", "/v1beta/files")).status).toBe(405);
      expect((await send("DELETE", "/v1beta/models/gemini-3-flash-preview")).status).toBe(405);
      expect(seen, "FOREIGN_HANDLE_NEVER_CONTACTED").toEqual([]);
      expect(refusals.map(refusal => refusal.reason)).toEqual(["file_not_owned", "file_not_owned", "file_not_owned", "method_not_allowed", "method_not_allowed"]);
    } finally { await relay.stop(); }
  });

  test("a handle created under another relay is foreign to this one", async () => {
    const first = open();
    let name: string;
    try {
      const started = await first.start();
      name = JSON.parse((await first.upload(String(started.headers["x-goog-upload-url"]))).body).file.name;
    } finally { await first.relay.stop(); }
    const second = open();
    try {
      seen.length = 0;
      expect((await second.send("GET", `/v1beta/${name}`)).status, "HANDLES_PRIVATE_TO_THEIR_RELAY").toBe(403);
      expect(seen).toEqual([]);
    } finally { await second.relay.stop(); }
  });

  test("a blocked budget refuses the upload before any byte is sent, while cleanup still deletes", async () => {
    let blocked = false;
    const { relay, refusals, send, start, upload } = open({ admit: () => blocked ? { allowed: false, message: "Turn inference budget reached." } : { allowed: true } });
    try {
      blocked = true;
      expect((await start()).status, "BLOCKED_BUDGET_REFUSES_UPLOAD_START").toBe(403);
      expect(seen, "BLOCKED_BUDGET_SENDS_NO_BYTE").toEqual([]);
      blocked = false;
      const relayUrl = String((await start()).headers["x-goog-upload-url"]);
      blocked = true;
      seen.length = 0;
      expect((await upload(relayUrl)).status, "BLOCKED_BUDGET_REFUSES_UPLOAD_BYTES").toBe(403);
      expect(seen, "BLOCKED_BUDGET_SENDS_NO_BYTE").toEqual([]);
      expect(refusals.map(refusal => refusal.reason)).toEqual(["budget_exceeded", "budget_exceeded"]);
      blocked = false;
      const name = JSON.parse((await upload(relayUrl)).body).file.name as string;
      blocked = true;
      seen.length = 0;
      expect((await send("DELETE", `/v1beta/${name}`)).status, "CLEANUP_NOT_BUDGET_BLOCKED").toBe(200);
      expect(seen.map(request => request.method)).toEqual(["DELETE"]);
    } finally { await relay.stop(); }
  });

  test("files a turn leaves behind are deleted with the host key when its relay stops", async () => {
    const { relay, receipts, start, upload } = open();
    const started = await start();
    const name = JSON.parse((await upload(String(started.headers["x-goog-upload-url"]))).body).file.name as string;
    seen.length = 0;
    await relay.stop();
    expect(seen.map(request => `${request.method} ${request.path}`), "STOP_DELETES_OWNED_FILES").toEqual([`DELETE /v1beta/${name}`]);
    expect(seen[0]!.headers["x-goog-api-key"]).toBe(HOST_KEY);
    expect(receipts.at(-1), "STOP_CLEANUP_RECORDED").toMatchObject({ operation: "files", outcome: "completed", status: 200 });
  });
});
