import { mockWorkerHostForSdkStream } from "../../ui-backend-claude/tests/helpers/worker-host";
mockWorkerHostForSdkStream();
/**
 * The runtime a Claude turn ran on reaches the run record (#211): the real
 * Claude backend (on a scripted SDK stream) feeds the production recorder,
 * which writes a real activity store, and the run is read back from it.
 */

import { describe, expect, test } from "bun:test";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeBackend, MEASURED_RUNTIME } from "@schlessera/brain-backend-claude";

import { createTurnRecorder } from "../src/activity/recorder";
import { createRuntimeStatus } from "../src/activity/runtime-status";
import { createActivityStore, rowToRunRollup } from "../src/activity/store";
import { createUiDb } from "../src/db/client";

function scripted(init: Record<string, unknown>, account: AccountInfo, more: unknown[] = []): typeof query {
  return (() => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1", ...init };
      yield* more;
      yield { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
    return Object.assign(stream, { initializationResult: async () => ({ account }) });
  }) as unknown as typeof query;
}

async function recordTurn(runId: string, queryFn: typeof query) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const runtime = createRuntimeStatus(() => new Date("2026-09-23T12:00:00Z"));
  // A second run in the same store, so "the right run" is a real question.
  createTurnRecorder({ store, runtime }, { turnId: "other-run", sessionId: "sess-0" }).finish("success");
  const recorder = createTurnRecorder({ store, runtime }, { turnId: runId, sessionId: null });
  const backend = createClaudeBackend({ brainPath: "/brain", queryFn, log: () => {} });
  await backend.startTurn({
    prompt: "hi",
    signal: new AbortController().signal,
    bridge: {
      emit: (frame) => recorder.observeFrame(frame),
      activity: (event) => recorder.observeActivity(event),
      requestPermission: async () => ({ behavior: "allow" }),
    },
  });
  recorder.finish("success");
  const rollup = (id: string) =>
    rowToRunRollup(db.query("SELECT * FROM activity_run_rollups WHERE run_id = ?").get(id) as never);
  return { store, runtime, rollup };
}

describe("the run record", () => {
  test("carries the Claude Code version the turn's init reported and the SDK version the backend loaded", async () => {
    const { store, runtime, rollup } = await recordTurn(
      "run-a",
      scripted(
        { claude_code_version: "2.1.999", apiKeySource: "none" },
        { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }
      )
    );
    const root = store.getSpan("run-a:turn")!;
    // Opened with its session: the report arrives after session_info.
    expect(root.sessionId).toBe("sess-1");
    expect(rollup("run-a").sessionId).toBe("sess-1");
    expect(root.attrs["brain.runtime.version"]).toBe("2.1.999");
    expect(root.attrs["brain.sdk.version"]).toBe(MEASURED_RUNTIME.agentSdk);
    expect(root.attrs["brain.billing_observed"]).toBe("subscription");
    expect(root.attrs["brain.runtime.measured"]).toBe(false);
    expect(store.getSpan("other-run:turn")!.attrs["brain.runtime.version"]).toBeUndefined();
    expect(runtime.snapshot().lastObserved).toMatchObject({
      runId: "run-a",
      runtime: { version: "2.1.999" },
      billing: "subscription",
    });
  });

  test("records an auth failure as its own class, and /api/status's snapshot names the last one", async () => {
    const { store, runtime } = await recordTurn(
      "run-b",
      scripted({ claude_code_version: "2.1.999", apiKeySource: "none" }, {
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
        apiProvider: "firstParty",
      }, [
        {
          type: "assistant",
          parent_tool_use_id: null,
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Failed to authenticate." }] },
        },
      ])
    );
    expect(store.getSpan("run-b:turn")!.attrs["brain.failure_class"]).toBe("authentication_failed");
    // The SDK's result says success with is_error set; the run is a failure.
    expect(store.getSpan("run-b:turn")!.outcome).toBe("error");
    expect(runtime.snapshot().lastAuthFailure).toEqual({
      errorClass: "authentication_failed",
      message: "Failed to authenticate.",
      runId: "run-b",
      at: "2026-09-23T12:00:00.000Z",
      action: "relogin",
    });
  });

  for (const errorClass of ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error"]) {
    test(`a turn failing with ${errorClass} is recorded as that class and as a failed run`, async () => {
      const runId = `run-${errorClass}`;
      const { store, runtime } = await recordTurn(
        runId,
        scripted({ claude_code_version: "2.1.999", apiKeySource: "none" }, { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }, [
          {
            type: "assistant",
            parent_tool_use_id: null,
            error: errorClass,
            message: { content: [{ type: "text", text: "Refused." }] },
          },
        ])
      );
      expect(store.getSpan(`${runId}:turn`)!.attrs["brain.failure_class"]).toBe(errorClass);
      expect(store.getSpan(`${runId}:turn`)!.outcome).toBe("error");
      expect(runtime.snapshot().lastAuthFailure).toMatchObject({ errorClass, runId });
    });
  }

  test("a subagent's auth failure does not fail a parent turn that completed", async () => {
    const { store, runtime } = await recordTurn(
      "run-child",
      scripted({ claude_code_version: "2.1.999", apiKeySource: "none" }, { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }, [
        {
          type: "assistant",
          parent_tool_use_id: "toolu_task",
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Failed to authenticate." }] },
        },
      ])
    );
    const root = store.getSpan("run-child:turn")!;
    expect(root.outcome).toBe("success");
    expect(root.attrs["brain.failure_class"]).toBeUndefined();
    expect(runtime.snapshot().lastAuthFailure).toBeUndefined();
  });

  test("a stored subscription login is recorded with every credential field the CLI reported, and no identity", async () => {
    const { store } = await recordTurn(
      "run-stored",
      scripted({ claude_code_version: "2.1.999", apiKeySource: "none" }, {
        subscriptionType: "Claude Max",
        apiProvider: "firstParty",
        // Who the account is stays out of the activity record.
        email: "odysseus@example.com",
        organization: "Example Org",
      })
    );
    const root = store.getSpan("run-stored:turn")!;
    expect(root.attrs["brain.credential"]).toEqual({
      apiKeySource: "none",
      subscriptionType: "Claude Max",
      apiProvider: "firstParty",
    });
    expect(root.attrs["brain.billing_observed"]).toBe("subscription");
  });

  test("an API credential under a credential-free profile is flagged on the run", async () => {
    const { store } = await recordTurn(
      "run-c",
      scripted({ claude_code_version: "2.1.999", apiKeySource: "ANTHROPIC_API_KEY" }, {
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
        apiKeySource: "ANTHROPIC_API_KEY",
        apiProvider: "firstParty",
      })
    );
    const root = store.getSpan("run-c:turn")!;
    expect(root.attrs["brain.billing_observed"]).toBe("api");
    expect(root.attrs["brain.billing_policy"]).toBe("subscription");
    expect(String(root.attrs["brain.billing_policy_violation"])).toContain("API credential");
  });
});
