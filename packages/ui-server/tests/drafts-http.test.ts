import { afterEach, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftListResponseSchema, draftSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { Draft, DraftListResponse } from "@schlessera/brain-ui-sdk/protocol";

import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

// Real composition roots over a file database: drafts saved through the
// mounted routes by one operator login must survive closing the app and come
// back, byte for byte, to a second login. Odysseus fixtures only.

const SECRET = "drafts-http-fixture-secret-0123456789";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-drafts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(dbPath: string): Promise<HttpContractApp> {
  const t = await httpContractApp({ env: {
    AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET,
    BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1", DB_PATH: dbPath,
  } });
  return t;
}

/** One authenticated operator login on `t`. */
async function login(t: HttpContractApp, label: string) {
  const principal = createPrincipal(t.app.db, { authMethod: "password", label, ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    headers.set("origin", "http://localhost");
    headers.set("host", "localhost");
    return t.fetch(path, { ...init, headers });
  };
  return {
    principal,
    cookie,
    call,
    put: (draftId: string, ifMatch: number | null, key: string, body: unknown) => call(`/api/drafts/${draftId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(ifMatch === null ? {} : { "if-match": String(ifMatch) }), "idempotency-key": key },
      body: JSON.stringify(body),
    }),
    upload: (draftId: string, key: string, bytes: Uint8Array<ArrayBuffer>, mime = "image/png", name = "harbour.png") =>
      call(`/api/drafts/${draftId}/attachments?name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { "content-type": mime, "idempotency-key": key }, body: bytes,
      }),
    remove: (draftId: string, ifMatch: number) => call(`/api/drafts/${draftId}`, { method: "DELETE", headers: { "if-match": String(ifMatch) } }),
    get: (draftId: string) => call(`/api/drafts/${draftId}`),
    list: () => call("/api/drafts"),
  };
}

/** A small PNG-signed payload; the host checks the signature, not the pixels. */
function png(seed: number, size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

const ITHACA = "Odysseus sails for Ithaca at first light.\nPack the bow.";

test("a saved draft survives a closed database and restores identically to a second login", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "ui.db");
  const first = await boot(dbPath);
  const a = await login(first, "Odysseus phone");
  const image = png(1, 4096);
  const uploaded = await a.upload("draft-ithaca", "upload-1", image);
  expect(uploaded.status).toBe(200);
  const { attachmentId } = await uploaded.json() as { attachmentId: string };
  const saved = await a.put("draft-ithaca", 0, "save-1", { sessionId: "fixture-session", text: ITHACA, attachmentIds: [attachmentId] });
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toBe("no-store");
  expect(await saved.json()).toMatchObject({ revision: 1 });
  expect((await a.put("draft-unbound", 0, "save-2", { sessionId: null, text: "A letter to Penelope", attachmentIds: [] })).status).toBe(200);
  expect((await a.put("draft-other", 0, "save-3", { sessionId: "other-session", text: "Ask Athena about the winds", attachmentIds: [] })).status).toBe(200);
  // The B login exists before the restart; its credential is in the same database.
  const b = await login(first, "Odysseus laptop");
  await first.close();

  const second = await boot(dbPath);
  cleanups.push(() => second.close());
  const call = (path: string) => second.fetch(path, { headers: { cookie: b.cookie, origin: "http://localhost", host: "localhost" } });
  const listed = draftListResponseSchema.parse(await (await call("/api/drafts")).json()) as DraftListResponse;
  expect(listed.drafts.map((d) => [d.draftId, d.sessionId, d.attachmentCount]).sort()).toEqual([
    ["draft-ithaca", "fixture-session", 1],
    ["draft-other", "other-session", 0],
    ["draft-unbound", null, 0],
  ]);
  expect(listed.drafts.find((d) => d.draftId === "draft-ithaca")?.preview).toBe("Odysseus sails for Ithaca at first light.");
  const restored = draftSchema.parse(await (await call("/api/drafts/draft-ithaca")).json()) as Draft;
  expect(restored).toMatchObject({ draftId: "draft-ithaca", sessionId: "fixture-session", revision: 1, text: ITHACA });
  expect(restored.attachments).toHaveLength(1);
  expect(restored.attachments[0]).toMatchObject({ attachmentId, mime: "image/png", name: "harbour.png" });
  const decoded = Uint8Array.from(Buffer.from(restored.attachments[0]!.bytes, "base64"));
  expect(decoded.byteLength).toBe(4096);
  expect(decoded).toEqual(image);
  expect(await (await call("/api/drafts/draft-other")).json()).toMatchObject({ sessionId: "other-session", text: "Ask Athena about the winds", attachments: [] });
});

test("a different root's host shares no drafts, and its database does not know this host's logins", async () => {
  const dir = tempDir();
  const ithaca = await boot(join(dir, "ithaca.db"));
  cleanups.push(() => ithaca.close());
  const troy = await boot(join(dir, "troy.db"));
  cleanups.push(() => troy.close());
  expect(ithaca.brainPath).not.toBe(troy.brainPath);
  const a = await login(ithaca, "Odysseus phone");
  expect((await a.put("draft-ithaca", 0, "save-1", { sessionId: null, text: ITHACA, attachmentIds: [] })).status).toBe(200);
  const local = await login(troy, "Odysseus at Troy");
  expect(await (await local.list()).json()).toEqual({ drafts: [] });
  expect(await (await local.get("draft-ithaca")).json()).toMatchObject({ error: "DRAFT_NOT_FOUND" });
  // Ithaca's credential presented at Troy: the same cookie secret, but a principal Troy never issued.
  const foreign = await troy.fetch("/api/drafts/draft-ithaca", { headers: { cookie: a.cookie, origin: "http://localhost", host: "localhost" } });
  expect(foreign.status).toBe(401);
});

test("revocation denies reads and mutations, including one whose body was still arriving", async () => {
  const t = await boot(":memory:");
  cleanups.push(() => t.close());
  const a = await login(t, "Odysseus phone");
  const b = await login(t, "Odysseus laptop");
  expect((await a.put("draft-ithaca", 0, "save-1", { sessionId: null, text: ITHACA, attachmentIds: [] })).status).toBe(200);

  // B starts a save; the credential is revoked after the guard passed and
  // before the body finished. Nothing may commit.
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const body = JSON.stringify({ sessionId: null, text: "Turn back to Troy", attachmentIds: [] });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
      await gate;
      controller.enqueue(new TextEncoder().encode(body.slice(10)));
      controller.close();
    },
  });
  const pending = b.call("/api/drafts/draft-ithaca", {
    method: "PUT", headers: { "content-type": "application/json", "if-match": "1", "idempotency-key": "late" }, body: stream,
    // @ts-expect-error Bun accepts duplex for streamed request bodies.
    duplex: "half",
  });
  await Bun.sleep(20);
  revokePrincipal(t.app.db, b.principal.id, Date.now());
  finish();
  const late = await pending;
  expect(late.status).toBe(401);
  expect(await late.json()).toEqual({ error: "Authentication required", authRequired: true });
  expect(await (await a.get("draft-ithaca")).json()).toMatchObject({ revision: 1, text: ITHACA });

  for (const response of [
    await b.list(), await b.get("draft-ithaca"), await b.remove("draft-ithaca", 1),
    await b.upload("draft-ithaca", "u", png(2)),
    await b.call("/api/drafts/draft-ithaca/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", requestId: "r" }) }),
  ]) expect(response.status).toBe(401);
  // A different, still valid login reads the same host draft.
  expect((await a.get("draft-ithaca")).status).toBe(200);
});

test("two devices saving one revision get one success and one typed conflict carrying the host's version", async () => {
  const t = await boot(":memory:");
  cleanups.push(() => t.close());
  const a = await login(t, "Odysseus phone");
  const b = await login(t, "Odysseus laptop");
  expect((await a.put("draft-ithaca", 0, "base", { sessionId: null, text: ITHACA, attachmentIds: [] })).status).toBe(200);
  const [fromA, fromB] = await Promise.all([
    a.put("draft-ithaca", 1, "edit-a", { sessionId: null, text: "Phone: sail at dawn", attachmentIds: [] }),
    b.put("draft-ithaca", 1, "edit-b", { sessionId: null, text: "Laptop: sail at dusk", attachmentIds: [] }),
  ]);
  const statuses = [fromA.status, fromB.status].sort();
  expect(statuses).toEqual([200, 409]);
  const winner = fromA.status === 200 ? "Phone: sail at dawn" : "Laptop: sail at dusk";
  const loser = fromA.status === 409 ? fromA : fromB;
  const conflict = await loser.json() as { error: string; current: Draft };
  expect(conflict.error).toBe("DRAFT_CONFLICT");
  expect(conflict.current).toMatchObject({ revision: 2, text: winner });
  expect(await (await a.get("draft-ithaca")).json()).toMatchObject({ revision: 2, text: winner });
});

test("a retried key returns its receipt, a changed payload under it is refused, and tombstones stop stale writes", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "ui.db");
  const t = await boot(dbPath);
  const a = await login(t, "Odysseus phone");
  const first = await (await a.put("draft-ithaca", 0, "save-1", { sessionId: null, text: ITHACA, attachmentIds: [] })).json();
  const replay = await a.put("draft-ithaca", 0, "save-1", { sessionId: null, text: ITHACA, attachmentIds: [] });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(first);
  const reused = await a.put("draft-ithaca", 0, "save-1", { sessionId: null, text: "Something else", attachmentIds: [] });
  expect(reused.status).toBe(409);
  expect(await reused.json()).toMatchObject({ error: "DRAFT_KEY_REUSED" });
  const second = await a.put("draft-ithaca", 1, "save-2", { sessionId: null, text: `${ITHACA} Bring wine.`, attachmentIds: [] });
  expect(await second.json()).toMatchObject({ revision: 2 });

  expect((await a.remove("draft-ithaca", 1)).status).toBe(409);
  expect((await a.remove("draft-ithaca", 2)).status).toBe(204);
  // The same delete, retried after a lost acknowledgement.
  expect((await a.remove("draft-ithaca", 2)).status).toBe(204);
  await t.close();

  const reopened = await boot(dbPath);
  cleanups.push(() => reopened.close());
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", a.cookie); headers.set("origin", "http://localhost"); headers.set("host", "localhost");
    return reopened.fetch(path, { ...init, headers });
  };
  const put = (ifMatch: number, key: string, text: string) => call("/api/drafts/draft-ithaca", {
    method: "PUT", headers: { "content-type": "application/json", "if-match": String(ifMatch), "idempotency-key": key },
    body: JSON.stringify({ sessionId: null, text, attachmentIds: [] }),
  });
  // A stale autosave, a fresh create and a delayed retry of an old save: none resurrects it.
  for (const response of [await put(2, "stale-autosave", "late keystrokes"), await put(0, "recreate", "late keystrokes")]) {
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: "DRAFT_DELETED", tombstoneRevision: 3 });
  }
  const delayed = await put(1, "save-2", `${ITHACA} Bring wine.`);
  expect(await delayed.json()).toEqual({ revision: 2, updatedAt: expect.any(Number) });
  expect((await call("/api/drafts/draft-ithaca")).status).toBe(410);
  expect(await (await call("/api/drafts")).json()).toEqual({ drafts: [] });
  expect((await call("/api/drafts/draft-ithaca", { method: "DELETE", headers: { "if-match": "1" } })).status).toBe(410);
});

test("invalid, oversized and over-capacity requests leave the committed draft as it was", async () => {
  const t = await boot(":memory:");
  cleanups.push(() => t.close());
  const a = await login(t, "Odysseus phone");
  const { attachmentId } = await (await a.upload("draft-ithaca", "u-1", png(1))).json() as { attachmentId: string };
  expect((await a.put("draft-ithaca", 0, "save-1", { sessionId: null, text: ITHACA, attachmentIds: [attachmentId] })).status).toBe(200);
  const before = await (await a.get("draft-ithaca")).json();

  const notPng = await a.upload("draft-ithaca", "u-bad", new TextEncoder().encode("not an image at all"));
  expect(notPng.status).toBe(400);
  expect(await notPng.json()).toMatchObject({ error: "DRAFT_INVALID" });
  expect((await a.upload("draft-ithaca", "u-svg", png(3), "image/svg+xml")).status).toBe(415);
  // A chunked body without Content-Length is counted as it arrives.
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(png(4, 8));
      for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1_000_000));
      controller.close();
    },
  });
  const big = await a.call("/api/drafts/draft-ithaca/attachments", {
    method: "POST", headers: { "content-type": "image/png", "idempotency-key": "u-big" }, body: oversized,
    // @ts-expect-error Bun accepts duplex for streamed request bodies.
    duplex: "half",
  });
  expect(big.status).toBe(413);
  expect(await big.json()).toMatchObject({ error: "DRAFT_TOO_LARGE", limit: 4_000_000, bound: "image" });

  const tooLong = await a.put("draft-ithaca", 1, "save-long", { sessionId: null, text: "Ω".repeat(40_000), attachmentIds: [attachmentId] });
  expect(tooLong.status).toBe(413);
  expect(await tooLong.json()).toMatchObject({ error: "DRAFT_TOO_LARGE", limit: 65_536, bound: "text" });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await (await a.upload("draft-ithaca", `u-many-${i}`, png(10 + i))).json() as { attachmentId: string }).attachmentId);
  const tooMany = await a.put("draft-ithaca", 1, "save-many", { sessionId: null, text: ITHACA, attachmentIds: ids });
  expect(tooMany.status).toBe(413);
  expect(await tooMany.json()).toMatchObject({ error: "DRAFT_TOO_LARGE", limit: 4, bound: "imageCount" });
  const unknown = await a.put("draft-ithaca", 1, "save-unknown", { sessionId: null, text: ITHACA, attachmentIds: ["no-such-image"] });
  expect(unknown.status).toBe(400);
  expect((await a.put("draft-ithaca", 1, "save-empty", { sessionId: null, text: "", attachmentIds: [] })).status).toBe(400);
  const precondition = await a.put("draft-ithaca", null, "save-no-match", { sessionId: null, text: ITHACA, attachmentIds: [] });
  expect(precondition.status).toBe(428);
  expect((await a.call("/api/drafts/draft-ithaca", { method: "PUT", headers: { "content-type": "text/plain", "if-match": "1", "idempotency-key": "k" }, body: "{}" })).status).toBe(415);
  expect(await (await a.get("draft-ithaca")).json()).toEqual(before);

  // Count capacity: the 100th draft saves, the 101st is refused and stored nowhere.
  for (let i = 1; i < 100; i++) {
    expect((await a.put(`draft-${i}`, 0, `fill-${i}`, { sessionId: null, text: `Oar ${i}`, attachmentIds: [] })).status).toBe(200);
  }
  const full = await a.put("draft-overflow", 0, "fill-overflow", { sessionId: null, text: "One oar too many", attachmentIds: [] });
  expect(full.status).toBe(507);
  expect(await full.json()).toMatchObject({ error: "DRAFT_CAPACITY", limit: 100, bound: "drafts" });
  expect((await a.get("draft-overflow")).status).toBe(404);
  expect(((await (await a.list()).json()) as DraftListResponse).drafts).toHaveLength(100);
});

test("draft text and images never reach the request log", async () => {
  const t = await boot(":memory:");
  cleanups.push(() => t.close());
  const a = await login(t, "Odysseus phone");
  const secret = "Penelope's loom is unpicked each night";
  await a.upload("draft-loom", "u", png(5), "image/png", "loom.png");
  await a.put("draft-loom", 0, "s", { sessionId: null, text: secret, attachmentIds: [] });
  await a.get("draft-loom");
  const records = JSON.stringify(t.observability.logs.records());
  expect(records).toContain("/api/drafts/draft-loom");
  expect(records).not.toContain("Penelope");
  expect(records).not.toContain("loom.png");
});
