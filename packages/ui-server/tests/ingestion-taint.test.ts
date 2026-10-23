import { expect, test } from "bun:test";
import { inputTaintSource, outputTaintSource } from "../src/activity/ingestion-taint";
import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";

const brain = "/srv/odysseus/brain";

test("web, external MCP and untrusted-area reads are taint sources on both backends", () => {
  for (const [tool, input, source] of [
    ["WebFetch", { url: "https://ithaca.invalid" }, "web_fetch"], ["WebSearch", { query: "Ithaca" }, "web_search"],
    ["fetch_content", { url: "https://ithaca.invalid" }, "web_fetch"], ["web_search", { query: "Ithaca" }, "web_search"],
    ["mcp__mail__read_message", { id: "7" }, "mcp_document"], ["mcp__brain-uix__get", {}, "mcp_document"],
    ["Read", { file_path: `${brain}/.brain-ui/inbox/share-1/notice.md` }, "staged_share"],
    ["read_file", { path: ".brain-ui/inbox/share-1/notice.md" }, "staged_share"],
    ["Read", { file_path: `${brain}/workspaces/voyage/README.md` }, "workspace_read"],
    ["Read", { file_path: "/tmp/brain-worker-areas/workspaces/voyage/README.md" }, "workspace_read"],
    ["Grep", { pattern: "Ithaca", path: "workspaces" }, "workspace_read"], ["grep", { pattern: "Ithaca", path: "./workspaces/voyage" }, "workspace_read"],
    ["Edit", { file_path: `${brain}/workspaces/voyage/a.md` }, "workspace_read"],
    ["Bash", { command: "curl https://example.org" }, "fetching_command"],
    // Equivalent spellings cannot hide an area.
    ["Read", { file_path: "/srv/odysseus/./brain/workspaces/a.md" }, "workspace_read"],
    ["Read", { file_path: `${brain}/../brain/workspaces/a.md` }, "workspace_read"],
    ["Read", { file_path: "../brain/workspaces/a.md" }, "workspace_read"],
    ["Read", { file_path: "/tmp/./brain-worker-areas/workspaces/a.md" }, "workspace_read"],
    // A view whose root the host cannot name counts any area segment.
    ["Read", { file_path: "/home/odysseus/view/workspaces/a.md" }, "workspace_read"],
    // brain-kit's own readers are not external documents, but still read areas.
    ["brain_read_base", { path: "workspaces/voyage/README.md" }, "workspace_read"],
    ["mcp__brain-ui__brain_read_base", { path: "workspaces/voyage/README.md" }, "workspace_read"],
    ["mcp__brain__brain_read", { path: ".brain-ui/inbox/share-1/notice.md" }, "staged_share"],
  ] as const) expect(inputTaintSource(tool, input, brain), `G6_SOURCE_${tool}`).toBe(source);
  for (const [tool, input] of [
    ["mcp__brain__brain_search", { query: "Ithaca" }], ["mcp__brain-ui__brain_update", {}],
    ["Read", { file_path: `${brain}/notes/ithaca.md` }], ["Read", { file_path: `${brain}/workspaces-notes/a.md` }],
    ["Read", { file_path: `${brain}/workspaces/../notes/a.md` }], ["Read", { file_path: `${brain}/notes/workspaces/a.md` }],
    ["Write", { file_path: `${brain}/workspaces/voyage/a.md` }], ["Grep", { pattern: "Ithaca" }], ["Bash", { command: "ls -la" }],
  ] as const) expect(inputTaintSource(tool, input, brain), `G6_CLEAN_${tool}_${JSON.stringify(input)}`).toBeNull();
});

test("a brain whose own path contains an area name does not taint its ordinary reads", () => {
  const nested = "/home/odysseus/workspaces/brain";
  expect(inputTaintSource("Read", { file_path: `${nested}/notes/a.md` }, nested), "G6_BRAIN_PATH_NOT_AN_AREA").toBeNull();
  expect(inputTaintSource("Read", { file_path: `${nested}/workspaces/a.md` }, nested)).toBe("workspace_read");
  expect(outputTaintSource("Grep", `${nested}/notes/a.md`, nested)).toBeNull();
});

test("a search from an ancestor directory taints only when its output names an untrusted-area file", () => {
  expect(outputTaintSource("Grep", `${brain}/notes/a.md\n${brain}/workspaces/voyage/b.md`, brain), "G6_GREP_OUTPUT_WORKSPACE").toBe("workspace_read");
  expect(outputTaintSource("grep", "notes/a.md:3: Ithaca\n.brain-ui/inbox/share-1/n.md:1: Ithaca", brain)).toBe("staged_share");
  expect(outputTaintSource("Glob", `${brain}/notes/a.md`, brain)).toBeNull();
  expect(outputTaintSource("Read", "workspaces/voyage/b.md", brain), "G6_OUTPUT_ONLY_FOR_SEARCH").toBeNull();
});

test("the real recorder keeps the first web source and excludes a denied fetch", () => {
  const db = createUiDb(":memory:");
  const sessionId = "odysseus-web-session";
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(sessionId);
  const recorder = createTurnRecorder({ store: createActivityStore(db, { writer: "test" }), governanceDb: db, brainPath: brain,
    governance: event => { recordGovernanceEvent(db, event); } }, { turnId: "odysseus-web", sessionId, profile: "governed" });
  const call = (id: string, toolName: string, input: Record<string, unknown>, output: string, denied = false) => {
    recorder.observeFrame({ type: "tool_use_start", sessionId, toolUseId: id, toolName });
    recorder.observeFrame({ type: "tool_use_complete", sessionId, toolUseId: id, toolName, input });
    if (denied) recorder.onApprovalDecision(id, "deny", "tool");
    recorder.observeFrame({ type: "tool_result", sessionId, toolUseId: id, output, isError: denied });
  };
  const events = () => queryGovernanceEvents(db, { sessionId, kinds: ["taint"], limit: 10 });
  try {
    call("denied", "WebFetch", { url: "https://ithaca.invalid" }, "Denied", true);
    call("clean", "Grep", { pattern: "Ithaca" }, `${brain}/notes/a.md`);
    expect(events(), "G6_DENIED_FETCH_CLEAN").toHaveLength(0);
    call("search", "Grep", { pattern: "Ithaca" }, `${brain}/workspaces/voyage/a.md`);
    call("fetch", "WebFetch", { url: "https://ithaca.invalid" }, "A fictional harbour notice.");
    expect(events().map(event => event.payload), "G6_RECORDER_FIRST_TOOL_SOURCE").toEqual([{ source: "workspace_read", tool: "Grep", detail: null }]);
    recorder.finish("success");
  } finally { db.close(); }
});

test("a taint that cannot be persisted stops the turn instead of leaving outward rules loose", () => {
  const db = createUiDb(":memory:");
  const sessionId = "odysseus-failure-session";
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(sessionId);
  const aborted: Error[] = [];
  const recorder = createTurnRecorder({ store: createActivityStore(db, { writer: "test" }), governanceDb: db, brainPath: brain,
    governance: () => { throw new Error("fixture governance write failure"); }, abort: error => aborted.push(error) },
  { turnId: "odysseus-failure", sessionId, profile: "governed" });
  try {
    recorder.observeFrame({ type: "tool_use_start", sessionId, toolUseId: "fetch", toolName: "WebFetch" });
    recorder.observeFrame({ type: "tool_use_complete", sessionId, toolUseId: "fetch", toolName: "WebFetch", input: { url: "https://ithaca.invalid" } });
    expect(aborted).toHaveLength(0);
    recorder.observeFrame({ type: "tool_result", sessionId, toolUseId: "fetch", output: "A fictional harbour notice.", isError: false });
    expect(aborted.map(error => error.message), "G6_TAINT_FAILURE_STOPS_TURN").toEqual(["Untrusted input could not be recorded; the turn was stopped."]);
    recorder.finish("error");
  } finally { db.close(); }
});
