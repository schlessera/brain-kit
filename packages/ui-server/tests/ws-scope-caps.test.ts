/** Actual adapters with offline provider/session fixtures and real worker processes. */
import { expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as workers from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend.js";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { handleChatMessage } from "../src/ws/run-session.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { createPrincipal } from "../src/db/principals.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import type { ServerMessage, ScopeCapReceipt } from "@schlessera/brain-ui-sdk/protocol";

async function wait(check: () => boolean, detail: () => unknown) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw Error(JSON.stringify(detail())); await Bun.sleep(10); } }
for (const adapter of ["claude", "pi"] as const) for (const voice of [false, true]) test(`${adapter}: ${voice ? (adapter === "pi" ? "voice admission refuses before a worker" : "true voice stops without a grant") : "dictation pauses, grants once, refuses a second grant and Stops normally"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-scope-adapter-")), brain = join(root, "brain"), config = join(root, "agent"), home = join(root, "home");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain); mkdirSync(config); mkdirSync(home);
  writeFileSync(join(config, "settings.json"), "{}"); mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nscope: { max_tool_calls: 2 }\n---\nAthena bounds the voyage.\n");
  let spawn: ReturnType<typeof spyOn> | undefined;
  const originalLaunch = workers.launchAgentWorker;
  const priorPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = config;
  if (adapter === "pi") spawn = spyOn(workers, "launchAgentWorker").mockImplementation(input => originalLaunch({ ...input,
    command: [process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/scope-pi-worker.ts")], env: { PATH: "/usr/bin:/bin" } }));
  const backend = adapter === "pi" ? createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"), loadExtensions: false })
    : createClaudeBackend({ brainPath: brain, queryFn: ((params: any) => {
      const child = params.options.spawnClaudeCodeProcess({ command: "/bin/sh", args: ["-c", 'while :; do printf x >> adapter-heartbeat; sleep 0.02; done'],
        env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: config }, signal: params.options.abortController.signal });
      child.stdin.end();
      const stream = (async function* () {
        yield { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" };
        for (let call = 1; call <= 4; call++) {
          while (call > 2 && params.options.abortController.signal.aborted === false && paused()) await Bun.sleep(10);
          if (params.options.abortController.signal.aborted) break;
          yield { type: "assistant", message: { content: [{ type: "tool_use", id: `loom-${call}`, name: "Bash", input: { command: "printf Ithaca" } }] } };
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `loom-${call}`, content: "Ithaca", is_error: false }] } };
          await Bun.sleep(100);
        }
        if (!params.options.abortController.signal.aborted) await new Promise<void>(done => params.options.abortController.signal.addEventListener("abort", () => done(), { once: true }));
      })();
      return Object.assign(stream, { initializationResult: async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }), close() { child.kill("SIGKILL"); }, interrupt: async () => { child.kill("SIGKILL"); } });
    }) as never });
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const frames: ServerMessage[] = [];
  const latest = () => frames.filter((frame): frame is Extract<ServerMessage,{ type:"turn_journal" }> => frame.type === "turn_journal").at(-1);
  const paused = () => latest()?.journal.scope?.receipts.at(-1)?.state === "paused";
  try {
    app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: join(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
      registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Athena scope", ttlSeconds: 60 });
    const ws = { send: (raw: string) => frames.push(JSON.parse(raw)), close() {} }, handlers = createWsHandlers(app.wsHost, principal);
    await handlers.onOpen(undefined as never, ws);
    const send = (message: object) => handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
    if (voice) {
      const authorization = app.wsHost.coordinator.openAuthorization({ principalId: principal.id, expiresAt: principal.expiresAt, valid: app.wsHost.isPrincipalValid(principal) });
      void handleChatMessage(app.wsHost, ws, { authorization, text: "Record the return", attachments: [], requestId: "voice-scope-request",
        work: { posture: "voice", started() {}, observe() {}, settle() {} } }).finally(() => authorization.release());
      if (adapter === "pi") {
        await wait(() => frames.some(frame => frame.type === "error" && frame.message.includes("no voice tool posture")), () => frames);
        expect(spawn, "PI_VOICE_REFUSED_BEFORE_WORKER").not.toHaveBeenCalled();
        expect(latest(), "PI_VOICE_HAS_NO_SCOPE_GRANT_CARD").toBeUndefined();
        return;
      }
      await wait(() => !app!.wsHost.coordinator.isTurnActive() && latest()?.journal.scope?.receipts.at(-1)?.state === "voice_stopped", () => frames);
      const stopped = latest()!.journal.scope!.receipts.at(-1)!;
      expect(stopped).toMatchObject({ state: "voice_stopped", cap: 2, count: 2, frozen: true }); expect(stopped.newCap).toBeUndefined();
      expect(frames.some(frame => frame.type === "text_delta" && frame.text.includes("I stopped because")), "SCOPE_ADAPTER_VOICE_STOP_SPOKEN_AND_WRITTEN").toBe(true);
      return;
    }
    send({ type: "chat_message", text: "Record the return", requestId: "scope-request", source: "dictation" });
    await wait(paused, () => frames);
    const first = latest()!, receipt = first.journal.scope!.receipts.at(-1)!;
    expect(first.journal.budget, "COMBINED_SCOPE_PAUSE_RETAINS_BUDGET_FACTS").toBeDefined();
    expect(receipt, "SCOPE_ADAPTER_PAUSES_WITH_EXACT_FINITE_CEILING").toMatchObject({ dimension: "tool_calls", cap: 2, count: 2, newCap: 4, frozen: true, state: "paused" });
    const heartbeat = Bun.file(join(brain, "adapter-heartbeat")).size; await Bun.sleep(150);
    expect(Bun.file(join(brain, "adapter-heartbeat")).size, "SCOPE_ADAPTER_RUNNING_WORKER_PAUSED").toBe(heartbeat);
    const decision = (r: ScopeCapReceipt, action: string, submissionId: string) => ({ type: "scope_decision", turnId: first.turnId, sessionId: first.sessionId, eventId: r.eventId, submissionId, action });
    send({ ...decision(receipt, "continue", "wrong-session"), sessionId: "ogygia" });
    await wait(() => frames.some(frame => frame.type === "scope_decision_receipt" && frame.submissionId === "wrong-session"), () => frames);
    expect(frames.find(frame => frame.type === "scope_decision_receipt" && frame.submissionId === "wrong-session")).toMatchObject({ state: "refused" });
    send(decision(receipt, "continue", "athena-grant")); send(decision(receipt, "continue", "athena-grant"));
    await wait(() => latest()?.journal.scope!.receipts.length === 2, () => frames);
    const second = latest()!.journal.scope!.receipts.at(-1)!;
    expect(second).toMatchObject({ cap: 4, count: 4, frozen: true, state: "paused" }); expect(second.newCap).toBeUndefined();
    send(decision(second, "continue", "illegal-grant"));
    await wait(() => frames.some(frame => frame.type === "scope_decision_receipt" && frame.submissionId === "illegal-grant"), () => frames);
    expect(frames.find(frame => frame.type === "scope_decision_receipt" && frame.submissionId === "illegal-grant")).toMatchObject({ state: "refused" });
    send(decision(second, "stop", "athena-stop"));
    await wait(() => !app!.wsHost.coordinator.isTurnActive(), () => frames);
    expect(latest()!.journal.scope!.receipts.at(-1)).toMatchObject({ state: "stopped" });
    expect(latest()!.journal.state).toBe("complete");
    expect(latest()!.journal.budget, "COMBINED_SCOPE_STOP_RETAINS_BUDGET_FACTS").toBeDefined();
    expect(frames.some(frame => frame.type === "error"), "SCOPE_STOP_NORMAL_NOT_FAILURE").toBe(false);
    const blocks = app.db.query("SELECT payload FROM governance_events WHERE kind='roadblock' AND json_extract(payload,'$.category')='scope_cap'").all() as { payload: string }[];
    expect(blocks, "SCOPE_CAP_ROADBLOCK_EPISODE_RECORDED").toHaveLength(1);
    const block = JSON.parse(blocks[0]!.payload);
    expect(block.failures, "SCOPE_CAP_BOTH_HITS_RETAINED_IN_ROADBLOCK_EPISODE").toHaveLength(2);
    expect(block.eventIds).toHaveLength(2);
  } finally { await app?.close(); spawn?.mockRestore(); if (priorPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorPi; rmSync(root, { recursive: true, force: true }); }
}, 30_000);
