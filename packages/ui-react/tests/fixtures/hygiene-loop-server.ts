/** C6: real routes, durable store, socket transport and CLI; no canned outcomes. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { createPrincipal } from "../../../ui-server/src/db/principals.js";
import { createBrainClient } from "../../../ui-server/src/brain/client.js";
import { createHygieneReview } from "../../../ui-server/src/inbox/hygiene-review.js";
import { createHygieneReviewRoutes } from "../../../ui-server/src/routes/hygiene-review.js";
import { createInboxStore, InboxStore } from "../../../ui-server/src/inbox/store.js";
import { createInboxStream } from "../../../ui-server/src/inbox/stream.js";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { AppEnv } from "../../../ui-server/src/app-env.js";
const [root, requestedPort] = process.argv.slice(2);
const now = () => Number(readFileSync(join(root!, "clock.txt"), "utf8"));
const db = createUiDb(join(root!, "ui.sqlite"));
const principal = db.query("SELECT id FROM principals LIMIT 1").get() as { id: string } | null;
const principalId = principal?.id ?? createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 }).id;
const brain = createBrainClient({ brainPath: root!, exec: {} });
const review = createHygieneReview(db, { brain, now, timeZone: "UTC" });
const store = createInboxStore(db, { now }), stream = createInboxStream(store, db, undefined, review.resolver);
// Stop inside the real synchronous outcome transaction, after the CLI has exited.
// The test kills the whole server, then boots the same SQLite/Markdown state.
const commit = InboxStore.prototype.commit;
InboxStore.prototype.commit = function (mutations) {
  if (existsSync(join(root!, "crash.txt")) && mutations.some(m => m.kind === "hygiene_update" && m.hygiene.outcome?.status === "fixed")) {
    writeFileSync(join(root!, "written.flag"), "written");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return commit.call(this, mutations);
};
await review.recover();
const auth = { principalId, expiresAt: Number.MAX_SAFE_INTEGER, valid: true, retain: () => () => {}, release() {} };
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => { c.set("principal", { id: principalId } as never); await next(); });
app.route("/api", createHygieneReviewRoutes(review));
app.get("/fixture", c => c.json({ read: review.read(), items: store.snapshot().items }));
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(requestedPort ?? 0),
  fetch(req, s) { if (new URL(req.url).pathname === "/ws" && s.upgrade(req)) return; return app.fetch(req); },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ type: "server_hello", protocolRev: 2, capabilities: { inbox: true } })); },
    message(ws, raw) {
      const p = parseClientMessage(String(raw)); if (!p.ok) throw new Error(p.error);
      const msg = p.message, ctx = { raw: ws, send: (s: string) => ws.send(s), close: () => ws.close() };
      if (msg.type === "inbox_subscribe") stream.handleSubscribe(ctx as never, msg, auth as never);
      else if (msg.type === "inbox_unsubscribe") stream.handleUnsubscribe(ctx as never, msg);
      else if (msg.type === "inbox_resolve" || msg.type === "inbox_snooze") void stream.handleDecision!(ctx as never, msg, auth as never);
    },
    close(ws) { stream.dropConnection({ raw: ws } as never); },
  },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
process.on("SIGTERM", () => { stream.close(); server.stop(true); db.close(); process.exit(0); });
