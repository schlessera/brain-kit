import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { createPrincipal } from "../src/db/principals.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { StreamAdapter } from "../../ui-backend-claude/src/stream-adapter.js";
import { createPiTurnRunner } from "../../ui-backend-pi/src/turn-runner.js";
import { createSessionPool } from "../../ui-backend-pi/src/session-pool.js";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context.js";
import type { PiSessionLike } from "../../ui-backend-pi/src/backend-options.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WsHost } from "../src/ws/host.js";
import { createTurnBudgets } from "../src/brain/turn-budgets.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
for (const adapter of ["claude", "pi"] as const)
  for (const mode of adapter === "claude" ? ["token", "usd", "sdk", "unavailable"] : ["token", "usd"])
    test(`actual ${adapter} completed response crosses the host ${mode === "unavailable" ? "unavailable accounting" : mode === "sdk" ? "SDK backstop" : mode === "usd" ? "USD budget" : "token fallback"} and stops with ${mode === "unavailable" ? "budget_unavailable" : "budget_exceeded"}, preserving partial work`, async () => {
      const priced = mode !== "token", backstop = mode === "sdk", unavailable = mode === "unavailable";
      let failAccounting: () => void = () => { };
      const root = await mkdtemp(resolve(tmpdir(), "odysseus-budget-host-")), brain = resolve(root, "brain");
      await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
      await mkdir(resolve(brain, "context/policies"), { recursive: true });
      await writeFile(resolve(brain, "context/policies/governance.md"), "---\nschema_version: 1\nbudgets: { turn: { warn_usd: 5, block_usd: 10, block_tokens: 10 }, session: { block_tokens: 100 }, day: { block_tokens: 100 } }\n---\nAthena reviews inference limits.\n");
      let called = 0, aborted = false, maxBudget: number | undefined, receivedPrompt: string | undefined, receivedLimits: string | undefined, receivedContext: string | undefined;
      const backend = makeFakeBackend({ id: `budget-${adapter}`, startTurn: async (req) => {
          called++;
          maxBudget = req.maxBudgetUsd;
          receivedPrompt = req.prompt;
          receivedLimits = req.sessionBudgetLimits;
          receivedContext = req.budgetContext;
          await writeFile(resolve(brain, "notes/partial.md"), "# Odysseus\nPartial work remains.\n");
          if (adapter === "claude") {
            req.bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
            const stream = new StreamAdapter(req.bridge.activity);
            if (unavailable)
              failAccounting();
            if (backstop)
              for (const frame of stream.adapt({ type: "result", subtype: "error_max_budget_usd", session_id: "ithaca", total_cost_usd: 10, duration_ms: 1, num_turns: 1, errors: [] } as unknown as SDKMessage))
                req.bridge.emit(frame);
            else
              for (const event of [{ type: "message_start", message: { id: "athena", model: "unknown-model", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } } },
                { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]) {
                for (const frame of stream.adapt({ type: "stream_event", event } as SDKMessage))
                  req.bridge.emit(frame);
              }
            if (!req.signal.aborted)
              await Promise.race([new Promise<void>(done => req.signal.addEventListener("abort", () => done(), { once: true })), Bun.sleep(200)]);
          }
          else {
            let listener: (event: AgentSessionEvent) => void = () => { };
            const session: PiSessionLike = { sessionId: "ithaca", subscribe: fn => { listener = fn; return () => { }; }, abort: async () => { }, dispose() { }, getSessionStats: () => ({ cost: 0 }),
              async prompt() {
                listener({ type: "message_end", message: { role: "assistant", model: "unknown-model", stopReason: "toolUse", content: [], usage: { input: 5, output: 1, cacheRead: 3, cacheWrite: 1, cost: { total: 0 } } } } as unknown as AgentSessionEvent);
                if (!req.signal.aborted)
                  await Promise.race([new Promise<void>(done => req.signal.addEventListener("abort", () => done(), { once: true })), Bun.sleep(200)]);
              } };
            const pool = createSessionPool({ newSession: async () => ({ session, turnContext: createTurnContext() }), openSession: async () => { throw Error("No fixture resume"); } });
            await createPiTurnRunner(pool, { brainPath: brain })({ ...req, profileId: undefined });
          }
          aborted = req.signal.aborted;
        } });
      const app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
      const host = priced ? new WsHost({ brainPath: brain, registry: createStaticBackendRegistry([backend], backend.id), catalog: app.wsHost.catalog,
        governedTurns: app.wsHost.governedTurns, journal: app.wsHost.journal, activity: app.wsHost.activity ?? undefined,
        budgets: createTurnBudgets(app.db, { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" }) }) }) : app.wsHost;
      failAccounting = () => app.db.exec("DROP TABLE turn_budget_days");
      try {
        const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 60 });
        const sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() { }, readyState: 1 } as WSContext;
        const handlers = createWsHandlers(host, principal);
        await handlers.onOpen(undefined as never, ws);
        handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Record Ithaca", requestId: "budget-request" }) } as MessageEvent, ws);
        const frames = () => sent.map(text => { const parsed = parseServerMessage(text); if (!parsed.ok)
          throw Error(parsed.error); return parsed.message; });
        const deadline = Date.now() + 5000;
        while (!called || host.coordinator.isTurnActive()) {
          if (Date.now() > deadline)
            throw Error(JSON.stringify(frames()));
          await Bun.sleep(5);
        }
        expect(receivedPrompt, "GOVERNED_PROMPT_PRESERVES_USER_BYTES").toBe("Record Ithaca");
        expect(receivedLimits, "STATIC_BUDGET_LIMITS_STILL_TRANSPORTED").toContain("turn: warn $5; stop $10");
        expect(receivedContext, "NO_ROUTINE_BUDGET_TAIL_AT_ADMISSION").toBeUndefined();
        expect(called, "BUDGET_ACTUAL_ADAPTER_LAUNCHED").toBe(1);
        expect(aborted, "BUDGET_HOST_ABORTS_ACTUAL_ADAPTER").toBe(true);
        expect(maxBudget).toBe(10);
        const failure = frames().findLast(frame => frame.type === "error")!;
        expect(failure).toMatchObject(unavailable ? { code: "BUDGET_UNAVAILABLE", failure: { errorClass: "budget_unavailable" } } : { code: "BUDGET_EXCEEDED", failure: { errorClass: "budget_exceeded", budgetScope: "turn" } });
        expect(JSON.stringify(frames())).not.toContain("Turn timed out");
        const receipt = frames().findLast(frame => frame.type === "turn_journal");
        if (!unavailable)
          expect(receipt?.type === "turn_journal" ? receipt.journal.budget : undefined).toMatchObject({ listPriceCostUsd: backstop ? null : priced ? 10 : null, tokens: backstop ? null : 10 });
        if (!unavailable)
          expect(receipt?.type === "turn_journal" ? receipt.journal.budget?.scopes.find(item => item.scope === "turn") : undefined).toMatchObject({ blocked: true });
        expect(app.db.query("SELECT outcome FROM activity_run_rollups WHERE run_id=?").get(failure.turnId!), "BUDGET_STOP_ACTIVITY_ERROR_NOT_TIMEOUT").toEqual({ outcome: "error" });
        expect(await readFile(resolve(brain, "notes/partial.md"), "utf8")).toContain("Partial work remains");
        if (priced && !backstop && !unavailable) {
          expect(app.db.query("SELECT COUNT(*) AS n FROM governance_events WHERE kind='budget_warning' AND turn_id=?").get(failure.turnId!), "BUDGET_WARNING_ONE_HOST_EVENT").toEqual({ n: 1 });
          app.db.query("INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,effective_cost_usd,input_tokens) VALUES('retained','session','invoke_agent','ithaca',?,4000,0,1)").run(Date.now());
          handlers.onMessage({ data: JSON.stringify({ type: "chat_message", sessionId: "ithaca", text: "Continue the return", requestId: "admission-request" }) } as MessageEvent, ws);
          const until = Date.now() + 5000;
          while (!frames().some(frame => frame.type === "error" && frame.requestId === "admission-request") || host.coordinator.isTurnActive()) {
            if (Date.now() > until)
              throw Error(JSON.stringify(frames()));
            await Bun.sleep(5);
          }
          expect(called, "BUDGET_RETAINED_ACTIVITY_REFUSES_BEFORE_BACKEND").toBe(1);
          expect(frames().findLast(frame => frame.type === "error")).toMatchObject({ failure: { errorClass: "budget_exceeded", budgetScope: "session" } });
        }
      }
      finally {
        if (host !== app.wsHost)
          host.close();
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
