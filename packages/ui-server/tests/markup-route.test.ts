/**
 * The markup layer upload (#3975), over real HTTP: a layer far above the
 * 12,000,000-byte socket frame and the 8 MiB mask cap travels intact, the
 * 52,428,800-byte cap is inclusive, and nothing but the waiting request's own
 * principal and turn can answer it.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { BRAIN_MARKUP_MAX_BYTES, BRAIN_MASK_MAX_BYTES } from "@schlessera/brain-ui-sdk/server";
import { MAX_CLIENT_FRAME_BYTES } from "@schlessera/brain-ui-sdk/schemas";

import type { AppEnv } from "../src/app-env.js";
import { createMarkupRoutes, MARKUP_UPLOAD_MAX_BODY_BYTES } from "../src/routes/markup.js";
import { TurnCoordinator, type MarkupSubmission, type RunningTurn } from "../src/ws/turns.js";
import { png } from "./helpers/markup-images.js";

let coordinator: TurnCoordinator;
let server: ReturnType<typeof Bun.serve>;
let as = "odysseus";
const turn = {} as RunningTurn;
const turnId = "raft-turn";

beforeAll(() => {
  const app = new Hono<AppEnv>()
    .use("*", async (c, next) => { if (as) c.set("principal", { id: as } as never); await next(); })
    .route("/api", createMarkupRoutes({ peekMarkup: (...a) => coordinator.peekMarkup(...a), claimMarkup: (...a) => coordinator.claimMarkup(...a) }));
  // Far above the route's own bound, so only the route can refuse a large body.
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4 * MARKUP_UPLOAD_MAX_BODY_BYTES, fetch: app.fetch });
});
afterAll(() => server.stop(true));
beforeEach(() => { coordinator = new TurnCoordinator(); as = "odysseus"; });

const SOURCE = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
function open(requestId = `markup-${crypto.randomUUID()}`) {
  let settled: MarkupSubmission | Error | undefined;
  coordinator.openMarkup(requestId, { turn, turnId, principalId: "odysseus", source: () => ({ bytes: SOURCE, type: "image/jpeg" }),
    resolve: s => { settled = s; }, reject: e => { settled = e; } });
  return { requestId, settled: () => settled };
}
const SUMMARY = { marks: { pen: 1, arrow: 2, ellipse: 1, text: 2 }, notes: ["make the sail red", "move the raft here"] };
function form(layer: Uint8Array<ArrayBuffer>, summary: unknown = SUMMARY) {
  const body = new FormData();
  body.append("summary", typeof summary === "string" ? summary : JSON.stringify(summary));
  body.append("layer", new Blob([layer], { type: "image/png" }), "markup.png");
  return body;
}
const post = (requestId: string, body: BodyInit, query = `?turnId=${turnId}`, headers?: HeadersInit) =>
  fetch(`http://127.0.0.1:${server.port}/api/markup/${requestId}${query}`, { method: "POST", body, ...(headers ? { headers } : {}) });

test("a 13 MB layer, above the socket frame and the mask cap, arrives byte for byte", async () => {
  // Random pixels do not compress: 1900 × 1750 × 4 is about 13.3 MB of PNG.
  const layer = png(1900, 1750, { noise: true });
  expect(layer.length).toBeGreaterThan(MAX_CLIENT_FRAME_BYTES);
  expect(layer.length).toBeGreaterThan(BRAIN_MASK_MAX_BYTES);
  const pending = open();
  const res = await post(pending.requestId, form(layer));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ accepted: true, bytes: layer.length });
  const settled = pending.settled() as MarkupSubmission;
  expect(Buffer.from(settled.png).equals(layer)).toBe(true);
  expect(settled.marks).toEqual(SUMMARY.marks);
  expect(settled.notes).toEqual(SUMMARY.notes);
  expect(coordinator.pendingMarkup.size, "the request is answered once").toBe(0);
});

test("exactly 52,428,800 bytes is accepted; one byte over is refused and the editor's request stays open", async () => {
  const exact = png(4, 4, { exactBytes: BRAIN_MARKUP_MAX_BYTES });
  const accepted = open();
  expect((await post(accepted.requestId, form(exact))).status).toBe(202);
  expect((accepted.settled() as MarkupSubmission).png.byteLength).toBe(52_428_800);

  const over = png(4, 4, { exactBytes: BRAIN_MARKUP_MAX_BYTES + 1 });
  const waiting = open();
  const res = await post(waiting.requestId, form(over));
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "markup_too_large", limit: 52_428_800,
    message: "This markup is 52428801 bytes; the limit is 52428800 bytes (50 MiB)." });
  expect(waiting.settled(), "the layer never reached the request").toBeUndefined();
  expect(coordinator.peekMarkup(waiting.requestId)).toBeDefined();
});

test("a body past the bound is cut off as it streams, whatever its length header says", async () => {
  const waiting = open();
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (sent > MARKUP_UPLOAD_MAX_BODY_BYTES + 2 * chunk.length) return controller.close();
    sent += chunk.length; controller.enqueue(chunk);
  } });
  const res = await post(waiting.requestId, stream, `?turnId=${turnId}`, { "content-type": "multipart/form-data; boundary=x" });
  expect(res.status).toBe(413);
  expect(waiting.settled()).toBeUndefined();
});

test("another principal, another turn or an unknown id finds no request, and the editor's stays open", async () => {
  const waiting = open();
  const layer = png(4, 4);
  as = "athena";
  expect((await post(waiting.requestId, form(layer))).status).toBe(404);
  as = "odysseus";
  expect((await post(waiting.requestId, form(layer), "?turnId=old-turn")).status).toBe(404);
  expect((await post(waiting.requestId, form(layer), "")).status, "no turn at all").toBe(404);
  expect((await post(waiting.requestId, form(layer), "?turnId=")).status, "an empty turn").toBe(404);
  expect((await post(`markup-${crypto.randomUUID()}`, form(layer))).status).toBe(404);
  expect((await post("../files", form(layer))).status).toBe(404);
  expect(waiting.settled()).toBeUndefined();
  expect((await post(waiting.requestId, form(layer))).status).toBe(202);
});

test("an unauthenticated upload is refused, and never cached", async () => {
  const waiting = open();
  as = "";
  const res = await post(waiting.requestId, form(png(4, 4)));
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "Authentication required", authRequired: true });
  expect(waiting.settled()).toBeUndefined();
});

test("the bound source is served to the request's own principal and turn while it is open", async () => {
  const waiting = open();
  const get = (query: string) => fetch(`http://127.0.0.1:${server.port}/api/markup/${waiting.requestId}/source${query}`);
  const res = await get(`?turnId=${turnId}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/jpeg");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(SOURCE);
  expect((await get("")).status, "no turn").toBe(404);
  as = "athena";
  expect((await get(`?turnId=${turnId}`)).status, "another principal").toBe(404);
  as = "odysseus";
  coordinator.claimMarkup(waiting.requestId)!.reject(new Error("closed"));
  expect((await get(`?turnId=${turnId}`)).status, "an answered request").toBe(404);
});

test.each([
  ["no marks", { marks: { pen: 0, arrow: 0, ellipse: 0, text: 0 }, notes: [] }, "Draw at least one mark."],
  ["a fractional count", { marks: { pen: 1.5, arrow: 0, ellipse: 0, text: 0 }, notes: [] }, "whole number"],
  ["notes that do not match", { marks: { pen: 0, arrow: 0, ellipse: 0, text: 2 }, notes: ["sail"] }, "note count"],
  ["an 81-character note", { marks: { pen: 0, arrow: 0, ellipse: 0, text: 1 }, notes: ["x".repeat(81)] }, "at most 80 characters"],
  ["a multi-line note", { marks: { pen: 0, arrow: 0, ellipse: 0, text: 1 }, notes: ["sail\nmast"] }, "single lines"],
  ["not JSON", "{marks", "not valid JSON"],
])("a summary with %s is refused", async (_name, summary, message) => {
  const waiting = open();
  const res = await post(waiting.requestId, form(png(4, 4), summary));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { message: string }).message).toContain(message);
  expect(waiting.settled()).toBeUndefined();
});

test("only multipart form data carries a layer", async () => {
  const waiting = open();
  const res = await post(waiting.requestId, png(4, 4), `?turnId=${turnId}`, { "content-type": "image/png" });
  expect(res.status).toBe(415);
  const missing = new FormData(); missing.append("summary", JSON.stringify(SUMMARY));
  expect((await post(waiting.requestId, missing)).status).toBe(400);
  expect(waiting.settled()).toBeUndefined();
});
