import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { resolveTurnTarget } from "../src/ws/routing";
import type { WSContext } from "../src/ws/clients";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createSessionCatalog } from "../src/ws/session-catalog";
import {
  closeDb,
  getDb,
  handleClientMessage,
  removeDbFile,
  resetForTests,
  setBackendsForTests,
  testRegistry,
  useTestDb,
} from "./helpers/test-host";

const catalog = createSessionCatalog(() => getDb());

const TEST_DB = `/tmp/brain-ui-ws-routing-${process.pid}.db`;

beforeEach(() => {
  closeDb();
  removeDbFile(TEST_DB);
  useTestDb(TEST_DB);
  resetForTests();
});

afterEach(() => {
  resetForTests();
  closeDb();
  removeDbFile(TEST_DB);
});

function insertSession(
  id: string,
  providerId: string | null,
  backendId: string | null
) {
  getDb()
    .prepare(
      `INSERT INTO sessions
       (id, title, created_at, last_active_at, provider_id, backend_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, id, 1, 2, providerId, backendId);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

describe("resolveTurnTarget", () => {
  test("new sessions route to the requested profile owner", async () => {
    const claude = makeFakeBackend({ id: "claude" });
    const gemini = makeFakeBackend({ id: "gemini" });
    setBackendsForTests([claude, gemini], "claude");

    const target = await resolveTurnTarget(testRegistry(), catalog, undefined, "gemini");

    expect(target.backend).toBe(gemini);
    expect(target.profileId).toBe("gemini");
  });

  test("resumed sessions route by stored backend_id and keep stored profile", async () => {
    const claude = makeFakeBackend({ id: "claude" });
    const gemini = makeFakeBackend({ id: "gemini" });
    setBackendsForTests([claude, gemini], "claude");
    insertSession("resume-gemini", "gemini", "gemini");

    const target = await resolveTurnTarget(testRegistry(), catalog, "resume-gemini", "claude");

    expect(target.backend).toBe(gemini);
    expect(target.profileId).toBe("gemini");
  });

  test("legacy NULL backend_id resumes on the default backend", async () => {
    const claude = makeFakeBackend({ id: "claude" });
    const gemini = makeFakeBackend({ id: "gemini" });
    setBackendsForTests([claude, gemini], "claude");
    insertSession("legacy", "claude", null);

    const target = await resolveTurnTarget(testRegistry(), catalog, "legacy", "gemini");

    expect(target.backend).toBe(claude);
    expect(target.profileId).toBe("claude");
  });

  test("a stored profile no longer offered by its backend is omitted", async () => {
    const claude = makeFakeBackend({ id: "claude" });
    const gemini = makeFakeBackend({ id: "gemini" });
    setBackendsForTests([claude, gemini], "claude");
    insertSession("stale-profile", "removed", "gemini");

    const target = await resolveTurnTarget(testRegistry(), catalog, "stale-profile", "claude");

    expect(target.backend).toBe(gemini);
    expect(target.profileId).toBeUndefined();
  });
});

describe("websocket backend routing", () => {
  test("a new Gemini turn starts on Gemini and persists its backend id", async () => {
    const starts: Array<{ profileId?: string }> = [];
    const claude = makeFakeBackend({ id: "claude" });
    const gemini = makeFakeBackend({
      id: "gemini",
      async startTurn(request) {
        starts.push({ profileId: request.profileId });
        request.bridge.emit({
          type: "session_info",
          sessionId: "new-gemini",
          isNew: true,
          providerId: "gemini",
        });
        request.bridge.emit({
          type: "result",
          sessionId: "new-gemini",
          costUsd: 0,
          durationMs: 1,
          numTurns: 1,
          isError: false,
        });
      },
    });
    setBackendsForTests([claude, gemini], "claude");
    const ws: WSContext = { send() {} };

    await handleClientMessage(ws, {
      type: "chat_message",
      text: "Use Gemini",
      providerId: "gemini",
    });
    await waitFor(() => starts.length === 1);
    await waitFor(
      () =>
        getDb()
          .query("SELECT backend_id FROM sessions WHERE id = ?")
          .get("new-gemini") !== null
    );

    const row = getDb()
      .query(
        "SELECT provider_id AS providerId, backend_id AS backendId FROM sessions WHERE id = ?"
      )
      .get("new-gemini") as { providerId: string; backendId: string };
    expect(starts).toEqual([{ profileId: "gemini" }]);
    expect(row).toEqual({ providerId: "gemini", backendId: "gemini" });
  });

  test("session_resume loads history from the stored backend owner", async () => {
    const claudeCalls: string[] = [];
    const geminiCalls: string[] = [];
    const claude = makeFakeBackend({
      id: "claude",
      historyCalls: claudeCalls,
    });
    const gemini = makeFakeBackend({
      id: "gemini",
      histories: {
        "resume-history": [
          { role: "assistant", content: "Gemini history", toolCalls: [] },
        ],
      },
      historyCalls: geminiCalls,
    });
    setBackendsForTests([claude, gemini], "claude");
    insertSession("resume-history", "gemini", "gemini");
    const sent: ServerMessage[] = [];
    const ws: WSContext = {
      send(data) {
        sent.push(JSON.parse(data) as ServerMessage);
      },
    };

    await handleClientMessage(ws, {
      type: "session_resume",
      sessionId: "resume-history",
    });

    expect(geminiCalls).toEqual(["resume-history"]);
    expect(claudeCalls).toEqual([]);
    const history = sent.find((message) => message.type === "session_history");
    expect(history?.type === "session_history" && history.messages[0].content)
      .toBe("Gemini history");
  });

  test("follow-up capabilities and calls come from the running turn backend", async () => {
    let geminiStarted = false;
    const followUps: string[] = [];
    const claude = makeFakeBackend({
      id: "claude",
      capabilities: { followUp: false },
    });
    const gemini = makeFakeBackend({
      id: "gemini",
      capabilities: { followUp: true },
      async startTurn(request) {
        request.bridge.emit({
          type: "session_info",
          sessionId: "running-gemini",
          isNew: true,
          providerId: "gemini",
        });
        geminiStarted = true;
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
      async followUp(request) {
        followUps.push(request.prompt);
      },
    });
    setBackendsForTests([claude, gemini], "claude");
    const ws: WSContext = { send() {} };

    await handleClientMessage(ws, {
      type: "chat_message",
      text: "Start",
      providerId: "gemini",
    });
    await waitFor(() => geminiStarted);
    await handleClientMessage(ws, {
      type: "chat_message",
      text: "Live follow-up",
      sessionId: "running-gemini",
    });
    await waitFor(() => followUps.length === 1);

    expect(followUps).toEqual(["Live follow-up"]);
  });
});
