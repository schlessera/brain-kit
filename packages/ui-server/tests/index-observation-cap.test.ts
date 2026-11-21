import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createTurnScope, INDEX_OBSERVATION_CAP_BYTES } from "../src/brain/turn-scope.js";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { TurnJournal } from "../src/brain/turn-journal.js";
import { previousScopeSummarySchema } from "./helpers/activity-schema-0-44.js";
import { turnScopeSummarySchema } from "@schlessera/brain-ui-sdk/schemas";

test("live index size pauses independently of retained bytes, with one finite index grant", async () => {
  const db = createUiDb(":memory:");
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  let observe!: Parameters<TurnJournal["onObservation"]>[0];
  let held!: NonNullable<Parameters<TurnJournal["onObservation"]>[1]>;
  const journal = { onObservation(callback: typeof observe, control: typeof held) { observe = callback; held = control; return () => true; } } as TurnJournal;
  const scope = createTurnScope(db, { brainPath: "/odysseus", journal, connected: () => true, changed() {}, space: () => ({ total: 100 * 1024 ** 3, free: 50 * 1024 ** 3 }) });
  const state = { frozen: false, resumes: 0, killed: false };
  const worker = { exited: new Promise(() => {}), freeze() { state.frozen = true; }, resume() { state.frozen = false; state.resumes++; }, kill() { state.killed = true; } };
  const facts = (indexBytes: number | null) => {
    held.before(); observe("voyage", { changedPaths: 0, observedBytes: 0, workspacePaths: 0, partial: false, indexBytes }); held.after(true);
  };
  const saved = () => JSON.parse((db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string }).summary);
  try {
    await scope.begin("voyage", { sessionId: "ithaca", principalId: "athena", origin: "interactive", profile: "governed", policy: resolveGovernancePolicy({ schema_version: 1 }), source: "default", hardTimeoutMs: 3600000, current: () => true, stop() {} });
    scope.workerStarted("voyage", worker as never);
    facts(INDEX_OBSERVATION_CAP_BYTES - 1); expect(scope.isPaused("voyage"), "INDEX_UNDER_CAP_CONTINUES").toBe(false); expect(state.frozen).toBe(false);
    facts(INDEX_OBSERVATION_CAP_BYTES); expect(scope.isPaused("voyage"), "INDEX_EXACT_BOUND_FITS").toBe(false);
    facts(INDEX_OBSERVATION_CAP_BYTES + 1);
    expect(scope.isPaused("voyage"), "INDEX_OVER_CAP_PAUSES").toBe(true); expect(state.frozen, "INDEX_CAP_REMAINS_HELD").toBe(true);
    let summary = saved();
    expect(summary.observedBytes, "INDEX_NEVER_CHARGED_AS_RETAINED_TURN_BYTES").toBe(0);
    expect(summary.receipts, "INDEX_CAP_HAS_NAMED_RESULT").toMatchObject([{ dimension: "turn_bytes", result: "index_capacity", count: INDEX_OBSERVATION_CAP_BYTES + 1, cap: INDEX_OBSERVATION_CAP_BYTES, state: "paused", newCap: 2 * INDEX_OBSERVATION_CAP_BYTES }]);
    expect(previousScopeSummarySchema.safeParse(summary).success, "PREVIOUS_SCOPE_PARSER_ACCEPTS_INDEX_CAP").toBe(true);
    expect(turnScopeSummarySchema.safeParse(summary).success).toBe(true);
    const unknownDimension = structuredClone(summary); unknownDimension.receipts[0].dimension = "index_bytes";
    expect(previousScopeSummarySchema.safeParse(unknownDimension).success, "CLOSED_DIMENSION_NEGATIVE_CONTROL").toBe(false);
    facts(null); expect(saved().receipts[0].newCap, "UNKNOWN_INDEX_SIZE_WITHHOLDS_CONTINUATION").toBeUndefined();
    facts(INDEX_OBSERVATION_CAP_BYTES + 1);
    const receipt = summary.receipts[0];
    const answer = await scope.decide({ type: "scope_decision", sessionId: "ithaca", turnId: "voyage", eventId: receipt.eventId, submissionId: "athena", action: "continue" }, true);
    expect(answer.state).toBe("accepted"); expect(state.frozen).toBe(false);
    summary = saved(); expect(summary.indexLimitBytes).toBe(2 * INDEX_OBSERVATION_CAP_BYTES);
    expect(summary.limits.turn_bytes, "INDEX_GRANT_DOES_NOT_RAISE_CONTENT_ALLOWANCE").toBe(INDEX_OBSERVATION_CAP_BYTES);
    facts(2 * INDEX_OBSERVATION_CAP_BYTES + 1); expect(scope.isPaused("voyage")).toBe(true);
    expect(saved().receipts.at(-1).newCap, "INDEX_SECOND_HIT_HAS_NO_MORE_GRANT").toBeUndefined();
    await scope.finish("voyage");
  } finally { scope.close(); db.close(); }
});
