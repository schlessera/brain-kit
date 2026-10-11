/**
 * A worker's resource-limit hit (#1660) is kept twice: as a span event on
 * the run, and as a `resource_limit` governance event (#1651) that outlives
 * span detail. A refused governance record never breaks the turn.
 */
import { expect, test } from "bun:test";

import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";

const HIT = { limit: "pids" as const, source: "cgroup" as const, value: 4096, events: 2 };

function setup(posture?: "voice", origin?: "autonomous") {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "resource-limit-test" });
  const recorder = createTurnRecorder({ store, governance: (input) => { recordGovernanceEvent(db, input); } },
    { turnId: "turn-ithaca", sessionId: null, ...(posture ? { posture } : {}), ...(origin ? { origin } : {}) });
  return { db, store, recorder };
}

test("a hit is a span event and a resource_limit governance event, attributed to the turn", () => {
  const { db, store, recorder } = setup();
  recorder.observeActivity({ kind: "resource_limit", limits: [HIT], fatal: false });
  recorder.observeActivity({ kind: "resource_limit", limits: [{ ...HIT, limit: "memory", value: 2 ** 31, events: 1 }], fatal: true });
  const events = queryGovernanceEvents(db, { turnId: "turn-ithaca", kinds: ["resource_limit"], limit: 10 });
  expect(events.map(e => ({ actor: e.actor, profile: e.profile, payload: e.payload }))).toEqual([
    { actor: "interactive", profile: null, payload: { limits: [HIT], fatal: false } },
    { actor: "interactive", profile: null, payload: { limits: [{ ...HIT, limit: "memory", value: 2 ** 31, events: 1 }], fatal: true } },
  ]);
  const root = store.getSpan("turn-ithaca:turn");
  expect(root?.attrs?.["brain.failure_class"]).toBe("worker_resource_limit");
});

test("voice and autonomous turns are attributed as such", () => {
  for (const [posture, origin, actor, profile] of [["voice", undefined, "voice", null], [undefined, "autonomous", "autonomous", "restricted"]] as const) {
    const { db, recorder } = setup(posture, origin);
    recorder.observeActivity({ kind: "resource_limit", limits: [HIT], fatal: false });
    expect(queryGovernanceEvents(db, { kinds: ["resource_limit"], limit: 10 }).map(e => [e.actor, e.profile])).toEqual([[actor, profile]]);
  }
});

test("a governance writer that refuses the record does not break the turn", () => {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "resource-limit-test" });
  const recorder = createTurnRecorder({ store, governance: () => { throw new Error("Invalid resource_limit payload"); } },
    { turnId: "turn-aeolus", sessionId: null });
  expect(() => recorder.observeActivity({ kind: "resource_limit", limits: [HIT], fatal: false })).not.toThrow();
  expect(store.getSpan("turn-aeolus:turn")).toBeTruthy();
});
