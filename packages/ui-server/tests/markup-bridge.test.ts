/**
 * `request_image_markup` through the host (#3975): the bridge reads the source,
 * asks only a browser that can draw, takes the layer over the real upload
 * route and returns the receipt; every decline, cancellation and refusal
 * writes nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { BRAIN_MARKUP_MAX_BYTES, createKeyedLock, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { IMAGE_MARKUP_CAPABILITY } from "@schlessera/brain-ui-sdk/protocol";

import type { AppEnv } from "../src/app-env.js";
import { createUiDb } from "../src/db/client.js";
import { WsHost } from "../src/ws/host.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { makeBridge } from "../src/ws/bridge.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { createPrincipal } from "../src/db/principals.js";
import { createMarkupRoutes } from "../src/routes/markup.js";
import type { RunningTurn } from "../src/ws/turns.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization } from "./helpers/principal.js";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { markupProblem } from "../../module-images/src/markup.js";
import { jpegWithOrientation, png } from "./helpers/markup-images.js";

type Answer = "upload" | "decline" | "nothing";
let server: ReturnType<typeof Bun.serve>;
let currentHost: WsHost | undefined;
beforeAll(() => {
  const app = new Hono<AppEnv>()
    .use("*", async (c, next) => { c.set("principal", { id: "odysseus" } as never); await next(); })
    .route("/api", createMarkupRoutes({
      peekMarkup: (...a) => currentHost!.coordinator.peekMarkup(...a),
      claimMarkup: (...a) => currentHost!.coordinator.claimMarkup(...a),
    }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 64 * 1024 * 1024, fetch: app.fetch });
});
afterAll(() => server.stop(true));

async function fixture(options: { backendId?: "claude" | "pi"; voice?: boolean; capable?: boolean; answer?: Answer; layer?: (frame: Record<string, unknown>) => Uint8Array<ArrayBuffer> } = {}) {
  const backendId = options.backendId ?? "claude";
  const root = mkdtempSync(join(tmpdir(), "markup-bridge-"));
  mkdirSync(join(root, "photos")); mkdirSync(join(root, ".brain/scratch"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  // Stored 64 × 48, displayed 48 × 64 after EXIF orientation 6.
  writeFileSync(join(root, "photos/raft-at-ithaca.jpg"), jpegWithOrientation(64, 48, 6));
  const db = createUiDb(":memory:");
  const maintenance = createFixtureMaintenanceHost(root);
  const host = new WsHost({ brainPath: root, maintenance, registry: createStaticBackendRegistry([makeFakeBackend({ id: backendId })], backendId),
    catalog: createSessionCatalog(() => db), isPrincipalAuthorized: () => true });
  currentHost = host;
  const frames: Record<string, unknown>[] = [];
  const uploads: Promise<Response>[] = [];
  const sources: { status: number; bytes: Buffer }[] = [];
  const authorization = testAuthorization("odysseus");
  const ws = { send(text: string) {
    const frame = JSON.parse(text) as Record<string, unknown>;
    frames.push(frame);
    if (frame.type !== "markup_request") return;
    if (options.answer === "decline") {
      void handleClientMessage(host, ws, { type: "markup_error", requestId: frame.requestId as string, code: "cancelled", message: "closed", turnId: frame.turnId as string },
        { principal: { id: "odysseus" } as never, authorization, protocolRev: 3 });
    } else if ((options.answer ?? "upload") === "upload") {
      const body = new FormData();
      body.append("summary", JSON.stringify({ marks: { pen: 1, arrow: 2, ellipse: 1, text: 2 }, notes: ["make the sail red", "move the raft here"] }));
      const layer = options.layer?.(frame) ?? png(frame.width as number, frame.height as number, { pixel: (x) => (x === 7 ? [255, 59, 48, 255] : [0, 0, 0, 0]) });
      body.append("layer", new Blob([layer], { type: "image/png" }));
      // As the editor does: read the bound source, then send the layer.
      uploads.push(fetch(`http://127.0.0.1:${server.port}/api${frame.sourcePath}?turnId=${frame.turnId}`).then(async source => {
        sources.push({ status: source.status, bytes: Buffer.from(await source.arrayBuffer()) });
        return fetch(`http://127.0.0.1:${server.port}/api${frame.uploadPath}?turnId=${frame.turnId}`, { method: "POST", body });
      }));
    }
  } };
  host.clients.add(ws, "odysseus");
  if (options.capable ?? true) host.clients.setCapabilities(ws, { [IMAGE_MARKUP_CAPABILITY]: true });
  const live = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const turn = { turnId: "raft-turn", principalId: "odysseus", authorization: live, startedAt: 1, abortController: new AbortController(), queue: [], pendingCancellationPrincipalIds: [],
    ...(options.voice ? { work: { posture: "voice" } } : {}) } as unknown as RunningTurn;
  const bridge = await makeBridge(host, turn, { promptText: "Odysseus marks the raft", backendId,
    applicationPolicy: { lock: createKeyedLock(), available: ["write"], autoAllowed: ["write"] } }) as BackendBridge;
  const layers = () => existsSync(join(root, ".brain/scratch/markup")) ? readdirSync(join(root, ".brain/scratch/markup")) : [];
  return { root, host, bridge, turn, frames, uploads, sources, layers,
    cleanup() { live.release(); host.close(); maintenance.cleanup(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test.each(["claude", "pi"] as const)("%s: the user draws on the rotated source and the receipt names the saved layer", async backendId => {
  const f = await fixture({ backendId });
  try {
    expect(f.bridge.requestImageMarkup, "both interactive backends get the host operation").toBeDefined();
    const payload = await f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg", instruction: "mark what should move and where" });
    const request = f.frames.find(frame => frame.type === "markup_request")!;
    expect(request).toMatchObject({ imagePath: "photos/raft-at-ithaca.jpg", instruction: "mark what should move and where",
      width: 48, height: 64, maxBytes: BRAIN_MARKUP_MAX_BYTES, turnId: "raft-turn" });
    expect(request.uploadPath).toBe(`/markup/${request.requestId}`);
    expect(request.sourcePath).toBe(`/markup/${request.requestId}/source`);
    expect((await f.uploads[0]!).status).toBe(202);
    expect(f.sources[0]!.status, "the editor reads the bound source").toBe(200);
    expect(f.sources[0]!.bytes.equals(readFileSync(join(f.root, "photos/raft-at-ithaca.jpg")))).toBe(true);
    expect(payload).toMatchObject({ imagePath: "photos/raft-at-ithaca.jpg", width: 48, height: 64,
      marks: { pen: 1, arrow: 2, ellipse: 1, text: 2 }, notes: ["make the sail red", "move the raft here"] });
    expect(payload.markupPath).toMatch(/^\.brain\/scratch\/markup\/raft-at-ithaca\.[a-f0-9]{8}\.markup\.png$/);
    expect(payload.note).toContain("brain image --ref <imagePath> --markup <markupPath>");
    const written = readFileSync(join(f.root, payload.markupPath));
    expect(payload.bytes).toBe(written.length);
    expect(markupProblem({ data: written, mime: "image/png" }, { data: readFileSync(join(f.root, "photos/raft-at-ithaca.jpg")), mime: "image/jpeg" })).toBeNull();
  } finally { f.cleanup(); }
});

test("closing the editor refuses in the editor's words and writes nothing", async () => {
  const f = await fixture({ answer: "decline" });
  try {
    await expect(f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" })).rejects.toThrow("The user closed the markup editor");
    expect(f.layers()).toEqual([]);
  } finally { f.cleanup(); }
});

test("another principal's connection cannot decline the request", async () => {
  const f = await fixture({ answer: "nothing" });
  try {
    const pending = f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" });
    await Bun.sleep(10);
    const request = f.frames.find(frame => frame.type === "markup_request")!;
    await handleClientMessage(f.host, { send() {} }, { type: "markup_error", requestId: request.requestId as string, code: "cancelled", message: "closed", turnId: "raft-turn" },
      { principal: { id: "athena" } as never, authorization: testAuthorization("athena"), protocolRev: 3 });
    expect(f.host.coordinator.peekMarkup(request.requestId as string), "the request is still open").toBeDefined();
    await handleClientMessage(f.host, { send() {} }, { type: "markup_error", requestId: request.requestId as string, code: "cancelled", message: "closed", turnId: "raft-turn" },
      { principal: { id: "odysseus" } as never, authorization: testAuthorization("odysseus"), protocolRev: 3 });
    await expect(pending).rejects.toThrow("The user closed the markup editor");
  } finally { f.cleanup(); }
});

test("a source changed after the editor opened is no longer served to it", async () => {
  const f = await fixture({ answer: "nothing" });
  try {
    const pending = f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" });
    pending.catch(() => {});
    await Bun.sleep(10);
    const request = f.frames.find(frame => frame.type === "markup_request")!;
    const read = () => fetch(`http://127.0.0.1:${server.port}/api${request.sourcePath}?turnId=raft-turn`);
    expect((await read()).status).toBe(200);
    writeFileSync(join(f.root, "photos/raft-at-ithaca.jpg"), jpegWithOrientation(64, 48, 1));
    const stale = await read();
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("markup_source_unavailable");
    f.host.coordinator.claimMarkup(request.requestId as string)!.reject(new Error("closed"));
  } finally { f.cleanup(); }
});

test("a layer that does not match the source is refused and writes nothing", async () => {
  const f = await fixture({ layer: () => png(64, 48) });
  try {
    await expect(f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" })).rejects.toThrow("64x48 but the image is 48x64");
    expect(f.layers()).toEqual([]);
  } finally { f.cleanup(); }
});

test("cancelling the turn while the editor is open writes nothing, and a late upload finds no request", async () => {
  const f = await fixture({ answer: "nothing" });
  try {
    const pending = f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" });
    await Bun.sleep(10);
    const request = f.frames.find(frame => frame.type === "markup_request")!;
    f.host.coordinator.cancelTurn(f.turn, "Cancelled by the user");
    await expect(pending).rejects.toThrow();
    const body = new FormData();
    body.append("summary", JSON.stringify({ marks: { pen: 1, arrow: 0, ellipse: 0, text: 0 }, notes: [] }));
    body.append("layer", new Blob([png(48, 64)]));
    const late = await fetch(`http://127.0.0.1:${server.port}/api${request.uploadPath}?turnId=raft-turn`, { method: "POST", body });
    expect(late.status).toBe(404);
    expect(f.layers()).toEqual([]);
  } finally { f.cleanup(); }
});

test("no editor opens without a connected browser that declared it can draw", async () => {
  const f = await fixture({ capable: false });
  try {
    await expect(f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" })).rejects.toThrow("can show the markup editor");
    expect(f.frames.filter(frame => frame.type === "markup_request")).toEqual([]);
  } finally { f.cleanup(); }
});

test("a voice turn refuses before any editor opens", async () => {
  const f = await fixture({ voice: true });
  try {
    await expect(f.bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" })).rejects.toThrow("outside the voice membership");
    expect(f.frames.filter(frame => frame.type === "markup_request")).toEqual([]);
    expect(f.layers()).toEqual([]);
  } finally { f.cleanup(); }
});

test("a source the markup cannot bind refuses before any editor opens", async () => {
  const f = await fixture();
  try {
    await expect(f.bridge.requestImageMarkup!({ imagePath: "photos/missing.png" })).rejects.toThrow("does not exist");
    await expect(f.bridge.requestImageMarkup!({ imagePath: "../outside.png" })).rejects.toThrow("without traversal");
    expect(f.frames.filter(frame => frame.type === "markup_request")).toEqual([]);
  } finally { f.cleanup(); }
});

test("only the principal's drawing connections see the request, and losing the last of them rejects it", async () => {
  const root = mkdtempSync(join(tmpdir(), "markup-disconnect-"));
  mkdirSync(join(root, "photos")); mkdirSync(join(root, ".brain/scratch"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  writeFileSync(join(root, "photos/raft-at-ithaca.jpg"), jpegWithOrientation(64, 48, 6));
  const db = createUiDb(":memory:");
  const maintenance = createFixtureMaintenanceHost(root);
  const host = new WsHost({ brainPath: root, maintenance, registry: createStaticBackendRegistry([makeFakeBackend({ id: "claude" })], "claude"),
    catalog: createSessionCatalog(() => db), isPrincipalAuthorized: () => true });
  const socket = async (label: string, capable: boolean) => {
    const principal = createPrincipal(db, { authMethod: "password", label, ttlSeconds: 3600 });
    const handlers = createWsHandlers(host, principal);
    const frames: Record<string, unknown>[] = [];
    const ws = { raw: {}, send(data: string) { frames.push(JSON.parse(data)); }, close() {} } as never;
    await handlers.onOpen(new Event("open"), ws);
    handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "client_hello", protocolRev: 3, capabilities: capable ? { [IMAGE_MARKUP_CAPABILITY]: true } : {} }) }), ws);
    await Bun.sleep(0);
    return { principal, handlers, frames, ws };
  };
  const odysseus = await socket("Odysseus", true);
  const odysseusOldTab = await socket("Odysseus without the editor", false);
  const athena = await socket("Athena", true);
  const live = host.coordinator.openAuthorization({ principalId: odysseus.principal.id, valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const turn = { turnId: "raft-turn", principalId: odysseus.principal.id, authorization: live, startedAt: 1, abortController: new AbortController(),
    queue: [], pendingCancellationPrincipalIds: [] } as unknown as RunningTurn;
  try {
    const bridge = await makeBridge(host, turn, { promptText: "Odysseus marks the raft", backendId: "claude",
      applicationPolicy: { lock: createKeyedLock(), available: ["write"], autoAllowed: ["write"] } }) as BackendBridge;
    const pending = bridge.requestImageMarkup!({ imagePath: "photos/raft-at-ithaca.jpg" });
    pending.catch(() => {});
    await Bun.sleep(10);
    expect(odysseus.frames.some(frame => frame.type === "markup_request"), "the drawing connection is asked").toBe(true);
    for (const other of [odysseusOldTab, athena]) expect(other.frames.some(frame => frame.type === "markup_request"), "nobody else is").toBe(false);
    odysseus.handlers.onClose(new CloseEvent("close", { code: 1000 }), odysseus.ws);
    // Bounded: a request nobody can answer must not wait for the turn timeout.
    const settled = await Promise.race([pending.then(() => "resolved", (error: Error) => error.message), Bun.sleep(3000).then(() => "still waiting")]);
    expect(settled).toBe("Client disconnected");
    expect(host.coordinator.pendingMarkup.size).toBe(0);
  } finally { live.release(); host.close(); maintenance.cleanup(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
