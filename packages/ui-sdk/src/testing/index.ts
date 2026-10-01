/**
 * Published AgentBackend contract suite. The SAME assertions run against all
 * backends. This is the executable form of the startTurn contract documented
 * in ../server/backend.ts:
 *
 *   1. capabilities is a complete, honest boolean set
 *   2. listProfiles() yields safe ProviderInfo shapes
 *   3. an ordinary turn emits session_info before content, streams deltas, and ends
 *      with a terminal `result` frame (outcome: success) before the promise
 *      resolves
 *   4. host abort → diagnostic `status: cancelled`, then the unified terminal
 *      `result` frame with outcome: cancelled; the promise RESOLVES
 *   5. busy-ness is PER SESSION (rev 2): resuming a running session rejects
 *      with BackendBusyError; a second NEW session runs in parallel when
 *      capabilities.concurrentSessions; the backend recovers after drains
 *   6. an unknown profileId rejects with BackendRequestError and emits nothing
 *
 * Backends run against caller-supplied fake runtimes — no live models. Test
 * registration and assertion primitives are injected so this module remains
 * importable by plain Node consumers without depending on a test runner.
 */

import type { ProviderInfo, ServerMessage } from "../protocol.js";
import type { AgentBackend, BackendActivityEvent, BackendBridge, PermissionRequest, StartTurnRequest } from "../server/backend.js";
import { BackendBusyError, BackendRequestError } from "../server/backend.js";
import { defineBackendModule, type BackendModule, type BackendModuleContext } from "../server/backend-module.js";

interface ContractMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatch(expected: RegExp): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeDefined(): void;
  toHaveLength(expected: number): void;
  toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
  readonly not: Pick<ContractMatchers, "toBe" | "toMatch">;
  readonly rejects: Pick<ContractMatchers, "toBeInstanceOf">;
}

/** The minimal test-runner surface used by the backend contract assertions. */
export interface ContractTestPrimitives {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>): void;
  expect(actual: unknown): ContractMatchers;
}

export interface TurnScript {
  sessionId: string;
  textDeltas: string[];
}

/** Calls outside the configured allowlist, and an allowlisted confirmation. */
export type PermissionScenario = "mutation" | "shortcut" | "command";

/** Observations from a scripted runtime's actual tool execution path. */
export interface PermissionProbe {
  backend: AgentBackend;
  toolName: string;
  toolUseId: string;
  /** Count runtime acquisition, even if no tool was attempted. */
  starts(): number;
  attempts(): number;
  /** Observe the tool body's effect; do not infer it from permission frames. */
  effects(): number;
}

export interface BackendContractHarness {
  name: string;
  /**
   * A runtime that attempts one tool through the adapter's real gate. Mutation
   * and shortcut are off-list; shortcut models runtime auto-approval. Command
   * is allowlisted but matches the backend's confirmation policy. An allowing
   * host must produce an observable tool-body effect in all three scenarios.
   */
  permission(scenario: PermissionScenario): PermissionProbe;
  /** Backend whose next turn plays the script and completes. */
  scripted(script: TurnScript): AgentBackend;
  /** Backend whose turn hangs until the host aborts. */
  hanging(): AgentBackend;
  /** Backend whose turn fails at runtime AFTER the session identity exists. */
  failing(script: TurnScript): AgentBackend;
  /** Backend whose stream ends WITHOUT a terminal result (claude-only shape). */
  truncated?(script: TurnScript): AgentBackend;
  /**
   * Backend whose runtime reports the model call rejected with HTTP 400,
   * worded as that runtime words it and containing {@link API_FAILURE_DETAIL}
   * (#575). The runtime's own failure path, not a thrown error.
   */
  apiFailure?(script: TurnScript): AgentBackend;
  /**
   * Backend whose runtime retries one failed call (HTTP 429, `rate_limit`)
   * and then plays the script to success (#575).
   */
  retrying?(script: TurnScript): AgentBackend;
  /** Runtime reports retries 1 and 2, then an HTTP 429 terminal provider failure. */
  retriedFailure?(script: TurnScript): AgentBackend;
  /** A profileId guaranteed to be unknown to the backend. */
  unknownProfileId: string;
}

export interface BackendModuleContractHarness {
  name: string;
  module: BackendModule;
  /** A nonempty valid roster, including backend-specific required fields. */
  validProfilesJson: string;
  /** Ids of that roster that must survive parsing and resolution. */
  profileIds: readonly string[];
  /** Isolated, keyless construction context; no live turn is started. */
  context(): Omit<BackendModuleContext, "profiles">;
}

/** Register profile parsing and descriptor resolution conformance. */
export function runBackendModuleContract(
  harness: BackendModuleContractHarness,
  { describe, test, expect }: ContractTestPrimitives
): void {
  describe(`BackendModule contract: ${harness.name}`, () => {
    test("a valid nonempty profile roster survives parsing and resolution", async () => {
      const module = defineBackendModule(harness.module);
      const parsed = module.profileSchema.parse(harness.validProfilesJson, { occupiedProfiles: [] });
      expect(harness.profileIds.length).toBeGreaterThan(0);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      for (const id of harness.profileIds) expect(parsed.profiles.some((p) => p.id === id)).toBe(true);
      for (const confirmBashPatterns of [null, []] as const) {
        const resolved = await module.resolveFromEnv({ ...harness.context(), profiles: parsed.profiles, confirmBashPatterns });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) continue;
        expect(resolved.value.backend.id).toBe(module.id);
        const profiles = await resolved.value.backend.listProfiles();
        for (const id of harness.profileIds) expect(profiles.some((p) => p.id === id)).toBe(true);
      }
    });

    test("invalid JSON returns a typed profile failure", () => {
      const parsed = harness.module.profileSchema.parse("{", { occupiedProfiles: [] });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors.some((e) => e.code === "invalid_json")).toBe(true);
    });

    test("a profile occupied by another descriptor is rejected", () => {
      expect(harness.profileIds.length).toBeGreaterThan(0);
      const parsed = harness.module.profileSchema.parse(harness.validProfilesJson, {
        occupiedProfiles: [{ id: harness.profileIds[0]!, source: "example-roster" }],
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors.some((e) => e.code === "duplicate_id")).toBe(true);
    });
  });
}

/** What a harness's `apiFailure` runtime says went wrong, in its own wording. */
export const API_FAILURE_DETAIL = "model not supported by this runtime";

function makeBridge(): { frames: ServerMessage[]; bridge: BackendBridge } {
  const frames: ServerMessage[] = [];
  return {
    frames,
    bridge: {
      emit: (m) => frames.push(m),
      requestPermission: async () => ({ behavior: "allow" }),
    },
  };
}

/** Poll until `cond` is true (or fail after ~2s). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

function sessionIdOf(frames: ServerMessage[]): string {
  const info = frames.find((f) => f.type === "session_info");
  if (!info || info.type !== "session_info") throw new Error("no session_info frame");
  return info.sessionId;
}

/** Register the complete startTurn contract suite for one backend harness. */
export function runBackendContract(
  harness: BackendContractHarness,
  primitives: ContractTestPrimitives
): void {
  const { describe, expect, test } = primitives;

  describe(`AgentBackend contract: ${harness.name}`, () => {
    async function permissionTurn(
      scenario: PermissionScenario,
      posture: Pick<StartTurnRequest, "enforceAllowedTools" | "noGrantSurface">,
      allow: boolean,
      unanswered = false
    ) {
      const probe = harness.permission(scenario);
      const { frames, bridge } = makeBridge();
      const requests: PermissionRequest[] = [];
      const controller = new AbortController();
      let releaseCard: (() => void) | undefined;
      bridge.requestPermission = async (request) => {
        requests.push(request);
        if (unanswered) await new Promise<void>((resolve) => { releaseCard = resolve; });
        return allow ? { behavior: "allow" } : { behavior: "deny", message: "Contract denial: keep the fixture unchanged." };
      };
      const deniedActivity: Extract<BackendActivityEvent, { kind: "permission_denied" }>[] = [];
      bridge.activity = (event) => { if (event.kind === "permission_denied") deniedActivity.push(event); };
      let rejected: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const turn = probe.backend.startTurn({ prompt: "exercise the tool", signal: controller.signal, bridge, ...posture })
        .catch((error: unknown) => { rejected = error; });
      try {
        await Promise.race([
          turn,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("restricted tool turn parked instead of settling promptly")), 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
        releaseCard?.();
      }
      // A backend may reject unsupported restrictions, but only BEFORE runtime
      // acquisition, frames, permission requests or effects. A failed runtime
      // after acquisition is not safe rejection.
      if (rejected !== undefined) {
        expect(rejected).toBeInstanceOf(BackendRequestError);
        expect(posture.enforceAllowedTools === true || posture.noGrantSurface === true).toBe(true);
        expect(probe.effects()).toBe(0);
        expect(probe.starts()).toBe(0);
        expect(probe.attempts()).toBe(0);
        expect(requests).toHaveLength(0);
        expect(frames).toHaveLength(0);
      }
      return { probe, frames, requests, deniedActivity, rejected };
    }

    test("permissions: a denied mutation does not execute and returns the denial", async () => {
      if (!harness.permission("mutation").backend.capabilities.permissions) return;
      const denied = await permissionTurn("mutation", {}, false);
      expect(denied.probe.effects()).toBe(0);
      expect(denied.probe.attempts()).toBe(1);
      expect(denied.requests).toHaveLength(1);
      expect(denied.frames.some((f) => f.type === "tool_result" && f.toolUseId === denied.probe.toolUseId && f.isError && f.output.includes("Contract denial"))).toBe(true);
      const allowed = await permissionTurn("mutation", {}, true);
      expect(allowed.probe.attempts()).toBe(1);
      expect(allowed.probe.effects()).toBe(1);
    });

    for (const scenario of ["mutation", "shortcut", "command"] as const) {
      test(`enforceAllowedTools: ${scenario} cannot bypass a denied decision`, async () => {
        const turn = await permissionTurn(scenario, { enforceAllowedTools: true }, false);
        if (turn.rejected !== undefined) return;
        expect(turn.probe.effects()).toBe(0);
        expect(turn.probe.attempts()).toBe(1);
        expect(turn.requests).toHaveLength(1);
        expect(turn.requests[0]!.toolName).toBe(turn.probe.toolName);
        expect(turn.requests[0]!.toolUseId).toBe(turn.probe.toolUseId);
        if (scenario === "command") expect(turn.requests[0]!.kind).toBe("command");
        else expect(turn.requests[0]!.outsideEnforcedAllowlist).toBe(true);
        expect(turn.frames.some((f) => f.type === "tool_result" && f.toolUseId === turn.probe.toolUseId && f.isError && f.output.includes("Contract denial"))).toBe(true);
      });

      test(`enforceAllowedTools: an approved ${scenario} reaches the tool body`, async () => {
        const turn = await permissionTurn(scenario, { enforceAllowedTools: true }, true);
        if (turn.rejected !== undefined) return;
        expect(turn.probe.attempts()).toBe(1);
        expect(turn.probe.effects()).toBe(1);
        expect(turn.requests).toHaveLength(1);
      });

      test(`noGrantSurface: ${scenario} denies promptly without an unanswered card`, async () => {
        const turn = await permissionTurn(scenario, { enforceAllowedTools: true, noGrantSurface: true }, false, true);
        if (turn.rejected !== undefined) return;
        expect(turn.probe.effects()).toBe(0);
        expect(turn.probe.attempts()).toBe(1);
        expect(turn.requests).toHaveLength(0);
        expect(turn.deniedActivity).toHaveLength(1);
        expect(turn.deniedActivity[0]!.toolUseId).toBe(turn.probe.toolUseId);
        expect(turn.deniedActivity[0]!.requestKind).toBe(scenario === "command" ? "command" : "tool");
        expect(turn.frames.some((f) => f.type === "tool_result" && f.toolUseId === turn.probe.toolUseId && f.isError && f.output.includes(turn.probe.toolName))).toBe(true);
      });
    }

    for (const enforceAllowedTools of [undefined, false]) {
      test(`noGrantSurface without enforcement (${String(enforceAllowedTools)}) rejects before runtime acquisition`, async () => {
        const turn = await permissionTurn("mutation", { noGrantSurface: true, enforceAllowedTools }, false);
        expect(turn.rejected).toBeInstanceOf(BackendRequestError);
      });
    }

    test("capabilities is a complete boolean set", () => {
      const backend = harness.scripted({ sessionId: "s", textDeltas: [] });
      const keys = [
        "resume",
        "permissions",
        "thinking",
        "attachments",
        "askUser",
        "costReporting",
        "concurrentSessions",
        "followUp",
      ] as const;
      for (const key of keys) {
        expect(typeof backend.capabilities[key]).toBe("boolean");
      }
      const optional = Object.hasOwn(backend.capabilities, "autonomous") ? ["autonomous"] : [];
      if (optional.length) expect(typeof backend.capabilities.autonomous).toBe("boolean");
      expect(Object.keys(backend.capabilities).sort()).toEqual([...keys, ...optional].sort());
      expect(backend.id.length).toBeGreaterThan(0);
    });

    test("listProfiles yields safe ProviderInfo shapes", async () => {
      const backend = harness.scripted({ sessionId: "s", textDeltas: [] });
      const profiles: ProviderInfo[] = await backend.listProfiles();
      expect(Array.isArray(profiles)).toBe(true);
      for (const p of profiles) {
        expect(typeof p.id).toBe("string");
        expect(typeof p.label).toBe("string");
        // Never leak key material through profile listings.
        expect(JSON.stringify(p).toLowerCase()).not.toMatch(/api[_-]?key|token|secret/);
      }
    });

    test("an explicit autonomous request honors its lifecycle or rejects safely", async () => {
      const backend = harness.scripted({ sessionId: "autonomous-1", textDeltas: ["fixture"] });
      const { frames, bridge } = makeBridge();
      const events: BackendActivityEvent[] = [];
      bridge.activity = (event) => events.push(event);
      bridge.checkpointPermission = () => {};
      const request: StartTurnRequest = {
        prompt: "fixture", signal: new AbortController().signal, bridge,
        enforceAllowedTools: true, noGrantSurface: true,
        autonomous: { origin: "autonomous", persistence: "none", allowedTools: [], systemPromptAppend: "" },
      };
      if (backend.capabilities.autonomous !== true) {
        await expect(backend.startTurn(request)).rejects.toBeInstanceOf(BackendRequestError);
        expect(frames).toEqual([]);
        expect(events).toEqual([]);
        return;
      }
      await backend.startTurn(request);
      expect(frames.some((frame) => frame.type === "session_info")).toBe(false);
      expect(events.some((event) => event.kind === "autonomous_identity" && event.runtimeSessionId === "autonomous-1")).toBe(true);
      expect(frames.filter((frame) => frame.type === "text_delta").map((frame) => frame.text)).toEqual(["fixture"]);
      const results = frames.filter((frame) => frame.type === "result");
      expect(results).toHaveLength(1);
      expect(frames.at(-1)).toBe(results[0]);
      expect(results[0].outcome).toBe("success");
    });

    test("turn lifecycle: session_info first, deltas, terminal result, then resolve", async () => {
      const backend = harness.scripted({ sessionId: "sess-42", textDeltas: ["a", "b"] });
      const { frames, bridge } = makeBridge();

      await backend.startTurn({
        prompt: "hello",
        signal: new AbortController().signal,
        bridge,
      });

      const types = frames.map((f) => f.type);
      const infoIdx = types.indexOf("session_info");
      const firstText = types.indexOf("text_delta");
      expect(infoIdx).toBeGreaterThanOrEqual(0);
      expect(firstText).toBeGreaterThan(infoIdx);

      const texts = frames.filter((f) => f.type === "text_delta").map((f) => f.text);
      expect(texts).toEqual(["a", "b"]);

      const result = frames.filter((f) => f.type === "result").at(-1);
      expect(result).toBeDefined();
      if (result?.type === "result") {
        expect(result.sessionId).toBe("sess-42");
        expect(result.outcome).toBe("success");
        expect(typeof result.costUsd).toBe("number");
        expect(result.costUsd).toBeGreaterThanOrEqual(0);
        expect(result.isError).toBe(false);
      }
      // The terminal frame must exist by the time the promise resolved —
      // asserted implicitly: frames were captured before this line ran.
    });

    test("host abort → status:cancelled diagnostic, then terminal result outcome:cancelled", async () => {
      const backend = harness.hanging();
      const { frames, bridge } = makeBridge();
      const controller = new AbortController();

      const turn = backend.startTurn({ prompt: "hi", signal: controller.signal, bridge });
      // Give the backend a beat to enter the hanging runtime, then cancel.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await turn; // must RESOLVE, not reject

      const cancelled = frames.filter(
        (f) => f.type === "status" && f.status === "cancelled"
      );
      expect(cancelled.length).toBeGreaterThanOrEqual(1);

      // Both harnesses emit a session identity before hanging — the abort
      // path must therefore ALWAYS end on the unified terminal result.
      expect(frames.some((f) => f.type === "session_info")).toBe(true);
      const results = frames.filter((f) => f.type === "result");
      expect(results.length).toBe(1); // exactly one terminal frame
      const last = frames.at(-1);
      expect(last?.type).toBe("result");
      if (last?.type === "result") {
        expect(last.outcome).toBe("cancelled");
        expect(last.isError).toBe(false);
      }
    });

    test("a pre-aborted signal terminates promptly instead of hanging", async () => {
      const backend = harness.hanging();
      const { frames, bridge } = makeBridge();
      const controller = new AbortController();
      controller.abort(); // already aborted BEFORE startTurn

      await Promise.race([
        backend.startTurn({ prompt: "hi", signal: controller.signal, bridge }),
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error("startTurn hung on a pre-aborted signal")), 3_000)
        ),
      ]);

      // Terminal frame either way: a result when an identity existed, else a
      // bare error. Never zero frames, never a hang.
      const last = frames.at(-1);
      expect(last === undefined ? "none" : last.type).toMatch(/result|error/);
    });

    test("runtime failure → diagnostic error, then EXACTLY ONE terminal result outcome:error, last", async () => {
      const backend = harness.failing({ sessionId: "fail-1", textDeltas: [] });
      const { frames, bridge } = makeBridge();

      await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

      expect(frames.some((f) => f.type === "error")).toBe(true);
      const results = frames.filter((f) => f.type === "result");
      expect(results.length).toBe(1);
      const last = frames.at(-1);
      expect(last?.type).toBe("result");
      if (last?.type === "result") {
        expect(last.outcome).toBe("error");
        expect(last.isError).toBe(true);
      }
    });

    test("exactly one result frame on success, and outcome agrees with isError", async () => {
      const backend = harness.scripted({ sessionId: "one-1", textDeltas: ["x"] });
      const { frames, bridge } = makeBridge();
      await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

      const results = frames.filter((f) => f.type === "result");
      expect(results.length).toBe(1);
      const r = results[0]!;
      if (r.type === "result") {
        expect(r.outcome).toBe("success");
        expect(r.isError).toBe(false);
      }
      expect(frames.at(-1)?.type).toBe("result");
    });

    if (harness.truncated) {
      test("stream that ends without a result still gets a terminal result", async () => {
        const backend = harness.truncated!({ sessionId: "trunc-1", textDeltas: ["a"] });
        const { frames, bridge } = makeBridge();
        await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

        const results = frames.filter((f) => f.type === "result");
        expect(results.length).toBe(1);
        const last = frames.at(-1);
        expect(last?.type).toBe("result");
        if (last?.type === "result") {
          expect(last.outcome).toBe("error");
          expect(last.isError).toBe(true);
        }
      });
    }

    if (harness.apiFailure) {
      test("a provider failure → one terminal result outcome:error carrying the failure, once", async () => {
        const backend = harness.apiFailure!({ sessionId: "api-fail-1", textDeltas: [] });
        const { frames, bridge } = makeBridge();
        await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

        const results = frames.filter((f) => f.type === "result");
        expect(results.length).toBe(1);
        const last = frames.at(-1);
        expect(last?.type).toBe("result");
        if (last?.type !== "result") return;
        expect(last.outcome).toBe("error");
        expect(last.isError).toBe(true);
        // Both backends name it alike: the class a 400 means, the status,
        // and the runtime's own text.
        expect(last.failure?.errorClass).toBe("invalid_request");
        expect(last.failure?.status).toBe(400);
        expect(last.failure?.message ?? "").toMatch(new RegExp(API_FAILURE_DETAIL));
        // One failure, reported once: nothing else in the turn carries it.
        expect(frames.filter((f) => (f as { failure?: unknown }).failure !== undefined)).toHaveLength(1);
      });
    }

    if (harness.retriedFailure) {
      test("exhausted retries → the terminal failure retains two observed attempts", async () => {
        const backend = harness.retriedFailure!({ sessionId: "retry-fail-1", textDeltas: [] });
        const { frames, bridge } = makeBridge();
        await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });
        const retries = frames.filter((frame) => frame.type === "status" && frame.retry);
        expect(retries.map((frame) => frame.type === "status" && frame.retry?.attempt)).toEqual([1, 2]);
        const last = frames.at(-1);
        expect(last?.type).toBe("result");
        if (last?.type !== "result") return;
        expect(last.failure?.attempts).toBe(2);
        expect(last.outcome).toBe("error");
        expect(last.failure?.errorClass).toBe("rate_limit");
        expect(last.failure?.status).toBe(429);
        expect(frames.filter((frame) => frame.type === "result")).toHaveLength(1);
      });
    }

    if (harness.retrying) {
      test("a retried call → a status:thinking frame carrying the retry, then success", async () => {
        const backend = harness.retrying!({ sessionId: "retry-1", textDeltas: ["ok"] });
        const { frames, bridge } = makeBridge();
        await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

        const retry = frames.find((f) => f.type === "status" && f.retry !== undefined);
        expect(retry?.type).toBe("status");
        if (retry?.type !== "status" || !retry.retry) return;
        expect(retry.status).toBe("thinking");
        expect(retry.retry.attempt).toBe(1);
        expect(retry.retry.status).toBe(429);
        expect(retry.retry.errorClass).toBe("rate_limit");
        expect(retry.detail ?? "").toMatch(/^Retrying \(attempt 1/);
        const last = frames.at(-1);
        expect(last?.type).toBe("result");
        if (last?.type !== "result") return;
        expect(last.outcome).toBe("success");
        expect(last.failure === undefined).toBe(true);
      });
    }

    test("busy-ness is per session; parallel sessions per capability; recovers", async () => {
      const backend = harness.hanging();
      const first = makeBridge();
      const c1 = new AbortController();
      const turn1 = backend.startTurn({ prompt: "1", signal: c1.signal, bridge: first.bridge });
      await waitFor(() => first.frames.some((f) => f.type === "session_info"));
      const sid = sessionIdOf(first.frames);

      // Resuming a session whose turn is RUNNING is the busy condition (rev 2).
      const resumer = makeBridge();
      await expect(
        backend.startTurn({
          prompt: "2",
          sessionId: sid,
          signal: new AbortController().signal,
          bridge: resumer.bridge,
        })
      ).rejects.toBeInstanceOf(BackendBusyError);
      expect(resumer.frames).toHaveLength(0);

      if (backend.capabilities.concurrentSessions) {
        // A second NEW session runs in parallel with the first.
        const second = makeBridge();
        const c2 = new AbortController();
        const turn2 = backend.startTurn({
          prompt: "3",
          signal: c2.signal,
          bridge: second.bridge,
        });
        await waitFor(() => second.frames.some((f) => f.type === "session_info"));
        expect(sessionIdOf(second.frames)).not.toBe(sid);
        c2.abort();
        await turn2;
      }

      c1.abort();
      await turn1;

      // Recovery: the drained session accepts a new (hanging) turn again.
      const again = makeBridge();
      const c3 = new AbortController();
      const turn3 = backend.startTurn({
        prompt: "4",
        sessionId: sid,
        signal: c3.signal,
        bridge: again.bridge,
      });
      await waitFor(() => again.frames.some((f) => f.type === "session_info"));
      c3.abort();
      await turn3;
    });

    test("multi-session backends scope frames with sessionId", async () => {
      const backend = harness.scripted({ sessionId: "scope-1", textDeltas: ["x"] });
      if (!backend.capabilities.concurrentSessions) return;
      const { frames, bridge } = makeBridge();
      await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

      const info = frames.findIndex((f) => f.type === "session_info");
      for (const frame of frames.slice(info + 1)) {
        expect("sessionId" in frame ? frame.sessionId : undefined).toBe("scope-1");
      }
    });

    test("unknown profileId rejects BackendRequestError, emits nothing", async () => {
      const backend = harness.scripted({ sessionId: "s", textDeltas: [] });
      const { frames, bridge } = makeBridge();
      await expect(
        backend.startTurn({
          prompt: "hi",
          profileId: harness.unknownProfileId,
          signal: new AbortController().signal,
          bridge,
        })
      ).rejects.toBeInstanceOf(BackendRequestError);
      expect(frames).toHaveLength(0);
    });
  });
}
