import { expect, test } from "bun:test";
import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";

test("real recorder persists first shell ingestion across turns, excludes denials and leaves safe sessions clean", () => {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const session = "odysseus-session";
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(session);
  const recorder = (turnId: string, origin?: "autonomous", sessionId = session) => createTurnRecorder({ store, governanceDb: db,
    governance: event => { recordGovernanceEvent(db, event); } }, { turnId, sessionId, origin, profile: "governed" });
  const call = (value: ReturnType<typeof recorder>, id: string, tool: string, command: string, denied = false, isError = false) => {
    value.observeFrame({ type: "tool_use_start", sessionId: session, toolUseId: id, toolName: tool });
    value.observeFrame({ type: "tool_use_complete", sessionId: session, toolUseId: id, toolName: tool, input: { command } });
    if (denied) value.onApprovalDecision(id, "deny", "command");
    value.observeFrame({ type: "tool_result", sessionId: session, toolUseId: id, output: "fictional result", isError });
  };
  const events = () => queryGovernanceEvents(db, { sessionId: session, kinds: ["taint"], limit: 100 });
  try {
    const first = recorder("odysseus-first");
    call(first, "list", "Bash", "ls -la");
    call(first, "search", "bash", "brain search Ithaca");
    call(first, "denied", "Bash", "curl https://example.org", true);
    expect(events()).toHaveLength(0);
    // A failed fetching call may still return untrusted partial output.
    call(first, "fetch", "Bash", "curl https://example.org", false, true);
    expect(events(), "G6_RECORDER_PERSISTS_COMMAND_INGESTION").toMatchObject([
      { turnId: "odysseus-first", payload: { source: "fetching_command", tool: "Bash", detail: null } },
    ]);
    first.finish("success");
    const second = recorder("odysseus-second");
    call(second, "opaque", "bash", "sh fetch.sh");
    expect(events(), "G6_RECORDER_RETAINS_FIRST_SESSION_SOURCE").toHaveLength(1);
    expect(events()[0]!.turnId).toBe("odysseus-first");
    second.finish("success");
    db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('telemachus-session', 'Voyage', 1, 1)").run();
    const autonomous = recorder("odysseus-autonomous", "autonomous", "telemachus-session");
    call(autonomous, "restricted", "Bash", "sh fetch.sh");
    autonomous.finish("success");
    expect(events()).toHaveLength(1);
    expect(queryGovernanceEvents(db, { sessionId: "telemachus-session", kinds: ["taint"], limit: 100 })).toHaveLength(0);
  } finally { db.close(); }
});

test.each([
  ["Claude interactive", "Bash", undefined],
  ["Claude voice", "Bash", "voice"],
  ["Pi interactive", "bash", undefined],
] as const)("%s records opaque ingestion only after an admitted result", (_label, tool, posture) => {
  const db = createUiDb(":memory:");
  const sessionId = "odysseus-opaque-session";
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(sessionId);
  const recorder = createTurnRecorder({
    store: createActivityStore(db, { writer: "test" }),
    governanceDb: db,
    governance: event => { recordGovernanceEvent(db, event); },
  }, { turnId: "odysseus-opaque", sessionId, posture, profile: "governed" });
  recorder.setMainModel("fixture-model");
  const events = () => queryGovernanceEvents(db, { sessionId, kinds: ["taint"], limit: 100 });
  const input = (toolUseId: string) => {
    recorder.observeFrame({ type: "tool_use_start", sessionId, toolUseId, toolName: tool });
    recorder.observeFrame({ type: "tool_use_complete", sessionId, toolUseId, toolName: tool, input: { command: "sh fetch.sh" } });
  };
  try {
    input("denied-opaque");
    recorder.observeActivity({ kind: "permission_denied", toolUseId: "denied-opaque", requestKind: "command", reason: "fixture policy denial" });
    recorder.observeFrame({ type: "tool_result", sessionId, toolUseId: "denied-opaque", output: "Denied", isError: true });
    expect(events(), "G6_DENIED_COMMAND_STAYS_CLEAN").toHaveLength(0);
    input("admitted-opaque");
    expect(events(), "G6_INPUT_ALONE_IS_NOT_INGESTION").toHaveLength(0);
    recorder.observeFrame({ type: "tool_result", sessionId, toolUseId: "admitted-opaque", output: "fictional opaque result", isError: false });
    expect(events(), "G6_OPAQUE_COMMAND_SOURCE").toMatchObject([{
      sessionId, turnId: "odysseus-opaque", actor: posture ?? "interactive", model: "fixture-model", profile: "governed",
      payload: { source: "unclassified_command", tool, detail: null },
    }]);
    recorder.finish("success");
  } finally { db.close(); }
});
