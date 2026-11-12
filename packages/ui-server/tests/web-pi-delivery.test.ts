/**
 * A forwarded web result is recorded before the model receives it (#3685).
 * Installed Pi drives a real session against a loopback Responses origin; its
 * only tool is the real curated `web_search` forwarding tool, whose bridge is
 * the ws web slice over the real broker and a real fixture executor process.
 * Pi's managed tool-safety hook hands each result to the concrete host
 * input-safety collector, and the second provider request must find the
 * occurrence already durable. Keyless and offline.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createPiBridgeTools } from "../../ui-backend-pi/src/bridge-tools";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createSessionRuntime } from "../../ui-backend-pi/src/native-session-runtime";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { createWebBroker } from "../src/web-tools/broker";
import { createChildWebExecutor } from "../src/web-tools/child-executor";
import { createWebAccess } from "../src/ws/bridge-capabilities/web";

const FIXTURE = join(import.meta.dir, "fixtures/web-executor.ts");

test("installed Pi records a forwarded web result before the next provider request", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-web-delivery-")), agentDir = join(root, "agent"), executorDir = join(root, "executor");
  mkdirSync(agentDir); mkdirSync(executorDir);
  const db = createUiDb(":memory:"), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer), controller = new AbortController();
  const requests: string[] = [];
  let recordedBeforeSecond = false;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text(); requests.push(raw);
    // The result's exposure, not only the call's taint, must be durable first.
    if (requests.length === 2) recordedBeforeSecond = safetyRecords(db, "ithaca")
      .some(record => record.kind === "exposure" && record.state === "finalized");
    const output = requests.length === 1
      ? [{ type: "function_call", id: "fc_mast", call_id: "call_mast", name: "web_search", arguments: JSON.stringify({ query: "Odysseus mast" }) }]
      : [{ type: "message", role: "assistant", id: "msg_mast", status: "completed", content: [{ type: "output_text", text: "Ithaca", annotations: [] }] }];
    const response = { id: `resp_${requests.length}`, object: "response", status: "completed", model: "gpt-4o-mini", output,
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } };
    const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      ...output.flatMap(item => [{ type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }]),
      { type: "response.completed", response }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const broker = createWebBroker({
    executor: createChildWebExecutor({ launch: { command: [process.execPath, FIXTURE], env: { PATH: process.env.PATH!, WEB_FIXTURE_DIR: executorDir } } }),
    admittedProviders: () => [],
  });
  const sessions: AgentSession[] = [];
  try {
    const bindingId = crypto.randomUUID();
    await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId: "odysseus", backendId: "pi", at: 0 });
    db.exec("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'pi'); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
    safetyCatalogCreated(db, "ithaca", "odysseus", "voyage"); await writes.bind("voyage", "ithaca");
    const collector = createSafetyCollector(db, writes, { turnId: "voyage", bindingId, sessionId: () => "ithaca", backendId: "pi", brainPath: root,
      shellProxied: () => false, signal: controller.signal, stop: () => controller.abort() });
    await collector.ready("pi", 1);
    // The ws web slice as makeBridge composes it for a governed Pi turn.
    const web = createWebAccess({ host: { webTools: broker }, turn: { sessionId: "ithaca" }, turnId: "voyage", principalId: "odysseus", signal: controller.signal,
      backendId: "pi", workerProfile: { origin: "interactive", actualProfile: "governed" }, current: () => !controller.signal.aborted,
      recordingAvailable: () => true } as never, { collectedSessionId: "ithaca" }, { policy: { hash: "rev-odyssey" } } as never);
    expect(web.webAccess, "WEB_SLICE_PRESENT_FOR_GOVERNED_PI").toBeFunction();
    const turn = createTurnContext();
    turn.bridge = { emit() {}, requestPermission: async () => ({ behavior: "allow" }), webAccess: web.webAccess } as never;
    turn.signal = controller.signal;
    const webSearch = createPiBridgeTools({ brainPath: root, turn, capabilities: { web: true } }).find(tool => tool.name === "web_search")!;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, transport: "sse", cacheWarming: "idle", retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true });
    await loader.reload();
    const modelsPath = join(agentDir, "models.json");
    await Bun.write(modelsPath, JSON.stringify({ providers: { openai: { baseUrl: origin.url.origin + "/v1", api: "openai-responses", apiKey: "odysseus-offline-only",
      models: [{ id: "gpt-4o-mini", name: "Voyage", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
    const runtime = createSessionRuntime({ backend: { brainPath: root, model: "openai/gpt-4o-mini" }, sessionDir: root, sessionId: crypto.randomUUID(), observeManager() {},
      modelRuntimeOptions: { authPath: join(agentDir, "auth.json"), modelsPath, modelsStorePath: join(agentDir, "models-cache.json") },
      resources: { buildToolkit: () => ({ tools: [webSearch], turnContext: turn }), build: async () => ({ loader, settingsManager }) },
      toolSafety: {
        async permission(name: string, id: string, input: Record<string, unknown>) { await collector.begin(id, name, input); return { behavior: "allow" }; },
        async result(name: string, id: string, content: { type: string; text?: string }[]) {
          await collector.result(id, name, content.filter(part => part.type === "text").map(part => part.text).join("\n"), true);
        },
        stop() { controller.abort(); },
        async unavailable() { throw new Error("WEB_DELIVERY_NEVER_REFUSES_CURATED_TOOLS"); },
      } } as unknown as Parameters<typeof createSessionRuntime>[0]);
    const { session } = await runtime.newSession(undefined, { caps: {} } as never);
    sessions.push(session as AgentSession);
    await (session as AgentSession).prompt("Find the mast.");
    expect(requests, "WEB_DELIVERY_TWO_REQUESTS").toHaveLength(2);
    expect(requests[1], "WEB_RESULT_REACHES_MODEL").toContain("web_search found 1 source for Odysseus mast");
    expect(requests[1], "WEB_MODEL_SEES_HOST_HANDLE").toMatch(/wr_[A-Za-z0-9_-]{24}/);
    expect(requests[1], "WEB_MODEL_NEVER_SEES_UPSTREAM_ID").not.toContain("upstream-");
    expect(recordedBeforeSecond, "WEB_RESULT_RECORDED_BEFORE_PROVIDER").toBe(true);
    expect(safetyRecords(db, "ithaca").filter(record => record.kind === "occurrence").map(record => (record.payload as { source: string; tool: string })),
      "WEB_RESULT_TAINTS_SESSION").toEqual([expect.objectContaining({ source: "web_search", tool: "web_search" })]);
    expect(writes.safety(null, "ithaca").coverage.state, "WEB_RECORDING_COVERAGE_COMPLETE").toBe("complete");
  } finally {
    controller.abort();
    for (const session of sessions) { await session.abort(); session.dispose(); }
    await broker.close(); origin.stop(true); await writer.close(); db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
