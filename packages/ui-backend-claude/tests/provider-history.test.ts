import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, captureOffline, history, identical, main, messages, noInternalNotes, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";

let captures: Captures;
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-probe.ts")); }, 180_000);

test("Claude captures three real resumed interactive turns and a tool result", () => {
  for (const [name, capture] of Object.entries(captures)) {
    if (name === "reference") continue;
    expect(capture.sessions).toHaveLength(3);
    expect(new Set(capture.sessions).size).toBe(1);
    expect(main(capture).map(e => e.turn)).toEqual([0, 0, 1, 2]);
    expect(main(capture).every(e => e.path === "/v1/messages")).toBe(true);
    expect(main(capture)[1]!.raw).toContain('"tool_result"');
    expect(main(capture)[1]!.raw).not.toContain('"is_error":true');
    if (name !== "promotion") expect(main(capture)[1]!.raw).toContain("Odysseus repairs the raft.");
  }
  expect(captures.budget!.budgets).toHaveLength(3);
  expect(captures.budget!.budgets![1]).not.toEqual(captures.budget!.budgets![0]);
  identical(captures.facts!.appends[0], captures.facts!.appends[1], "stable facts append");
});
test("Claude typed tools stay byte-identical across repository and device changes", () => {
  for (const name of ["control", "repository", "facts", "promotion", "budget"]) for (const [a, b] of pairs(captures[name]!)) identical(body(a).tools, body(b).tools, `tools ${name}`);
});
test("Claude tool round trips preserve the complete prefix even in known-break scenarios", () => {
  for (const capture of Object.values(captures)) for (const [a, b] of pairs(capture)) if (a.turn === b.turn) {
    identical(body(a).tools, body(b).tools, "tools within turn");
    identical(system(a), system(b), "system within turn");
    history(a, b);
  }
});
test("Claude stable system stays byte-identical on resume", () => {
  for (const name of ["control", "posture", "promotion", "budget"]) for (const [a, b] of pairs(captures[name]!)) identical(system(a), system(b), `system ${name}`);
});
test("Claude ordinary messages retain every previous request and scripted answer", () => {
  for (const name of ["control", "repository", "facts", "posture", "budget"]) for (const [a, b] of pairs(captures[name]!)) history(a, b);
});
test("Claude requests contain no internal budget notes at the backend boundary", () => {
  for (const [name, capture] of Object.entries(captures)) if (name !== "budget") noInternalNotes(capture);
});
test("Claude hosted requests contain no internal budget notes (#2051)", () => { noInternalNotes(captures.budget!); });
test("Claude system stays identical across repository changes on local resume (#2046)", () => {
  for (const [a, b] of pairs(captures.repository!)) identical(system(a), system(b), "system repository");
});
test("Claude system stays identical across device and sandbox changes on resume (#2047)", () => {
  // Hold both actual request bytes and the supplied SDK option below.
  for (const [a, b] of pairs(captures.facts!)) identical(system(a), system(b), "system facts");
});
// The local CLI replays turn 1's recorded system, which would hide a changed
// append at the provider boundary. The SDK documents that recording as
// account-gated, so the guard also holds the option brain-kit hands it.
test("Claude system-prompt option stays identical on resume", () => {
  for (const name of ["control", "repository", "promotion", "budget"]) {
    const [first, ...rest] = captures[name]!.appends;
    for (const next of rest) identical(first, next, `systemPrompt option ${name}`);
  }
});
test("Claude system-prompt option stays identical across device and sandbox changes (#2047)", () => {
  const [first, ...rest] = captures.facts!.appends;
  for (const next of rest) identical(first, next, "systemPrompt option facts");
});
test("Claude tools stay identical typed -> voice -> typed (#2048)", () => {
  for (const [a, b] of pairs(captures.posture!)) identical(body(a).tools, body(b).tools, "tools posture");
});
test("Claude promoted answer remains the exact provider answer (#2049)", () => {
  for (const [a, b] of pairs(captures.promotion!)) history(a, b);
});
test("title traffic is suppressed only by the explicit disable-nonessential flag (#2052)", () => {
  for (const [name, capture] of Object.entries(captures)) if (name !== "title") identical([], capture.exchanges.filter(e => !e.main).map(body), "auxiliary title requests with explicit suppression");
  const helpers = captures.title!.exchanges.filter(e => !e.main);
  expect(helpers).toHaveLength(1);
  expect(helpers[0]!.turn).toBe(0);
  expect(body(helpers[0]!).tools ?? []).toHaveLength(0);
  expect(body(helpers[0]!).model).toBe(body(main(captures.title!)[0]!).model);
  for (const [a, b] of pairs(captures.title!)) { identical(system(a), system(b), "system with title helper"); identical(body(a).tools, body(b).tools, "tools with title helper"); history(a,b); }
});

// #2432: the worktree tool runs through the installed CLI and its MCP route on
// every turn, while the host's lifecycle answer and the sandbox views change.
test("Claude reference tools dispatch to the host and keep tools, system and history stable across the worktree lifecycle", () => {
  const capture = captures.reference!;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  expect(main(capture).map(e => e.turn), "REFERENCE_TOOLS_CLAUDE_EVERY_TURN_CALLS").toEqual([0, 0, 1, 1, 2, 2]);
  expect(capture.calls, "REFERENCE_TOOLS_CLAUDE_HOST_RECEIVES_PARSED_INPUT").toEqual([
    { tool: "reference_worktree", input: { action: "request", repository: "https://github.com/odysseus/ithaca", revision: "main" } },
    { tool: "reference_worktree", input: { action: "release", worktreeId: "raft-worktree" } }]);
  const results = main(capture).filter((_, index) => index % 2 === 1);
  for (const exchange of results) expect(exchange.raw).toContain('"tool_result"');
  // The newest message of each request carries that turn's tool result.
  const latest = results.map(exchange => JSON.stringify(messages(exchange).at(-1)));
  expect(latest.map(text => text.includes('"is_error":true')), "REFERENCE_TOOLS_CLAUDE_NO_HANDLER_REFUSES").toEqual([false, true, false]);
  expect(latest[1]).toContain("no available host handler");
  expect(main(capture)[5]!.raw).toContain('\\"state\\":\\"released\\"');
  for (const [a, b] of pairs(capture)) {
    identical(body(a).tools, body(b).tools, "REFERENCE_TOOLS_CLAUDE_TOOLS_STABLE");
    identical(system(a), system(b), "REFERENCE_TOOLS_CLAUDE_SYSTEM_STABLE");
    history(a, b);
  }
  const [first, ...rest] = capture.appends;
  for (const next of rest) identical(first, next, "REFERENCE_TOOLS_CLAUDE_SYSTEM_OPTION_STABLE");
  expect(body(main(capture)[0]!).tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["mcp__brain-ui__reference_source", "mcp__brain-ui__reference_worktree"]));
});
