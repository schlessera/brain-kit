import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createNativeJournalCapture } from "../src/brain/native-journal-capture.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { recordGovernanceEvent, queryGovernanceEvents } from "../src/governance/events.js";
import { createJournalRoutes } from "../src/routes/journal.js";

function fixture(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "turn-journal-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(brain, "notes", "odysseus.md"), "# Ithaca\r\n");
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  return { root, brain, db, journal, native, begin, async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the retained journal reads exact before/after versions and ignored listings after the turn ends", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "# Ithaca\r\nReturn by sea.\r\n");
    writeFileSync(join(f.brain, "notes", "athena.md"), "# Athena\n");
    writeFileSync(join(f.brain, "ignored.txt"), "ignored change");
    await f.journal.finish("odysseus");
    const details = f.journal.details("ithaca", "odysseus")!;
    expect(details.summary).toMatchObject({ state: "complete", changedFiles: 3, costUsd: null, profile: "governed" });
    const note = details.changes.find(change => change.path === "notes/odysseus.md")!;
    expect(f.journal.version("ithaca", "odysseus", note.sequence, "before")!.bytes(1024)).toEqual(Buffer.from("# Ithaca\r\n"));
    expect(f.journal.version("ithaca", "odysseus", note.sequence, "after")!.bytes(1024)).toEqual(Buffer.from("# Ithaca\r\nReturn by sea.\r\n"));
    expect(details.changes.find(change => change.path === "ignored.txt")?.after).toMatchObject({ ignored: true, bytes: 14 });
    expect(f.journal.details("other-session", "odysseus")).toBeNull();
  } finally { await f.close(); }
});

test("inline preview enforces the approved raw byte and line boundaries and never coerces binary content", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus");
    writeFileSync(join(f.brain, "large.txt"), "A".repeat(256 * 1024 + 1));
    writeFileSync(join(f.brain, "boundary.txt"), "B".repeat(256 * 1024));
    writeFileSync(join(f.brain, "lines.txt"), Array.from({ length: 5001 }, () => "Ithaca").join("\n"));
    writeFileSync(join(f.brain, "line-boundary.txt"), Array.from({ length: 5000 }, () => "Athena").join("\n"));
    writeFileSync(join(f.brain, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    await f.journal.finish("odysseus");
    const routes = createJournalRoutes({ journal: f.journal });
    const details = f.journal.details("ithaca", "odysseus")!;
    for (const [path, expected] of [["large.txt", { inline: false, reason: "size" }], ["boundary.txt", { inline: true }], ["lines.txt", { inline: false, reason: "lines" }], ["line-boundary.txt", { inline: true }], ["binary.bin", { inline: false, reason: "binary_or_unavailable" }]] as const) {
      const change = details.changes.find(change => change.path === path)!;
      const response = await routes.request(`/sessions/ithaca/turns/odysseus/journal/${change.sequence}/preview`);
      expect(response.status).toBe(200); expect(await response.json(), `JOURNAL_INLINE_BOUNDARY_${path}`).toMatchObject(expected);
    }
  } finally { await f.close(); }
});

test("native admission refuses unavailable storage and changed-version capacity stops work without copying the baseline", async () => {
  const f = fixture(1024 * 1024);
  try {
    writeFileSync(join(f.brain, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024, 65));
    f.native.failNextCheckpoint(Error("native capacity fixture"));
    await expect(f.begin("refused")).rejects.toThrow("native capacity fixture");
    expect(f.journal.summary("refused").state).toBe("unknown");
    const stopped: Error[] = [];
    await f.journal.begin("running", { sessionId: "ithaca", actor: "voice", model: null, profile: "governed", policyHash: null }, error => stopped.push(error));
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_objects").get(), "NATIVE_BASELINE_RETAINS_NO_UNCHANGED_CONTENT").toEqual({ n: 0 });
    writeFileSync(join(f.brain, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024, 66));
    await expect(f.journal.finish("running")).rejects.toThrow();
    expect(stopped.length, "JOURNAL_OVERFLOW_STOPS_TURN").toBeGreaterThan(0);
    expect(f.journal.details("ithaca", "running")).toMatchObject({ summary: { state: "partial", actor: "voice" }, missing: [{ path: ".", reason: "journal_capacity" }] });
    expect(Bun.file(join(f.brain, "too-large.txt")).size, "JOURNAL_PARTIAL_WORK_REMAINS").toBe(2 * 1024 * 1024);
  } finally { await f.close(); }
});

test("failed policy admission ends its journal row and leaves no raw baseline pins before the next turn", async () => {
  const f = fixture(512 * 1024);
  try {
    // Concrete disk input failure after durable admission row: ignore policy is a directory.
    rmSync(join(f.brain, ".gitignore")); mkdirSync(join(f.brain, ".gitignore"));
    await expect(f.begin("refused-manifest")).rejects.toThrow("native journal admission could not be prepared");
    await f.journal.finish("refused-manifest");
    expect(f.db.query("SELECT ended_at FROM turn_journal_turns WHERE turn_id='refused-manifest'").get(), "JOURNAL_REFUSED_ADMISSION_ENDED").toMatchObject({ ended_at: expect.any(Number) });
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_object_refs WHERE turn_id='refused-manifest'").get(), "JOURNAL_REFUSED_BASELINE_PINS_RELEASED").toEqual({ n: 0 });
    rmSync(join(f.brain, ".gitignore"), { recursive: true }); writeFileSync(join(f.brain, ".gitignore"), "ignored.txt\n");
    await f.begin("small-next"); await f.journal.finish("small-next");
    expect(f.journal.summary("small-next").state, "JOURNAL_SAME_PROCESS_NEXT_TURN_RECOVERS").toBe("complete");
  } finally { await f.close(); }
});

test("a delayed observation holds authority synchronously until its complete serialized barrier", async () => {
  const f = fixture();
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  try {
    await f.begin("delayed");
    const delta = f.native.manager.delta;
    f.native.manager.delta = async (...args) => { entered(); await blocked; return delta(...args); };
    const observation = f.journal.observe();
    expect(f.journal.isHeld(), "JOURNAL_AUTHORITY_HELD_BEFORE_ASYNC_YIELD").toBe(true);
    await started;
    let idle = false; const waiting = f.journal.idle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle, "JOURNAL_IDLE_WAITS_COMPLETE_NATIVE_BARRIER").toBe(false);
    resume(); await observation; await waiting;
    expect(f.journal.isHeld()).toBe(false); expect(idle).toBe(true);
    f.native.manager.delta = delta;
    await f.journal.finish("delayed");
  } finally { resume(); await f.close(); }
});

test("cancellation while native admission awaits cannot create an active late turn", async () => {
  const f = fixture(), cancellation = new AbortController();
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  const checkpoint = f.native.manager.checkpoint;
  f.native.manager.checkpoint = async (...args) => { entered(); await blocked; return checkpoint(...args); };
  try {
    const pending = f.journal.begin("cancelled", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {}, cancellation.signal);
    void pending.catch(() => {});
    await started; cancellation.abort(Error("Odysseus cancelled admission")); resume();
    await expect(pending).rejects.toThrow("Odysseus cancelled admission");
    expect(f.journal.summary("cancelled").state, "JOURNAL_CANCELLED_ADMISSION_NEVER_RECORDING").toBe("unknown");
    expect(f.journal.isHeld()).toBe(false);
    f.native.manager.checkpoint = checkpoint;
    await f.begin("next"); await f.journal.finish("next");
    expect(f.journal.summary("next").state).toBe("complete");
  } finally { resume(); await f.close(); }
});

test("cancelling an overlapping admission resumes a healthy peer after its shared observation", async () => {
  const f = fixture(), cancellation = new AbortController();
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  const delta = f.native.manager.delta, completed: boolean[] = [];
  let paused = false;
  try {
    await f.begin("healthy-peer");
    f.journal.onObservation(() => {}, { before() { paused = true; }, after(ok) { completed.push(ok); if (ok) paused = false; } });
    f.native.manager.delta = async (...args) => { entered(); await blocked; return delta(...args); };
    const pending = f.journal.begin("cancelled-peer", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {}, cancellation.signal);
    void pending.catch(() => {});
    await started; expect(paused).toBe(true);
    cancellation.abort(Error("Odysseus cancelled overlapping admission")); resume();
    await expect(pending).rejects.toThrow("cancelled overlapping admission");
    expect(completed, "CANCELLED_ADMISSION_PRESERVES_HEALTHY_PEER_HOLD").toEqual([true]);
    expect(paused).toBe(false);
    expect(f.journal.summary("cancelled-peer").state).toBe("unknown");
    f.native.manager.delta = delta;
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "The original turn continues.\n");
    await f.journal.finish("healthy-peer");
    expect(f.journal.summary("healthy-peer")).toMatchObject({ state: "complete", changedFiles: 1 });
  } finally { resume(); f.native.manager.delta = delta; await f.close(); }
});

test("a retained raw stream pins its object until the reader ends", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus"); writeFileSync(join(f.brain, "notes", "odysseus.md"), "Athena\n"); await f.journal.finish("odysseus");
    const change = f.journal.details("ithaca", "odysseus")!.changes[0]!;
    const stream = f.journal.version("ithaca", "odysseus", change.sequence, "before")!.stream();
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='read'").get()).toEqual({ n: 1 });
    expect(await new Response(stream.body).text()).toBe("# Ithaca\r\n");
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_reservations WHERE kind='read'").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test("overlapping writable windows both preserve observed shared and disjoint versions with shared attribution", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus"); await f.begin("athena");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Shared return plan");
    writeFileSync(join(f.brain, "notes", "athena.md"), "Athena's observed advice");
    await f.journal.observe();
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Overwritten between observations");
    writeFileSync(join(f.brain, "notes", "odysseus.md"), "Next observed return plan");
    await f.journal.finish("odysseus"); await f.journal.finish("athena");
    for (const [id, other] of [["odysseus", "athena"], ["athena", "odysseus"]]) {
      const details = f.journal.details("ithaca", id!)!;
      expect(details.summary.sharedAttribution).toBe(true);
      expect(details.changes.find(change => change.path === "notes/athena.md")?.overlappingTurnIds).toEqual([other]);
      const versions = details.changes.filter(change => change.path === "notes/odysseus.md").map(change => f.journal.version("ithaca", id!, change.sequence, "after")?.bytes(1024).toString());
      expect(versions).toEqual(["Shared return plan", "Next observed return plan"]);
      expect(versions).not.toContain("Overwritten between observations");
    }
  } finally { await f.close(); }
});

test("a complete no-change turn has a known zero change count and unknown price; missing history remains unknown", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus"); await f.journal.finish("odysseus");
    expect(f.journal.summary("odysseus")).toMatchObject({ state: "complete", changedFiles: 0, costUsd: null });
    expect(f.journal.summary("unrecorded")).toMatchObject({ state: "unknown", changedFiles: null, costUsd: null });
  } finally { await f.close(); }
});

test("approved policy writes retain user attribution in the original active windows and cannot revive a completed turn", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.brain, "context/policies"), { recursive: true });
    const policy = join(f.brain, "context/policies/governance.md");
    writeFileSync(policy, "Athena's original policy\n");
    await f.begin("odysseus"); await f.begin("athena");
    await f.journal.observeUserPolicy("odysseus", () => writeFileSync(policy, "Odysseus approves the policy\n"));
    for (const id of ["odysseus", "athena"]) {
      const change = f.journal.details("ithaca", id)!.changes.find(change => change.path === "context/policies/governance.md")!;
      expect(change, "JOURNAL_APPROVED_POLICY_ATTRIBUTION").toMatchObject({ class: "policy", actor: "user" });
      expect(change.overlappingTurnIds).toHaveLength(1);
      expect(f.journal.version("ithaca", id, change.sequence, "before")!.bytes(1024).toString()).toBe("Athena's original policy\n");
    }
    await f.journal.finish("odysseus"); await f.journal.finish("athena");
    let executed = false;
    await expect(f.journal.observeUserPolicy("odysseus", () => { executed = true; })).rejects.toThrow("active complete observation window");
    expect(executed, "JOURNAL_COMPLETED_TURN_NEVER_REVIVED").toBe(false);
  } finally { await f.close(); }
});

test("actual journal classifies steering and local transitive configuration separately from content and policy", async () => {
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
    await f.begin("steering");
    for (const [path, bytes] of Object.entries(inputs)) if (path !== "context/policies/governance.md") writeFileSync(join(f.brain, path), bytes + "\n");
    writeFileSync(join(f.brain, "notes/a.md"), "Odysseus returns.\n");
    await f.journal.observeUserPolicy("steering", () => writeFileSync(join(f.brain, "context/policies/governance.md"), "Approved policy\n"));
    await f.journal.finish("steering");
    const details = f.journal.details("ithaca", "steering")!;
    for (const path of Object.keys(inputs).filter(path => path !== "context/policies/governance.md")) expect(details.changes.find(change => change.path === path)?.class, `STEERING_ACTUAL_INPUT_${path}`).toBe("steering");
    expect(details.changes.find(change => change.path === "notes/a.md")?.class).toBe("content");
    expect(details.changes.find(change => change.path === "context/policies/governance.md")).toMatchObject({ class: "policy", actor: "user" });
    expect(details.summary.steeringFiles, "STEERING_COUNT_EXCLUDES_POLICY").toBe(9);
    expect(queryGovernanceEvents(f.db, { turnId: "steering", kinds: ["steering_change"], limit: 100 })).toHaveLength(9);
  } finally { await f.close(); }
});

test("steering retains only taint recorded before observation, including sticky session evidence and overlap", async () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Ithaca',0,0)").run();
    writeFileSync(join(f.brain, "AGENTS.md"), "Original instructions\n");
    await f.begin("untainted"); writeFileSync(join(f.brain, "AGENTS.md"), "First instructions\n"); await f.journal.finish("untainted");
    const source = recordGovernanceEvent(f.db, { kind: "taint", sessionId: "ithaca", turnId: "prior-turn", actor: "interactive", model: null, profile: "governed", payload: { source: "web_fetch", tool: "WebFetch", detail: "Odysseus reads a harbour notice." } });
    await f.begin("odysseus"); await f.begin("athena"); writeFileSync(join(f.brain, "AGENTS.md"), "Shared instructions\n"); await f.journal.finish("odysseus"); await f.journal.finish("athena");
    expect(f.journal.details("ithaca", "untainted")!.changes[0], "STEERING_NO_RETROACTIVE_TAINT").not.toHaveProperty("tainted");
    for (const id of ["odysseus", "athena"]) {
      const change = f.journal.details("ithaca", id)!.changes.find(change => change.path === "AGENTS.md")!;
      expect(change, "STEERING_REAL_TAINT_SOURCE").toMatchObject({ class: "steering", tainted: true, taintSourceEventId: source.id });
      expect(change.overlappingTurnIds).toHaveLength(1);
    }
  } finally { await f.close(); }
});

test("opaque configuration input limitations survive replay without executing code or fabricating a steering dependency", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.brain, "brain.config.ts"), 'import("./" + selectRoute() + ".json"); throw new Error("no host evaluation");\n');
    await f.begin("opaque-config"); writeFileSync(join(f.brain, "notes/a.md"), "Odysseus keeps the route.\n"); await f.journal.finish("opaque-config");
    const replay = createTurnJournal(f.db, { nativeManager: f.native.manager, brainPath: f.brain, dbPath: join(f.root, "ui.db"), objectsRoot: join(f.root, "objects") });
    try {
      const details = replay.details("ithaca", "opaque-config")!;
      expect(details.missing, "STEERING_OPAQUE_INPUT_HONEST_REPLAY").toContainEqual({ path: "brain.config.ts", reason: "configuration_inputs_not_fully_identified" });
      expect(details.changes.find(change => change.path === "notes/a.md")?.class).toBe("content");
    } finally { await replay.close(); }
  } finally { await f.close(); }
});


test("runtime main-model binding only updates the correlated active journal", async () => {
  const f = fixture();
  try {
    await f.begin("odysseus");
    await f.journal.begin("athena", { sessionId: "troy", actor: "voice", model: null, profile: "governed", policyHash: null }, error => { throw error; });
    expect(f.journal.bindModel("odysseus", "troy", "main-model"), "MODEL_WRONG_SESSION_REJECTED").toBe(false);
    expect(f.journal.bindModel("odysseus", "ithaca", "main-model"), "MODEL_ACTIVE_BINDING").toBe(true);
    expect(f.journal.summary("odysseus").model, "MODEL_ACTIVE_SUMMARY").toBe("main-model");
    expect(f.journal.summary("athena").model, "MODEL_CONCURRENT_ISOLATION").toBeNull();
    expect(f.journal.bindModel("athena", "ithaca", "wrong-model"), "MODEL_TWO_SESSIONS_CROSS_BIND_REJECTED").toBe(false);
    expect(f.journal.bindModel("athena", "troy", "voice-model")).toBe(true);
    expect(f.journal.summary("athena").model).toBe("voice-model");
    await f.journal.finish("odysseus");
    expect(f.journal.bindModel("odysseus", "ithaca", "late-model"), "MODEL_FINISHED_REJECTED").toBe(false);
    expect(f.journal.summary("odysseus").model).toBe("main-model");
  } finally { await f.close(); }
});

test("native capture journals consumed nested configuration and ordinary excluded project edits", async () => {
  const f = fixture();
  try {
    const inputs = {
      "bunfig.toml": 'preload = ["./config/navigator/start.ts"]\n',
      "package.json": '{"name":"ithaca"}\n',
      "config/navigator/start.ts": 'export const route = "Ithaca";\n',
      "config/navigator/package.json": '{"type":"module","scripts":{"unused":"bun ./unused.ts"}}\n',
      "config/navigator/unused.ts": 'throw new Error("unused");\n',
      "node_modules/a/package.json": '{"name":"incidental"}\n',
      "workspaces/odyssey-tools/package.json": '{"scripts":{"start":"bun ./start.ts"}}\n',
      "workspaces/odyssey-tools/start.ts": 'throw new Error("unused clone");\n',
    };
    writeFileSync(join(f.brain, ".gitignore"), "node_modules/\n");
    for (const [path, text] of Object.entries(inputs)) { mkdirSync(join(f.brain, path, ".."), {recursive:true}); writeFileSync(join(f.brain, path), text); }
    await f.begin("consumer-seeds");
    for (const [path, text] of Object.entries(inputs)) writeFileSync(join(f.brain, path), text + "\n");
    await f.journal.finish("consumer-seeds");
    const details = f.journal.details("ithaca", "consumer-seeds")!;
    for (const path of ["bunfig.toml", "package.json", "config/navigator/start.ts", "config/navigator/package.json"]) expect(details.changes.find(change => change.path === path)?.class, `NATIVE_CONSUMED_CONFIGURATION_${path}`).toBe("steering");
    for (const path of ["config/navigator/unused.ts", "workspaces/odyssey-tools/package.json", "workspaces/odyssey-tools/start.ts"]) expect(details.changes.find(change => change.path === path)?.class, `NATIVE_UNUSED_CONFIGURATION_${path}`).toBe("content");
    expect(details.missing.filter(item => item.path.startsWith("node_modules/") || item.path.startsWith("workspaces/")), "NATIVE_INCIDENTAL_CONFIG_NOT_COVERAGE_NOISE").toEqual([]);
    expect(details.changes.find(change => change.path === "node_modules/a/package.json")?.after?.ignored).toBe(true);
  } finally { await f.close(); }
});
test("native journal excludes the resolved index and sidecars while preserving input-role events", async () => {
  const index = "brain.db", f = fixture();
  try {
    mkdirSync(join(f.brain, "cache"), { recursive: true }); mkdirSync(join(f.brain,"resources")); mkdirSync(join(f.brain,".claude"));
    const ignored = [index, ...["-wal","-shm","-journal"].map(suffix=>`${index}${suffix}`)];
    writeFileSync(join(f.brain,".gitignore"), ignored.join("\n"));
    writeFileSync(join(f.brain,"brain.config.ts"), `export default { db: "${index}", output: "./ordinary" };`);
    writeFileSync(join(f.brain,"bunfig.toml"), `preload = ["./startup.ts", ${ignored.map(path=>JSON.stringify(`./${path}`)).join(", ")}]`);
    writeFileSync(join(f.brain,"startup.ts"), 'import "./instructions" with {type:"text"}; import "./resources/brain.db" with {type:"text"};');
    writeFileSync(join(f.brain,".claude/settings.json"), JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"bun ./hook.ts ./ordinary"}]}]}}));
    const genuine = ["startup.ts","instructions","resources/brain.db","hook.ts",".claude/settings.json"];
    for (const path of [...ignored,"instructions","resources/brain.db","hook.ts","ordinary"]) writeFileSync(join(f.brain,path), "initial");
    await f.begin("index-only");
    for (const path of ignored) writeFileSync(join(f.brain,path), "index changed");
    await f.journal.finish("index-only");
    const details = f.journal.details("ithaca","index-only")!;
    expect(details.changes.map(change=>change.path).sort()).toEqual(ignored.sort());
    expect(details.changes.every(change=>change.class === "content"), "NATIVE_INDEX_HAS_NO_STEERING_CLASS").toBe(true);
    expect(queryGovernanceEvents(f.db,{turnId:"index-only",kinds:["steering_change"],limit:100}), "NATIVE_INDEX_HAS_NO_STEERING_EVENTS").toEqual([]);
    expect(details.summary.steeringFiles).toBe(0);
    await f.begin("inputs");
    writeFileSync(join(f.brain,"startup.ts"), 'import "./instructions" with {type:"text"}; import "./resources/brain.db" with {type:"text"}; // edited');
    writeFileSync(join(f.brain,"hook.ts"), 'export {}; // edited');
    writeFileSync(join(f.brain,"instructions"), "Athena guides the return.");
    writeFileSync(join(f.brain,"resources/brain.db"), "A genuine text input, despite its basename.");
    writeFileSync(join(f.brain,"ordinary"), "data changed");
    writeFileSync(join(f.brain,".claude/settings.json"), JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"bun ./hook.ts ./ordinary"}]}]},model:"voyage"}));
    await f.journal.finish("inputs");
    const controls = f.journal.details("ithaca","inputs")!;
    expect(controls.changes.filter(change=>change.class === "steering").map(change=>change.path).sort(), "NATIVE_GENUINE_INPUT_ROLE_CONTROLS").toEqual(genuine.sort());
    expect(controls.changes.find(change=>change.path === "ordinary")?.class, "NATIVE_ORDINARY_ARGUMENT_IS_DATA").toBe("content");
    expect(queryGovernanceEvents(f.db,{turnId:"inputs",kinds:["steering_change"],limit:100}).map(event=>event.payload.path).sort()).toEqual(genuine.sort());
  } finally { await f.close(); }
});


test("native capture excludes an alternate trusted index identity without a public configuration option", async () => {
  const f = fixture();
  const capture = createNativeJournalCapture(f.native.manager, async () => { throw Error("ignored versions must not be retained"); }, {resolvedIndexPaths:["cache/voyage.sqlite"]});
  try {
    mkdirSync(join(f.brain,"cache")); mkdirSync(join(f.brain,"resources"));
    const indexes = ["", "-wal", "-shm", "-journal"].map(suffix=>`cache/voyage.sqlite${suffix}`);
    writeFileSync(join(f.brain,".gitignore"),indexes.join("\n"));
    writeFileSync(join(f.brain,"bunfig.toml"),`preload = [${[...indexes,"resources/brain.db"].map(path=>JSON.stringify(`./${path}`)).join(",")}]`);
    for (const path of [...indexes,"resources/brain.db"]) writeFileSync(join(f.brain,path),"initial");
    await capture.initialize(); const policy = await capture.policy();
    for (const path of indexes) writeFileSync(join(f.brain,path),"changed");
    const observed = await capture.observe(new Map([["alternate",policy]]));
    try {
      expect(observed.changes.get("alternate")!.map(change=>change.path).sort()).toEqual(indexes.sort());
      for (const path of indexes) expect(observed.steering.paths.has(path),"NATIVE_ALTERNATE_INDEX_IDENTITY_EXCLUDED").toBe(false);
      expect(observed.steering.paths.has("resources/brain.db"),"NATIVE_UNRELATED_BASENAME_REMAINS_INPUT").toBe(true);
      await observed.commit();
    } catch (error) { await observed.abort(); throw error; }
  } finally { await capture.close(); await f.close(); }
});
