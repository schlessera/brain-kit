/**
 * #3429: on a turn whose worker runs behind the turn egress proxy, shell
 * commands no longer taint through the command classifier. The proxy's
 * admitted-connection taint is the shell signal there; every non-shell
 * source still taints, and unproxied turns keep the classifier.
 */
import { expect, test } from "bun:test";
import { request } from "node:http";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import {connectedSafetySession} from "./helpers/connected-safety";
import { createUiDb } from "../src/db/client";
import { beginSafetyCollection, acknowledgeSafety } from "../src/governance/safety-store";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";

const BRAIN = "/srv/ithaca";

function fixture() {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const sessions = new Set<string>();
  const recorder = (sessionId: string, proxied: boolean, connected=false) => {
    if (!sessions.has(sessionId)) {
      if(connected)connectedSafetySession(db,sessionId,`${sessionId}-birth`);
      else db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(sessionId);
      sessions.add(sessionId);
    }
    if (connected) {
      beginSafetyCollection(db, { turnId: `${sessionId}-turn`, bindingId: crypto.randomUUID(), sessionId, principalId: "odysseus", backendId: "claude", at: 0 });
      acknowledgeSafety(db, `${sessionId}-turn`, "claude", 1);
    }
    const value = createTurnRecorder({ store, governanceDb: db, brainPath: BRAIN, governance: event => { recordGovernanceEvent(db, event); } },
      { turnId: `${sessionId}-turn`, sessionId, profile: "governed" });
    if (proxied) value.setEgressProxied();
    return value;
  };
  const start = (value: ReturnType<typeof recorder>, sessionId: string, id: string, tool: string, input: Record<string, unknown>) => {
    value.observeFrame({ type: "tool_use_start", sessionId, toolUseId: id, toolName: tool });
    value.observeFrame({ type: "tool_use_complete", sessionId, toolUseId: id, toolName: tool, input });
  };
  const finish = (value: ReturnType<typeof recorder>, sessionId: string, id: string) =>
    value.observeFrame({ type: "tool_result", sessionId, toolUseId: id, output: "fictional result", isError: false });
  const call = (value: ReturnType<typeof recorder>, sessionId: string, id: string, tool: string, input: Record<string, unknown>) => {
    start(value, sessionId, id, tool, input); finish(value, sessionId, id);
  };
  const taints = (sessionId: string) => queryGovernanceEvents(db, { sessionId, kinds: ["taint"], limit: 20 });
  return { db, recorder, start, finish, call, taints };
}

test("on a proxied turn, ordinary shell commands record no taint", () => {
  const { db, recorder, call, taints } = fixture();
  try {
    const turn = recorder("penelope", true);
    call(turn, "penelope", "help", "Bash", { command: "brain diagram --help" });
    call(turn, "penelope", "read", "Bash", { command: "cat notes/x.md" });
    call(turn, "penelope", "pi-read", "bash", { command: "cat notes/x.md | head -n 5" });
    expect(taints("penelope"), "G6_PROXIED_SHELL_STAYS_CLEAN").toHaveLength(0);
    turn.finish("success");
  } finally { db.close(); }
});

test("on a proxied turn, the non-shell sources still taint", () => {
  const { db, recorder, call, taints } = fixture();
  try {
    for (const [session, tool, input, source] of [
      ["web", "WebFetch", { url: "https://troy.example/" }, "web_fetch"],
      ["mail", "mcp__mail__read_message", { id: "suitors-letter" }, "mcp_document"],
      ["workspace", "Read", { file_path: `${BRAIN}/workspaces/troy/README.md` }, "workspace_read"],
      ["share", "Read", { file_path: ".brain-ui/inbox/sirens.md" }, "staged_share"],
    ] as const) {
      const turn = recorder(session, true);
      call(turn, session, "shell", "Bash", { command: "brain diagram --help" });
      call(turn, session, "source", tool, input);
      expect(taints(session), `G6_PROXIED_${source}`).toMatchObject([{ payload: { source, tool, detail: null } }]);
      turn.finish("success");
    }
  } finally { db.close(); }
});

test("without the proxy, the shell classifier still taints", () => {
  const { db, recorder, call, taints } = fixture();
  try {
    const turn = recorder("telemachus", false);
    call(turn, "telemachus", "help", "Bash", { command: "brain diagram --help" });
    expect(taints("telemachus"), "G6_UNPROXIED_SHELL_CLASSIFIED").toMatchObject([{ payload: { source: "unclassified_command", tool: "Bash" } }]);
    turn.finish("success");
    const fetching = recorder("eumaeus", false);
    call(fetching, "eumaeus", "curl", "Bash", { command: "curl https://troy.example/" });
    expect(taints("eumaeus"), "G6_UNPROXIED_FETCH_CLASSIFIED").toMatchObject([{ payload: { source: "fetching_command", tool: "Bash" } }]);
    fetching.finish("success");
  } finally { db.close(); }
});

function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!));
      response.once("error", reject);
    });
    child.once("error", reject); child.end();
  });
}

test("on a proxied turn, curl taints through the proxy's connection record, not the classifier", async () => {
  const { db, recorder, start, finish, call, taints } = fixture();
  const offline=recorder("argos",true,true);
  const troy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Troy") });
  const egress = await prepareTurnEgress({ controller: new AbortController(), policy: resolveGovernancePolicy({ schema_version: 1 }),
    turnId: "argos-turn", sessionId: () => "argos", model: () => null, profile: "governed", origin: "interactive",
    bridge: { requestPermission: async () => ({ behavior: "deny", message: "Odysseus declines" }), emit() {} } as unknown as BackendBridge,
    record: event => recordGovernanceEvent(db, event), governanceDb: db });
  try {
    // A curl whose result arrives without any admitted connection records nothing.
    call(offline, "argos", "offline", "Bash", { command: "curl https://troy.example/" });
    expect(taints("argos"), "G6_PROXIED_CURL_NOT_CLASSIFIED").toHaveLength(0);
    start(offline, "argos", "online", "Bash", { command: `curl ${troy.url.href}` });
    expect(await get(egress.socketPath, troy.url.href)).toBe(200);
    await egress.settled();
    finish(offline, "argos", "online");
    expect(taints("argos"), "G6_PROXIED_CURL_CONNECTION_TAINTS").toMatchObject([
      { payload: { source: "egress_connection", tool: null, detail: `GET 127.0.0.1:${troy.port}` } },
    ]);
    offline.finish("success");
  } finally { egress.stop(); troy.stop(true); db.close(); }
});
