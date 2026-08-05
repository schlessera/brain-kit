import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import {
  resetBackendForTests,
  setBackendsForTests,
} from "../src/agent/backend";
import { closeDb, getDb } from "../src/db/client";
import { sessionRoutes } from "../src/routes/sessions";
import { makeFakeBackend } from "./helpers/fake-backend";

const TEST_DB = `/tmp/brain-ui-session-routes-${process.pid}.db`;

function removeTestDb() {
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

beforeEach(() => {
  closeDb();
  removeTestDb();
  process.env.DB_PATH = TEST_DB;
  resetBackendForTests();
});

afterEach(() => {
  resetBackendForTests();
  closeDb();
  removeTestDb();
  delete process.env.DB_PATH;
});

describe("multi-backend session routes", () => {
  test("GET /sessions unions, tags, and globally sorts backend sessions", async () => {
    const claude = makeFakeBackend({
      id: "claude",
      sessions: [
        {
          id: "c1",
          title: "Claude",
          createdAt: 10,
          lastActiveAt: 20,
          totalCostUsd: 1,
          numTurns: 1,
        },
      ],
    });
    const gemini = makeFakeBackend({
      id: "gemini",
      sessions: [
        {
          id: "g1",
          title: "Gemini",
          createdAt: 15,
          lastActiveAt: 30,
          totalCostUsd: 0,
          numTurns: 2,
        },
      ],
    });
    setBackendsForTests([claude, gemini], "claude");

    const response = await sessionRoutes.request("/sessions");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
      "g1",
      "c1",
    ]);
    expect(body.sessions.map(
      (session: { backendId: string }) => session.backendId
    )).toEqual(["gemini", "claude"]);
  });

  test("GET /sessions/:id reads history from the persisted owner backend", async () => {
    const claudeCalls: string[] = [];
    const geminiCalls: string[] = [];
    const claude = makeFakeBackend({
      id: "claude",
      historyCalls: claudeCalls,
    });
    const gemini = makeFakeBackend({
      id: "gemini",
      histories: {
        "g-session": [
          { role: "assistant", content: "from Gemini", toolCalls: [] },
        ],
      },
      historyCalls: geminiCalls,
    });
    setBackendsForTests([claude, gemini], "claude");
    getDb()
      .prepare(
        `INSERT INTO sessions
         (id, title, created_at, last_active_at, provider_id, backend_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("g-session", "Gemini", 1, 2, "gemini", "gemini");

    const response = await sessionRoutes.request("/sessions/g-session");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].content).toBe("from Gemini");
    expect(geminiCalls).toEqual(["g-session"]);
    expect(claudeCalls).toEqual([]);
  });

  test("unknown DB sessions fall back to the default backend", async () => {
    const claudeCalls: string[] = [];
    const geminiCalls: string[] = [];
    setBackendsForTests(
      [
        makeFakeBackend({ id: "claude", historyCalls: claudeCalls }),
        makeFakeBackend({ id: "gemini", historyCalls: geminiCalls }),
      ],
      "claude"
    );

    const response = await sessionRoutes.request("/sessions/unknown");

    expect(response.status).toBe(200);
    expect(claudeCalls).toEqual(["unknown"]);
    expect(geminiCalls).toEqual([]);
  });
});
