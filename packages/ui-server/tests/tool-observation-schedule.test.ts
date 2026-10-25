import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { scopeFixture } from "./helpers/scope-fixture.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { toolObservation } from "../src/brain/tool-observation.js";

/** #2834: what each tool class's proven execution path lets a result skip. */
test("only a proven read skips its result's observation; unknown, bash and writers never do", () => {
  const cases: [string | null, Parameters<typeof toolObservation>[1], ReturnType<typeof toolObservation>][] = [
    // Host bridge handlers that write nothing in the brain root.
    ["brain_read_base", "host_bridge", "read"], ["query_activity", "host_bridge", "read"], ["inbox_list", "host_bridge", "read"],
    ["inbox_get", "host_bridge", "read"], ["show_block", "host_bridge", "read"], ["ask_user", "host_bridge", "read"],
    ["get_current_location", "host_bridge", "read"],
    // Host handlers that write: observed, but their effects end with the result.
    ["inbox_add", "host_bridge", "write"], ["write_file", "host_bridge", "write"], ["brain_add", "host_bridge", "write"],
    ["request_image_mask", "host_bridge", "write"], ["propose_policy_change", "host_bridge", "write"],
    // Host evidence for a call that started as another tool proves nothing about what it ran.
    ["brain_search", "host_bridge", "unproven"], ["bash", "host_bridge", "unproven"], ["odysseus_custom", "host_bridge", "unproven"],
    // First-party worker file tools.
    ["read_file", "worker_read", "read"], ["write_file", "worker_write", "write"], ["edit_file", "worker_write", "write"],
    // Evidence that does not match the tool proves nothing.
    ["bash", "worker_read", "unproven"], ["grep", "worker_read", "unproven"], ["bash", "worker_write", "unproven"], ["read_file", "worker_write", "unproven"],
    // A name or risk label alone is never evidence.
    ["read_file", undefined, "unproven"], ["brain_search", undefined, "unproven"], ["query_activity", undefined, "unproven"],
    ["bash", undefined, "unproven"], ["Read", undefined, "unproven"], ["mcp__brain-ui__query_activity", undefined, "unproven"], [null, "host_bridge", "unproven"],
  ];
  for (const [name, path, expected] of cases) expect([name, path, toolObservation(name, path)], "TOOL_OBSERVATION_CLASS").toEqual([name, path, expected]);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-tool-schedule-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes", "loom.md"), "Penelope weaves.\n");
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects") });
  let observations = 0;
  journal.onObservation(() => { observations++; });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  const call = async (turnId: string, id: string, name: string, path?: Parameters<typeof toolObservation>[1], during?: () => void) => {
    journal.toolStarted(turnId, id, name, true); during?.();
    if (path) journal.toolExecuted(turnId, id, path);
    await journal.toolEnded(turnId, id);
  };
  const versions = (turnId: string, file: string) => journal.details("ithaca", turnId)!.changes.filter(change => change.path === file)
    .map(change => journal.version("ithaca", turnId, change.sequence, "after")?.bytes(1024).toString() ?? null);
  return { brain, journal, begin, call, versions, get observations() { return observations; },
    async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a proven read's skipped result loses no change: the turn's terminal capture still records it", async () => {
  const t = fixture();
  try {
    await t.begin("voyage");
    const before = t.observations;
    // A change no observed result made: an unattributed writer during a proven read.
    await t.call("voyage", "read-1", "read_file", "worker_read", () => writeFileSync(join(t.brain, "notes", "loom.md"), "Athena weaves.\n"));
    expect(t.observations - before, "PROVEN_READ_SKIPS_ITS_OBSERVATION").toBe(0);
    await t.call("voyage", "base-1", "brain_read_base", "host_bridge");
    expect(t.observations - before, "PROVEN_HOST_READ_SKIPS_ITS_OBSERVATION").toBe(0);
    await t.journal.finish("voyage");
    expect(t.versions("voyage", "notes/loom.md"), "TERMINAL_CAPTURE_RECORDS_THE_UNOBSERVED_CHANGE").toEqual(["Athena weaves.\n"]);
    expect(t.journal.summary("voyage").state).toBe("complete");
  } finally { await t.close(); }
});

test("after a call whose effects can outlast it, every later result is observed and each version retained", async () => {
  const t = fixture();
  try {
    await t.begin("voyage");
    // No evidence: bash may have left a writer running in the worker.
    await t.call("voyage", "bash-1", "bash");
    writeFileSync(join(t.brain, "notes", "loom.md"), "Athena weaves.\n");
    const before = t.observations;
    await t.call("voyage", "read-1", "read_file", "worker_read");
    expect(t.observations - before, "LASTING_TURN_PROVEN_READ_OBSERVED").toBe(1);
    writeFileSync(join(t.brain, "notes", "loom.md"), "Telemachus weaves.\n");
    await t.call("voyage", "read-2", "read_file", "worker_read");
    await t.journal.finish("voyage");
    expect(t.versions("voyage", "notes/loom.md"), "BACKGROUND_WRITES_BETWEEN_CALLS_KEEP_EACH_VERSION").toEqual(["Athena weaves.\n", "Telemachus weaves.\n"]);
  } finally { await t.close(); }
});

test("a proven read is observed while another call, of any active turn, is still running", async () => {
  const t = fixture();
  try {
    await t.begin("voyage"); await t.begin("return");
    t.journal.toolStarted("return", "bash-1", "bash", true);
    writeFileSync(join(t.brain, "notes", "loom.md"), "Athena weaves.\n");
    const before = t.observations;
    await t.call("voyage", "read-1", "read_file", "worker_read");
    // One observation, reported to both active turns.
    expect(t.observations - before, "RUNNING_SIBLING_KEEPS_PROVEN_READ_OBSERVED").toBe(2);
    writeFileSync(join(t.brain, "notes", "loom.md"), "Telemachus weaves.\n");
    await t.journal.toolEnded("return", "bash-1");
    await t.journal.finish("return"); await t.journal.finish("voyage");
    expect(t.versions("return", "notes/loom.md"), "RUNNING_CALL_INTERMEDIATE_VERSION_RETAINED").toEqual(["Athena weaves.\n", "Telemachus weaves.\n"]);
  } finally { await t.close(); }
});

test("another active turn's lasting call keeps this turn's proven reads observed; the end of that turn releases them", async () => {
  const t = fixture();
  try {
    await t.begin("voyage"); await t.begin("return");
    await t.call("return", "bash-1", "bash");
    let before = t.observations;
    await t.call("voyage", "read-1", "read_file", "worker_read");
    expect(t.observations - before, "OTHER_TURN_LASTING_KEEPS_READ_OBSERVED").toBe(2);
    await t.journal.finish("return");
    before = t.observations;
    await t.call("voyage", "read-2", "read_file", "worker_read");
    expect(t.observations - before, "ENDED_TURN_NO_LONGER_HOLDS_READS").toBe(0);
    await t.journal.finish("voyage");
  } finally { await t.close(); }
});

test("a call started twice under one identity, or proven as another tool, keeps every later result observed", async () => {
  for (const variant of ["duplicate", "forged"] as const) {
    const t = fixture();
    try {
      await t.begin("voyage");
      if (variant === "duplicate") {
        // Two parallel writers under one id: the first result must not settle the second.
        t.journal.toolStarted("voyage", "dup", "write_file", true); t.journal.toolStarted("voyage", "dup", "write_file", false);
        t.journal.toolStarted("voyage", "dup", "write_file", true);
        t.journal.toolExecuted("voyage", "dup", "worker_write"); await t.journal.toolEnded("voyage", "dup");
      } else {
        // An index tool's brain-owned code reporting itself as a host read.
        await t.call("voyage", "search-1", "brain_search", "host_bridge");
      }
      writeFileSync(join(t.brain, "notes", "loom.md"), "Athena weaves.\n");
      const before = t.observations;
      await t.call("voyage", "read-1", "read_file", "worker_read");
      expect(t.observations - before, `${variant.toUpperCase()}_CALL_KEEPS_LATER_READS_OBSERVED`).toBe(1);
      writeFileSync(join(t.brain, "notes", "loom.md"), "Telemachus weaves.\n");
      await t.journal.finish("voyage");
      expect(t.versions("voyage", "notes/loom.md"), `${variant.toUpperCase()}_CALL_KEEPS_EACH_VERSION`).toEqual(["Athena weaves.\n", "Telemachus weaves.\n"]);
    } finally { await t.close(); }
  }
});

test("writers and host handlers are observed after their result without holding later proven reads", async () => {
  const t = fixture();
  try {
    await t.begin("voyage");
    let before = t.observations;
    await t.call("voyage", "write-1", "write_file", "worker_write", () => writeFileSync(join(t.brain, "notes", "loom.md"), "Athena weaves.\n"));
    await t.call("voyage", "add-1", "inbox_add", "host_bridge");
    expect(t.observations - before, "WRITERS_OBSERVED_AFTER_RESULT").toBe(2);
    before = t.observations;
    await t.call("voyage", "read-1", "read_file", "worker_read");
    expect(t.observations - before, "SYNCHRONOUS_WRITERS_LEAVE_NOTHING_RUNNING").toBe(0);
    // A result with no start is unknown and observed.
    await t.journal.toolEnded("voyage", "loom");
    expect(t.observations - before, "UNKNOWN_RESULT_OBSERVED").toBe(1);
    await t.journal.finish("voyage");
    expect(t.versions("voyage", "notes/loom.md")).toEqual(["Athena weaves.\n"]);
  } finally { await t.close(); }
});

for (const dimension of ["files_changed", "turn_bytes"] as const) test(`a ${dimension} limit crossed between two tool calls stops the turn at the next result, as before`, async () => {
  const t = scopeFixture(dimension === "files_changed" ? { max_files_changed: 2 } : { max_bytes_written: 4096 });
  try {
    await t.begin();
    const worker = t.worker("sleep 30");
    // A call that may keep writing, then its background writes after its result.
    t.journal.toolStarted("voyage", "bash-1", "bash", true); await t.journal.toolEnded("voyage", "bash-1");
    for (const name of ["ithaca", "scheria", "aeaea"]) writeFileSync(join(t.brain, `${name}.md`), `Odysseus reaches ${name}.\n`.repeat(dimension === "turn_bytes" ? 100 : 1));
    t.journal.toolStarted("voyage", "read-1", "read_file", true); t.journal.toolExecuted("voyage", "read-1", "worker_read");
    await t.journal.toolEnded("voyage", "read-1");
    expect(t.receipt(), "LIMIT_CROSSED_BETWEEN_CALLS_PAUSES_AT_NEXT_RESULT").toMatchObject(
      dimension === "files_changed" ? { dimension, cap: 2, count: 3, state: "paused", frozen: true } : { dimension, cap: 4096, state: "paused", frozen: true });
    worker.kill("SIGKILL");
  } finally { await t.close(); }
}, 20_000);
