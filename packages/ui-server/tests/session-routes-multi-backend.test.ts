import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env.js";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createSessionRoutes } from "../src/routes/sessions";
import { makeFakeBackend } from "./helpers/fake-backend";

let db: Database;
let sessionRoutes: Hono<AppEnv>;

function setBackendsForTests(backends: AgentBackend[], defaultBackendId?: string) {
  sessionRoutes = createSessionRoutes({
    registry: createStaticBackendRegistry(backends, defaultBackendId),
    db,
  });
}

const getDb = () => db;

beforeEach(() => {
  db = createUiDb(":memory:");
});

afterEach(() => {
  db.close();
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

  test("keeps healthy histories when another backend throws, and recovers on retry", async () => {
    const healthy = makeFakeBackend({ id: "healthy", sessions: [{ id: "saved", title: "Saved", createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 1 }] });
    const broken = makeFakeBackend({ id: "broken" });
    broken.listSessions = () => { throw new Error("unavailable"); };
    setBackendsForTests([healthy, broken]);
    const response = await sessionRoutes.request("/sessions");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["saved"]);
    expect(body.unavailableBackends).toEqual(["broken"]);
    broken.listSessions = async () => [];
    expect((await (await sessionRoutes.request("/sessions")).json()).unavailableBackends).toBeUndefined();
  });

  test("bounds stalled backends and coalesces scans across concurrent requests", async () => {
    const stuck = makeFakeBackend({ id: "stuck" });
    let calls = 0;
    let release!: (sessions: Awaited<ReturnType<AgentBackend["listSessions"]>>) => void;
    stuck.listSessions = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    setBackendsForTests([stuck]);
    try {
      const responses = await Promise.all([sessionRoutes.request("/sessions"), sessionRoutes.request("/sessions")]);
      expect(calls).toBe(1);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessions: [], unavailableBackends: ["stuck"] });
      }
    } finally { release([]); }
    await Promise.resolve();
    stuck.listSessions = async () => [];
    expect(await (await sessionRoutes.request("/sessions")).json()).toEqual({ sessions: [] });
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


test("retained host-only metadata pages without fabricating native sessions and fences the principal", async()=>{
  setBackendsForTests([makeFakeBackend({id:"fixture",sessions:[]})]);
  const insert=db.prepare("INSERT INTO dialogue_owners(id,principal_id,coverage,created_at) VALUES(?,?,'complete',?)");
  for(let i=0;i<403;i++)insert.run(`ithaca-${String(i).padStart(4,"0")}`,"odysseus",i);
  insert.run("other-owner","penelope",0);
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.set("principal",{id:"odysseus",kind:"owner",authMethod:"password",label:"Odysseus",credentialId:null,createdBy:null,createdAt:0,expiresAt:Date.now()+10000,lastSeenAt:null,revokedAt:null});await next();});
  app.route("/",sessionRoutes);
  // Old callers (and an explicit false) receive the exact legacy payload.
  for(const query of ["/sessions","/sessions?includeRetainedConversations=false"]){
    const response=await app.request(query);expect(response.status).toBe(200);expect(await response.json()).toEqual({sessions:[]});
  }
  const ids:string[]=[];let cursor:string|undefined;
  do{
    const response=await app.request(`/sessions?includeRetainedConversations=true${cursor?`&retainedAfter=${cursor}`:""}`);
    expect(response.status).toBe(200);
    const page=await response.json();expect(page.sessions).toEqual([]);
    expect(page.retainedConversations.length).toBeLessThanOrEqual(200);
    ids.push(...page.retainedConversations.map((r:{id:string})=>r.id));cursor=page.retainedAfter;
  }while(cursor);
  expect(ids).toHaveLength(403);expect(new Set(ids).size).toBe(403);expect(ids).not.toContain("other-owner");
});
