/**
 * The shared body reader (`readBodyBytes`, #4774) for a `Request` built in
 * process (#4903): an embedder's `app.fetch` or a test can declare a length no
 * client over HTTP sends, and can hand the reader one buffer twice. Odysseus
 * fixtures only.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SHARE_MAX_TOTAL_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { BRAIN_MARKUP_MAX_BYTES, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import type { AppEnv } from "../src/app-env";
import { readBodyBytes, readJsonBody } from "../src/middleware/body-limit";
import { createMarkupRoutes } from "../src/routes/markup";
import { createShareRoutes } from "../src/routes/share";
import { MAX_ARCHIVE_BYTES } from "../src/skills/install";
import { TurnCoordinator, type RunningTurn } from "../src/ws/turns";

const speech: SpeechProvider = {
  id: "fixture-speech",
  capabilities: { streaming: true, interimResults: false, endpointing: false, keyterms: false },
  createSession: async () => ({ url: "wss://speech.example/listen", expiresAt: Date.now() + 60_000 }),
  transcribeRecording: async () => ({ text: "Odysseus reaches Ithaca." }),
};

let t: HttpContractApp;
beforeAll(async () => { t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: speech }); });
afterAll(async () => { await t.close(); });

const answer = async (response: Response) => ({ status: response.status, body: await response.json() });
/** An all-digit length too long for a double: `Number()` reads it as Infinity. */
const HUGE = "9".repeat(400);
const JSON_HEADERS = { "content-type": "application/json" };

test("a declared length too long for a double gets each route's over-limit answer", async () => {
  const declared = (method: string, path: string, headers: Record<string, string>, body: BodyInit = "{}") => {
    const request = new Request(new URL(path, "http://localhost"), { method, body, headers: { ...headers, "content-length": HUGE } });
    expect(Number(request.headers.get("content-length"))).toBe(Infinity);
    return request;
  };
  const multipart = { "content-type": "multipart/form-data; boundary=ithaca" };
  const audio = { "content-type": "audio/webm;codecs=opus", "content-sha256": createHash("sha256").update("{}").digest("hex") };
  const rows: Array<[string, () => Promise<Response>, { status: number; body: unknown }]> = [
    ["JSON route", () => t.app.fetch(declared("POST", "/api/storage/scans", JSON_HEADERS)), { status: 413, body: { error: "Request body too large" } }],
    ["drafts", () => t.app.fetch(declared("POST", "/api/drafts/draft-ithaca/bind", JSON_HEADERS, JSON.stringify({ sessionId: "fixture-session" }))),
      { status: 400, body: { error: "DRAFT_INVALID", message: "The body is too large." } }],
    ["schedules", () => t.app.fetch(declared("POST", "/api/schedules/proposals", JSON_HEADERS)),
      { status: 400, body: { ok: false, error: { code: "invalid_request", message: "Request body too large." } } }],
    ["session profiles", () => t.app.fetch(declared("PUT", "/api/drafts/draft-ithaca/profile", JSON_HEADERS, JSON.stringify({ preference: "strict" }))),
      { status: 413, body: { error: "Profile request is too large." } }],
    ["transcriptions", () => t.app.fetch(declared("PUT", `/api/voice/recordings/${randomUUID()}/transcription`, audio)),
      { status: 413, body: { error: "recording_too_large", message: "The recording exceeds the upload byte budget." } }],
    ["skill archive", () => t.app.fetch(declared("POST", "/api/skills/install/zip", multipart, "--ithaca--")),
      { status: 400, body: { error: `Archive exceeds ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB.` } }],
  ];
  const brainRoot = mkdtempSync(join(tmpdir(), "brain-ui-share-declared-"));
  try {
    const share = createShareRoutes({ brainRoot, allowedOrigins: [], trustProxy: false });
    rows.push(["share", () => share.request(declared("POST", "http://localhost/share", multipart, "--ithaca--")),
      { status: 413, body: { error: "share_too_large", limit: SHARE_MAX_TOTAL_BYTES } }]);
    const coordinator = new TurnCoordinator();
    const markup = new Hono<AppEnv>()
      .use("*", async (c, next) => { c.set("principal", { id: "odysseus" } as never); await next(); })
      .route("/api", createMarkupRoutes({ peekMarkup: (...a) => coordinator.peekMarkup(...a), claimMarkup: (...a) => coordinator.claimMarkup(...a) }));
    const requestId = `markup-${randomUUID()}`;
    coordinator.openMarkup(requestId, { turn: {} as RunningTurn, turnId: "raft-turn", principalId: "odysseus",
      source: () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), type: "image/jpeg" }), resolve: () => {}, reject: () => {} });
    rows.push(["markup", () => markup.request(declared("POST", `http://localhost/api/markup/${requestId}?turnId=raft-turn`, multipart, "--ithaca--")),
      { status: 413, body: { error: "markup_too_large", limit: BRAIN_MARKUP_MAX_BYTES, message: `This markup is over the ${BRAIN_MARKUP_MAX_BYTES}-byte (50 MiB) limit.` } }]);
    for (const [route, send, over] of rows) expect({ route, answer: await answer(await send()) }).toEqual({ route, answer: over });
  } finally { rmSync(brainRoot, { recursive: true, force: true }); }
});

test("a missing or unparseable declared length is still ignored", async () => {
  for (const length of [undefined, "", "ithaca", "-1"]) {
    const request = new Request("http://localhost/", { method: "POST", body: "{}", headers: length === undefined ? {} : { "content-length": length } });
    expect({ length, bytes: (await readBodyBytes(request, 16))?.bytes }).toEqual({ length, bytes: 2 });
  }
});

/** A stream that enqueues `first`, then refills the same buffer with `second` and enqueues it again. */
function reused(make: (bytes: Uint8Array) => Uint8Array, first: string, second: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder(), buffer = make(encoder.encode(first));
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) controller.enqueue(buffer);
      else if (step === 1) { buffer.set(encoder.encode(second)); controller.enqueue(buffer); }
      else controller.close();
      step++;
    },
  }, { highWaterMark: 0 });
}
/** The same bytes in two buffers of their own. */
function separate(first: string, second: string): ReadableStream<Uint8Array> {
  const parts = [first, second].map((text) => new TextEncoder().encode(text));
  return new ReadableStream<Uint8Array>({ pull(controller) { const next = parts.shift(); if (next) controller.enqueue(next); else controller.close(); } });
}
const streamedRequest = (body: ReadableStream<Uint8Array>) =>
  new Request("http://localhost/", { method: "POST", body, headers: JSON_HEADERS, duplex: "half" } as RequestInit);

test("a reused chunk buffer gives readJsonBody the same result as separate chunks", async () => {
  // Equal lengths, so the second chunk overwrites the first in place.
  const [first, second] = ['{"to":', '"Ith"}'];
  const app = new Hono().post("/", async (c) => {
    try { const body = await readJsonBody(c); return body instanceof Response ? body : c.json({ parsed: body }); }
    catch { return c.json({ invalid: true }); }
  });
  const read = async (body: ReadableStream<Uint8Array>) => (await app.request(streamedRequest(body))).json();
  expect(await read(separate(first, second))).toEqual({ parsed: { to: "Ith" } });
  expect(await read(reused((bytes) => bytes, first, second)), "READ_JSON_BODY_REUSED_BUFFER").toEqual({ parsed: { to: "Ith" } });
});

test("a reused chunk buffer, a Uint8Array or a Buffer, gives share's copied read the same bytes as separate chunks", async () => {
  const [first, second] = ["--ith", "aca--"];
  const bytes = async (body: ReadableStream<Uint8Array>) => {
    // Share's own read: the chunks are kept beyond the read, so it asks for copies.
    const read = await readBodyBytes(streamedRequest(body), 1024, { copyChunks: true });
    return Buffer.concat(read!.chunks).toString("utf8");
  };
  expect(await bytes(separate(first, second))).toBe("--ithaca--");
  expect(await bytes(reused((b) => b, first, second)), "SHARE_REUSED_UINT8ARRAY").toBe("--ithaca--");
  expect(await bytes(reused((b) => Buffer.from(b), first, second)), "SHARE_REUSED_BUFFER").toBe("--ithaca--");
});

test("a schedule POST with no body and an over-limit declared length is too large, not missing", async () => {
  const request = new Request("http://localhost/api/schedules/proposals", { method: "POST", headers: { ...JSON_HEADERS, "content-length": "70000" } });
  expect(request.body).toBeNull();
  expect(await answer(await t.app.fetch(request)))
    .toEqual({ status: 400, body: { ok: false, error: { code: "invalid_request", message: "Request body too large." } } });
  // With no declared length, a missing body keeps its own answer.
  expect(await answer(await t.app.fetch(new Request("http://localhost/api/schedules/proposals", { method: "POST", headers: JSON_HEADERS }))))
    .toEqual({ status: 400, body: { ok: false, error: { code: "invalid_request", message: "Expected a JSON body." } } });
});
