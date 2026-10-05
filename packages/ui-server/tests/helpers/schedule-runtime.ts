/**
 * The real Queue runtime, budget, autonomous-turn plumbing and schedule
 * admission over one operational database, with a scripted backend and a
 * fake clock. Shared by the in-process tests and the crash workers.
 */
import type { Database } from "bun:sqlite";
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

import { createActivityStore } from "../../src/activity/store.js";
import { createInboxRuntime } from "../../src/inbox/runtime.js";
import { createScheduleAdmission, type AdmissionTimers } from "../../src/schedules/admission.js";
import { createScheduleService } from "../../src/schedules/service.js";
import { POLICY } from "./schedule-fixture.js";

export type Script = (request: StartTurnRequest, attempt: number) => Promise<void>;

/** Report a successful terminal result with some text, as a backend would. */
export function succeed(text: string): Script {
  return async (request) => {
    request.bridge.activity?.({ kind: "autonomous_identity", runtimeSessionId: "ephemeral", backendId: "fixture" });
    request.bridge.emit({ type: "text_delta", text });
    request.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  };
}

export function scriptedBackend(script: Script) {
  const calls: StartTurnRequest[] = [];
  const backend: AgentBackend = {
    id: POLICY.backendId,
    capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false,
      askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
    startTurn: async (request) => { calls.push(request); await script(request, calls.length); },
  };
  return { backend, calls };
}

/** Deadline timers the test fires by hand. */
export function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: AdmissionTimers = {
    setTimeout: (callback) => { const id = ++next; pending.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (timer) => { pending.delete(timer as unknown as number); },
  };
  return { timers, pending, fireAll: () => { for (const [id, callback] of [...pending]) { pending.delete(id); callback(); } } };
}

const log = { emit() {}, enabled: () => false };

export function scheduleRuntime(db: Database, options: {
  root: string;
  clock: { now: number };
  script: Script;
  timers?: AdmissionTimers;
  allowedTools?: () => string[];
  afterClaim?: () => unknown;
}) {
  const now = () => options.clock.now;
  const service = createScheduleService(db, { brainRoot: options.root, now, executionPolicy: () => POLICY,
    gitIgnored: () => false, dispatchAvailable: () => true });
  const { backend, calls } = scriptedBackend(options.script);
  const activity = createActivityStore(db, { writer: "schedule-runtime-test" });
  const admission = createScheduleAdmission(db, {
    service, backend, now, store: activity, timers: options.timers ?? manualTimers().timers,
    operation: () => ({ model: "fixture", billingMode: "subscription" }),
    allowedTools: options.allowedTools ?? ((definition) => definition.scope.tools.map((tool) => tool.name)),
  });
  const runtime = createInboxRuntime(db, {
    log, now,
    timers: { setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} },
    budget: { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 },
      pricing: { resolve: () => null } },
    operation: (item) => admission.operation(item),
    // The hook runs after the Queue claim committed and before the start transaction.
    dispatch: async (item, signal) => { await options.afterClaim?.(); return admission.dispatch(item, signal); },
  });
  return { service, admission, runtime, backend, calls, activity };
}
