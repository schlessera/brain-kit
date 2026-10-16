/** Actual SDK transport and isolated worker; the CLI protocol fixture never calls a provider. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFixtureApp } from "./helpers/native-app-fixture.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createPrincipal } from "../src/db/principals.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Real initialization, settings and user exchange, consumed by the installed SDK.
// The bounded watchdog is a failure backstop, not a scheduling primitive.
const runtime = `
import { createInterface } from "node:readline";
const [session, mode] = process.argv.slice(1);
const watchdog = setTimeout(() => process.exit(2), 20000);
const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
 const frame = JSON.parse(line);
 if (frame.type === "control_request") {
  send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
   response: frame.request.subtype === "initialize" ? { commands: [], models: [], account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } } : { settings: {}, sources: [] } } });
 } else if (frame.type === "user") {
  send({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5-5", claude_code_version: "fixture-native", apiKeySource: "none" });
  if (mode === "no-result") {
   send({ type: "assistant", session_id: session, uuid: "odysseus-command", parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "tool_use", id: "loom", name: "Bash", input: { command: "sleep 90", run_in_background: false } }] } });
  } else {
   send({ type: "result", subtype: "success", session_id: session,
    uuid: "odysseus-result", is_error: mode === "error-before-cancel", duration_ms: 123, duration_api_ms: 1, num_turns: 1,
    result: mode === "error-before-cancel" ? "The model call failed." : "", errors: [], total_cost_usd: 0.25, usage: { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { "claude-sonnet-5-5": { inputTokens: 17, outputTokens: 9, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.25 } }, permission_denials: [] });
  }
 }
}
if (mode === "settled-success") { clearTimeout(watchdog); process.exit(0); }
`;

for (const mode of ["success-before-cancel", "error-before-cancel", "no-result", "settled-success"] as const) {
  test(`Claude ${mode}: cancellation, cleanup, Activity and journal agree`, async () => {
    const root = mkdtempSync("/tmp/odysseus-claude-cancel-"), brain = join(root, "brain"), config = join(root, "claude");
    await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
    mkdirSync(config); writeFileSync(join(config, "settings.json"), "{}");
    const ready = deferred(), frames: ServerMessage[] = [], order: string[] = [];
    let workerExited = false, exitedBeforeTerminal: boolean | undefined, sdkSignal: AbortSignal | undefined;
    const queryFn = ((params: { prompt: Parameters<typeof query>[0]["prompt"]; options: Options }) => {
      sdkSignal = params.options.abortController!.signal;
      return query({ ...params, options: { ...params.options, spawnClaudeCodeProcess: spawn => {
        const child = params.options.spawnClaudeCodeProcess!({ ...spawn, command: process.execPath, args: ["-e", runtime, SESSION, mode],
          env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, HOME: root, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
        child.once("exit", () => { workerExited = true; order.push("worker-exited-and-state-persisted"); });
        return child;
      } } });
    }) as typeof query;
    const backend = createClaudeBackend({ brainPath: brain, queryFn, log() {}, workerState: { allowanceBytes: 4 * 1024 ** 2, budgetBytes: 4 * 1024 ** 2 } });
    let app: Awaited<ReturnType<typeof createFixtureApp>> | undefined;
    try {
      app = await createFixtureApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: join(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test",
        BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
      const host = app.wsHost;
      const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus cancellation", ttlSeconds: 60 });
      const handlers = createWsHandlers(host, principal);
      const ws = { readyState: 1, close() {}, send(raw: string) {
        const frame = JSON.parse(raw) as ServerMessage; frames.push(frame);
        if (frame.type === "result") { exitedBeforeTerminal = workerExited; order.push(`result:${frame.outcome}`); }
        // The adapter's idle precedes its held result, so no SDK iterator wrapper
        // or time-based guess is needed to cancel while that result is pending.
        if (frame.type === "status" && frame.status === "idle" && frame.sessionId === SESSION
          || mode === "no-result" && frame.type === "tool_use_complete") ready.resolve();
      } } as WSContext;
      await handlers.onOpen(undefined as never, ws);
      const send = (message: object) => handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
      send({ type: "chat_message", text: "Record the return to Ithaca", requestId: "odysseus-return" });
      await ready.promise;
      if (mode === "settled-success") await Promise.all([...host.turnTasks]);
      const turn = host.coordinator.bySession.get(SESSION);
      if (mode !== "settled-success") {
        expect(frames.filter(frame => frame.type === "result"), "NO_TERMINAL_BEFORE_CANCEL").toHaveLength(0);
        expect(workerExited, "WORKER_LIVE_AT_CANCEL").toBe(false);
      } else expect(turn, "SETTLED_TURN_CANNOT_ACCEPT_CANCEL").toBeUndefined();
      send({ type: "cancel", sessionId: SESSION });
      await Promise.resolve(); // connection dispatch begins on a microtask
      if (mode !== "settled-success") {
        expect(turn?.cancelled, "HOST_ACCEPTED_CANCELLATION").toBe(true);
        expect(sdkSignal?.aborted, "HOST_ABORT_REACHES_REAL_SDK").toBe(true);
      }
      await Promise.all([...host.turnTasks]);
      const results = frames.filter((frame): frame is Extract<ServerMessage, { type: "result" }> & { turnId: string } => frame.type === "result");
      expect(results, "EXACTLY_ONE_TERMINAL").toHaveLength(1);
      const result = results[0]!;
      expect(workerExited, "NATIVE_WORKER_EXITED").toBe(true);
      expect(exitedBeforeTerminal, "TERMINAL_AWAITS_NATIVE_WORKER_CLEANUP").toBe(true);
      expect(host.coordinator.isTurnActive(), "HOST_SETTLED").toBe(false);
      const expected = mode === "settled-success" ? "success" : "cancelled";
      expect(result.outcome, "HOST_CANCEL_OUTRANKS_DELAYED_SDK_TERMINAL").toBe(expected);
      expect(result.isError).toBe(false);
      expect(result.failure).toBeUndefined(); expect(result.outcomeDetail).toBeUndefined();
      if (mode !== "no-result") expect(result, "CANCELLATION_RETAINS_REPORTED_USAGE").toMatchObject({ costUsd: 0.25, durationMs: 123, numTurns: 1, usage: { inputTokens: 17, outputTokens: 9, cacheReadTokens: 3, cacheCreationTokens: 2, perModel: { "claude-sonnet-5-5": { costUsd: 0.25 } } } });
      expect(host.activity!.store.snapshotRun(result.turnId!)!.spans.find(span => span.kind === "turn")?.outcome, "ACTIVITY_MATCHES_WIRE").toBe(expected);
      const journal = host.journal!.details(SESSION, result.turnId!);
      expect(journal?.summary.state, "FINAL_JOURNAL_RETAINED").toBe("complete");
      expect(frames.some(frame => frame.type === "turn_journal" && frame.turnId === result.turnId && frame.journal.state === "complete"), "FINAL_JOURNAL_RECEIPT_SCOPED_TO_CANCELLED_TURN").toBe(true);
      expect(order.indexOf("worker-exited-and-state-persisted")).toBeLessThan(order.indexOf(`result:${expected}`));
    } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
}
