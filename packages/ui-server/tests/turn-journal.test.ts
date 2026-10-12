import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { recordGovernanceEvent, queryGovernanceEvents } from "../src/governance/events.js";
import { createJournalRoutes } from "../src/routes/journal.js";

function fixture(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "turn-journal-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(brain, "notes", "odysseus.md"), "# Ithaca\r\n");
  const db = createUiDb(path), journal = createTurnJournal(db, { brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  return { root, brain, db, journal, begin, close() { journal.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the retained journal reads exact before/after versions and ignored listings after the turn ends", () => {
  const f = fixture();
  try {
    f.begin("odysseus");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "# Ithaca\r\nReturn by sea.\r\n");
    writeFileSync(join(f.brain, "notes", "athena.md"), "# Athena\n");
    writeFileSync(join(f.brain, "ignored.txt"), "ignored change");
    f.journal.finish("odysseus");
    const details = f.journal.details("ithaca", "odysseus")!;
    expect(details.summary).toMatchObject({ state: "complete", changedFiles: 3, costUsd: null, profile: "governed" });
    const note = details.changes.find(change => change.path === "notes/odysseus.md")!;
    expect(f.journal.version("ithaca", "odysseus", note.sequence, "before")!.bytes(1024)).toEqual(Buffer.from("# Ithaca\r\n"));
    expect(f.journal.version("ithaca", "odysseus", note.sequence, "after")!.bytes(1024)).toEqual(Buffer.from("# Ithaca\r\nReturn by sea.\r\n"));
    expect(details.changes.find(change => change.path === "ignored.txt")?.after).toMatchObject({ ignored: true, bytes: 14 });
    expect(f.journal.details("other-session", "odysseus")).toBeNull();
  } finally { f.close(); }
});

test("inline preview enforces the approved raw byte and line boundaries and never coerces binary content", async () => {
  const f = fixture();
  try {
    f.begin("odysseus");
    writeFileSync(join(f.brain, "large.txt"), "A".repeat(256 * 1024 + 1));
    writeFileSync(join(f.brain, "boundary.txt"), "B".repeat(256 * 1024));
    writeFileSync(join(f.brain, "lines.txt"), Array.from({ length: 5001 }, () => "Ithaca").join("\n"));
    writeFileSync(join(f.brain, "line-boundary.txt"), Array.from({ length: 5000 }, () => "Athena").join("\n"));
    writeFileSync(join(f.brain, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    f.journal.finish("odysseus");
    const routes = createJournalRoutes({ journal: f.journal });
    const details = f.journal.details("ithaca", "odysseus")!;
    for (const [path, expected] of [["large.txt", { inline: false, reason: "size" }], ["boundary.txt", { inline: true }], ["lines.txt", { inline: false, reason: "lines" }], ["line-boundary.txt", { inline: true }], ["binary.bin", { inline: false, reason: "binary_or_unavailable" }]] as const) {
      const change = details.changes.find(change => change.path === path)!;
      const response = await routes.request(`/sessions/ithaca/turns/odysseus/journal/${change.sequence}/preview`);
      expect(response.status).toBe(200); expect(await response.json(), `JOURNAL_INLINE_BOUNDARY_${path}`).toMatchObject(expected);
    }
  } finally { f.close(); }
});

test("capacity refuses an initial snapshot before a worker and stops a running turn without claiming complete reversibility", () => {
  const f = fixture(1024 * 1024);
  try {
    writeFileSync(join(f.brain, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024, 65));
    expect(() => f.begin("refused")).toThrow("initial snapshot incomplete");
    expect(f.journal.summary("refused").state).toBe("partial");
    rmSync(join(f.brain, "too-large.txt"));
    const stopped: Error[] = [];
    f.journal.begin("running", { sessionId: "ithaca", actor: "voice", model: null, profile: "governed", policyHash: null }, error => stopped.push(error));
    writeFileSync(join(f.brain, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024, 66));
    f.journal.finish("running");
    expect(stopped.length, "JOURNAL_OVERFLOW_STOPS_TURN").toBeGreaterThan(0);
    expect(f.journal.details("ithaca", "running")).toMatchObject({ summary: { state: "partial", actor: "voice" }, missing: [{ path: "too-large.txt", reason: "journal_capacity" }] });
    expect(Bun.file(join(f.brain, "too-large.txt")).size, "JOURNAL_PARTIAL_WORK_REMAINS").toBe(2 * 1024 * 1024);
  } finally { f.close(); }
});

test("a refused manifest on the same live journal ends admission and releases initial-only pins before the next small turn", () => {
  const f = fixture(512 * 1024);
  try {
    // A concrete SQLite write failure after the raw baseline objects were pinned.
    f.db.exec("CREATE TRIGGER refuse_manifest BEFORE INSERT ON turn_journal_manifests BEGIN SELECT RAISE(ABORT,'fixture manifest unavailable'); END");
    expect(() => f.begin("refused-manifest")).toThrow("initial snapshot could not be recorded");
    f.journal.finish("refused-manifest");
    expect(f.db.query("SELECT ended_at FROM turn_journal_turns WHERE turn_id='refused-manifest'").get(), "JOURNAL_REFUSED_ADMISSION_ENDED").toMatchObject({ ended_at: expect.any(Number) });
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_object_refs WHERE turn_id='refused-manifest'").get(), "JOURNAL_REFUSED_BASELINE_PINS_RELEASED").toEqual({ n: 0 });
    f.db.exec("DROP TRIGGER refuse_manifest");
    f.begin("small-next"); f.journal.finish("small-next");
    expect(f.journal.summary("small-next").state, "JOURNAL_SAME_PROCESS_NEXT_TURN_RECOVERS").toBe("complete");
  } finally { f.close(); }
});

test("a retained raw stream pins its object until the reader ends", async () => {
  const f = fixture();
  try {
    f.begin("odysseus"); writeFileSync(join(f.brain, "notes", "odysseus.md"), "Athena\n"); f.journal.finish("odysseus");
    const change = f.journal.details("ithaca", "odysseus")!.changes[0]!;
    const stream = f.journal.version("ithaca", "odysseus", change.sequence, "before")!.stream();
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='read'").get()).toEqual({ n: 1 });
    expect(await new Response(stream.body).text()).toBe("# Ithaca\r\n");
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='read'").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("overlapping writable windows both preserve observed shared and disjoint versions with shared attribution", () => {
  const f = fixture();
  try {
    f.begin("odysseus"); f.begin("athena");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Shared return plan");
    writeFileSync(join(f.brain, "notes", "athena.md"), "Athena's observed advice");
    f.journal.observe();
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Overwritten between observations");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Next observed return plan");
    f.journal.finish("odysseus"); f.journal.finish("athena");
    for (const [id, other] of [["odysseus", "athena"], ["athena", "odysseus"]]) {
      const details = f.journal.details("ithaca", id!)!;
      expect(details.summary.sharedAttribution).toBe(true);
      expect(details.changes.find(change => change.path === "notes/athena.md")?.overlappingTurnIds).toEqual([other]);
      const versions = details.changes.filter(change => change.path === "notes/odysseus.md").map(change => f.journal.version("ithaca", id!, change.sequence, "after")?.bytes(1024).toString());
      expect(versions).toEqual(["Shared return plan", "Next observed return plan"]);
      expect(versions).not.toContain("Overwritten between observations");
    }
  } finally { f.close(); }
});

test("a complete no-change turn has a known zero change count and unknown price; missing history remains unknown", () => {
  const f = fixture();
  try {
    f.begin("odysseus"); f.journal.finish("odysseus");
    expect(f.journal.summary("odysseus")).toMatchObject({ state: "complete", changedFiles: 0, costUsd: null });
    expect(f.journal.summary("unrecorded")).toMatchObject({ state: "unknown", changedFiles: null, costUsd: null });
  } finally { f.close(); }
});

test("approved policy writes retain user attribution in the original active windows and cannot revive a completed turn", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.brain, "context/policies"), { recursive: true });
    const policy = join(f.brain, "context/policies/governance.md");
    writeFileSync(policy, "Athena's original policy\n");
    f.begin("odysseus"); f.begin("athena");
    f.journal.observeUserPolicy("odysseus", () => writeFileSync(policy, "Odysseus approves the policy\n"));
    for (const id of ["odysseus", "athena"]) {
      const change = f.journal.details("ithaca", id)!.changes.find(change => change.path === "context/policies/governance.md")!;
      expect(change, "JOURNAL_APPROVED_POLICY_ATTRIBUTION").toMatchObject({ class: "policy", actor: "user" });
      expect(change.overlappingTurnIds).toHaveLength(1);
      expect(f.journal.version("ithaca", id, change.sequence, "before")!.bytes(1024).toString()).toBe("Athena's original policy\n");
    }
    f.journal.finish("odysseus"); f.journal.finish("athena");
    let executed = false;
    expect(() => f.journal.observeUserPolicy("odysseus", () => { executed = true; })).toThrow("active complete observation window");
    expect(executed, "JOURNAL_COMPLETED_TURN_NEVER_REVIVED").toBe(false);
  } finally { f.close(); }
});

test("actual journal classifies steering and local transitive configuration separately from content and policy", () => {
  const f = fixture();
  try {
    for (const path of [".claude/skills/voyage", ".claude", "config", "hooks", "context/scheduled-tasks", "context/policies"]) mkdirSync(join(f.brain, path), { recursive: true });
    const inputs = {
      ".claude/skills/voyage/SKILL.md": "# Voyage\n",
      "AGENTS.md": "Athena's instructions\n", ".mcp.json": "{}\n",
      ".claude/settings.json": JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "bun ./hooks/voyage.ts" }] }] } }),
      "hooks/voyage.ts": 'import "../config/routes.json";\n',
      "brain.config.ts": 'import "./config/helper.ts"; throw new Error("must never execute config");\n',
      "config/helper.ts": 'import "./routes.json";\n', "config/routes.json": '{"harbour":"Ithaca"}\n',
      "context/scheduled-tasks/voyage.md": "Athena reviews the schedule.\n",
      "context/policies/governance.md": "Original policy\n",
    };
    for (const [path, bytes] of Object.entries(inputs)) writeFileSync(join(f.brain, path), bytes);
    f.begin("steering");
    for (const [path, bytes] of Object.entries(inputs)) if (path !== "context/policies/governance.md") writeFileSync(join(f.brain, path), bytes + "\n");
    writeFileSync(join(f.brain, "notes/a.md"), "Odysseus returns.\n");
    f.journal.observeUserPolicy("steering", () => writeFileSync(join(f.brain, "context/policies/governance.md"), "Approved policy\n"));
    f.journal.finish("steering");
    const details = f.journal.details("ithaca", "steering")!;
    for (const path of Object.keys(inputs).filter(path => path !== "context/policies/governance.md")) expect(details.changes.find(change => change.path === path)?.class, `STEERING_ACTUAL_INPUT_${path}`).toBe("steering");
    expect(details.changes.find(change => change.path === "notes/a.md")?.class).toBe("content");
    expect(details.changes.find(change => change.path === "context/policies/governance.md")).toMatchObject({ class: "policy", actor: "user" });
    expect(details.summary.steeringFiles, "STEERING_COUNT_EXCLUDES_POLICY").toBe(9);
    expect(queryGovernanceEvents(f.db, { turnId: "steering", kinds: ["steering_change"], limit: 100 })).toHaveLength(9);
  } finally { f.close(); }
});

test("steering retains only taint recorded before observation, including sticky session evidence and overlap", () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Ithaca',0,0)").run();
    writeFileSync(join(f.brain, "AGENTS.md"), "Original instructions\n");
    f.begin("untainted"); writeFileSync(join(f.brain, "AGENTS.md"), "First instructions\n"); f.journal.finish("untainted");
    const source = recordGovernanceEvent(f.db, { kind: "taint", sessionId: "ithaca", turnId: "prior-turn", actor: "interactive", model: null, profile: "governed", payload: { source: "web_fetch", tool: "WebFetch", detail: "Odysseus reads a harbour notice." } });
    f.begin("odysseus"); f.begin("athena"); writeFileSync(join(f.brain, "AGENTS.md"), "Shared instructions\n"); f.journal.finish("odysseus"); f.journal.finish("athena");
    expect(f.journal.details("ithaca", "untainted")!.changes[0], "STEERING_NO_RETROACTIVE_TAINT").not.toHaveProperty("tainted");
    for (const id of ["odysseus", "athena"]) {
      const change = f.journal.details("ithaca", id)!.changes.find(change => change.path === "AGENTS.md")!;
      expect(change, "STEERING_REAL_TAINT_SOURCE").toMatchObject({ class: "steering", tainted: true, taintSourceEventId: source.id });
      expect(change.overlappingTurnIds).toHaveLength(1);
    }
  } finally { f.close(); }
});

test("opaque configuration input limitations survive replay without executing code or fabricating a steering dependency", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.brain, "brain.config.ts"), 'import("./" + selectRoute() + ".json"); throw new Error("no host evaluation");\n');
    f.begin("opaque-config"); writeFileSync(join(f.brain, "notes/a.md"), "Odysseus keeps the route.\n"); f.journal.finish("opaque-config");
    const replay = createTurnJournal(f.db, { brainPath: f.brain, dbPath: join(f.root, "ui.db"), objectsRoot: join(f.root, "objects") });
    try {
      const details = replay.details("ithaca", "opaque-config")!;
      expect(details.missing, "STEERING_OPAQUE_INPUT_HONEST_REPLAY").toContainEqual({ path: "brain.config.ts", reason: "configuration_inputs_not_fully_identified" });
      expect(details.changes.find(change => change.path === "notes/a.md")?.class).toBe("content");
    } finally { replay.close(); }
  } finally { f.close(); }
});
