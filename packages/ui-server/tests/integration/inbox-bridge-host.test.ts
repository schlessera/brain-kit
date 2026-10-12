import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { createApp } from "../../src/app.js";
import { resolveServerConfig } from "../../src/config/env.js";
import { createStaticBackendRegistry } from "../../src/agent/backend.js";
import { createSilentObservability } from "../../src/observability/index.js";
import { createPrincipal } from "../../src/db/principals.js";
import { createInboxStore } from "../../src/inbox/store.js";
import { makeFakeBackend } from "../helpers/fake-backend.js";
const closes: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const SECRET = "fixture-cookie-secret-0123456789abcdef";
const Socket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };

test("the authenticated app attaches durable tools to the live turn bridge and refuses unbound resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-bridge-host-")); closes.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(brain);
  let finish!: () => void, reject!: (error: unknown) => void;
  const proof = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
  // Observe rejection immediately, even if the browser hello has not arrived yet.
  void proof.catch(() => {});
  const backend = makeFakeBackend({ id: "fixture", startTurn: async req => {
    try {
      expect(req.bridge.inboxList).toBeDefined(); expect(req.bridge.inboxGet).toBeDefined();
      expect(req.bridge.inboxAdd).toBeDefined(); expect(req.bridge.resolveAction).toBeDefined();
      const read = await req.bridge.inboxGet!({ itemId: "arrival" });
      expect(read.thread).toMatchObject({ id: "share", trustClass: "untrusted" });
      const added = await req.bridge.inboxAdd!({ text: "Odysseus inspects the harbor", idempotencyKey: "harbor" });
      expect(added.created).toBe(true);
      await expect(req.bridge.resolveAction!({ sessionId: "harbor-session", itemId: "decision", optionId: "approve", expectedVersion: 1 })).rejects.toThrow("discuss is unavailable");
      finish();
    } catch (error) { reject(error); }
  } });
  const app = await createApp({ config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: SECRET,
    HOST: "127.0.0.1", DB_PATH: join(root, "ui.sqlite"), BRAIN_PATH: brain, BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    observability: createSilentObservability(), registry: createStaticBackendRegistry([backend], backend.id) });
  closes.push(() => app.close());
  createInboxStore(app.db).ingest({ threadId: "share", itemId: "arrival", source: "share", dedupKey: "share", stagingId: crypto.randomUUID(), stakes: 1, expiresAt: Date.now() + 86400000 });
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const cookie = await serializeSigned("brain_ui_session", principal.id, SECRET);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket }); closes.push(() => server.stop(true));
  const socket = new Socket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie } }); closes.push(() => socket.close());
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.send(JSON.stringify({ type: "chat_message", text: "Read the inbox" }));
  await proof;
});
