/**
 * `GET /api/chat-deletions/:operationId` (#3455) through the real composition
 * root, its cookie authentication and middleware, on file-backed SQLite: the
 * owner reads its receipt; a foreign owner, an agent and an unknown operation
 * get the same bytes; a read before the POST admits nothing. A scripted
 * backend and synthetic Odysseus text; no model, key or network.
 */
import { afterEach, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createPrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import { makeFakeBackend } from "./helpers/fake-backend";

const SECRET = "chat-deletion-http-fixture-secret-0123456789";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function boot() {
  const removals: string[] = [];
  const backend = { ...makeFakeBackend({ id: "fixture", capabilities: { historyRemoval: true },
    sessions: [{ id: "voyage", title: null, createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 1 }] }),
    async removeSessionHistory(req: { operationId: string }) { removals.push(req.operationId); return { outcome: "removed" as const }; } };
  const t = await httpContractApp({ registry: createStaticBackendRegistry([backend], backend.id), env: {
    AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  cleanups.push(() => t.close());
  return { t, removals };
}

async function as(t: HttpContractApp, principalId: string) {
  const cookie = (await generateSignedCookie("brain_ui_session", principalId, SECRET)).split(";")[0]!;
  const headers = { cookie, origin: "http://localhost", host: "localhost" };
  return {
    read: (operationId: string) => t.fetch(`/api/chat-deletions/${encodeURIComponent(operationId)}`, { headers }),
    post: (operationId: string) => t.fetch("/api/chat-deletions", { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId, target: { sessionId: "voyage" }, expected: { backendId: "fixture", generation: 1 } }) }),
  };
}
const answer = async (response: Response) => `${response.status} ${response.headers.get("cache-control")} ${await response.text()}`;

test("through the real host, the owner reads its receipt and every other caller gets one not_admitted", async () => {
  const { t, removals } = await boot();
  const catalog = t.app.wsHost.catalog;
  const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 3600 }).id;
  const other = createPrincipal(t.app.db, { authMethod: "passkey", label: "Penelope tablet", ttlSeconds: 3600 }).id;
  const agent = createPrincipal(t.app.db, { authMethod: "delegated", label: "Mentor agent", createdBy: owner, ttlSeconds: 3600 }).id;
  catalog.persistSessionStub("voyage", "Odysseus hid the oar under the olive root", null, "fixture");
  await catalog.dialogueOpen!({ conversationId: "ithaca", principalId: owner, epoch: 1, providerId: "gemini-live", sessionId: "voyage" });
  await catalog.settled!();
  const odysseus = await as(t, owner), penelope = await as(t, other), mentor = await as(t, agent);

  const before = await answer(await odysseus.read("delete-voyage"));
  expect(before, "REAL_HOST_UNKNOWN").toBe(`404 no-store ${JSON.stringify({ error: "CHAT_DELETION_NOT_ADMITTED", reason: "not_admitted",
    message: "Nothing is deleted under this operation. A request still on its way can be admitted later." })}`);
  expect([t.app.db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get(), removals], "REAL_HOST_READ_ADMITS_NOTHING").toEqual([{ n: 0 }, []]);

  const posted = await odysseus.post("delete-voyage");
  const receipt = await posted.json();
  expect([posted.status, receipt.status, removals], "REAL_HOST_FIRST_POST").toEqual([200, "removed", ["delete-voyage"]]);
  const own = await odysseus.read("delete-voyage");
  expect([own.status, own.headers.get("cache-control"), await own.json()], "REAL_HOST_OWNER_RECEIPT").toEqual([200, "no-store", receipt]);
  expect({ foreign: await answer(await penelope.read("delete-voyage")), agent: await answer(await mentor.read("delete-voyage")),
    unknown: await answer(await odysseus.read("never-sent")) }, "REAL_HOST_MISSES_IDENTICAL").toEqual({ foreign: before, agent: before, unknown: before });
  expect(removals, "REAL_HOST_READS_REMOVE_NOTHING").toEqual(["delete-voyage"]);
  expect((await t.fetch("/api/chat-deletions/delete-voyage")).status, "REAL_HOST_UNAUTHENTICATED").toBe(401);
});
