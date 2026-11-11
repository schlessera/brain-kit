/** Real FULL SQLite writers, loopback transport and backend permission bindings. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendActivityEvent, BackendBridge, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { createPermissionWiring } from "../../ui-backend-claude/src/permission-hooks";
import { MUTATING_TOOL_MATCHER } from "../../ui-backend-claude/src/tool-policy";
import { decidePiToolPermission } from "../../ui-backend-pi/src/permission-gate";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createBrainAccess } from "../../ui-backend-pi/src/brain-access";
import { createBrainToolKit } from "../../ui-backend-pi/src/tool-kit";
import { bashTool } from "../../ui-backend-pi/src/file-tools";
import { createPiWorkerRpcDispatcher, type PiWorkerRpcContext } from "../../ui-backend-pi/src/worker-rpc";
import { bashLockKey } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createEffectiveSafety } from "../src/governance/effective-safety";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { occurrence } from "../src/governance/occurrence";
import { queryGovernanceEvents } from "../src/governance/events";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import * as probe from "./fixtures/write-worker-probe";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { requestToolPermission } from "@schlessera/brain-ui-sdk/server";
import { NativeFileVersions } from "@schlessera/brain-ui-sdk/internal";
import { handleToolApproval, handleToolDenial } from "../src/ws/handlers/tool-permission";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createSettingsWrites } from "../src/db/settings-writes";
import { getAutoAllowedTools } from "../src/db/settings";
import { retireChat, resolveChat } from "../src/ws/chat-lifecycle";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture";
import { createTurnJournal } from "../src/brain/turn-journal";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-live-safety-")), db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer), bindingId = crypto.randomUUID();
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId: principal.id, backendId: "claude", at: 0 });
  db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'claude')").run();
  db.query("INSERT INTO chat_session_owners VALUES('ithaca',?,0)").run(principal.id);
  safetyCatalogCreated(db, "ithaca", principal.id, "voyage"); await writes.bind("voyage", "ithaca");
  const controller = new AbortController();
  const collector = createSafetyCollector(db, writes, { turnId: "voyage", bindingId, sessionId: () => "ithaca", backendId: "claude",
    signal: controller.signal, shellProxied: () => true, brainPath: root });
  await collector.ready("claude", 1);
  const state = () => writes.safety("voyage", "ithaca");
  const actor = { principalId: principal.id, channel: "owner_history" as const };
  const add = async (name: string, finalized = true) => {
    await collector.begin(name, "WebFetch", { url: "https://ithaca.invalid/notice" });
    if (finalized) await collector.result(name, "WebFetch", "The harbour is open.", true);
    return safetyRecords(db, "ithaca").filter(r => r.kind === "occurrence").at(-1)!.id;
  };
  const review = async (id: string) => {
    const projection = state(), body = { version: 1 as const, session: projection.session!, occurrenceId: id,
      expectedEvidenceRevision: projection.evidenceRevision, verdict: "safe" as const };
    const prepared = await writes.safetyPrepareReview(body, actor);
    return writes.safetyCommitReview(prepared.requestId!, body, actor);
  };
  let trustRevision = "0", authorityCurrent = true, authorityEpoch = "0";
  const listeners = new Set<() => void>();
  const safety = createEffectiveSafety(db, { turnId: "voyage", sessionId: () => "ithaca", policyHash: null, writes,
    authority: () => ({ current: authorityCurrent, epoch: authorityEpoch }),
    trust: { revision: () => trustRevision, subscribe: changed => { listeners.add(changed); return () => { listeners.delete(changed); }; } } });
  const remove = () => { trustRevision = String(BigInt(trustRevision) + 1n); for (const listener of [...listeners]) listener(); };
  const revoke = () => { authorityCurrent = false; authorityEpoch = "1"; for (const listener of [...listeners]) listener(); };
  return { root, db, writer, writes, bindingId, principal, controller, collector, state, add, review, safety, remove, revoke,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const command = "git push https://github.com/odysseus/voyage.git main";
const allow = [{ command: "^git push ", remotes: ["github.com/odysseus/*"], index: 0 }];
type Binding = "claude-hook" | "claude-callback" | "pi";
async function execute(f: Fixture, binding: Binding, options: {
  phase?: "approval" | "input" | "index" | "lock"; interleave?: () => Promise<unknown>; explicit?: boolean;
}) {
  let interleaved = false;
  const pause = async (phase: typeof options.phase) => {
    if (options.phase === phase && !interleaved) { interleaved = true; await options.interleave?.(); }
  };
  const requests: PermissionRequest[] = [], events: BackendActivityEvent[] = [];
  const bridge: BackendBridge = { emit() {}, admissionSafety: f.safety, activity: e => { events.push(e); },
    async requestPermission(req) { requests.push(req); await pause("approval"); return { behavior: "allow" }; },
    async awaitIndex() { await pause("index"); },
    inputSafety: { ...f.collector, async begin(id, tool, input) { await f.collector.begin(id, tool, input); await pause("input"); } } };
  const policy = { hash: null, deny: [], confirm: options.phase === "approval" && binding === "claude-hook" && !options.explicit
    ? [{ pattern: "^git push ", reason: "Review this command", index: 0 }] : [], outwardAllow: options.explicit ? [] : allow,
    taint: () => f.writes.taint("voyage", "ithaca") };
  const id = crypto.randomUUID(), input = { command };
  let allowed = false;
  if (binding === "pi") {
    const decision = await decidePiToolPermission({ turn: { ...createTurnContext(), bridge, signal: f.controller.signal, commandPolicy: policy },
      allowedTools: new Set(options.phase === "approval" && !options.explicit ? [] : ["bash"]), confirmPatterns: [] }, "bash", input, id);
    allowed = decision.behavior === "allow";
  } else {
    const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca", bridge, signal: f.controller.signal,
      workerSandbox: { brain: f.root, profile: "governed", commandPolicy: policy } as never }, allowedTools: ["Bash"], confirmPatterns: [], brainPath: f.root,
      turnLock: { async acquireForTool() { await pause("lock"); return { ok: true }; }, releaseForTool() {} } as never,
      childEnv: {}, log() {} });
    if (binding === "claude-callback") {
      const result = await wiring.canUseTool!("Bash", input, { toolUseID: id, signal: f.controller.signal } as never);
      allowed = result?.behavior === "allow";
    } else {
      const hook = wiring.hooks!.PreToolUse!.find(group => group.matcher === MUTATING_TOOL_MATCHER)!.hooks[0]!;
      const result = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input, tool_use_id: id } as never, id, { signal: f.controller.signal });
      allowed = !("hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "PreToolUse" && result.hookSpecificOutput.permissionDecision === "deny");
    }
  }
  // An actual process effect is the oracle; no external Git/network executes.
  const bin = join(f.root, "bin"), marker = join(f.root, "executed"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'Ithaca\\n' >> '${marker}'\n`, { mode: 0o755 });
  const before = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  if (allowed) {
    const child = Bun.spawn(["/bin/sh", "-c", command], { cwd: f.root, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  }
  return { allowed, requests, events, interleaved, executed: (existsSync(marker) ? readFileSync(marker, "utf8") : "") !== before };
}

for (const mode of ["in-process-lock", "rpc-lock", "rpc-final"] as const) for (const explicit of [false, true]) {
  test(`Pi ${mode}: final post-permission admission preserves ${explicit ? "per-use approval" : "standing-rule restrictions"}`, async () => {
    const f = await fixture(), bin = join(f.root, "bin"), marker = join(f.root, "effect"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'Ithaca\\n' >> '${marker}'\n`, { mode: 0o755 });
    const saved = Object.getOwnPropertyDescriptor(process.env, "PATH"); process.env.PATH = `${bin}:/usr/bin:/bin`;
    const bridge: BackendBridge = { emit() {}, admissionSafety: f.safety, inputSafety: f.collector, requestPermission: async () => ({ behavior: "allow" }) };
    const turn = { ...createTurnContext(), bridge, signal: f.controller.signal, commandPolicy: { hash: null, deny: [], confirm: [], outwardAllow: explicit ? [] : allow } };
    const id = "post-permission", input = { command };
    let refused: unknown;
    const interleave = () => f.add("post-gate-input");
    try {
      if (mode === "in-process-lock") {
        expect((await decidePiToolPermission({ turn, allowedTools: new Set(["bash"]), confirmPatterns: [] }, "bash", input, id)).behavior).toBe("allow");
        const tool = bashTool(createBrainToolKit({ brain: createBrainAccess(f.root), turn, exec: {}, lock: { async withKey(_key, body) { await interleave(); return body(); } } }));
        try { await tool.execute(id, input, f.controller.signal, undefined, {} as never); } catch (error) { refused = error; }
      } else {
        const context = { brainPath: f.root, turn, live() {}, grants: new Map(), releases: new Map(), admitTool() {},
          autonomous: false, workerSandbox: undefined, allowedTools: new Set(["bash"]), confirmPatterns: [],
          workerLock: { async acquire() { if (mode === "rpc-lock") await interleave(); return () => {}; } },
          executed: () => ({ name: "bash", lock: false, host: false, phases: new Set() }) } as unknown as PiWorkerRpcContext;
        const dispatch = createPiWorkerRpcDispatcher(context);
        const message = (n: number, method: "permission" | "lock" | "admission", value: Record<string, unknown>) => ({ type: "rpc" as const, id: n, method, toolName: "bash", toolCallId: id, input: value });
        expect(await dispatch(message(1, "permission", input))).toEqual({ behavior: "allow" });
        try {
          await dispatch(message(2, "lock", { key: bashLockKey(command) }));
          if (mode === "rpc-final") await interleave();
          await dispatch(message(3, "admission", input));
          const child = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
          expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
          await expect(dispatch(message(4, "admission", input)), "LIVE_PI_FINAL_TICKET_CANNOT_REPLAY").rejects.toThrow("no exact permission grant");
        } catch (error) { refused = error; }
        for (const release of context.releases.values()) release();
      }
      expect(existsSync(marker), "LIVE_PI_POST_GATE_WAITS_REVALIDATE_BEFORE_PROCESS_EFFECT").toBe(explicit);
      if (explicit) expect(refused).toBeUndefined(); else expect(String(refused)).toContain("Safety or authority changed");
    } finally {
      if (saved) Object.defineProperty(process.env, "PATH", saved); else delete process.env.PATH;
      await f.close();
    }
  });
}

for (const binding of ["claude-hook", "claude-callback", "pi"] as const) {
  test(`${binding}: A/B/C individual verdicts change later admissions without rewriting prior facts`, async () => {
    const f = await fixture(); try {
      const [a, b, c] = [await f.add("A"), await f.add("B"), await f.add("C")];
      const original = JSON.stringify(queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint", "taint_exposure"], limit: 100 }));
      await f.review(a); expect(f.state().unresolvedCount).toBe(2);
      expect((await execute(f, binding, {})).requests.some(r => r.kind === "command"), "LIVE_A_VERDICT_CANNOT_CLEAR_B_OR_C_ADMISSION").toBe(true);
      await f.review(b); expect(f.state().unresolvedCount).toBe(1);
      expect((await execute(f, binding, {})).requests.some(r => r.kind === "command"), "LIVE_B_VERDICT_CANNOT_CLEAR_SAME_SOURCE_C_ADMISSION").toBe(true);
      await f.review(c); expect(f.state().restriction).toBe("normal");
      const normal = await execute(f, binding, {});
      expect(normal.executed, "LIVE_SAFE_ZERO_RESTORES_LATER_POLICY_ALLOW").toBe(true);
      expect(normal.requests.filter(r => r.kind === "command")).toEqual([]);
      const open = await f.add("D", false);
      expect((await f.review(open)).reason).toBe("not_finalized");
      const restricted = await execute(f, binding, {});
      expect(restricted.requests.some(r => r.kind === "command"), "LIVE_OPEN_INPUT_CANNOT_BORROW_SAFE_VERDICT").toBe(true);
      expect(JSON.stringify(queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["taint", "taint_exposure"], limit: 100 })).startsWith(original.slice(0, -1)), "LIVE_RETAINED_OCCURRENCES_UNCHANGED").toBe(true);
    } finally { await f.close(); }
  });
  for (const phase of binding === "claude-hook" ? ["approval", "lock", "input", "index"] as const : binding === "pi" ? ["approval", "input", "index"] as const : ["approval", "lock", "input"] as const) {
    test(`${binding}: a new trigger during ${phase} cannot dispatch under an earlier outward allowance`, async () => {
      const f = await fixture(); try {
        const result = await execute(f, binding, { phase, interleave: () => f.add("B") });
        expect(result.interleaved, "LIVE_TEST_REACHES_ASYNC_BOUNDARY").toBe(true);
        expect(result.executed, "LIVE_FINAL_GATE_REJECTS_STALE_STANDING_ALLOW").toBe(false);
        expect(f.state().unresolvedCount).toBe(1);
      } finally { await f.close(); }
    });
  }
  for (const change of ["remove", "revoke"] as const) test(`${binding}: live ${change} during a per-use approval never dispatches`, async () => {
    const f = await fixture(); try {
      const result = await execute(f, binding, { explicit: true, phase: "approval", interleave: async () => { f[change](); } });
      expect(result.interleaved).toBe(true);
      expect(result.executed, "LIVE_APPROVAL_WAITS_RECHECK_REVISION_AND_AUTHORITY").toBe(false);
    } finally { await f.close(); }
  });
  test(`${binding}: a completed explicit outward approval stays distinct from a removed standing rule`, async () => {
    const f = await fixture(); try {
      const result = await execute(f, binding, { explicit: true, phase: "input", interleave: async () => { f.remove(); } });
      expect(result.executed, "LIVE_COMPLETED_PER_USE_IS_NOT_STANDING_AUTHORITY").toBe(true);
      expect(result.events.find(e => e.kind === "outward_action")).toMatchObject({ payload: { decision: "approved", rule: null } });
    } finally { await f.close(); }
  });
  test(`${binding}: another facade's recorder loss during the last input wait fences dispatch`, async () => {
    const f = await fixture(); try {
      const result = await execute(f, binding, { explicit: true, phase: "input", interleave: () => createGovernanceWrites(f.db, f.writer).safetyFail("other-turn") });
      expect(result.interleaved).toBe(true);
      expect(result.executed, "LIVE_BACKEND_RECHECKS_SHARED_RECORDER_HEALTH").toBe(false);
    } finally { await f.close(); }
  });
}

const get = (socketPath: string, target: string) => new Promise<number>((resolve, reject) => {
  const req = request({ socketPath, path: target }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); res.once("error", reject); });
  req.once("error", reject); req.end();
});

test("an independent connection cannot borrow another request's own-input authority; dispatched legacy grants still work", async () => {
  const f = await fixture(); let reached = 0, admissions = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reached++; return new Response("Ithaca"); } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const asked = Promise.withResolvers<"asked">(), borrowed = Promise.withResolvers<"borrowed">();
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }),
    bridge: { emit() {}, admissionSafety: f.safety, requestPermission: async () => { asked.resolve("asked"); return { behavior: "deny", message: "Odysseus declines" }; } }, controller: f.controller,
    turnId: "voyage", sessionId: () => "ithaca", model: () => null, profile: "governed", origin: "interactive", governanceDb: f.db,
    governanceWrites: { ...f.writes, async firstTaint(event) {
      if (++admissions > 1) borrowed.resolve("borrowed");
      await f.writes.firstTaint(event); entered.resolve(); await release.promise; return true;
    } }, record: event => f.writes.record(event) });
  let first: Promise<number> | undefined, second: Promise<number> | undefined;
  try {
    first = get(proxy.socketPath, origin.url.href); await entered.promise;
    second = get(proxy.socketPath, origin.url.href);
    expect(await Promise.race([asked.promise, borrowed.promise]), "LIVE_UNRELATED_CONNECTION_CANNOT_BORROW_OWN_INPUT_AUTHORITY").toBe("asked");
    expect(await second).toBe(403); expect(reached).toBe(0);
    release.resolve(); expect(await first).toBe(200);
    await proxy.settled();
    expect(await get(proxy.socketPath, origin.url.href), "LIVE_DISPATCHED_LEGACY_CONTACT_GRANT_REMAINS_AVAILABLE").toBe(200);
    expect(reached).toBe(2);
    expect(safetyRecords(f.db, "ithaca").filter(r => r.kind === "occurrence")).toHaveLength(2);
  } finally { release.resolve(); proxy.stop(); await Promise.allSettled([first, second]); await proxy.settled(); origin.stop(true); await f.close(); }
});

for (const change of ["healthy", "new-input", "other-recorder-loss", "revoke"] as const) test(`loopback proxy final occurrence-write wait revalidates ${change}`, async () => {
  const f = await fixture(); let reached = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reached++; return new Response("Ithaca"); } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }),
    bridge: { emit() {}, admissionSafety: f.safety, requestPermission: async () => ({ behavior: "allow" }) }, controller: f.controller,
    turnId: "voyage", sessionId: () => "ithaca", model: () => null, profile: "governed", origin: "interactive", governanceDb: f.db,
    governanceWrites: { ...f.writes, async firstTaint(event) { await f.writes.firstTaint(event); entered.resolve(); await release.promise; return true; } },
    record: event => f.writes.record(event) });
  try {
    const pending = get(proxy.socketPath, origin.url.href); await entered.promise;
    if (change === "new-input") await f.add("B");
    if (change === "other-recorder-loss") await f.writes.safetyFail("unrelated-turn");
    if (change === "revoke") f.revoke();
    release.resolve();
    expect(await pending, "LIVE_PROXY_CHECKS_AFTER_OCCURRENCE_COMMIT_WAIT").toBe(change === "healthy" ? 200 : 403);
    expect(reached, "LIVE_PROXY_NEVER_DISPATCHES_STALE_AUTHORITY").toBe(change === "healthy" ? 1 : 0);
  } finally { release.resolve(); proxy.stop(); await proxy.settled(); origin.stop(true); await f.close(); }
});

test("FULL writer pending input restricts every facade before reservation commit, and queued safe verdict never loosens", async () => {
  const f = await fixture(); try {
    const a = await f.add("A");
    const projection = f.state(), body = { version: 1 as const, session: projection.session!, occurrenceId: a,
      expectedEvidenceRevision: projection.evidenceRevision, verdict: "safe" as const };
    const actor = { principalId: f.principal.id, channel: "owner_history" as const };
    const prepared = await f.writes.safetyPrepareReview(body, actor);
    expect(prepared.stage).toBe("prepared");
    const channel = f.writer.channel(probe, { table: "live_hold" }); await channel.ready;
    expect(await channel.call<number>("level")).toBe(2);
    const entered = new Int32Array(new SharedArrayBuffer(4)), held = channel.call("slow", "Ithaca", 200, entered);
    const waiting = Atomics.waitAsync(entered, 0, 0, 5000); if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    const safe = f.writes.safetyCommitReview(prepared.requestId!, body, actor);
    expect(f.safety.read().restricted, "LIVE_QUEUED_SAFE_VERDICT_REMAINS_RESTRICTIVE").toBe(true);
    await held; expect((await safe).stage).toBe("verdict_committed");
    const enteredAgain = new Int32Array(new SharedArrayBuffer(4)), second = channel.call("slow", "Troy", 200, enteredAgain);
    const next = Atomics.waitAsync(enteredAgain, 0, 0, 5000); if (next.async) await next.value;
    const pending = f.writes.firstTaint({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: null,
      payload: { source: "web_fetch", tool: "WebFetch", detail: null, occurrence: occurrence(f.bindingId, "tool_web_input", "B", "finalized") } });
    expect(f.safety.read().recordingAvailable, "LIVE_PENDING_INPUT_FENCES_BEFORE_FULL_COMMIT").toBe(false);
    expect(createGovernanceWrites(f.db, f.writer).taint("voyage", "ithaca")).not.toBeNull();
    await second; await pending;
    expect(f.state().unresolvedCount).toBe(1);
  } finally { await f.close(); }
});

for (const change of ["review", "new-input", "remove", "revoke"] as const) test(`real bridge withdraws a stale ${change} card only with a durable terminal receipt and never replays it`, async () => {
  const f = await fixture(), trigger = await f.add("A");
  const raised = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  const decisions: string[] = [], frames: { type: string; outcome?: string }[] = [];
  const backend = makeFakeBackend({ id: "claude", async startTurn(req) {
    await req.bridge.inputSafety!.ready("claude", 1);
    req.bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: false });
    const result = await requestToolPermission(req.bridge, { toolUseId: "ithaca-card", toolName: "Network", kind: "command", input: { target: "troy.invalid:443" } });
    decisions.push(result.behavior);
    // The wait cannot settle until its terminal receipt has committed.
    expect(queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["safety_admission_expired"], limit: 100 }), "LIVE_WITHDRAWAL_COMMITS_BEFORE_BACKEND_SETTLES").toHaveLength(1);
    req.bridge.emit({ type: "result", sessionId: "ithaca", isError: false, durationMs: 1, numTurns: 1 });
    completed.resolve();
  } });
  const store = createActivityStore(f.db);
  let principalCurrent = true;
  const host = new WsHost({ brainPath: f.root, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => f.db),
    isPrincipalAuthorized: id => principalCurrent && id === f.principal.id,
    safetyTrust: { revision: () => f.safety.read().trustRevision, subscribe: callback => f.safety.subscribe(callback) },
    activity: { store, stream: createActivityStream(store), governanceDb: f.db, governanceWrites: f.writes } });
  host.clients.add({ send(text) { const frame = JSON.parse(text); frames.push(frame); if (frame.type === "tool_approval_request") raised.resolve(); } }, f.principal.id);
  try {
    const run = runSession(host, { authorization: testAuthorization(f.principal.id), text: "Return to Ithaca", attachments: [], sessionId: "ithaca" });
    await Promise.race([raised.promise, run.then(() => { throw new Error(`Bridge ended before opening its card: ${JSON.stringify(frames)}`); })]);
    if (change === "review") expect((await f.review(trigger)).stage).toBe("verdict_committed");
    if (change === "new-input") await f.add("B");
    if (change === "remove") f.remove();
    if (change === "revoke") { principalCurrent = false; await host.revokePrincipals([f.principal.id], 1008, "Revoked"); }
    await Promise.race([completed.promise, run]); await run;
    expect(frames.filter(frame => frame.type === "error"), JSON.stringify(frames)).toEqual([]);
    expect(decisions, "LIVE_STALE_CARD_NEVER_AUTOMATICALLY_REPLAYS").toEqual(["deny"]);
    expect(host.coordinator.claimApproval("ithaca-card"), "LIVE_LATE_CARD_REPLY_HAS_NO_AUTHORITY").toBeUndefined();
    expect(host.coordinator.resolvedApprovals.get("ithaca-card")).toMatchObject({ outcome: "expired" });
    expect(frames.filter(frame => frame.type === "tool_approval_request")).toHaveLength(1);
    expect(f.db.query("SELECT payload FROM governance_events WHERE kind='safety_admission_expired'").all()).toHaveLength(1);
  } finally { host.close(); await f.close(); }
});

test("only new journal steering attribution uses effective evidence; original facts remain identical", async () => {
  const f = await fixture(), brain = join(f.root, "brain"); mkdirSync(brain);
  writeFileSync(join(brain, "AGENTS.md"), "Original harbour instructions\n");
  const native = createNativeJournalFixture(brain, f.root);
  const journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: brain, dbPath: join(f.root, "ui.db"), objectsRoot: join(f.root, "objects") });
  const observe = async (id: string, text: string) => {
    await journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
    writeFileSync(join(brain, "AGENTS.md"), text); await journal.finish(id);
    return journal.details("ithaca", id)!.changes.find(change => change.path === "AGENTS.md")!;
  };
  try {
    await journal.ready;
    const a = await f.add("A"), first = await observe("journal-a", "The first harbour instructions\n");
    expect(first, "LIVE_JOURNAL_RECORDS_ORIGINAL_TAINT").toMatchObject({ tainted: true });
    const retained = JSON.stringify(journal.details("ithaca", "journal-a"));
    await f.review(a);
    expect(await observe("journal-b", "Reviewed harbour instructions\n"), "LIVE_NEW_JOURNAL_DOES_NOT_REUSE_RESOLVED_FIRST_SOURCE").not.toHaveProperty("tainted");
    const b = await f.add("B");
    const third = await observe("journal-c", "Another harbour instruction\n");
    expect(third).toMatchObject({ tainted: true });
    expect(third.taintSourceEventId, "LIVE_NEW_JOURNAL_NAMES_CURRENT_UNRESOLVED_SOURCE").not.toBe(first.taintSourceEventId);
    await f.review(b);
    await f.writes.safetyBegin({ turnId: "unknown-journal-epoch", bindingId: crypto.randomUUID(), sessionId: "ithaca", principalId: f.principal.id, backendId: "unknown", at: 0 });
    const unknown = await observe("journal-d", "Instructions from unknown retained context\n");
    expect(unknown, "LIVE_JOURNAL_RETAINS_UNKNOWN_RESTRICTION_WITHOUT_INVENTING_SOURCE").toHaveProperty("tainted", true);
    expect(unknown).not.toHaveProperty("taintSourceEventId");
    expect(JSON.stringify(journal.details("ithaca", "journal-a")), "LIVE_HISTORICAL_JOURNAL_IS_BYTE_IDENTICAL").toBe(retained);
  } finally { await journal.close(); await native.close(); await f.close(); }
});

test("zero reviewed triggers cannot clear unknown coverage or waive ordinary deny and byte controls", async () => {
  const f = await fixture();
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  try {
    await f.review(await f.add("A"));
    await f.writes.safetyBegin({ turnId: "unknown-epoch", bindingId: crypto.randomUUID(), sessionId: "ithaca", principalId: f.principal.id, backendId: "unknown", at: 0 });
    expect(f.state().unresolvedCount).toBe(0); expect(f.safety.read().restricted, "LIVE_ZERO_WITH_UNKNOWN_HISTORY_STAYS_RESTRICTED").toBe(true);
    for (const egress of [{ mode: "record" as const, deny: ["127.0.0.1"] }, { mode: "allowlist" as const, allow: [] }, { mode: "record" as const, max_bytes_per_turn: 0 }]) {
      const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1, egress }),
        bridge: { emit() {}, admissionSafety: f.safety, requestPermission: async () => ({ behavior: "allow" }) }, controller: new AbortController(),
        turnId: "voyage", sessionId: () => "ithaca", model: () => null, profile: "governed", origin: "interactive", governanceDb: f.db, governanceWrites: f.writes, record: event => f.writes.record(event) });
      try { expect(await get(proxy.socketPath, origin.url.href), "LIVE_INDEPENDENT_EGRESS_CONTROLS_STILL_REFUSE").toBe(403); }
      finally { proxy.stop(); await proxy.settled(); }
    }
  } finally { origin.stop(true); await f.close(); }
});


// Each hook sees the original input concurrently. The last hook must fence its
// own final wait even when every other hook already returned an allow/continue.
for (const last of ["rtk", "agent", "native-read", "index"] as const) {
  for (const change of ["healthy", "recording-loss", "revoke", "cancel"] as const) {
    test(`parallel Claude ${last}: final wait fences ${change} before process/file delivery`, async () => {
      const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), siblings = Promise.withResolvers<void>();
      const wait = async () => { entered.resolve(); await release.promise; };
      const versions = new NativeFileVersions(), begin = versions.beginRead.bind(versions);
      versions.beginRead = async (...args) => { await begin(...args); await wait(); };
      writeFileSync(join(f.root, "notice.md"), "Ithaca");
      let finished = 0;
      const name = last === "agent" ? "Agent" : last === "native-read" || last === "index" ? "Read" : "Bash";
      const input = name === "Bash" ? { command: "echo Ithaca" } : name === "Agent" ? { prompt: "Return to Ithaca" } : { file_path: "notice.md" };
      const bridge: BackendBridge = { emit() {}, admissionSafety: f.safety, requestPermission: async () => ({ behavior: "allow" }),
        inputSafety: { ...f.collector, async begin(id, tool, value) {
          await f.collector.begin(id, tool, value);
          if (last === "rtk" && value.command === "printf Ithaca" || last === "agent" && value.run_in_background === false) await wait();
        } }, ...(last === "index" ? { awaitIndex: async () => { await wait(); } } : {}) };
      const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca", bridge, signal: f.controller.signal,
        workerSandbox: { brain: f.root, profile: "governed" } as never }, allowedTools: [name], confirmPatterns: [], brainPath: f.root,
        turnLock: { async acquireForTool() { return { ok: true }; }, releaseForTool() {} } as never,
        ...(last === "native-read" ? { fileVersions: versions } : {}), childEnv: {}, rewriteRtk: async () => "printf Ithaca", log() {} });
      const calls = wiring.hooks!.PreToolUse!.filter(group => !group.matcher || new RegExp(group.matcher).test(name))
        .flatMap(group => group.hooks).map(hook => hook({ hook_event_name: "PreToolUse", tool_name: name,
          tool_input: input, tool_use_id: "parallel-admission" } as never, "parallel-admission", { signal: f.controller.signal })
          .then(output => { if (++finished === calls.length - 1) siblings.resolve(); return output; }));
      if (calls.length === 1) siblings.resolve();
      try {
        // Every other hook has returned (each records its call's admission,
        // a write-worker round trip) while the last one waits.
        await entered.promise;
        await siblings.promise;
        expect(finished, "PARALLEL_PROBE_REACHES_LAST_HOOK_WAIT").toBe(calls.length - 1);
        if (change === "recording-loss") await f.writes.safetyFail("another-turn");
        if (change === "revoke") f.revoke();
        if (change === "cancel") f.controller.abort();
        release.resolve();
        const outputs = await Promise.all(calls);
        const denied = outputs.some(output => "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse" && output.hookSpecificOutput.permissionDecision === "deny");
        const marker = join(f.root, "parallel-effect");
        let delivered: string | null = null;
        if (!denied) {
          if (name === "Read") delivered = readFileSync(join(f.root, "notice.md"), "utf8");
          else {
            const command = name === "Bash" ? "printf Ithaca" : "printf Odyssey";
            const child = Bun.spawn(["/bin/sh", "-c", command], { stdout: Bun.file(marker), stderr: "pipe" });
            expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
          }
        }
        expect(name === "Read" ? delivered !== null : existsSync(marker), "PARALLEL_LAST_WAIT_MUST_FENCE_REAL_DELIVERY").toBe(change === "healthy");
      } finally { release.resolve(); await Promise.allSettled(calls); await f.close(); }
    });
  }
}

for (const kind of ["tool", "command", "policy", "actor"] as const) for (const change of ["healthy", "remove"] as const) {
  test(`direct host ${kind} approval: host-owned snapshot fences ${change}`, async () => {
    const f = await fixture(), raised = Promise.withResolvers<void>();
    let reached = 0, decision: string | undefined, run: Promise<void> | undefined;
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reached++; return new Response("Ithaca"); } });
    const backend = makeFakeBackend({ id: "claude", async startTurn(req) {
      await req.bridge.inputSafety!.ready("claude", 1);
      req.bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: false });
      // Application, policy, compute and Apify callers all use this boundary.
      const result = await req.bridge.requestPermission({ toolUseId: "direct-card", toolName: "OdysseyTool", kind, input: {} });
      decision = result.behavior;
      if (result.behavior === "allow") await fetch(origin.url);
      req.bridge.emit({ type: "result", sessionId: "ithaca", isError: false, durationMs: 1, numTurns: 1 });
    } });
    const store = createActivityStore(f.db);
    const host = new WsHost({ brainPath: f.root, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => f.db),
      isPrincipalAuthorized: id => id === f.principal.id,
      safetyTrust: { revision: () => f.safety.read().trustRevision, subscribe: changed => f.safety.subscribe(changed) },
      activity: { store, stream: createActivityStream(store), governanceDb: f.db, governanceWrites: f.writes } });
    const frames: ServerMessage[] = [];
    const ws = { send(text: string) { const frame = JSON.parse(text) as ServerMessage; frames.push(frame); if (frame.type === "tool_approval_request") raised.resolve(); } };
    host.clients.add(ws, f.principal.id);
    host.clients.setCapabilities(ws, { toolResolution: true });
    try {
      run = runSession(host, { authorization: testAuthorization(f.principal.id), text: "Return to Ithaca", attachments: [], sessionId: "ithaca" });
      await raised.promise;
      const pending = host.coordinator.pendingApprovals.get("direct-card")!;
      if (change === "remove") f.remove();
      // A simultaneous answer must neither revive nor grant a withdrawn card.
      await handleToolApproval({ host, ws, requireEcho: true, connection: { principal: f.principal,
        authorization: testAuthorization(f.principal.id), capabilities: { toolResolution: true } } },
        { type: "tool_approval", toolUseId: "direct-card", turnId: pending.turnId, channel: "card" });
      await run;
      expect(reached, "DIRECT_HOST_STALE_CARD_CANNOT_DISPATCH_LOOPBACK").toBe(change === "healthy" ? 1 : 0);
      expect(decision).toBe(change === "healthy" ? "allow" : "deny");
      expect(queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["safety_admission_expired"], limit: 100 })).toHaveLength(change === "healthy" ? 0 : 1);
      expect(host.coordinator.resolvedApprovals.get("direct-card")?.outcome).toBe(change === "healthy" ? "granted" : "expired");
      expect(frames.filter(frame => frame.type === "tool_resolution" && frame.outcome === (change === "healthy" ? "granted" : "expired"))).toHaveLength(1);
    } finally { host.close(); await run; origin.stop(true); await f.close(); }
  });
}

for (const failStore of [false, true]) for (const change of ["healthy", "remove", "revoke", "cancel", "shutdown", "silent-remove", "retire"] as const) {
  test(`claimed approval grant-storage ${failStore ? "failure" : "success"}: ${change} settles once without stale dispatch`, async () => {
    const f = await fixture(), raised = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let decision: string | undefined, reached = 0, adds = 0, run: Promise<void> | undefined, answer: Promise<unknown> | undefined;
    let trust = "0", principalCurrent = true;
    const grants = createSettingsWrites(f.db, f.writer);
    const flush = f.writer.channel(probe, { table: "approval_flush" }); await flush.ready;
    expect(await flush.call<number>("level")).toBe(2);
    let pendingCard: import("../src/ws/turns").PendingApproval | undefined;
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reached++; return new Response("Ithaca"); } });
    const backend = makeFakeBackend({ id: "claude", async startTurn(req) {
      await req.bridge.inputSafety!.ready("claude", 1);
      req.bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: false });
      const result = await requestToolPermission(req.bridge, { toolUseId: "stored-card", toolName: "OdysseyTool", kind: "tool", input: {} });
      decision = result.behavior;
      if (result.behavior === "allow") await fetch(origin.url);
      req.bridge.emit({ type: "result", sessionId: "ithaca", isError: false, durationMs: 1, numTurns: 1 });
    } });
    const store = createActivityStore(f.db);
    const host = new WsHost({ brainPath: f.root, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => f.db),
      isPrincipalAuthorized: id => principalCurrent && id === f.principal.id,
      safetyTrust: { revision: () => change === "silent-remove" ? trust : f.safety.read().trustRevision, subscribe: changed => f.safety.subscribe(changed) },
      toolPermissions: { isAutoAllowed: () => false, async add(name) { adds++; entered.resolve(); await release.promise; if (failStore) throw new Error("injected grant write failure"); await grants.addAutoAllowedTool(name); } },
      activity: { store, stream: createActivityStream(store), governanceDb: f.db, governanceWrites: f.writes } });
    const frames: ServerMessage[] = [];
    const ws = { send(text: string) { const frame = JSON.parse(text) as ServerMessage; frames.push(frame); if (frame.type === "tool_approval_request") raised.resolve(); } };
    host.clients.add(ws, f.principal.id);
    host.clients.setCapabilities(ws, { toolResolution: true });
    const ctx = { host, ws, requireEcho: true, connection: { principal: f.principal, authorization: testAuthorization(f.principal.id) } };
    try {
      run = runSession(host, { authorization: testAuthorization(f.principal.id), text: "Return to Ithaca", attachments: [], sessionId: "ithaca" });
      await raised.promise;
      const pending = host.coordinator.pendingApprovals.get("stored-card")!;
      pendingCard = pending;
      const reply = { type: "tool_approval" as const, toolUseId: "stored-card", turnId: pending.turnId, always: true, channel: "card" as const };
      answer = Promise.resolve(handleToolApproval(ctx, reply));
      // Observe handler errors without masking the eventual success assertion.
      void answer.catch(() => {});
      await entered.promise;
      expect(host.coordinator.pendingApprovals.has("stored-card")).toBe(false);
      expect(host.chatBusy({ sessions: ["ithaca"], dialogueOwners: [], conversations: [], tasks: [], requests: [], nativeTasks: [] }),
        "CLAIMED_CARD_KEEPS_CHAT_BUSY_BEFORE_RETIREMENT").toBe(true);
      await handleToolApproval(ctx, reply);
      handleToolDenial(ctx, { type: "tool_denial", toolUseId: "stored-card", turnId: pending.turnId, message: "Late denial", channel: "card" });
      expect(adds, "CLAIMED_CARD_HAS_ONE_GRANT_STORE_WRITER").toBe(1);
      if (change === "remove") f.remove();
      if (change === "silent-remove") trust = "1";
      if (change === "revoke") { principalCurrent = false; await host.revokePrincipals([f.principal.id], 1008, "Revoked"); }
      if (change === "cancel") host.coordinator.cancelTurn(pending.turn, "Odysseus cancelled");
      if (change === "shutdown") host.close();
      if (change === "retire") {
        // Simulate a separate lifecycle writer; the public deletion path above
        // refuses busy work, and must keep doing so.
        const chat = resolveChat(f.db, { sessionId: "ithaca" });
        if ("refused" in chat) throw new Error(chat.refused);
        expect(retireChat(f.db, { operationId: "retire-stored-card", principalId: f.principal.id, target: { sessionId: "ithaca" },
          expected: { backendId: chat.backendId, generation: chat.generation }, removableBackends: ["claude"], at: Date.now() }).status).toBe("retired");
      }
      if (["remove", "revoke", "cancel", "shutdown"].includes(change)) {
        await Promise.resolve(); // Let the invalidation enqueue its durable terminal first.
        await flush.call("level");
        await new Promise(resolve => setImmediate(resolve));
        expect(decision, "INVALIDATION_SETTLES_BACKEND_WHILE_GRANT_STORE_STILL_WAITS").toBe("deny");
      }
      release.resolve();
      await answer.catch(() => {});
      // Drain the real FULL writer and settlement continuations, without a timeout oracle.
      await Promise.resolve();
      await flush.call("level");
      await new Promise(resolve => setImmediate(resolve));
      const expired = queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["safety_admission_expired"], limit: 100 });
      const allowed = change === "healthy" && !failStore;
      if (allowed) await run;
      expect(expired, "CLAIMED_CARD_RETAINS_EXACTLY_ONE_DURABLE_TERMINAL").toHaveLength(allowed || change === "retire" ? 0 : 1);
      if (change === "retire") {
        expect(host.coordinator.resolvedApprovals.get("stored-card")?.reason).toContain("could not be retained");
        expect(pending.turn.abortController.signal.aborted).toBe(true);
        expect(f.db.query("SELECT generation FROM chat_lifecycles WHERE operation_id='retire-stored-card'").get()).toEqual({ generation: 2 });
      }
      expect(decision, "GRANT_FAILURE_OR_WITHDRAWAL_NEVER_ORPHANS_BACKEND").toBe(allowed ? "allow" : "deny");
      expect(reached, "CLAIMED_CARD_CANNOT_DISPATCH_STALE_GRANT").toBe(allowed ? 1 : 0);
      expect(host.coordinator.resolvedApprovals.get("stored-card")?.outcome).toBe(allowed ? "granted" : "expired");
      expect(frames.filter(frame => frame.type === "tool_resolution")).toHaveLength(change === "revoke" ? 0 : 1);
      // The already-requested legacy standing grant is independent of whether
      // this operation expired; it must never revive that operation.
      expect(getAutoAllowedTools(f.db)).toEqual(failStore ? [] : ["OdysseyTool"]);
      await run;
      await answer;
    } finally {
      release.resolve();
      if (decision === undefined) pendingCard?.resolve({ behavior: "deny", message: "Probe cleanup" });
      host.close();
      await answer?.catch(() => {});
      await run;
      origin.stop(true); await f.close();
    }
  });
}


test("withdrawal receipt storage failure explicitly terminates and stops the backend without dispatch", async () => {
  const f = await fixture(), raised = Promise.withResolvers<void>();
  let decision: string | undefined, aborted = false, reached = 0, run: Promise<void> | undefined;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reached++; return new Response("Ithaca"); } });
  const backend = makeFakeBackend({ id: "claude", async startTurn(req) {
    await req.bridge.inputSafety!.ready("claude", 1);
    req.bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: false });
    const result = await req.bridge.requestPermission({ toolUseId: "failed-terminal", toolName: "OdysseyTool", kind: "command", input: {} });
    decision = result.behavior; aborted = req.signal.aborted;
    if (result.behavior === "allow") await fetch(origin.url);
  } });
  const store = createActivityStore(f.db);
  const host = new WsHost({ brainPath: f.root, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => f.db),
    isPrincipalAuthorized: id => id === f.principal.id,
    safetyTrust: { revision: () => f.safety.read().trustRevision, subscribe: changed => f.safety.subscribe(changed) },
    activity: { store, stream: createActivityStream(store), governanceDb: f.db, governanceWrites: f.writes } });
  const frames: ServerMessage[] = [];
  const ws = { send(text: string) { const frame = JSON.parse(text) as ServerMessage; frames.push(frame); if (frame.type === "tool_approval_request") raised.resolve(); } };
  host.clients.add(ws, f.principal.id); host.clients.setCapabilities(ws, { toolResolution: true });
  try {
    run = runSession(host, { authorization: testAuthorization(f.principal.id), text: "Return to Ithaca", attachments: [], sessionId: "ithaca" });
    await raised.promise;
    f.db.exec("CREATE TRIGGER fail_terminal BEFORE INSERT ON governance_events WHEN NEW.kind='safety_admission_expired' BEGIN SELECT RAISE(FAIL,'injected terminal storage failure'); END");
    f.remove(); await run;
    expect(decision, "FAILED_WITHDRAWAL_STILL_SETTLES_BACKEND").toBe("deny");
    expect(aborted, "FAILED_WITHDRAWAL_STOPS_PROVIDER_CONTINUATION").toBe(true);
    expect(reached, "FAILED_WITHDRAWAL_CANNOT_DISPATCH").toBe(0);
    expect(host.coordinator.resolvedApprovals.get("failed-terminal")).toMatchObject({ outcome: "expired", reason: "Safety withdrawal could not be retained; the turn was stopped." });
    expect(frames.filter(frame => frame.type === "tool_resolution")).toHaveLength(1);
    expect(queryGovernanceEvents(f.db, { sessionId: "ithaca", kinds: ["safety_admission_expired"], limit: 100 })).toHaveLength(0);
  } finally {
    host.close(); await run; origin.stop(true); await f.close();
  }
});
