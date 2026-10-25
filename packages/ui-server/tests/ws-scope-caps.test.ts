/** Actual adapters with offline provider/session fixtures and real worker processes. */
import { expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as workers from "@schlessera/brain-ui-sdk/internal";
import * as journalCaptures from "../src/brain/native-journal-capture.js";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend.js";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { handleChatMessage } from "../src/ws/run-session.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { createPrincipal } from "../src/db/principals.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { scopePiProgress } from "./helpers/scope-pi-progress.js";
import type { ServerMessage, ScopeCapReceipt } from "@schlessera/brain-ui-sdk/protocol";

async function wait(check: () => boolean, detail: () => unknown) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw Error(JSON.stringify(detail())); await Bun.sleep(10); } }
const cases = (["claude", "pi"] as const).flatMap(adapter => [false, true].map(voice => ({ adapter, voice, overshoot: false })));
cases.push({ adapter: "pi", voice: false, overshoot: true });
for (const { adapter, voice, overshoot } of cases) test(`${adapter}: ${overshoot ? "backlogged four-call overshoot is Stop-only" : voice ? (adapter === "pi" ? "voice admission refuses before a worker" : "true voice stops without a grant") : "dictation pauses, grants once, refuses a second grant and Stops normally"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-scope-adapter-")), brain = join(root, "brain"), config = join(root, "agent"), home = join(root, "home");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain); mkdirSync(config); mkdirSync(home);
  writeFileSync(join(config, "settings.json"), "{}"); mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nscope: { max_tool_calls: 2 }\n---\nAthena bounds the voyage.\n");
  let spawn: ReturnType<typeof spyOn> | undefined;
  let heartbeatPath: string | undefined;
  let piProgress: ReturnType<typeof scopePiProgress> | undefined;
  const heartbeatSize = () => heartbeatPath ? Bun.file(heartbeatPath).size : 0;
  const originalLaunch = workers.launchAgentWorker;
  const priorPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = config;
  const launch = (input: Parameters<typeof originalLaunch>[0]) => {
    const worker = originalLaunch(adapter === "pi" ? { ...input,
      command: [process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/scope-pi-worker.ts")], env: { PATH: "/usr/bin:/bin", ...(overshoot ? { SCOPE_FIXTURE_CHECKPOINT: "4" } : {}) } } : input);
    // Read the actual worker's private writable tmpfs through its retained host handle.
    expect(worker.turnTemp, "SCOPE_ADAPTER_NATIVE_TURN_TEMP_PRESENT").toBeDefined();
    heartbeatPath = join(worker.turnTemp!.root, relative("/tmp", workers.WORKER_SCRATCH), "adapter-heartbeat");
    if (adapter === "pi") { piProgress = scopePiProgress(worker); return piProgress.worker; }
    return worker;
  };
  spawn = spyOn(workers, "launchAgentWorkerAsync").mockImplementation(async input => launch(input));
  const backend = adapter === "pi" ? createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions"), loadExtensions: false })
    : createClaudeBackend({ brainPath: brain, queryFn: ((params: any) => {
      const child = params.options.spawnClaudeCodeProcess({ command: "/bin/sh", args: ["-c", 'while :; do printf x >> "$BRAIN_WORKER_SCRATCH/adapter-heartbeat"; sleep 0.02; done'],
        env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: config }, signal: params.options.abortController.signal });
      child.stdin.end();
      const stream = (async function* () {
        await wait(() => heartbeatSize() >= 2, () => ({ heartbeatPath, bytes: heartbeatSize() }));
        runningHeartbeat = heartbeatSize();
        expect(heartbeatSize(), "SCOPE_ADAPTER_HEARTBEAT_GROWS_WHILE_RUNNING").toBeGreaterThan(1);
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
  let runningHeartbeat = 0;
  const frames: ServerMessage[] = [];
  const latest = () => frames.filter((frame): frame is Extract<ServerMessage,{ type:"turn_journal" }> => frame.type === "turn_journal").at(-1);
  const paused = () => latest()?.journal.scope?.receipts.at(-1)?.state === "paused";
  let releaseObservation!: () => void, observationHeld = false;
  const observationReleased = new Promise<void>(done => { releaseObservation = done; });
  let captureSpy: ReturnType<typeof spyOn> | undefined;
  if (adapter === "pi" && !voice) {
    const createCapture = journalCaptures.createNativeJournalCapture;
    captureSpy = spyOn(journalCaptures, "createNativeJournalCapture").mockImplementation((...args) => {
      const capture = createCapture(...args);
      return { ...capture, async observe(...input) {
        const observation = await capture.observe(...input);
        return { ...observation, async commit() {
          // The real journal has published the finite pause, but its observation
          // hold must remain effective until this real capture commit completes.
          if (!observationHeld && paused()) { observationHeld = true; await observationReleased; }
          await observation.commit();
        } };
      } };
    });
  }
  try {
    app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: join(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
      registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Athena scope", ttlSeconds: 60 });
    const ws = { send: (raw: string) => {
      const frame = JSON.parse(raw);
      if (frame.type === "tool_use_start" && !runningHeartbeat) runningHeartbeat = heartbeatSize();
      frames.push(frame);
    }, close() {} }, handlers = createWsHandlers(app.wsHost, principal);
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
    // Scope summaries reach the client once each commits (#2850): wait for the
    // one that counts every call the worker has made so far.
    const calls = () => new Set(frames.flatMap(frame => frame.type === "tool_use_start" || frame.type === "tool_use_complete" ? [frame.toolUseId] : [])).size;
    await wait(() => paused() && latest()!.journal.scope!.receipts.at(-1)!.count === calls(), () => frames);
    const first = latest()!, receipt = first.journal.scope!.receipts.at(-1)!;
    expect(first.journal.budget, "COMBINED_SCOPE_PAUSE_RETAINS_BUDGET_FACTS").toBeDefined();
    if (overshoot) {
      expect(receipt, "PI_BACKLOGGED_OVERSHOOT_REMAINS_STOP_ONLY").toMatchObject({ dimension: "tool_calls", cap: 2, count: 4, overshoot: 2, frozen: true, state: "paused", reason: "The finite continuation ceiling of 4 tool calls is already exhausted. Stop only." });
      expect(receipt.newCap, "PI_EXHAUSTED_CEILING_HAS_NO_FINITE_GRANT").toBeUndefined();
      expect(piProgress!.checkpoint, "PI_OVERSHOOT_CONTROL_DELIVERS_FOUR_BUFFERED_CALLS").toBe(4);
    } else expect(receipt, "SCOPE_ADAPTER_PAUSES_WITH_EXACT_FINITE_CEILING").toMatchObject({ dimension: "tool_calls", cap: 2, count: 2, newCap: 4, frozen: true, state: "paused" });
    if (adapter === "pi" && !overshoot) {
      expect(piProgress!.checkpoint, "PI_BACKLOG_CHECKPOINT_AFTER_EXACTLY_TWO_CALLS").toBe(2);
      expect(piProgress!.calls, "PI_REMAINING_CALLS_HELD_BEFORE_PAUSE").toEqual(["loom-1", "loom-2"]);
    }
    if (adapter === "pi") await wait(() => observationHeld, () => frames);
    expect(runningHeartbeat, "SCOPE_ADAPTER_HEARTBEAT_GROWS_WHILE_RUNNING").toBeGreaterThan(1);
    const heartbeat = heartbeatSize();
    expect(heartbeat, "SCOPE_ADAPTER_HEARTBEAT_GREW_BEFORE_PAUSE").toBeGreaterThan(0);
    await Bun.sleep(150);
    expect(heartbeatSize(), "SCOPE_ADAPTER_RUNNING_WORKER_PAUSED").toBe(heartbeat);
    const decision = (r: ScopeCapReceipt, action: string, submissionId: string) => ({ type: "scope_decision", turnId: first.turnId, sessionId: first.sessionId, eventId: r.eventId, submissionId, action });
    send({ ...decision(receipt, "continue", "wrong-session"), sessionId: "ogygia" });
    await wait(() => frames.some(frame => frame.type === "scope_decision_receipt" && frame.submissionId === "wrong-session"), () => frames);
    expect(frames.find(frame => frame.type === "scope_decision_receipt" && frame.submissionId === "wrong-session")).toMatchObject({ state: "refused" });
    const decisions = (submissionId: string) => frames.filter((frame): frame is Extract<ServerMessage, { type: "scope_decision_receipt" }> => frame.type === "scope_decision_receipt" && frame.submissionId === submissionId);
    if (overshoot) {
      releaseObservation(); await app.wsHost.journal!.idle();
      send(decision(receipt, "continue", "exhausted-grant"));
      await wait(() => decisions("exhausted-grant").length === 1, () => frames);
      expect(decisions("exhausted-grant")[0], "PI_OVERSHOOT_CONTINUE_REFUSED").toMatchObject({ state: "refused" });
      send(decision(receipt, "stop", "exhausted-stop"));
      await wait(() => !app!.wsHost.coordinator.isTurnActive(), () => frames);
      expect(latest()!.journal.scope!.receipts.at(-1), "PI_OVERSHOOT_NATIVE_STOP").toMatchObject({ state: "stopped", count: 4 });
      expect(frames.some(frame => frame.type === "error"), "PI_OVERSHOOT_STOP_NORMAL_NOT_FAILURE").toBe(false);
      return;
    }
    if (adapter === "pi") {
      expect(app.wsHost.journal!.isHeld(), "SCOPE_ADAPTER_REAL_OBSERVATION_COMMIT_HELD").toBe(true);
      send(decision(receipt, "continue", "athena-held"));
      await wait(() => decisions("athena-held").length === 1, () => frames);
      expect(decisions("athena-held")[0], "SCOPE_ADAPTER_HELD_OBSERVATION_REFUSES_FINITE_OFFER").toMatchObject({ state: "refused", reason: "This limit permits Stop only while continuation headroom is unconfirmed." });
      expect(latest()!.journal.scope, "SCOPE_ADAPTER_REFUSAL_CONSUMES_NO_GRANT").toMatchObject({ calls: 2, limits: { tool_calls: 2 }, receipts: [{ state: "paused", cap: 2, count: 2, newCap: 4, frozen: true }] });
      expect(heartbeatSize(), "SCOPE_ADAPTER_REFUSED_WORKER_STAYS_PAUSED").toBe(heartbeat);
    }
    // Synchronize the grant with completed observation, not merely its published facts.
    releaseObservation();
    await app.wsHost.journal!.idle();
    expect(app.wsHost.journal!.isHeld(), "SCOPE_ADAPTER_GRANT_AFTER_OBSERVATION_COMPLETES").toBe(false);
    send(decision(receipt, "continue", "athena-grant")); send(decision(receipt, "continue", "athena-grant"));
    await wait(() => decisions("athena-grant").length === 2, () => frames);
    expect(decisions("athena-grant").map(frame => frame.state), "SCOPE_ADAPTER_FIRST_GRANT_AND_DUPLICATE_ACCEPTED").toEqual(["accepted", "accepted"]);
    if (adapter === "pi") {
      expect(piProgress!.calls, "PI_REMAINING_CALLS_HELD_UNTIL_OBSERVATION_AND_ACCEPTED_CONTINUE").toEqual(["loom-1", "loom-2"]);
      piProgress!.release();
      await wait(() => piProgress!.continued, () => frames);
    }
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
  } finally {
    releaseObservation();
    piProgress?.release();
    try { await app?.close(); }
    finally {
      try { if (piProgress) { await piProgress.worker.exited; piProgress.close(); } }
      finally { captureSpy?.mockRestore(); spawn?.mockRestore(); if (priorPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorPi; rmSync(root, { recursive: true, force: true }); }
    }
  }
}, 30_000);
