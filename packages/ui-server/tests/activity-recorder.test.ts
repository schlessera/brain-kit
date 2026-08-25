/**
 * TurnRecorder terminal precedence: the buffered result frame refines the
 * host's disposition (a max_turns error result lands as timeout), while
 * host-owned facts (cancel/timeout) always win over the backend's outcome.
 */
import { describe, expect, test } from "bun:test";

import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";

function setup(
  turnId: string,
  extra: { profileId?: string; billingMode?: "subscription" | "api" } = {}
) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const recorder = createTurnRecorder(
    { store },
    { turnId, sessionId: "sess-1", ...extra }
  );
  return { db, store, recorder };
}

describe("turn recorder terminal precedence", () => {
  test("a max_turns error result refines finish('error') into a timeout outcome", () => {
    const { store, recorder } = setup("turn-mt");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "result",
      sessionId: "sess-1",
      outcome: "error",
      durationMs: 10,
      numTurns: 1,
      isError: true,
      outcomeDetail: "max_turns",
    });
    recorder.finish("error");

    const root = store.getSpan("turn-mt:turn")!;
    expect(root.outcome).toBe("timeout");
    expect(root.attrs["outcome.detail"]).toBe("max_turns");
  });

  test("a host-owned cancellation beats a success result frame", () => {
    const { store, recorder } = setup("turn-cx");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "result",
      sessionId: "sess-1",
      outcome: "success",
      durationMs: 10,
      numTurns: 1,
      isError: false,
    });
    recorder.finish("cancelled");

    expect(store.getSpan("turn-cx:turn")!.outcome).toBe("cancelled");
  });
});

describe("root span profile and billing attrs", () => {
  test("the root span carries the resolved profile and billing mode when given", () => {
    const { store, recorder } = setup("turn-bill", {
      profileId: "claude",
      billingMode: "subscription",
    });
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.finish("success");

    const root = store.getSpan("turn-bill:turn")!;
    expect(root.attrs["brain.profile_id"]).toBe("claude");
    expect(root.attrs["brain.billing_mode"]).toBe("subscription");
  });

  test("without the options the root span carries no billing attrs", () => {
    const { store, recorder } = setup("turn-nobill");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.finish("success");

    const root = store.getSpan("turn-nobill:turn")!;
    expect("brain.profile_id" in root.attrs).toBe(false);
    expect("brain.billing_mode" in root.attrs).toBe(false);
  });
});
