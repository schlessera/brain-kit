/**
 * The Gmail display route through the real app (#4207; plan §9, "Results"):
 * createApp mounts it over the host's Google credential; the chat's owner
 * reads the full body of a message its turn's Gmail read returned, beyond
 * the model's cap; a message no result in the session returned, a delegated
 * agent and a thread hidden since are refused; and detail reads leave the
 * session as they found it: no taint, the same history, the next turn's
 * request the same as a session's that read nothing.
 *
 * Keyless and offline: the fake gog only; the credential home is a fresh
 * directory outside every temp area.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFakeGog } from "../../common/tests/support/fake-gog.ts";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal, type Principal } from "../src/db/principals.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { HALL_REPLY, SWINE, ithacaMail, ithacaPolicy, longLetter } from "./fixtures/google-host-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const SECRET = "odysseus-gmail-details-cookie-secret-0123";
const LETTER = longLetter(40_000);

test("the owner reads a returned message's full body; detail reads leave the session's history, taint and next turn unchanged", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-gmail-details-"))), brain = resolve(root, "brain");
  await createFixtureBrain(ROOT, brain);
  const policy = (hidden?: string[]) => writeFile(resolve(brain, "context/policies/governance.md"), `---\nschema_version: 1\n${ithacaPolicy(hidden ? { hidden } : {})}\n---\nIthaca's Gmail rules.\n`);
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await policy();
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const homeRoot = realpathSync(mkdtempSync(join(ROOT, "tmp/odysseus-gmail-details-home-"))), home = join(homeRoot, "gog-home");
  mkdirSync(home, { mode: 0o700 }); chmodSync(home, 0o700);
  const fake = createFakeGog({ ...ithacaMail(), [`gmail.get ${HALL_REPLY}`]: LETTER.answer });
  const names = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_UI_GOG_PATH"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { BRAIN_UI_GOOGLE_HOME: home, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "penelope-weaves-by-day" });
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
        const input = { target: "message" as const, id: HALL_REPLY, view: "content" as const };
        const result = await bridge.google!({ tool: "brain_google_gmail_read", input });
        histories[sessionId] = [{ role: "user", content: request.prompt, toolCalls: [] },
          { role: "assistant", content: "Telemachus sailed for Pylos.", toolCalls: [{ id: "read-reply", name: "mcp__brain-ui__brain_google_gmail_read",
            input, output: JSON.stringify(result), isError: !result.ok }] }];
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
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), googleBinary: fake.binary } as Parameters<typeof createApp>[0]);
  try {
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Penelope's loom", ttlSeconds: 600 });
    const agent = createPrincipal(app.db, { authMethod: "delegated", label: "Suitor agent", createdBy: owner.id, ttlSeconds: 600 });
    const cookie = async (principal: Principal) => (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
    const get = async (path: string, principal: Principal) => app.fetch(new Request(`http://localhost/api${path}`, { headers: { cookie: await cookie(principal) } }));
    async function chat(text: string, sessionId?: string) {
      const before = finished, handlers = createWsHandlers(app.wsHost, owner), sent: string[] = [];
      const ws = { send: (frame: string) => { sent.push(frame); }, close() {}, readyState: 1 } as WSContext;
      await handlers.onOpen(undefined as never, ws);
      handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text, requestId: `gmail-details-${requests.length}`, ...(sessionId ? { sessionId } : {}) }) } as MessageEvent, ws);
      const until = Date.now() + 45_000;
      while (finished === before || app.isTurnActive()) { if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`); await Bun.sleep(10); }
      handlers.onClose({ code: 1000 } as CloseEvent, ws);
    }

    await chat("What did Telemachus write?");
    await chat("What did Telemachus write?");
    const [read, control] = ["sess-ithaca-1", "sess-ithaca-2"];
    const output = histories[read]![1]!.toolCalls![0]!.output!;
    expect((JSON.parse(output) as { ok: boolean }).ok, `GMAIL_DETAIL_READ_RETURNED: ${output.slice(0, 600)}`).toBe(true);
    const turnResult = JSON.parse(output) as { result: { message: { untrusted: { body_text: string; body_truncated: boolean; body_length: number } } } };
    expect(turnResult.result.message.untrusted, "GMAIL_DETAIL_MODEL_CAPPED").toMatchObject({ body_truncated: true, body_length: LETTER.text.length });
    expect(turnResult.result.message.untrusted.body_text).not.toContain("The end of Pylos.");
    const taints = (sessionId: string) => queryGovernanceEvents(app.db, { sessionId, kinds: ["taint"], limit: 50 }).map(event => event.id);
    const readTaints = taints(read);
    expect(readTaints.length, "GMAIL_TOOL_READ_TAINTS").toBe(1);
    const historyBefore = JSON.stringify(await (await get(`/sessions/${read}`, owner)).json());

    const path = `/sessions/${read}/google/gmail/messages/${HALL_REPLY}/body`;
    const response = await get(path, owner);
    expect(response.status, "GMAIL_DETAIL_APP_BODY").toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json(), "GMAIL_DETAIL_APP_FULL_BODY").toEqual({ message_id: HALL_REPLY, body_text: LETTER.text, body_length: LETTER.text.length, body_truncated: false });
    expect((await get(`/sessions/${read}/google/gmail/messages/${SWINE}/body`, owner)).status, "GMAIL_DETAIL_APP_NOT_IN_SESSION").toBe(404);
    expect((await get(path, agent)).status, "GMAIL_DETAIL_APP_AGENT_NOT_OWNER").toBe(403);
    expect((await get(`/sessions/${read}/google/gmail/messages/Penelope/body`, owner)).status, "GMAIL_DETAIL_APP_ID").toBe(400);
    // Hidden since the turn read it: the current policy decides, and it reads as a miss.
    await policy(["Label_12"]);
    const hidden = await get(path, owner);
    expect([hidden.status, await hidden.json()], "GMAIL_DETAIL_APP_HIDDEN_SINCE").toEqual([404, { error: { code: "not_found", reason: null, message: "No such Gmail thread, message or draft was found." } }]);
    await policy();

    expect(taints(read), "GMAIL_DETAIL_READS_NEVER_TAINT").toEqual(readTaints);
    expect(JSON.stringify(await (await get(`/sessions/${read}`, owner)).json()), "GMAIL_DETAIL_HISTORY_UNCHANGED").toBe(historyBefore);

    // The next turn: the backend is handed exactly what the session that read nothing is handed.
    await chat("And then?", read);
    await chat("And then?", control);
    const handed = (request: StartTurnRequest) => JSON.stringify({ prompt: request.prompt, attachments: request.attachments ?? null, profileId: request.profileId ?? null,
      thinkingLevel: request.thinkingLevel ?? null, budgetContext: request.budgetContext ?? null, sessionBudgetLimits: request.sessionBudgetLimits ?? null,
      client: request.client ?? null, posture: request.posture ?? null, noGrantSurface: request.noGrantSurface ?? null, enforceAllowedTools: request.enforceAllowedTools ?? null });
    const [next, controlNext] = [requests.at(-2)!, requests.at(-1)!];
    expect([next.sessionId, controlNext.sessionId]).toEqual([read, control]);
    expect(handed(next), "GMAIL_DETAIL_NEXT_TURN_UNCHANGED").toBe(handed(controlNext));
    expect(next.prompt, "GMAIL_DETAIL_NEVER_IN_PROMPT").not.toContain("The end of Pylos.");
  } finally {
    await app.close(); broker.close(); await native.close();
    fake.dispose();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(root, { recursive: true, force: true }); rmSync(homeRoot, { recursive: true, force: true });
  }
}, 90_000);
