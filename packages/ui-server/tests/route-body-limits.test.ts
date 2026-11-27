import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import { MAX_ARCHIVE_BYTES } from "../src/skills/install";

/** The documented JSON request cap (`docs/http-api.md`). */
const CAP = 262_144;
const TOO_LARGE = { error: "Request body too large" };
const JSON_HEADERS = { "content-type": "application/json" };

let sessions = 0;
const speech: SpeechProvider = {
  id: "fixture-speech",
  capabilities: { streaming: true, interimResults: false, endpointing: false, keyterms: false },
  createSession: async () => { sessions++; return { url: "wss://speech.example/listen" }; },
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

