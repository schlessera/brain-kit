/**
 * Runtime assembly-order regression: the boot sweep must run AFTER the
 * notifier exists, so restart-interrupted turns become failure intents on the
 * first tick instead of dying below the notifier's change cursor.
 */
import { describe, expect, test } from "bun:test";
import type { Logger } from "@opentelemetry/api-logs";

import { createActivityStore } from "../src/activity/store";
import { createActivityRuntime } from "../src/activity/runtime";
import { createUiDb } from "../src/db/client";

const quietLog = { emit() {} } as unknown as Logger;

describe("activity runtime", () => {
  test("a turn orphaned by a restart produces a failure intent on the first tick", () => {
    const db = createUiDb(":memory:");
    // The previous life: a session turn left open by a dead process.
    const before = createActivityStore(db, { writer: "previous-life" });
    before.startSpan({
      spanId: "turn:root",
      runId: "turn-1",
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      sessionId: "sess-1",
    });

    // The new boot: runtime construction sweeps the orphan...
    const runtime = createActivityRuntime(db, { log: quietLog });
    try {
      expect(runtime.store.getSpan("turn:root")!.outcome).toBe("interrupted");

      // ...and the notifier's first tick NOTICES the sweep's terminal write.
      runtime.notifier.tick();
      const inbox = runtime.notifier.inbox();
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.kind).toBe("failure");
      expect(inbox[0]!.runId).toBe("turn-1");
      expect(inbox[0]!.title).toContain("interrupted");
    } finally {
      runtime.close();
    }
  });
});

test("an incomplete alias check retains its owner-visible cause across recovery and restart", async () => {
  const db = createUiDb(":memory:");
  const first = createActivityRuntime(db, { log: quietLog });
  const detail = "OperationalStateAliasVerificationUnavailable: fixture state I/O unavailable";
  try {
    first.runtime.recordGoverned({ hostExecution: "worker", available: false, reason: "private_state_unverified", detail });
    first.runtime.recordGoverned({ hostExecution: "worker", available: true });
    expect(first.runtime.snapshot().workerHost?.governed?.available, "RECOVERY_NEVER_REUSES_OLD_REFUSAL").toBe(true);
    await first.close();
    const second = createActivityRuntime(db, { log: quietLog });
    try {
      expect(second.runtime.snapshot().operationalStateLastFailure, "ALIAS_FAILURE_CAUSE_SURVIVES_RESTART").toMatchObject({ detail,
        at: expect.any(Number), errorClass: "OperationalStateAliasVerificationUnavailable", callSite: "operationalStateRefusal", scope: "brain_reads" });
    } finally { await second.close(); }
  } finally { await first.close(); db.close(); }
});
