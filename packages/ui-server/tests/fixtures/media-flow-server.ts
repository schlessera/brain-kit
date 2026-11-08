/**
 * The media review flow's server (#2783): the real brain client and core CLI,
 * hygiene review coordinator, journal-backed media effects under the real
 * writer gate and change journal, inbox store and stream, review and files
 * routes, on loopback. Nothing is canned. `tests/helpers/media-flow.ts` boots
 * it on one state directory, and stops, kills and boots it again there.
 *
 * argv: <brain> <state> <port> <journal cap bytes, 0 for the default> <host|worker>
 *
 * `worker` runs every brain CLI command the server issues in a real
 * maintenance worker behind the native manager boundary, with the test-only
 * copied checkpoints, as the worker-backed review suites do; a host that
 * cannot start one fails rather than falling back. `host` runs them as host
 * processes, as a server on a host without a qualified worker does.
 *
 * Test-only seams, each named by the parent: a principal per request
 * (`x-media-flow-principal` or `?as=` on the socket: the owner Odysseus, a
 * second owner device, a delegated agent), and `interrupt.txt`, which stops
 * this process dead at one CLI step of a media effect so the parent can kill
 * it there. The change journal's native checkpoints use the test-only copied
 * fixture, as in the media effects suite.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../../src/db/client.js";
import { createPrincipal } from "../../src/db/principals.js";
import { createBrainClient } from "../../src/brain/client.js";
import { createHostBoundary } from "../../src/brain/host-boundary.js";
import { createTurnJournal } from "../../src/brain/turn-journal.js";
import { createWriterGate } from "../../src/brain/writer-gate.js";
import { createMediaEffects } from "../../src/inbox/media-effects.js";
import { createHygieneReview } from "../../src/inbox/hygiene-review.js";
import { createHygieneReviewRoutes } from "../../src/routes/hygiene-review.js";
import { createFilesRoutes } from "../../src/routes/files.js";
import { createInboxStore } from "../../src/inbox/store.js";
import { createInboxStream } from "../../src/inbox/stream.js";
import type { AppEnv } from "../../src/app-env.js";
import { createNativeJournalFixture } from "../helpers/native-journal-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../helpers/fixture-native-startup.js";
import { createNativeBrainManagerClient, NATIVE_MANAGER_MAX_DELTA_BYTES, NATIVE_MANAGER_OPERATION_TIMEOUT_MS } from "@schlessera/brain-ui-sdk/internal";

const [brainPath, state, port, cap, execution] = process.argv.slice(2) as [string, string, string, string, "host" | "worker"];
const dbPath = join(state, "ui.sqlite");
const db = createUiDb(dbPath);
const principalsFile = join(state, "principals.json");
type Principals = { owner: string; penelope: string; agent: string };
const principals: Principals = existsSync(principalsFile) ? JSON.parse(readFileSync(principalsFile, "utf8")) : (() => {
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope tablet", ttlSeconds: 86400 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Telemachus research", createdBy: owner.id, ttlSeconds: 86400 });
  const ids = { owner: owner.id, penelope: penelope.id, agent: agent.id };
  writeFileSync(principalsFile, JSON.stringify(ids));
  return ids;
})();
const principalOf = (as: string | null | undefined) => principals[(as ?? "owner") as keyof Principals] ?? principals.owner;

const native = createNativeJournalFixture(brainPath, state);
const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath, dbPath, objectsRoot: join(state, "objects"), ...(Number(cap) > 0 ? { capBytes: Number(cap) } : {}) });
await journal.ready;
const gate = createWriterGate(db, brainPath);
// The brain client the app builds. In a worker, through the native manager
// boundary; otherwise on a host without a qualified worker, as host processes.
let broker: { socketPath: string; close(): void } | undefined;
if (execution === "worker") { replaceNativeStartupAcquisitionForFixture(); broker = native.serve(); }
const boundary = broker
  ? createHostBoundary({ brainPath, exec: {}, dbPath, nativeManager: createNativeBrainManagerClient({ socketPath: broker.socketPath, leasePath: join(state, "native-leases.sqlite"), timeoutMs: NATIVE_MANAGER_OPERATION_TIMEOUT_MS, maxDeltaBytes: NATIVE_MANAGER_MAX_DELTA_BYTES }) })
  : createHostBoundary({ brainPath, exec: {}, dbPath, workerHost: () => ({ ok: false, requirement: "the media flow fixture runs the CLI on the host" }) });
// As the app does at boot: qualify the worker boundary before any admission.
const governed = await boundary.prepare();
const brain = createBrainClient({ brainPath, exec: {}, boundary });

/** Stop dead at `interrupt.txt`'s CLI step, before (`keep-copy`) or after (`media`) it runs. */
const interrupt = existsSync(join(state, "interrupt.txt")) ? readFileSync(join(state, "interrupt.txt"), "utf8").trim() : "";
function halt(): never {
  writeFileSync(join(state, "interrupted.flag"), "interrupted");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}
async function hygiene(args: string[]) {
  const applying = args[0] === interrupt && !args.includes("--dry-run");
  if (applying && interrupt === "keep-copy") halt();
  const result = await brain.hygiene!(args);
  if (applying && interrupt === "media") halt();
  return result;
}
const media = createMediaEffects(db, { brainPath, journal, gate, lock: createKeyedLock(), cli: hygiene,
  authorized: id => id === principals.owner || id === principals.penelope });
const review = createHygieneReview(db, { brain, media });
// As the app does at boot: an interrupted effect is compensated before anything else runs.
await review.recover();

const store = createInboxStore(db), stream = createInboxStream(store, db, undefined, review.resolver);
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => { c.set("principal", { id: principalOf(c.req.header("x-media-flow-principal")) } as never); await next(); });
app.route("/api", createHygieneReviewRoutes(review));
app.route("/api", createFilesRoutes({ brainRoot: brainPath }));
const auth = (principalId: string) => ({ principalId, expiresAt: Number.MAX_SAFE_INTEGER, valid: true, retain: () => () => {}, release() {} });

const server = Bun.serve<{ principalId: string }, never>({
  hostname: "127.0.0.1", port: Number(port),
  fetch(req, s) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && s.upgrade(req, { data: { principalId: principalOf(url.searchParams.get("as")) } })) return;
    return app.fetch(req);
  },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ type: "server_hello", protocolRev: 2, capabilities: { inbox: true } })); },
    message(ws, raw) {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) throw new Error(parsed.error);
      const msg = parsed.message, ctx = { raw: ws, send: (s: string) => ws.send(s), close: () => ws.close() };
      if (msg.type === "inbox_subscribe") stream.handleSubscribe(ctx as never, msg, auth(ws.data.principalId) as never);
      else if (msg.type === "inbox_unsubscribe") stream.handleUnsubscribe(ctx as never, msg);
      else if (msg.type === "inbox_resolve" || msg.type === "inbox_snooze") void stream.handleDecision!(ctx as never, msg, auth(ws.data.principalId) as never);
    },
    close(ws) { stream.dropConnection({ raw: ws } as never); },
  },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, principals, hostExecution: boundary.status().hostExecution, governed }));
process.on("SIGTERM", async () => {
  stream.close();
  server.stop(true);
  await journal.close();
  broker?.close();
  await native.close();
  db.close();
  process.exit(0);
});
