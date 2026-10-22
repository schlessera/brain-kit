import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeOutwardPlan, prepareOutwardPlan } from "@schlessera/brain-ui-sdk/internal";
import type { WorkerSandbox } from "../../ui-sdk/src/server/worker-sandbox.js";
import { launchFixtureAgentWorker } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { queryGovernanceEvents, recordGovernanceEvent, type GovernanceEventInput } from "../src/governance/events.js";
import { createOutwardCalls, prepareTurnEgress } from "../src/brain/turn-egress.js";

function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!));
      response.once("error", reject);
    });
    child.once("error", reject); child.end();
  });
}
function connectStatus(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", data => { text += data; const status = /^HTTP\/1\.1 (\d{3})/.exec(text); if (status) { socket.destroy(); resolve(Number(status[1])); } });
    // A tunnel closed without a status line reports 0.
    socket.on("close", () => resolve(0)); socket.on("error", reject);
  });
}
const bridge = (requestPermission: BackendBridge["requestPermission"]): BackendBridge => ({ requestPermission, emit() {} }) as unknown as BackendBridge;
const inputs = (controller: AbortController, policy: GovernancePolicyInput = { schema_version: 1 }) => ({
  controller, policy: resolveGovernancePolicy(policy), turnId: "turn-ithaca", sessionId: () => null,
  model: () => "claude-haiku-4-5", profile: "governed" as const, origin: "interactive" as const,
  bridge: bridge(async () => ({ behavior: "deny", message: "Odysseus declines" })),
});

test("a real turn proxy durably records bounded connection facts without the query", async () => {
  const db = createUiDb(":memory:");
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController()), record: event => recordGovernanceEvent(db, event) });
  try {
    expect(await get(proxy.socketPath, `${origin.url}voyage?private=odysseus-query`)).toBe(200);
    proxy.stop();
    const rows = queryGovernanceEvents(db, { kinds: ["egress_connection"], limit: 10 });
    expect(rows, "TURN_EGRESS_DURABLE_CONNECTION").toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: "turn-ithaca", actor: "interactive", profile: "governed",
      payload: { host: "127.0.0.1", port: origin.port, path: "/voyage", method: "GET", outcome: "completed" } });
    expect(JSON.stringify(rows)).not.toContain("odysseus-query");
    expect(proxy.recordingFailure()).toBeUndefined();
  } finally { proxy.stop(); origin.stop(true); db.close(); }
});

test("a zero-byte policy records refusal without contacting the origin", async () => {
  const db = createUiDb(":memory:"); let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  let proxy: Awaited<ReturnType<typeof prepareTurnEgress>> | undefined;
  try {
    let admissionError: unknown;
    try { proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, egress: { max_bytes_per_turn: 0 } }),
      record: event => recordGovernanceEvent(db, event) }); } catch (error) { admissionError = error; }
    expect(admissionError, "TURN_EGRESS_ZERO_CAP_ADMISSION_VALID").toBeUndefined();
    expect(await get(proxy!.socketPath, origin.url.href)).toBe(403);
    expect(calls, "TURN_EGRESS_ZERO_CAP_PREVENTS_CONTACT").toBe(0);
    expect(queryGovernanceEvents(db, { kinds: ["egress_connection"], limit: 10 })).toMatchObject([
      { payload: { outcome: "denied", reason: "max_bytes_per_turn", bytes: 0 } },
    ]);
    expect(queryGovernanceEvents(db, { kinds: ["egress_denial"], limit: 10 })).toMatchObject([
      { payload: { reason: "byte_cap", bytes: 0 } },
    ]);
    expect(proxy!.usedBytes()).toBe(0);
  } finally { proxy?.stop(); origin.stop(true); db.close(); }
});

const refusalCases: Array<[string, NonNullable<GovernancePolicyInput["egress"]>]> = [
  ["denied_host", { mode: "allowlist", allow: ["127.0.0.1"], deny: ["127.0.0.1"] }],
  ["not_allowlisted", { mode: "allowlist", allow: ["ithaca.invalid"] }],
  ["byte_cap", { max_bytes_per_turn: 1 }],
];
for (const [reason, egress] of refusalCases) test(`a real turn refusal durably retains ${reason} before contacting the origin`, async () => {
  const db = createUiDb(":memory:"); let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, egress }),
    record: event => recordGovernanceEvent(db, event) });
  try {
    expect(await get(proxy.socketPath, origin.url.href)).toBe(403);
    expect(calls, "TURN_EGRESS_REFUSAL_BEFORE_CONTACT").toBe(0);
    expect(queryGovernanceEvents(db, { kinds: ["egress_denial"], limit: 10 }), "TURN_EGRESS_DURABLE_DENIAL").toMatchObject([
      { payload: { host: "127.0.0.1", port: origin.port, method: "GET", reason, bytes: 0 } },
    ]);
    expect(proxy.recordingFailure()).toBeUndefined();
  } finally { proxy.stop(); origin.stop(true); db.close(); }
});

for (const failingKind of ["egress_connection", "egress_denial"] as const) test(`a failed ${failingKind} recorder aborts the owning turn and retains its failure`, async () => {
  const controller = new AbortController(); let attempts = 0;
  const proxy = await prepareTurnEgress({ ...inputs(controller, { schema_version: 1, egress: { mode: "allowlist", allow: [] } }),
    record(event) { attempts++; if (event.kind === failingKind) throw new Error("Fictional unavailable ledger"); } });
  try {
    await get(proxy.socketPath, "http://127.0.0.1:1/voyage").catch(() => undefined);
    expect(controller.signal.aborted, "TURN_EGRESS_FAILED_RECORD_ABORTS").toBe(true);
    expect(proxy.recordingFailure()?.message).toBe("Turn egress recording is unavailable");
    expect(controller.signal.reason).toBe(proxy.recordingFailure());
    expect(attempts).toBe(failingKind === "egress_connection" ? 1 : 2);
  } finally { proxy.stop(); }
});

test("a turn's outward connection waits for its bridge decision before contact", async () => {
  let calls = 0, approve!: (value: PermissionDecision) => void, observed!: () => void;
  let refuseMissingCard!: (error: Error) => void;
  const permission = new Promise<void>((resolve, reject) => { observed = resolve; refuseMissingCard = reject; });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, outward: { hosts: ["127.0.0.1"] } }),
    bridge: bridge(() => { observed(); return new Promise(resolve => { approve = resolve; }); }), record() {} });
  const response = get(proxy.socketPath, origin.url.href);
  const deadline = setTimeout(() => refuseMissingCard(new Error("TURN_EGRESS_OUTWARD_CARD_REQUIRED")), 5_000);
  try {
    await permission;
    expect(calls, "TURN_EGRESS_OUTWARD_WAITS_FOR_CARD").toBe(0);
    approve({ behavior: "allow" });
    expect(await response).toBe(200); expect(calls).toBe(1);
  } finally { clearTimeout(deadline); approve?.({ behavior: "deny", message: "Fixture cleanup" }); proxy.stop(); await response.catch(() => undefined); origin.stop(true); }
});

test("voice without a grant surface refuses the outward connection", async () => {
  let calls = 0, asks = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, outward: { hosts: ["127.0.0.1"] } }),
    origin: "voice", bridge: bridge(async () => { asks++; return { behavior: "allow" }; }), record() {} });
  try {
    expect(await get(proxy.socketPath, origin.url.href)).toBe(403);
    expect(calls).toBe(0); expect(asks, "TURN_EGRESS_VOICE_NO_APPROVAL_SURFACE").toBe(0);
  } finally { proxy.stop(); origin.stop(true); }
});

test("mail submission is outward by default: any host on a submission port and the built-in mail-send APIs ask first", async () => {
  const asked: unknown[] = [], records: GovernanceEventInput[] = [];
  let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController()),
    bridge: bridge(async request => { asked.push(request.input); return { behavior: "deny", message: "Penelope declines" }; }),
    record: event => { records.push(event); } });
  try {
    for (const target of ["mail.ithaca.invalid:587", "mail.ithaca.invalid:465", "mail.ithaca.invalid:25", "api.sendgrid.com:443", "gmail.googleapis.com:443"]) {
      expect(await connectStatus(proxy.socketPath, target), `TURN_EGRESS_MAIL_DEFAULT_${target}`).toBe(403);
    }
    expect(asked, "TURN_EGRESS_MAIL_DEFAULT_ASKS").toEqual([
      { host: "mail.ithaca.invalid", port: 587, method: "CONNECT" }, { host: "mail.ithaca.invalid", port: 465, method: "CONNECT" },
      { host: "mail.ithaca.invalid", port: 25, method: "CONNECT" }, { host: "api.sendgrid.com", port: 443, method: "CONNECT" },
      { host: "gmail.googleapis.com", port: 443, method: "CONNECT" }]);
    expect(records.filter(event => event.kind === "egress_connection").map(event => (event.payload as { reason?: string }).reason))
      .toEqual(Array(5).fill("outward_not_approved"));
    // An ordinary destination on another port is recorded without a card.
    expect(await get(proxy.socketPath, origin.url.href)).toBe(200);
    expect(asked).toHaveLength(5); expect(calls).toBe(1);
  } finally { proxy.stop(); origin.stop(true); }
});

const classified = (bridge: BackendBridge, toolUseId: string, command: string, behavior: "allow" | "deny" = "allow") =>
  observeOutwardPlan(prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command } }),
    { bridge, toolName: "Bash", toolUseId, input: { command }, decision: behavior === "allow" ? { behavior } : { behavior, message: "Declined" } });

test("an approved outward action covers only the hosts it names, and only while no unknown call runs", () => {
  const calls = createOutwardCalls();
  const bridge = { activity: calls.activity, emit: calls.emitted } as unknown as BackendBridge;
  expect(calls.covers("api.github.com"), "OUTWARD_EXCEPTION_NEEDS_A_CALL").toBe(false);
  classified(bridge, "comment", "gh issue comment 7 --repo odysseus/voyage --body Homeward");
  expect(calls.covers("api.github.com"), "OUTWARD_EXCEPTION_APPROVED_GH_WRITE").toBe(true);
  expect(calls.covers("smtp.ithaca.invalid")).toBe(false);
  classified(bridge, "script", "sh send.sh");
  expect(calls.covers("api.github.com"), "OUTWARD_EXCEPTION_WITHHELD_BESIDE_OPAQUE").toBe(false);
  bridge.emit({ type: "tool_result", sessionId: "ithaca", toolUseId: "script", output: "", isError: false });
  expect(calls.covers("api.github.com"), "OUTWARD_EXCEPTION_RESULT_ENDS_THE_OPAQUE_CALL").toBe(true);
  classified(bridge, "declined", "sh other.sh", "deny");
  expect(calls.covers("api.github.com"), "OUTWARD_EXCEPTION_DECLINED_CALL_NEVER_RUNS").toBe(true);
  bridge.emit({ type: "tool_result", sessionId: "ithaca", toolUseId: "comment", output: "", isError: false });
  expect(calls.covers("api.github.com"), "OUTWARD_EXCEPTION_ENDS_WITH_THE_CALL").toBe(false);
  classified(bridge, "push", "git push https://github.com/odysseus/voyage.git main");
  expect(calls.covers("github.com")).toBe(true);
  expect(calls.covers("api.github.com")).toBe(false);
});

test("a real worker's send.sh waits on the card while a classified gh read to the same host does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-turn-outward-")), brain = join(root, "brain");
  mkdirSync(brain);
  let contacts = 0, asks = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { contacts++; return new Response("Ithaca"); } });
  writeFileSync(join(brain, "send.sh"), `/usr/bin/curl --silent --fail --max-time 10 --data voyage ${origin.url.href}\n`);
  writeFileSync(join(brain, "read.sh"), `/usr/bin/curl --silent --fail --max-time 10 ${origin.url.href}\n`);
  const egress = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, outward: { hosts: ["127.0.0.1"] } }),
    bridge: bridge(async () => { asks++; return { behavior: "deny", message: "Odysseus declines" }; }), record() {} });
  const sandbox: WorkerSandbox = { brain, restricted: false, profile: "governed", areas: [], scratchAliasesRemoved: [], protection: { paths: [], ancestors: [] } };
  const run = async (script: string) => {
    const worker = launchFixtureAgentWorker({ brainPath: brain, command: ["/bin/sh", script], env: { PATH: "/usr/bin:/bin", HOME: "/tmp/odysseus" },
      sandbox, egress: { proxyDir: egress.dir }, turnTempBytes: 16 * 1024 * 1024 });
    try {
      worker.stdin.end();
      const [code, stdout] = await Promise.all([worker.exited, new Response(worker.stdout as never).text(), new Response(worker.stderr as never).text()]);
      return { code, stdout };
    } finally { worker.turnTemp?.close(); }
  };
  try {
    // The tool input shows only `sh send.sh`: unknown, so its connection asks.
    classified(egress.bridge, "send", "sh send.sh");
    const sent = await run("send.sh");
    expect(asks, "TURN_OUTWARD_UNCLASSIFIED_SCRIPT_ASKS").toBe(1);
    expect(sent.code).not.toBe(0);
    expect(contacts, "TURN_OUTWARD_DECLINED_BEFORE_CONTACT").toBe(0);
    egress.bridge.emit({ type: "tool_result", sessionId: "ithaca", toolUseId: "send", output: "", isError: true });
    // The proxy cannot see the process; the classified read in progress is the authority.
    classified(egress.bridge, "view", "gh issue view 7 --repo odysseus/voyage");
    const read = await run("read.sh");
    expect(read.code, "TURN_OUTWARD_CLASSIFIED_READ_CONNECTS").toBe(0); expect(read.stdout).toBe("Ithaca");
    expect(asks, "TURN_OUTWARD_CLASSIFIED_READ_NO_CARD").toBe(1);
    expect(contacts).toBe(1);
    egress.bridge.emit({ type: "tool_result", sessionId: "ithaca", toolUseId: "view", output: "", isError: false });
    expect((await run("read.sh")).code).not.toBe(0);
    expect(asks, "TURN_OUTWARD_READ_WINDOW_CLOSED").toBe(2);
  } finally { egress.stop(); origin.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("without a governance recorder the turn proxy still enforces its policy", async () => {
  let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress(inputs(new AbortController(), { schema_version: 1, egress: { mode: "allowlist", allow: ["ithaca.invalid"] } }));
  try {
    expect(await get(proxy.socketPath, origin.url.href), "TURN_EGRESS_UNRECORDED_STILL_ENFORCED").toBe(403);
    expect(calls).toBe(0); expect(proxy.recordingFailure()).toBeUndefined();
  } finally { proxy.stop(); origin.stop(true); }
});

test("the first admitted connection taints the session before its bytes; later turns keep contacted and taint-allowed hosts only", async () => {
  const db = createUiDb(":memory:");
  db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Ithaca',0,0)").run();
  const harbour = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const island = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("Aeaea") });
  const turn = async (turnId: string, policy: GovernancePolicyInput = { schema_version: 1 }) => prepareTurnEgress({ ...inputs(new AbortController(), policy),
    turnId, sessionId: () => "ithaca", record: event => recordGovernanceEvent(db, event), governanceDb: db });
  const events = (kind: "taint" | "egress_connection" | "egress_denial") => queryGovernanceEvents(db, { sessionId: "ithaca", kinds: [kind], limit: 20 });
  try {
    const first = await turn("turn-harbour");
    expect(await get(first.socketPath, harbour.url.href), "TURN_EGRESS_CLEAN_SESSION_CONNECTS").toBe(200);
    first.stop();
    const [taint] = events("taint");
    expect(taint, "TURN_EGRESS_CONNECTION_TAINTS").toMatchObject({ turnId: "turn-harbour", payload: { source: "egress_connection", tool: null, detail: `GET 127.0.0.1:${harbour.port}` } });
    // Admission records taint; the connection record follows when it ends.
    expect(taint!.id, "TURN_EGRESS_TAINT_PRECEDES_CONNECTION_RECORD").toBeLessThan(events("egress_connection")[0]!.id);
    // An attempt that never passed admission is not a contacted host.
    recordGovernanceEvent(db, { kind: "egress_connection", turnId: "turn-harbour", sessionId: "ithaca", actor: "interactive", model: null, profile: "governed",
      payload: { method: "CONNECT", host: "127.0.0.2", port: island.port!, bytes: 0, accounting: "opaque_bytes", durationMs: 1, outcome: "cancelled", reason: "turn_cancelled" } });
    const second = await turn("turn-island");
    expect(await get(second.socketPath, harbour.url.href), "TURN_EGRESS_CONTACTED_HOST_STAYS").toBe(200);
    expect(await get(second.socketPath, island.url.href), "TURN_EGRESS_TAINTED_NEW_HOST_REFUSED").toBe(403);
    second.stop();
    expect(events("egress_denial").map(event => event.payload)).toEqual([{ host: "127.0.0.2", port: island.port, method: "GET", reason: "taint_allowlist", bytes: 0 }]);
    const third = await turn("turn-allowed", { schema_version: 1, taint: { egress: { allow: ["127.0.0.2"] } } });
    expect(await get(third.socketPath, island.url.href), "TURN_EGRESS_TAINT_ALLOW_LIST").toBe(200);
    third.stop();
    expect(events("taint"), "TURN_EGRESS_FIRST_SOURCE_ONLY").toHaveLength(1);
  } finally { harbour.stop(true); island.stop(true); db.close(); }
});
