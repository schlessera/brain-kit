/**
 * The GitHub detail pages through the real app (#3796): createApp mounts the
 * route with the tools' dedicated credential; the chat's owner account reads
 * an object its turn's GitHub tool returned, a delegated agent does not; and
 * any number of detail reads leave the session as they found it: no taint,
 * nothing recorded on the host for the conversation, and the next turn's
 * request to the backend the same as a session's that read nothing.
 *
 * Keyless and offline: the fixed API origin is routed to a loopback fake
 * after the network preload; the token is a synthetic sentinel.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { GITHUB_DETAIL_PAGE_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal, type Principal } from "../src/db/principals.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { GITHUB_TOOLS_SENTINEL, fakeGithub, routeGithubApi } from "./fixtures/github-host-fixture.js";

const SECRET = "odysseus-github-details-cookie-secret-0123";

test("the owner account pages a turn's GitHub object; detail reads leave the session's history, taint and next turn unchanged", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-github-details-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  const fake = fakeGithub({ comments: 45 }), restore = routeGithubApi(fake);
  const previous = process.env.BRAIN_UI_GITHUB_TOOLS_TOKEN;
  process.env.BRAIN_UI_GITHUB_TOOLS_TOKEN = GITHUB_TOOLS_SENTINEL;
  const histories: Record<string, SessionHistoryMessage[]> = {};
  const requests: StartTurnRequest[] = [];
  let finished = 0;
  const backend = makeFakeBackend({ id: "claude", histories, startTurn: async request => {
    requests.push(request);
    const { bridge } = request;
    await bridge.inputSafety!.ready("claude", 1);
    const sessionId = request.sessionId ?? `sess-ithaca-${requests.length}`;
    bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    try {
      if (!request.sessionId) {
        const result = await bridge.github!({ tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } });
        histories[sessionId] = [{ role: "user", content: request.prompt, toolCalls: [] },
          { role: "assistant", content: "The suitors drain the stores.", toolCalls: [{ id: "read-7", name: "mcp__brain-ui__brain_github_issue_read",
            input: { repository: "odysseus/ithaca", number: 7 }, output: JSON.stringify(result), isError: !result.ok }] }];
      }
    } finally {
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      finished++;
    }
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1",
    AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
    COOKIE_SECRET: SECRET, BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  try {
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Penelope's loom", ttlSeconds: 600 });
    const phone = createPrincipal(app.db, { authMethod: "password", label: "Penelope's phone", ttlSeconds: 600 });
    const agent = createPrincipal(app.db, { authMethod: "delegated", label: "Suitor agent", createdBy: owner.id, ttlSeconds: 600 });
    const cookie = async (principal: Principal) => (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
    const get = async (path: string, principal: Principal) => app.fetch(new Request(`http://localhost/api${path}`, { headers: { cookie: await cookie(principal) } }));
    async function chat(text: string, sessionId?: string) {
      const before = finished, handlers = createWsHandlers(app.wsHost, owner), sent: string[] = [];
      const ws = { send: (frame: string) => { sent.push(frame); }, close() {}, readyState: 1 } as WSContext;
      await handlers.onOpen(undefined as never, ws);
      handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text, requestId: `details-${requests.length}`, ...(sessionId ? { sessionId } : {}) }) } as MessageEvent, ws);
      const until = Date.now() + 45_000;
      while (finished === before || app.isTurnActive()) { if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`); await Bun.sleep(10); }
      handlers.onClose({ code: 1000 } as CloseEvent, ws);
    }

    // Two sessions take the same turns; only the first reads details in between.
    await chat("Look up the suitors issue");
    await chat("Look up the suitors issue");
    const [read, control] = ["sess-ithaca-1", "sess-ithaca-2"];
    const taints = (sessionId: string) => queryGovernanceEvents(app.db, { sessionId, kinds: ["taint"], limit: 50 }).map(event => event.id);
    const readTaints = taints(read);
    expect(readTaints.length, "GITHUB_TOOL_READ_TAINTS").toBe(1);
    const historyBefore = JSON.stringify(await (await get(`/sessions/${read}`, owner)).json());

    const path = `/sessions/${read}/github/odysseus/ithaca/7/comments`;
    let cursor: string | null = null, items = 0;
    for (let reads = 0; reads < 3; reads++) {
      const response = await get(cursor ? `${path}?cursor=${cursor}` : path, reads === 1 ? phone : owner);
      expect(response.status, `GITHUB_DETAIL_APP_PAGE ${reads}`).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = GITHUB_DETAIL_PAGE_SCHEMA.parse(await response.json());
      items += page.items.length;
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(items, "GITHUB_DETAIL_APP_ALL_COMMENTS").toBe(45);
    expect((await get(`/sessions/${read}/github/penelope/troy/7/comments`, owner)).status, "GITHUB_DETAIL_APP_NOT_IN_SESSION").toBe(404);
    expect((await get(path, agent)).status, "GITHUB_DETAIL_APP_AGENT_NOT_OWNER").toBe(403);
    expect((await get(`/sessions/${read}/github/odysseus/ithaca/7/timeline`, owner)).status, "GITHUB_DETAIL_APP_PART").toBe(400);

    expect(taints(read), "GITHUB_DETAIL_READS_NEVER_TAINT").toEqual(readTaints);
    expect(JSON.stringify(await (await get(`/sessions/${read}`, owner)).json()), "GITHUB_DETAIL_HISTORY_UNCHANGED").toBe(historyBefore);

    // The next turn: the backend is handed exactly what the session that read nothing is handed.
    await chat("And the bow?", read);
    await chat("And the bow?", control);
    const handed = (request: StartTurnRequest) => JSON.stringify({ prompt: request.prompt, attachments: request.attachments ?? null, profileId: request.profileId ?? null,
      thinkingLevel: request.thinkingLevel ?? null, budgetContext: request.budgetContext ?? null, sessionBudgetLimits: request.sessionBudgetLimits ?? null,
      client: request.client ?? null, posture: request.posture ?? null, noGrantSurface: request.noGrantSurface ?? null, enforceAllowedTools: request.enforceAllowedTools ?? null });
    const [next, controlNext] = [requests.at(-2)!, requests.at(-1)!];
    expect([next.sessionId, controlNext.sessionId]).toEqual([read, control]);
    expect(handed(next), "GITHUB_DETAIL_NEXT_TURN_UNCHANGED").toBe(handed(controlNext));
    expect(next.prompt, "GITHUB_DETAIL_NEVER_IN_PROMPT").not.toContain("Comment 9044");
    expect(taints(read).length, "GITHUB_DETAIL_NO_LATER_TAINT").toBe(1);
  } finally {
    await app.close(); broker.close(); await native.close();
    restore(); fake.stop();
    if (previous === undefined) delete process.env.BRAIN_UI_GITHUB_TOOLS_TOKEN; else process.env.BRAIN_UI_GITHUB_TOOLS_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
