import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { recordingCursors, recordedWindows, observationWindowTrace, type RecordedTrace } from "./observation-recording.js";
import { observationPhases } from "./observation-phases.js";

test("path-cell phases come from the periodic observation that actually committed the paths", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE turn_journal_turns(turn_id TEXT PRIMARY KEY,ended_at INTEGER); CREATE TABLE turn_journal_changes(turn_id TEXT,sequence INTEGER,path TEXT,PRIMARY KEY(turn_id,sequence)); INSERT INTO turn_journal_turns VALUES ('voyage',NULL)");
  try {
    const before = recordingCursors(db);
    for (let n = 1; n <= 200; n++) db.query("INSERT INTO turn_journal_changes VALUES ('voyage',?,?)").run(n, `notes/ithaca-${n}.md`);
    const periodic = recordedWindows(db, before, 20, 30), tool = recordedWindows(db, recordingCursors(db), 34, 35);
    expect(periodic[0]?.changedPaths).toBe(200); expect(tool[0]?.changedPaths).toBe(0);
    const traces: RecordedTrace[] = [
      { kind: "periodic", turnId: null, observations: periodic, steps: [{ name: "hold", startedAt: 10, endedAt: 31 }, { name: "observe_capture", startedAt: 11, endedAt: 20 }, { name: "observe_record", startedAt: 20, endedAt: 30 }] },
      { kind: "tool", turnId: "voyage", toolUseId: "path-matrix-200", observations: tool, steps: [{ name: "hold", startedAt: 15, endedAt: 36 }, { name: "observe_capture", startedAt: 32, endedAt: 34 }, { name: "observe_record", startedAt: 34, endedAt: 35 }] },
    ];
    const selected = observationWindowTrace(traces, "voyage", { changedPaths: 200, startedAt: 10, endedAt: 36 }), phases = observationPhases(selected, []);
    expect(phases.phases.observe_capture, "PATH_CELL_USES_CAPTURE_FROM_THE_OBSERVATION_THAT_RECORDED_200_PATHS").toBe(9);
    expect(phases.phases.observe_record, "PATH_CELL_USES_RECORD_FROM_THE_OBSERVATION_THAT_RECORDED_200_PATHS").toBe(10);
    expect(phases.holdMs).toBe(26);
    expect(() => observationWindowTrace([traces[1]!], "voyage", { changedPaths: 200, startedAt: 10, endedAt: 36 }), "ZERO_PATH_TOOL_CANNOT_STAND_IN_FOR_PERIODIC_CAPTURE").toThrow("PATH_MATRIX_RECORDING_TRACE_MISSING");
  } finally { db.close(); }
});
