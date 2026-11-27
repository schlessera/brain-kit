import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SHARE_MAX_TOTAL_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { BRAIN_MARKUP_MAX_BYTES, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import type { AppEnv } from "../src/app-env";
import { createMarkupRoutes, MARKUP_UPLOAD_MAX_BODY_BYTES } from "../src/routes/markup";
import { createShareRoutes } from "../src/routes/share";
import { MAX_TRANSCRIPTION_BYTES } from "../src/routes/transcriptions";
import { MAX_ARCHIVE_BYTES } from "../src/skills/install";
import { TurnCoordinator, type RunningTurn } from "../src/ws/turns";

/** The documented JSON request cap (`docs/http-api.md`). */
const CAP = 262_144;
const TOO_LARGE = { error: "Request body too large" };
const JSON_HEADERS = { "content-type": "application/json" };

let sessions = 0, transcribed = 0;
const speech: SpeechProvider = {
  id: "fixture-speech",
  capabilities: { streaming: true, interimResults: false, endpointing: false, keyterms: false },
  createSession: async () => { sessions++; return { url: "wss://speech.example/listen" }; },
  transcribeRecording: async () => { transcribed++; return { text: "Odysseus reaches Ithaca." }; },
};

let t: HttpContractApp;
let etag: string;
beforeAll(async () => {
  t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: speech });
  etag = (await t.fetch("/api/voice/dictation/settings")).headers.get("etag") ?? "";
});
afterAll(async () => { await t.close(); });

const read = async (path: string) => (await t.fetch(path)).json();

interface Row {
  route: string;
  method: "POST" | "PUT";
  path: string;
  headers?: () => Record<string, string>;
  /**
   * A well-formed request this route would act on (or validate further) if it
   * parsed it. Padded with JSON whitespace past the cap, it is still valid
   * JSON, so only the cap can stop the handler from reaching its effect.
   */
  body: unknown;
  /** The route's existing answer to a malformed JSON body. */
  malformed: { status: number; body: unknown };
  /** State the route's effect would change, read through the API. */
  observe?: () => Promise<unknown>;
}

const rows: Row[] = [
  { route: "storage scan", method: "POST", path: "/api/storage/scans", body: {},
    malformed: { status: 400, body: { error: "Expected an empty JSON object." } }, observe: () => read("/api/storage") },
  { route: "chat deletion", method: "POST", path: "/api/chat-deletions",
    body: { operationId: "op-ithaca", target: { sessionId: "fixture-session" }, expected: { backendId: "fixture", generation: 1 } },
    malformed: { status: 400, body: { error: "INVALID_CHAT_DELETION", message: "Name one chat, an operation ID and what was reviewed." } } },
  { route: "code history revert", method: "POST", path: "/api/sessions/fixture-session/turns/t1/journal/code/revert",
    body: { id: "00000000-0000-4000-8000-000000000000", checkout: "main" },
    malformed: { status: 400, body: { error: "Invalid code history selection." } } },
  { route: "untrusted mark", method: "PUT", path: "/api/files/untrusted", body: { path: "notes/arrival.md" },
    malformed: { status: 400, body: { error: "invalid_body" } }, observe: () => read("/api/files/untrusted/list") },
  { route: "dictation settings", method: "PUT", path: "/api/voice/dictation/settings", headers: () => ({ "if-match": etag }),
    body: { defaultProvider: null, smart: false },
    malformed: { status: 400, body: { error: "dictation_settings_invalid" } }, observe: () => read("/api/voice/dictation/settings") },
  { route: "voice session", method: "POST", path: "/api/voice/session", body: {},
    malformed: { status: 400, body: { error: "voice_session_invalid" } }, observe: async () => sessions },
  { route: "turn revert", method: "POST", path: "/api/sessions/fixture-session/turns/t1/revert", body: { id: "turn-history" },
    malformed: { status: 400, body: { error: "Invalid history action." } } },
  { route: "persona create", method: "POST", path: "/api/voice/personas", body: { name: "Penelope", voices: {}, instructions: "Weave by day." },
    malformed: { status: 400, body: { error: "PERSONA_INVALID" } }, observe: () => read("/api/voice/personas") },
  { route: "persona update", method: "PUT", path: "/api/voice/personas/penelope",
    body: { name: "Penelope", voices: {}, instructions: "Unweave by night.", baseRevision: "r1" },
    malformed: { status: 400, body: { error: "PERSONA_INVALID" } }, observe: () => read("/api/voice/personas") },
  { route: "voice settings", method: "PUT", path: "/api/settings/voice", body: { persona: { value: "penelope", revision: 0 } },
    malformed: { status: 400, body: { error: "VOICE_SETTINGS_INVALID" } }, observe: () => read("/api/settings/voice") },
];

/** The row's request, padded with trailing whitespace to exactly one byte over the cap. */
function oversized(row: Row): Uint8Array {
  const json = JSON.stringify(row.body);
  return new TextEncoder().encode(json + " ".repeat(CAP + 1 - Buffer.byteLength(json)));
}

/** A body with no Content-Length: Bun sends a stream as it is pulled. */
function streamed(bytes: Uint8Array, chunk = 16 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset += chunk));
    },
  });
}

for (const row of rows) {
  for (const delivery of ["declared", "streamed"] as const) {
    test(`${row.route}: a body one byte over the cap, ${delivery}, is refused before the route acts`, async () => {
      const bytes = oversized(row);
      expect(bytes.byteLength).toBe(CAP + 1);
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(row.body);
      const before = await row.observe?.();
      const init: RequestInit = delivery === "declared"
        ? { body: bytes, headers: { ...JSON_HEADERS, ...row.headers?.(), "content-length": String(bytes.byteLength) } }
        : { body: streamed(bytes), headers: { ...JSON_HEADERS, ...row.headers?.() }, duplex: "half" } as RequestInit;
      const request = new Request(new URL(row.path, "http://localhost"), { method: row.method, ...init });
      expect(request.headers.get("content-length")).toBe(delivery === "declared" ? String(CAP + 1) : null);
      const response = await t.app.fetch(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(TOO_LARGE);
      if (row.observe) expect(await row.observe()).toEqual(before);
    });
  }

  test(`${row.route}: a malformed JSON body under the cap keeps its existing 400`, async () => {
    const response = await t.fetch(row.path, { method: row.method, headers: { ...JSON_HEADERS, ...row.headers?.() }, body: "{\"unterminated\": " });
    expect(response.status).toBe(row.malformed.status);
    expect(await response.json()).toEqual(row.malformed.body);
  });
}

test("skill archive: a streamed body past the archive cap is refused after reading at most the cap plus one chunk", async () => {
  const chunk = new Uint8Array(64 * 1024);
  const cap = MAX_ARCHIVE_BYTES + 1_000_000;
  // Far more than the cap, so a reader without one is seen consuming past it.
  const offered = cap + 32 * chunk.byteLength;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= offered) return controller.close();
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const response = await t.fetch("/api/skills/install/zip", {
    method: "POST", body, duplex: "half",
    headers: { "content-type": "multipart/form-data; boundary=ithaca" },
  } as RequestInit);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: `Archive exceeds ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB.` });
  // Pulled on demand only (high-water mark 0), so pulled bytes are read bytes.
  expect(pulled).toBeGreaterThan(cap);
  expect(pulled).toBeLessThanOrEqual(cap + chunk.byteLength);
});

/**
 * Six routes keep their own limits, statuses and messages on the shared byte
 * reader (#4774). Each is sent its limit plus one byte with no Content-Length,
 * which only a streamed count can refuse, and exactly its limit, which the
 * reader must pass on to the route's own next answer.
 */
describe("route-local limits on the shared byte reader", () => {
  const zeros = new Uint8Array(256 * 1024);
  /** `size` bytes of `fill` (or zeros), streamed without a Content-Length. */
  function stream(size: number, fill?: Uint8Array): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    const source = fill ?? zeros;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= size) return controller.close();
        const length = Math.min(size - offset, fill ? fill.byteLength - offset : source.byteLength);
        controller.enqueue(fill ? fill.subarray(offset, offset + length) : source.subarray(0, length));
        offset += length;
      },
    }, { highWaterMark: 0 });
    return { body, pulled: () => offset };
  }
  const streamedInit = (method: string, size: number, headers: Record<string, string>, fill?: Uint8Array): RequestInit =>
    ({ method, body: stream(size, fill).body, headers, duplex: "half" }) as RequestInit;
  /** A JSON request padded with trailing whitespace to exactly `size` bytes. */
  const padded = (value: unknown, size: number) => {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json + " ".repeat(size - Buffer.byteLength(json)));
  };
  const answer = async (response: Response) => ({ status: response.status, body: await response.json() });

  async function jsonLimit(method: string, path: string, limit: number, value: unknown, over: { status: number; body: unknown }) {
    const refused = await t.fetch(path, streamedInit(method, limit + 1, JSON_HEADERS, padded(value, limit + 1)));
    expect(await answer(refused)).toEqual(over);
    const compact = await answer(await t.fetch(path, { method, headers: JSON_HEADERS, body: JSON.stringify(value) }));
    expect(compact.status).not.toBe(over.status === 400 ? 413 : over.status);
    const exact = await t.fetch(path, streamedInit(method, limit, JSON_HEADERS, padded(value, limit)));
    expect(await answer(exact), "exactly the limit gets the same answer as the compact request").toEqual(compact);
  }

  test("drafts: a bind body over 4,096 bytes is the draft's 400; exactly 4,096 is read", async () => {
    await jsonLimit("POST", "/api/drafts/draft-ithaca/bind", 4096, { sessionId: "fixture-session" },
      { status: 400, body: { error: "DRAFT_INVALID", message: "The body is too large." } });
  });

  test("schedules: a body over 64 KiB is the schedule refusal; exactly 64 KiB is read", async () => {
    await jsonLimit("POST", "/api/schedules/proposals", 64 * 1024, {},
      { status: 400, body: { ok: false, error: { code: "invalid_request", message: "Request body too large." } } });
  });

  test("session profiles: a body over 4,096 bytes is 413; exactly 4,096 is saved", async () => {
    await jsonLimit("PUT", "/api/drafts/draft-ithaca/profile", 4096, { preference: "strict" },
      { status: 413, body: { error: "Profile request is too large." } });
  });

  test("session profiles: an over-declared Content-Length is refused before the body is read", async () => {
    const { body, pulled } = stream(4097);
    const response = await t.fetch("/api/drafts/draft-ithaca/profile", {
      method: "PUT", body, duplex: "half", headers: { ...JSON_HEADERS, "content-length": "4097" },
    } as RequestInit);
    expect(await answer(response)).toEqual({ status: 413, body: { error: "Profile request is too large." } });
    expect(pulled(), "no byte of the body was read").toBe(0);
  });

  test("session profiles: the JSON media type is compared like every other JSON route", async () => {
    const save = (type: string) => t.fetch("/api/drafts/draft-ithaca/profile",
      { method: "PUT", headers: { "content-type": type }, body: JSON.stringify({ preference: "governed" }) });
    expect(await answer(await save("Application/JSON; charset=utf-8")))
      .toMatchObject({ status: 200, body: { preference: "governed", draftPreferenceStored: true } });
    expect(await answer(await save("text/plain"))).toEqual({ status: 415, body: { error: "Use JSON." } });
  });

  test("transcriptions: a recording over the upload budget is 413; exactly the budget is transcribed", async () => {
    const path = `/api/voice/recordings/${randomUUID()}/transcription`;
    const headers = (bytes: Uint8Array) => ({ "content-type": "audio/webm;codecs=opus", "content-sha256": createHash("sha256").update(bytes).digest("hex") });
    const over = new Uint8Array(MAX_TRANSCRIPTION_BYTES + 1);
    expect(await answer(await t.fetch(path, streamedInit("PUT", over.byteLength, headers(over), over))))
      .toEqual({ status: 413, body: { error: "recording_too_large", message: "The recording exceeds the upload byte budget." } });
    expect(transcribed).toBe(0);
    const exact = over.subarray(0, MAX_TRANSCRIPTION_BYTES);
    const accepted = await t.fetch(path, streamedInit("PUT", exact.byteLength, headers(exact), exact));
    expect(accepted.status).toBe(200);
    expect(transcribed).toBe(1);
  });

  test("share: a body over the share cap plus framing is 413; exactly that much reaches the multipart parser", async () => {
    const brainRoot = join(tmpdir(), `brain-ui-share-limit-${process.pid}`);
    const share = createShareRoutes({ brainRoot, allowedOrigins: [], trustProxy: false });
    try {
      const limit = SHARE_MAX_TOTAL_BYTES + 1_000_000;
      const headers = { "content-type": "multipart/form-data; boundary=ithaca" };
      expect(await answer(await share.request("/share", streamedInit("POST", limit + 1, headers))))
        .toEqual({ status: 413, body: { error: "share_too_large", limit: SHARE_MAX_TOTAL_BYTES } });
      expect(await answer(await share.request("/share", streamedInit("POST", limit, headers))))
        .toEqual({ status: 400, body: { error: "invalid_form" } });
    } finally { rmSync(brainRoot, { recursive: true, force: true }); }
  });

  test("markup: a body over the upload bound is 413; exactly the bound reaches the multipart parser", async () => {
    const coordinator = new TurnCoordinator();
    const app = new Hono<AppEnv>()
      .use("*", async (c, next) => { c.set("principal", { id: "odysseus" } as never); await next(); })
      .route("/api", createMarkupRoutes({ peekMarkup: (...a) => coordinator.peekMarkup(...a), claimMarkup: (...a) => coordinator.claimMarkup(...a) }));
    const open = () => {
      const requestId = `markup-${randomUUID()}`;
      coordinator.openMarkup(requestId, { turn: {} as RunningTurn, turnId: "raft-turn", principalId: "odysseus",
        source: () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), type: "image/jpeg" }), resolve: () => {}, reject: () => {} });
      return `/api/markup/${requestId}?turnId=raft-turn`;
    };
    const headers = { "content-type": "multipart/form-data; boundary=ithaca" };
    expect(await answer(await app.request(open(), streamedInit("POST", MARKUP_UPLOAD_MAX_BODY_BYTES + 1, headers))))
      .toEqual({ status: 413, body: { error: "markup_too_large", limit: BRAIN_MARKUP_MAX_BYTES,
        message: `This markup is over the ${BRAIN_MARKUP_MAX_BYTES}-byte (50 MiB) limit.` } });
    expect(await answer(await app.request(open(), streamedInit("POST", MARKUP_UPLOAD_MAX_BODY_BYTES, headers))))
      .toEqual({ status: 400, body: { error: "markup_invalid", message: "The upload is not valid multipart/form-data." } });
  });
});
