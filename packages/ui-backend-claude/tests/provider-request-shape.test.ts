import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, captureOffline, identical, main, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";
import { HOST_UNUSED_BUILTINS } from "../src/session-request-shape.js";
let captures: Captures;
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-request-shape-probe.ts"), { isolateManagedSettings: true }); }, 180_000);

// This is SDK assembly + real-runtime/relay proof. The worker boundary is
// exercised separately by provider-history.test.ts, never bypassed there.
test("new Claude sessions retain their removal selection and fixed batching brief", () => {
  const capture = captures.removed!;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
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
  expect(capture.budgets).toEqual([capture.budgets![0], capture.budgets![0], capture.budgets![0]]);
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
  for (const [a, b] of pairs(capture)) identical(system(a), system(b), "discovery system");
  const [discovered, ...resumed] = main(capture).slice(1);
  for (const exchange of resumed) identical(body(discovered!).tools, body(exchange).tools, "discovered roster survives resume");
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
