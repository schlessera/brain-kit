/**
 * Every route that keeps the chunks `readBodyBytes` hands it, and decodes or
 * parses them only after the stream ends, copies them as they arrive (#4996):
 * an in-process `Request` whose stream enqueues one buffer twice, changing it
 * in between, gets the answer the same bytes in separate chunks get. Odysseus
 * fixtures only.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import type { AppEnv } from "../src/app-env";
import { createMarkupRoutes } from "../src/routes/markup";
import { TurnCoordinator, type RunningTurn } from "../src/ws/turns";

const speech: SpeechProvider = {
  id: "fixture-speech",
  capabilities: { streaming: true, interimResults: false, endpointing: false, keyterms: false },
  createSession: async () => ({ url: "wss://speech.example/listen", expiresAt: Date.parse("2026-07-12T09:00:00Z") }),
  transcribeRecording: async () => ({ text: "Odysseus reaches Ithaca." }),
};

let t: HttpContractApp;
beforeAll(async () => { t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: speech }); });
afterAll(async () => { await t.close(); });

/** `text` in two halves of one length, padded with a trailing space. */
function halves(text: string): [string, string] {
  const even = text.length % 2 ? `${text} ` : text;
  return [even.slice(0, even.length / 2), even.slice(even.length / 2)];
}
/** A stream that enqueues the first half, then refills the same buffer with the second and enqueues it again. */
function reused(text: string): ReadableStream<Uint8Array> {
  const [first, second] = halves(text).map((half) => new TextEncoder().encode(half));
  const buffer = new Uint8Array(first!);
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) controller.enqueue(buffer);
      else if (step === 1) { buffer.set(second!); controller.enqueue(buffer); }
      else controller.close();
      step++;
    },
  }, { highWaterMark: 0 });
}
/** The same bytes in two buffers of their own. */
function separate(text: string): ReadableStream<Uint8Array> {
  const parts = halves(text).map((half) => new TextEncoder().encode(half));
  return new ReadableStream<Uint8Array>({ pull(controller) { const next = parts.shift(); if (next) controller.enqueue(next); else controller.close(); } });
}

/** A response, with the ids each request mints (recording and attempt) left out. */
const answer = async (response: Response) =>
  ({ status: response.status, body: (await response.text()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>") });
const JSON_HEADERS = { "content-type": "application/json" };
const BOUNDARY = "ithaca";
const MULTIPART = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };
/** One multipart file part named `name`, then the closing boundary. */
const multipart = (name: string, filename: string, type: string, content: string) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n${content}\r\n--${BOUNDARY}--\r\n`;

interface Route {
  route: string;
  send: (body: ReadableStream<Uint8Array>) => Promise<Response>;
  text: string;
}

test("a reused chunk buffer gets each copying route the answer separate chunks get", async () => {
  const coordinator = new TurnCoordinator();
  const markup = new Hono<AppEnv>()
    .use("*", async (c, next) => { c.set("principal", { id: "odysseus" } as never); await next(); })
    .route("/api", createMarkupRoutes({ peekMarkup: (...a) => coordinator.peekMarkup(...a), claimMarkup: (...a) => coordinator.claimMarkup(...a) }));
  const markupRequest = () => {
    const requestId = `markup-${randomUUID()}`;
    coordinator.openMarkup(requestId, { turn: {} as RunningTurn, turnId: "raft-turn", principalId: "odysseus",
      source: () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), type: "image/jpeg" }), resolve: () => {}, reject: () => {} });
    return requestId;
  };
  const request = (method: string, path: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>) =>
    new Request(new URL(path, "http://localhost"), { method, body, headers, duplex: "half" } as RequestInit);
  const audio = halves("Odysseus speaks to the Phaeacians.").join("");
  const routes: Route[] = [
    { route: "drafts", text: JSON.stringify({ sessionId: "fixture-session" }),
      send: (body) => t.app.fetch(request("POST", "/api/drafts/draft-ithaca/bind", JSON_HEADERS, body)) },
    { route: "schedules", text: JSON.stringify({ instruction: "Herd the cattle of the sun" }),
      send: (body) => t.app.fetch(request("POST", "/api/schedules/proposals", JSON_HEADERS, body)) },
    { route: "session profiles", text: JSON.stringify({ preference: "strict" }),
      send: (body) => t.app.fetch(request("PUT", "/api/drafts/draft-ithaca/profile", JSON_HEADERS, body)) },
    { route: "voice session", text: JSON.stringify({ providerId: "fixture-speech" }),
      send: (body) => t.app.fetch(request("POST", "/api/voice/session", JSON_HEADERS, body)) },
    { route: "transcriptions", text: audio,
      send: (body) => t.app.fetch(request("PUT", `/api/voice/recordings/${randomUUID()}/transcription`,
        { "content-type": "audio/webm;codecs=opus", "content-sha256": createHash("sha256").update(audio).digest("hex") }, body)) },
    { route: "skill archive", text: multipart("file", "voyage.zip", "application/zip", "PK-not-an-archive"),
      send: (body) => t.app.fetch(request("POST", "/api/skills/install/zip", MULTIPART, body)) },
    { route: "markup", text: multipart("layer", "layer.png", "image/png", "png-layer-of-the-raft"),
      send: (body) => markup.request(request("POST", `http://localhost/api/markup/${markupRequest()}?turnId=raft-turn`, MULTIPART, body)) },
  ];
  const separated: unknown[] = [], reusedAnswers: unknown[] = [];
  for (const { route, send, text } of routes) {
    separated.push({ route, answer: await answer(await send(separate(text))) });
    reusedAnswers.push({ route, answer: await answer(await send(reused(text))) });
  }
  expect(reusedAnswers, "REUSED_BUFFER_ANSWERS").toEqual(separated);
});
