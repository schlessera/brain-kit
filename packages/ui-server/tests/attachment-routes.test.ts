import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { attachmentFileSchema, draftSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { AttachmentFile, Draft } from "@schlessera/brain-ui-sdk/protocol";

import { createPrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

// The neutral composer-upload route through a real composition root (#3153).
// Every assertion about an original reads the actual file the agent would
// open, not metadata. Odysseus fixtures only.

const SECRET = "attachment-routes-fixture-secret-0123456789";
const PDF = readFileSync(join(import.meta.dir, "../../core/fixtures/corpus/studies/star-chart.pdf"));
const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="38.2" lon="20.7"/><trkpt lat="38.2" lon="20.701"/></trkseg></trk></gpx>';
const PNG = (() => { const b = new Uint8Array(96); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); for (let i = 8; i < b.length; i++) b[i] = (i * 13) & 0xff; return b; })();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function boot(env: Record<string, string> = {}) {
  const t = await httpContractApp({ env: {
    AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1", ...env,
  } });
  cleanups.push(() => t.close());
  const principal = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie); headers.set("origin", "http://localhost"); headers.set("host", "localhost");
    return t.fetch(path, { ...init, headers });
  };
  const upload = (draftId: string, key: string, body: Uint8Array | string, name: string, type = "application/octet-stream", extra: Record<string, string> = {}) =>
    call(`/api/drafts/${draftId}/files`, { method: "POST", headers: { "idempotency-key": key, "content-type": type, "x-file-name": encodeURIComponent(name), ...extra }, body: body as BodyInit });
  const save = (draftId: string, ifMatch: number, key: string, body: Record<string, unknown>) =>
    call(`/api/drafts/${draftId}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": String(ifMatch), "idempotency-key": key }, body: JSON.stringify(body) });
  return { t, call, upload, save };
}

function onDisk(t: HttpContractApp, file: AttachmentFile): Buffer {
  return readFileSync(join(t.brainPath, file.path));
}

test("a PDF the track route refuses is stored as a real, read-only original through the composer route", async () => {
  const { t, call, upload } = await boot();
  // Failing-first witness: the existing composer path refuses a PDF outright.
  const form = new FormData();
  form.append("files", new File([PDF], "ithaca-permit.pdf", { type: "application/pdf" }));
  const refused = await call("/api/track-upload", { method: "POST", body: form });
  expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({ error: "unsupported_track" });

  const res = await upload("draft-ithaca", "pdf-1", PDF, "ithaca-permit.pdf", "application/pdf");
  expect(res.status).toBe(201);
  const file = attachmentFileSchema.parse(await res.json()) as AttachmentFile;
  expect(file).toMatchObject({ kind: "pdf", reader: "pdf", mediaType: "application/pdf", name: "ithaca-permit.pdf", bytes: PDF.byteLength, sha256: sha(PDF) });
  expect(file.path).toBe(`.brain-ui/attachments/${file.fileId}/ithaca-permit.pdf`);
  // The original on disk is byte-identical and not writable.
  expect(sha(onDisk(t, file))).toBe(sha(PDF));
  expect(statSync(join(t.brainPath, file.path)).mode & 0o777).toBe(0o444);
  // No operational inbox side effect: nothing was staged under .brain-ui/inbox.
  const inbox = join(t.brainPath, ".brain-ui", "inbox");
  expect(lstatSync(inbox, { throwIfNoEntry: false }) ? readdirSync(inbox).filter((n) => !n.startsWith(".")) : []).toEqual([]);
});

test("generic, text, JSON, unknown binary, image and track originals each route by their bytes", async () => {
  const { t, upload } = await boot();
  const cases: Array<[string, Uint8Array | string, string, Partial<AttachmentFile>]> = [
    ["crew-list.txt", "Eurylochus\nPerimedes\n", "image/png", { kind: "text", reader: "text", mediaType: "image/png" }],
    ["manifest.json", '{"crew":44}', "application/json", { kind: "text", reader: "text" }],
    ["sirens.m4a", new Uint8Array([0xc3, 0x28, 0, 1, 2]), "audio/mp4", { kind: "binary", reader: "none" }],
    ["harbour.png", PNG, "image/png", { kind: "image", reader: "image", mediaType: "image/png" }],
    ["dock-walk.json", GPX, "application/json", { kind: "track", reader: "track", mediaType: "application/gpx+xml", name: "dock-walk.gpx" }],
    ["harbour.kml", "<kml>no placemarks</kml>", "application/vnd.google-earth.kml+xml", { kind: "text", trackRejected: true }],
  ];
  for (const [name, body, type, expected] of cases) {
    const res = await upload("draft-mixed", `k-${name}`, body, name, type);
    expect(res.status).toBe(201);
    const file = await res.json() as AttachmentFile;
    expect(file).toMatchObject(expected);
    expect(sha(onDisk(t, file))).toBe(sha(body));
    if (file.kind === "track") {
      expect(file.track).toMatchObject({ path: file.path, detected: "gpx", sha256: sha(GPX) });
      expect(file.track!.summary!.measurements.distance.value!).toBeGreaterThan(50);
    } else expect(file).not.toHaveProperty("track");
  }
});

test("refusals: size, emptiness, authority headers, envelope and key reuse store nothing", async () => {
  const { t, upload } = await boot();
  const big = await upload("draft-a", "big", "x", "big.bin", "application/octet-stream", { "content-length": "25000001" });
  expect(big.status).toBe(413);
  expect(await big.json()).toMatchObject({ error: "ATTACHMENT_TOO_LARGE", bound: "file", limit: 25_000_000 });
  expect((await upload("draft-a", "empty", "", "empty.txt")).status).toBe(400);
  const forged = await upload("draft-a", "forge", "hello", "a.txt", "text/plain", { "x-target-path": "context/policies/x.md" });
  expect([forged.status, (await forged.json() as { error: string }).error]).toEqual([400, "ATTACHMENT_INVALID"]);
  const first = await upload("draft-a", "same-key", "first", "a.txt", "text/plain");
  expect(first.status).toBe(201);
  const firstFile = await first.json() as AttachmentFile;
  // A lost response is reconciled: the same key and request returns the same file.
  const again = await upload("draft-a", "same-key", "first", "a.txt", "text/plain");
  expect(again.status).toBe(200);
  expect((await again.json() as AttachmentFile).fileId).toBe(firstFile.fileId);
  const reused = await upload("draft-a", "same-key", "different", "a.txt", "text/plain");
  expect([reused.status, (await reused.json() as { error: string }).error]).toEqual([409, "ATTACHMENT_KEY_REUSED"]);
  for (let i = 1; i < 10; i++) expect((await upload("draft-a", `n${i}`, `crew ${i}`, `c${i}.txt`, "text/plain")).status).toBe(201);
  const eleventh = await upload("draft-a", "n10", "one too many", "c10.txt", "text/plain");
  expect([eleventh.status, await eleventh.json()]).toEqual([413, expect.objectContaining({ bound: "draftCount", limit: 10 })]);
  // Exactly ten originals exist, and no partial is left behind.
  const dirs = readdirSync(join(t.brainPath, ".brain-ui", "attachments"));
  expect(dirs.filter((d) => !d.startsWith(".")).length).toBe(10);
  expect(dirs.filter((d) => d.startsWith("."))).toEqual([]);
});

test("the pool refuses honestly at capacity and the read-back route verifies the digest", async () => {
  const { t, call, upload, save } = await boot({ BRAIN_UI_ATTACHMENT_POOL_BYTES: "60" });
  const res = await upload("draft-pool", "p1", "x".repeat(40), "a.txt", "text/plain", { "content-length": "40" });
  expect(res.status).toBe(201);
  const file = await res.json() as AttachmentFile;
  const full = await upload("draft-pool", "p2", "y".repeat(30), "b.txt", "text/plain", { "content-length": "30" });
  expect([full.status, await full.json()]).toEqual([507, expect.objectContaining({ error: "ATTACHMENT_CAPACITY", bound: "pool", limit: 60 })]);
  // Nothing referenced or in grace was removed to make room.
  expect(onDisk(t, file).toString()).toBe("x".repeat(40));

  // An unreferenced upload is not readable back; a saved binding authorizes it.
  expect((await call(`/api/attachments/${file.fileId}`)).status).toBe(404);
  expect((await save("draft-pool", 0, "s1", { sessionId: null, text: "Read the log", attachmentIds: [], fileIds: [file.fileId] })).status).toBe(200);
  const read = await call(`/api/attachments/${file.fileId}`);
  expect(read.status).toBe(200);
  expect(read.headers.get("content-disposition")).toStartWith("attachment");
  expect(read.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(await read.text()).toBe("x".repeat(40));
  const draft = draftSchema.parse(await (await call("/api/drafts/draft-pool")).json()) as Draft;
  expect(draft.files?.map((f) => f.fileId)).toEqual([file.fileId]);

  // An altered original is reported as changed and none of it is served.
  const abs = join(t.brainPath, file.path);
  chmodSync(abs, 0o644); writeFileSync(abs, "z".repeat(40));
  const changed = await call(`/api/attachments/${file.fileId}`);
  const body = await changed.text();
  expect([changed.status, body.includes("z")]).toEqual([409, false]);
  expect(JSON.parse(body)).toMatchObject({ error: "ATTACHMENT_CHANGED" });
});
