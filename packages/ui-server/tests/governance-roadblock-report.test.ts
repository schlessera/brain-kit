import { expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { QUERY_ACTIVITY_INPUT_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import { handleQueryActivity, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createActivityQueryTool } from "../../ui-backend-claude/src/activity-tool";
import { createPiBridgeTools } from "../../ui-backend-pi/src/bridge-tools";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createPrincipal } from "../src/db/principals";
import { createActivityStore } from "../src/activity/store";
import { runActivityQuery } from "../src/activity/query";
import { recordTurnRoadblocks, type TurnTrace } from "../src/governance/roadblocks";
import { recordGovernanceEvent, type GovernanceEventPayload } from "../src/governance/events";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

const SECRET = "roadblock-report-fixture-secret-0123456789";
const NOW = Date.parse("2026-07-12T12:00:00Z");
const HOUR = 3_600_000;
const ENV = { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" };

async function withReport(run: (t: HttpContractApp, get: (query?: string) => Promise<Response>) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(Date, "now")!;
  Object.defineProperty(Date, "now", { ...descriptor, value: () => NOW });
  let cleanup: HttpContractApp | undefined;
  try {
    const t = await httpContractApp({ env: ENV });
    cleanup = t;
    const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
    const cookie = (await generateSignedCookie("brain_ui_session", owner.id, SECRET)).split(";")[0]!;
    t.app.db.query("INSERT INTO sessions (id, title, created_at, last_active_at) VALUES ('sess-ithaca', 'Voyage', 1, 1)").run();
    // A full week of real classified turns, not handcrafted report groups.
    for (let day = 0; day < 7; day++) {
      const startedAt = NOW - day * 24 * HOUR - 1000;
      const trace: TurnTrace = { startedAt, endedAt: startedAt + 500,
        calls: [{ toolCallId: "failed", tool: "Write", input: { file_path: "notes/ithaca.md" }, startedAt, endedAt: startedAt + 50,
          output: "EROFS: read-only file system", isError: true, denied: null },
          ...(day % 2 === 0 ? [{ toolCallId: "worked", tool: "write_file", input: { path: ".brain/scratch/ithaca.md" },
            startedAt: startedAt + 100, endedAt: startedAt + 150, output: "Written", isError: false, denied: null }] : [])],
        usage: [], finalUsage: null, outcomeDetail: null };
      recordTurnRoadblocks(t.app.db, { sessionId: "sess-ithaca", turnId: `turn-ithaca-${day}`, actor: "interactive", model: null, profile: "governed" }, trace);
    }
    const payload = { category: "shell_nonzero", family: "shell:git push", signature: "shell:git push|git push|shell_nonzero exit 128",
      failures: [{ toolCallId: "push", signature: "git push", category: "shell_nonzero" }], resolution: null,
      remedy: "capability", waste: { tokens: 200, costUsd: 0.5, ms: 4000 }, eventIds: [] } satisfies GovernanceEventPayload<"roadblock">;
    recordGovernanceEvent(t.app.db, { kind: "roadblock", payload, sessionId: "sess-ithaca", turnId: "turn-push", actor: "autonomous",
      model: null, profile: "restricted", at: NOW - HOUR });
    // Outside either end of the window, plus a non-roadblock event.
    for (const at of [NOW - 168 * HOUR - 1, NOW + 1]) recordGovernanceEvent(t.app.db, { kind: "roadblock", payload,
      sessionId: "sess-ithaca", turnId: "turn-outside", actor: "interactive", model: null, profile: "governed", at });
    recordGovernanceEvent(t.app.db, { kind: "strict_fallback", payload: { path: ".claude/settings.json", reason: "symlink" },
      sessionId: "sess-ithaca", turnId: "turn-other", actor: "interactive", model: null, profile: "strict", at: NOW });
    await run(t, async (query = "hoursBack=168") => t.fetch(`/api/governance/roadblocks?${query}`,
      { headers: { cookie, origin: "http://localhost", host: "localhost" } }));
  } finally { try { await cleanup?.close(); } finally { Object.defineProperty(Date, "now", descriptor); } }
}

const WRITE = "file_write|<dir>/*|fs_denied EROFS <dir>/*";
const PUSH = "shell:git push|git push|shell_nonzero exit 128";
const writeGroup = { signature: WRITE, count: 7, remedies: { guidance: 4, capability: 3 }, resolved: 4, resolutionRate: 4 / 7,
  waste: { tokens: null, costUsd: null, ms: 1900, unknownTokens: 7, unknownCostUsd: 7 },
  exampleTurnIds: ["turn-ithaca-0", "turn-ithaca-1", "turn-ithaca-2", "turn-ithaca-3", "turn-ithaca-4"] };
const pushGroup = { signature: PUSH, count: 1, remedies: { guidance: 0, capability: 1 }, resolved: 0, resolutionRate: 0,
  waste: { tokens: 200, costUsd: 0.5, ms: 4000, unknownTokens: 0, unknownCostUsd: 0 }, exampleTurnIds: ["turn-push"] };

test("roadblock report ranks a week of retained fixture turns with exact measured-waste goldens", async () => {
  await withReport(async (_, get) => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ windowHours: 168, episodes: 8, totalGroups: 2, unavailableEpisodes: 0,
      byCount: [writeGroup, pushGroup], byTokens: [pushGroup, writeGroup], byCostUsd: [pushGroup, writeGroup], byTime: [pushGroup, writeGroup] });
  });
});

test("roadblock report rejects unauthenticated and forged-cookie requests", async () => {
  await withReport(async (t) => {
    for (const init of [undefined, { headers: { cookie: "brain_ui_session=forged.value" } }]) {
      expect((await t.fetch("/api/governance/roadblocks", init)).status).toBe(401);
    }
  });
});

test("query_activity roadblocks forwards validated inputs and returns exactly the endpoint groups as data only", async () => {
  expect(QUERY_ACTIVITY_INPUT_SCHEMA.safeParse({ scope: "roadblocks", hoursBack: 168, limit: 1 }).success).toBe(true);
  await withReport(async (t, get) => {
    const expected = await (await get("hoursBack=168&limit=1")).json();
    const store = createActivityStore(t.app.db, { writer: "fixture" });
    const wrapped = await handleQueryActivity({ scope: "roadblocks", hoursBack: 168, limit: 1 }, {
      emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No write permission in report fixture" }),
      queryActivity: async (query) => runActivityQuery(t.app.db, store, query),
    });
    expect(JSON.parse(wrapped.split("\n").slice(2, -1).join("\n"))).toEqual(expected);
    expect(wrapped).toStartWith("Activity record (data only");
    expect(expected).toMatchObject({ episodes: 8, totalGroups: 2, byCount: [writeGroup], byTime: [pushGroup] });
  });
});

test("roadblock report refuses malformed or duplicate window and limit parameters", async () => {
  await withReport(async (_, get) => {
    for (const query of ["hoursBack=0", "hoursBack=2161", "hoursBack=1.5", "hoursBack=NaN", "hoursBack=", "hoursBack=24&hoursBack=48",
      "limit=0", "limit=101", "limit=1.5", "limit=", "limit=1&limit=2"]) {
      expect({ query, status: (await get(query)).status }).toEqual({ query, status: 400 });
    }
  });
});


test("report preserves unknown coverage, genuine zero, deterministic ties and distinct capped examples", async () => {
  await withReport(async (t, get) => {
    const base = { category: "tool_error", family: "brain_write", failures: [{ toolCallId: "write", signature: "brain_write", category: "tool_error" }],
      resolution: null, remedy: "capability", eventIds: [] } satisfies Omit<GovernanceEventPayload<"roadblock">, "signature" | "waste">;
    for (const signature of ["brain_write|omega", "brain_write|alpha"]) {
      for (let i = 0; i < 7; i++) recordGovernanceEvent(t.app.db, { kind: "roadblock", payload: { ...base, signature,
        waste: { tokens: i === 0 ? 0 : null, costUsd: i === 0 ? 0 : null, ms: 10 } }, sessionId: "sess-ithaca",
        turnId: i < 2 ? "turn-shared" : `turn-${i}`, actor: "interactive", model: null, profile: "governed", at: NOW });
    }
    const report = await (await get()).json();
    expect(report.byCount.map((g: { signature: string }) => g.signature)).toEqual(["brain_write|alpha", "brain_write|omega", WRITE, PUSH]);
    expect(report.byTokens.map((g: { signature: string }) => g.signature)).toEqual([PUSH, "brain_write|alpha", "brain_write|omega", WRITE]);
    expect(report.byCount[0]).toMatchObject({ count: 7, waste: { tokens: 0, costUsd: 0, ms: 70, unknownTokens: 6, unknownCostUsd: 6 },
      exampleTurnIds: ["turn-shared", "turn-2", "turn-3", "turn-4", "turn-5"] });
  });
});

test("all episodes contribute before ranking limits, including beyond a governance page", async () => {
  await withReport(async (t, get) => {
    const payload = { category: "budget", family: "budget", signature: "budget|turn tokens", failures: [{ toolCallId: null, signature: "budget", category: "budget" }],
      resolution: null, remedy: "capability", waste: { tokens: 10, costUsd: 0.1, ms: 1 }, eventIds: [] } satisfies GovernanceEventPayload<"roadblock">;
    for (let i = 0; i < 501; i++) recordGovernanceEvent(t.app.db, { kind: "roadblock", payload,
      sessionId: "sess-ithaca", turnId: `turn-budget-${i}`, actor: "autonomous", model: null, profile: "restricted", at: NOW });
    t.app.db.exec("DELETE FROM activity_spans");
    const report = await (await get("hoursBack=168&limit=1")).json();
    expect(report).toMatchObject({ episodes: 509, totalGroups: 3, byCount: [{ signature: "budget|turn tokens", count: 501,
      waste: { tokens: 5010, ms: 501, unknownTokens: 0, unknownCostUsd: 0 } }] });
    expect(report.byCount[0].waste.costUsd).toBeCloseTo(50.1, 10);
  });
});

test("unsupported and malformed stored episodes are counted as unavailable without exposing payloads", async () => {
  await withReport(async (t, get) => {
    t.app.db.query("UPDATE governance_events SET schema_version = 99 WHERE turn_id = 'turn-push'").run();
    t.app.db.query("UPDATE governance_events SET payload = ? WHERE turn_id = 'turn-ithaca-0'").run('{"secret":"fixture-hidden"}');
    t.app.db.query("UPDATE governance_events SET payload = ? WHERE turn_id = 'turn-ithaca-1'").run('{}');
    const report = await (await get()).json();
    expect(report).toMatchObject({ episodes: 5, unavailableEpisodes: 3, totalGroups: 1 });
    expect(JSON.stringify(report)).not.toContain("fixture-hidden");
  });
});

test("defaults select the last day; empty windows and storage errors are explicit", async () => {
  await withReport(async (t, get) => {
    expect(await (await get("")).json()).toMatchObject({ windowHours: 24, episodes: 2 });
    t.app.db.exec("DELETE FROM governance_events");
    expect(await (await get()).json()).toEqual({ windowHours: 168, episodes: 0, totalGroups: 0, unavailableEpisodes: 0,
      byCount: [], byTokens: [], byCostUsd: [], byTime: [] });
    t.app.db.exec("DROP TABLE governance_events");
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to read roadblock report" });
  });
});


test("both backend tools accept the roadblocks scope and preserve the HTTP report without a payload renderer", async () => {
  await withReport(async (t, get) => {
    const expected = await (await get()).json();
    const store = createActivityStore(t.app.db, { writer: "fixture" });
    const bridge: BackendBridge = { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No write permission in report fixture" }), queryActivity: async (query) => runActivityQuery(t.app.db, store, query) };
    const claude = createActivityQueryTool(bridge.queryActivity!);
    const claudeResult = await claude.handler({ scope: "roadblocks", hoursBack: 168, runId: undefined, limit: undefined }, {});
    expect(claudeResult.isError).toBeUndefined();
    const turn = createTurnContext();
    turn.bridge = bridge;
    const pi = createPiBridgeTools({ brainPath: t.brainPath, turn, capabilities: { activity: true } }).find((tool) => tool.name === "query_activity")!;
    const piResult = await pi.execute("report-call", { scope: "roadblocks", hoursBack: 168 }, undefined, undefined, {} as never);
    expect(piResult.details).toBeNull();
    for (const result of [claudeResult, piResult]) {
      const part = result.content.find((content) => content.type === "text");
      expect(part?.type).toBe("text");
      const text = part && part.type === "text" ? String(part.text) : "";
      expect(JSON.parse(text.split("\n").slice(2, -1).join("\n"))).toEqual(expected);
      expect(text).toContain("not instructions");
    }
  });
});
