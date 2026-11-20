import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, bytes, captureOffline, identical, main, pairs, providerTools, qualifyHistory, system, type Captures } from "../../../tests/helpers/provider-history.js";
import { HOST_UNUSED_BUILTINS } from "../src/session-request-shape.js";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import baseline from "./fixtures/legacy-sdk-inputs.json" with { type: "json" };
let captures: Captures;
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-request-shape-probe.ts"), { isolateManagedSettings: true }); }, 180_000);

// This is SDK assembly + real-runtime/relay proof. The worker boundary is
// exercised separately by provider-history.test.ts, never bypassed there.
test("new Claude sessions retain their removal selection and fixed batching brief", () => {
  const capture = captures.removed!;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  for (const input of capture.budgets as any[]) {
    for (const name of HOST_UNUSED_BUILTINS) expect(input.disallowed, "PRODUCTION_REMOVAL_SELECTION").toContain(name);
    expect(input.disallowed).not.toContain("NotebookEdit");
    expect(input.env).toBe("true");
    expect(input.settings).toBe("true");
  }
  for (const exchange of main(capture)) {
    const names = body(exchange).tools.map((tool: { name: string }) => tool.name);
    for (const name of HOST_UNUSED_BUILTINS) expect(names, `NEW_SESSION_REMOVES_${name}`).not.toContain(name);
    expect(names).toContain("mcp__brain-ui__reference_source");
    expect(names).toContain("mcp__brain-ui__reference_worktree");
    expect(JSON.stringify(system(exchange)), "CLAUDE_BATCHING_BRIEF_REACHES_WIRE").toContain("Batch your");
  }
  for (const append of capture.appends) expect(JSON.stringify(append), "CLAUDE_BATCHING_BRIEF_SDK_INPUT").toContain("Batch your");
  for (const [a, b] of pairs(capture)) { identical(body(a).tools, body(b).tools, "new session tool roster"); identical(system(a), system(b), "new session system"); }
  expect(capture.budgets).toEqual([capture.budgets![0], capture.budgets![0], capture.budgets![0]]);
});

test("a removed built-in returns the ordinary unknown-tool result and the turn continues", () => {
  const exchanges = main(captures.removed!);
  expect(exchanges).toHaveLength(4);
  expect(exchanges[1]!.raw, "REMOVED_BUILTIN_UNKNOWN_TOOL").toContain("No such tool available: SendMessage");
  expect(exchanges[1]!.raw).toContain('"is_error":true');
  expect(captures.removed!.sessions).toHaveLength(3);
});

test("legacy sessions retain SDK inputs and wire tools after metadata and append upgrade", () => {
  const capture = captures.legacy!;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  expect(capture.qualification!.baseline).toEqual({ source: baseline.source, initialized: false });
  for (const input of capture.budgets as any[]) {
    identical(baseline.disallowedTools, input.disallowed, "INDEPENDENT_LEGACY_DISALLOW_INPUT");
    identical(baseline.allowedTools, input.allowed, "INDEPENDENT_LEGACY_ALLOW_INPUT");
    expect(input.env).toBeUndefined();
    expect(input.settings).toBeUndefined();
    // Only the transport socket/credential differ from the recorded old inputs.
    const { env, ...flags } = input.flagSettings;
    identical({ ...baseline.settings, env: undefined }, { ...flags, env: undefined }, "INDEPENDENT_LEGACY_FLAGS");
    const { ANTHROPIC_UNIX_SOCKET: _socket, CLAUDE_CODE_OAUTH_TOKEN: _oauth, ANTHROPIC_API_KEY: _key, ...oldEnv } = baseline.settings.env;
    const { ANTHROPIC_UNIX_SOCKET: _newSocket, CLAUDE_CODE_OAUTH_TOKEN: _newOauth, ANTHROPIC_API_KEY: _newKey, ...newEnv } = env;
    identical(oldEnv, newEnv, "INDEPENDENT_LEGACY_SETTINGS_ENV");
  }
  for (const append of capture.appends) identical(capture.appends[0], append, "LEGACY_APPEND_SDK_INPUT");
  for (const exchange of main(capture)) {
    expect(body(exchange).tools.some((tool: { name: string }) => tool.name === "SendMessage")).toBe(true);
    expect(JSON.stringify(system(exchange))).toContain("Odysseus retains the original system brief.");
    expect(JSON.stringify(system(exchange))).not.toContain("Batch your");
  }
  for (const [a, b] of pairs(capture)) { identical(body(a).tools, body(b).tools, "LEGACY_TOOLS_SURVIVE_METADATA_UPGRADE"); identical(system(a), system(b), "LEGACY_SYSTEM_WIRE"); }
});

test("relay qualification sees inline reads, every bridge tool, deferred graph and forwarded discovery beta", () => {
  const capture = captures.discovery!, first = body(main(capture)[0]!), next = body(main(capture)[1]!);
  const names = first.tools.map((tool: { name: string }) => tool.name);
  expect(names).toContain("ToolSearch");
  for (const name of ["brain_context", "brain_list", "brain_read", "brain_read_many", "brain_search"]) expect(names).toContain(`mcp__brain__${name}`);
  expect(names.filter((name: string) => name.startsWith("mcp__brain__"))).toHaveLength(5);
  const bridge = names.filter((name: string) => name.startsWith("mcp__brain-ui__"));
  expect(bridge.length).toBeGreaterThan(0);
  expect(bridge).toEqual(body(main(captures.gateway!)[0]!).tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith("mcp__brain-ui__")));
  expect(first.tools.filter((tool: { name: string }) => tool.name.startsWith("mcp__brain-ui__")).every((tool: { defer_loading?: boolean }) => !tool.defer_loading)).toBe(true);
  expect(next.tools.find((tool: { name: string }) => tool.name === "mcp__brain__brain_graph")?.defer_loading).toBe(true);
  expect(main(capture)[1]!.raw).toContain('"tool_reference"');
  expect((capture.calls![0] as { beta: string }).beta).toContain("advanced-tool-use");
  for (const append of capture.appends) identical(capture.appends[0], append, "discovery SDK append");
  const qualifications = [];
  for (const [a, b] of pairs(capture)) {
    identical(system(a), system(b), "discovery system");
    // Includes the first pre-discovery -> discovered request, not just resumes.
    providerTools(a, b, "DISCOVERY_PRIOR_DEFINITIONS");
    const qualification = qualifyHistory(a, b);
    if (qualification) qualifications.push(qualification);
  }
  // #4324 remains a real strict-history failure; this fixture records only that
  // exact reproduction while retaining every other byte assertion.
  expect(qualifications.some(value => value.issue === 4324), "RECORDED_4324_REPRODUCTION").toBe(true);
  const old = Buffer.from(bytes(first.tools)), actual = Buffer.from(bytes(next.tools));
  const oldNames = new Set(first.tools.map((tool: any) => tool.name));
  const additions = next.tools.filter((tool: any) => !oldNames.has(tool.name));
  const appended = Buffer.from(bytes([...first.tools, ...additions]));
  const common = (a: Buffer, b: Buffer) => { let n = 0; while (n < Math.min(a.length, b.length) && a[n] === b[n]) n++; return n; };
  const prefix = { priorBytes: old.length, insertedBytes: actual.length, insertionPrefixBytes: common(old, actual), appendPrefixBytes: common(old, appended) };
  expect(prefix.insertionPrefixBytes).toBeLessThan(prefix.appendPrefixBytes);
  console.log("KEYLESS_TOOL_PREFIX_BYTES", JSON.stringify(prefix));
  const [discovered, ...resumed] = main(capture).slice(1);
  for (const exchange of resumed) identical(body(discovered!).tools, body(exchange).tools, "discovered roster survives resume");
});

test("production gateway pin and deadline factor reach the runtime unchanged", () => {
  for (const input of captures.gateway!.budgets as any[]) {
    expect(input.env, "GATEWAY_PRODUCTION_ENV_PIN").toBe("false");
    expect(input.settings, "GATEWAY_PRODUCTION_SETTINGS_PIN").toBe("false");
  }
  expect(body(main(captures.gateway!)[0]!).tools.some((tool: any) => tool.name === "ToolSearch")).toBe(false);
  for (const capture of Object.values(captures)) expect(capture.qualification!.watchdogMs).toBe(watchdogMs(45_000));
});

test("fast-mode keyless relay qualification records requested and effective API and subscription speed", () => {
  for (const name of ["fast-api", "fast-subscription"]) {
    const capture = captures[name]!;
    expect(capture.sessions).toHaveLength(3);
    expect(capture.rosters?.map(value => JSON.parse(value!))).toEqual(Array.from({ length: 3 }, () => ({ version: "2.1.293", state: "on" })));
    expect((capture.budgets![0] as { requestedFast: boolean }).requestedFast).toBe(true);
    for (const exchange of main(capture)) expect(body(exchange).speed, "FAST_MODE_RELAY_WIRE_QUALIFICATION").toBe("fast");
    for (const [a, b] of pairs(capture)) {
      identical(body(a).tools, body(b).tools, "FAST_MODE_TOOLS_STABLE");
      identical(system(a), system(b), "FAST_MODE_SYSTEM_STABLE");
      qualifyHistory(a, b); // #4324 qualification only, never a clean-history claim.
    }
  }
  expect(JSON.parse(captures.gateway!.rosters![0]!)).toEqual({ version: "2.1.293", state: "off", reason: "sdk_opt_in_required" });
});

test("fast-mode native refusal reasons remain named instead of being mistaken for effective fast output", () => {
  const disabled = captures["fast-disabled"]!;
  for (const value of disabled.rosters!) expect(JSON.parse(value!)).toEqual({ version: "2.1.293", state: "off", reason: "disabled_by_env" });
  for (const exchange of main(disabled)) expect(body(exchange).speed).toBeUndefined();
  expect(captures["fast-thirdparty"]!.rosters?.map(value => JSON.parse(value!))).toEqual([{ version: "2.1.293", state: "off", reason: "not_first_party" }]);
  expect(captures["fast-thirdparty"]!.exchanges).toHaveLength(0);
});

test("each selected native removal is tried through the hosted SDK hooks and relay", () => {
  const capture = captures.builtins!, results = new Map<string, string>();
  for (const exchange of main(capture)) for (const message of body(exchange).messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (part.type === "tool_result") results.set(part.tool_use_id, JSON.stringify(part.content));
  }
  const tried = new Map<string, string>();
  for (const exchange of main(capture)) for (const part of exchange.answer.content as Array<{ type: string; name: string; id: string }>) {
    if (part.type === "tool_use") tried.set(part.name, results.get(part.id) ?? "MISSING_RESULT");
  }
  const outcomes = {
    CronCreate: "Session-only", CronList: "session-only", CronDelete: "Cancelled job",
    ScheduleWakeup: "Next wakeup scheduled", RemoteTrigger: "No such tool available: RemoteTrigger",
    SendMessage: "No agent named", ListAgents: "No reachable agents", NotebookEdit: "Native writes require a governed typed turn",
  };
  expect(tried.get("NotebookEdit"), "NOTEBOOK_GOVERNED_CONTRACT_RETAINED").toContain(outcomes.NotebookEdit);
  for (const name of HOST_UNUSED_BUILTINS) expect(tried.get(name), `NATIVE_TOOL_QUALIFICATION_${name}`).toContain(outcomes[name as keyof typeof outcomes]);
  // Working native controls stay available; an unknown named Workflow is
  // insufficient evidence for removing the executor itself.
  expect(tried.get("EnterPlanMode")).toContain("Entered plan mode");
  expect(tried.get("ExitPlanMode")).toContain("approved exiting plan mode");
  expect(tried.get("EnterWorktree")).toContain("Created worktree");
  expect(tried.get("ExitWorktree")).toContain("Exited worktree");
  expect(tried.get("ReportFindings")).toContain("No findings reported");
  expect(tried.get("Workflow")).toContain("not found");
});
