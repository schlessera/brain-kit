import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, captureOffline, history, identical, main, noInternalNotes, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";

let captures: Captures;
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-probe.ts")); }, 180_000);

test("Pi captures three real resumed interactive turns and a tool result through Responses", () => {
  for (const [name, capture] of Object.entries(captures)) {
    if (["reference", "renewal", "freshness"].includes(name)) continue;
    expect(capture.sessions).toHaveLength(3);
    expect(new Set(capture.sessions).size).toBe(1);
    expect(main(capture).map(e => e.turn)).toEqual([0, 0, 1, 2]);
    expect(main(capture).every(e => e.path === "/v1/responses")).toBe(true);
    expect(main(capture)[1]!.raw).toContain('"function_call_output"');
    if (name !== "promotion") expect(main(capture)[1]!.raw).toContain("Odysseus repairs the raft.");
  }
  expect(captures.budget!.budgets).toHaveLength(3);
  expect(captures.budget!.budgets![1]).not.toEqual(captures.budget!.budgets![0]);
});
test("Pi typed tools stay byte-identical across repository and device changes", () => {
  for (const capture of Object.values(captures)) for (const [a, b] of pairs(capture)) identical(body(a).tools, body(b).tools, "tools");
});
test("Pi tool round trips preserve the complete prefix even in known-break scenarios", () => {
  for (const capture of Object.values(captures)) for (const [a, b] of pairs(capture)) if (a.turn === b.turn) {
    identical(body(a).tools, body(b).tools, "tools within turn");
    identical(system(a), system(b), "system within turn");
    history(a, b);
  }
});
test("Pi stable system stays byte-identical on resume and repository changes", () => {
  for (const name of ["control", "repository", "promotion", "datatree"]) for (const [a, b] of pairs(captures[name]!)) identical(system(a), system(b), `system ${name}`);
});
test("Pi ordinary messages retain every previous request and scripted answer", () => {
  for (const name of ["control", "repository", "facts", "budget", "datatree"]) for (const [a, b] of pairs(captures[name]!)) history(a, b);
});
test("Pi requests contain no internal budget notes at the backend boundary", () => {
  for (const [name, capture] of Object.entries(captures)) if (name !== "budget") noInternalNotes(capture);
});
test("Pi hosted requests contain no internal budget notes (#2051)", () => { noInternalNotes(captures.budget!); });
test("Pi system stays identical across device and sandbox changes (#2047)", () => {
  for (const [a, b] of pairs(captures.facts!)) identical(system(a), system(b), "system facts");
});
test("Pi hosted system stays identical across ambient changes (#2047)", () => {
  for (const [a, b] of pairs(captures.budget!)) identical(system(a), system(b), "system hosted");
});
test("Pi promoted answer remains the exact provider answer (#2049)", () => {
  for (const [a, b] of pairs(captures.promotion!)) history(a, b);
});
test("Pi voice is refused before inference (#2048)", () => {
  expect(captures.control!.voiceRefusal!.message).toContain("declares no voice tool posture");
  expect(captures.control!.voiceRefusal!.after).toBe(captures.control!.voiceRefusal!.before);
});

// #2432: the worktree tool crosses the real worker pipe and server permission
// route on every turn, while the host's lifecycle answer changes.
test("Pi reference tools dispatch to the host and keep tools, system and history stable across the worktree lifecycle", () => {
  const capture = captures.reference!;
  for (const [a, b] of pairs(capture)) {
    identical(body(a).tools, body(b).tools, "REFERENCE_TOOLS_PI_TOOLS_STABLE");
    identical(system(a), system(b), "REFERENCE_TOOLS_PI_SYSTEM_STABLE");
  }
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  expect(main(capture).map(e => e.turn), "REFERENCE_TOOLS_PI_EVERY_TURN_CALLS").toEqual([0, 0, 1, 1, 2, 2]);
  expect(capture.calls, "REFERENCE_TOOLS_PI_HOST_RECEIVES_PARSED_INPUT").toEqual([
    { tool: "reference_worktree", input: { action: "request", repository: "https://github.com/odysseus/ithaca", revision: "main" } },
    { tool: "reference_worktree", input: { action: "release", worktreeId: "raft-worktree" } }]);
  const results = main(capture).filter((_, index) => index % 2 === 1);
  for (const exchange of results) expect(exchange.raw).toContain('"function_call_output"');
  expect(results[1]!.raw, "REFERENCE_TOOLS_PI_NO_HANDLER_REFUSES").toContain("no available host handler");
  expect(main(capture)[5]!.raw).toContain('\\"state\\":\\"released\\"');
  for (const [a, b] of pairs(capture)) {
    identical(body(a).tools, body(b).tools, "REFERENCE_TOOLS_PI_TOOLS_STABLE");
    identical(system(a), system(b), "REFERENCE_TOOLS_PI_SYSTEM_STABLE");
    history(a, b);
  }
  expect(body(main(capture)[0]!).tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["reference_source", "reference_worktree"]));
});

// #2751: every lifecycle step reaches the host through the worker pipe, including a
// successful renewal, and the shared source the host reports moves and then goes
// stale between turns. Only the newest tool result differs.
for (const [name, tool, label] of [["renewal", "reference_worktree", "RENEWAL"], ["freshness", "reference_source", "FRESHNESS"]] as const) {
  test(`Pi reference ${name} keeps tools, system and history stable while each turn's result changes`, () => {
    const capture = captures[name]!;
    expect(capture.sessions).toHaveLength(3);
    expect(new Set(capture.sessions).size).toBe(1);
    expect(main(capture).map(e => e.turn), `REFERENCE_${label}_PI_EVERY_TURN_CALLS`).toEqual([0, 0, 1, 1, 2, 2]);
    expect((capture.calls as { tool: string }[]).map(call => call.tool), `REFERENCE_${label}_PI_HOST_ANSWERS_EVERY_TURN`).toEqual([tool, tool, tool]);
    const results = main(capture).filter((_, index) => index % 2 === 1).map(exchange => exchange.raw);
    for (const raw of results) expect(raw).toContain('"function_call_output"');
    // The newest input item of each request carries that turn's tool result.
    const latest = main(capture).filter((_, index) => index % 2 === 1).map(exchange => JSON.stringify(body(exchange).input.at(-1)));
    expect(latest.map(text => text.includes("no available host handler") || text.includes('\\"ok\\":false')), `REFERENCE_${label}_PI_EVERY_RESULT_SUCCEEDS`).toEqual([false, false, false]);
    if (name === "renewal") expect(latest.map(text => /\\"action\\":\\"(\w+)\\"/.exec(text)?.[1]), "REFERENCE_RENEWAL_PI_LIFECYCLE_RESULTS").toEqual(["request", "renew", "release"]);
    else expect(latest.map(text => [/\\"freshness\\":\\"(\w+)\\"/.exec(text)?.[1], /\\"commit\\":\\"(\w)/.exec(text)?.[1]]), "REFERENCE_FRESHNESS_PI_SOURCE_RESULTS")
      .toEqual([["fresh", "1"], ["fresh", "2"], ["stale", "2"]]);
    for (const [a, b] of pairs(capture)) {
      identical(body(a).tools, body(b).tools, `REFERENCE_${label}_PI_TOOLS_STABLE`);
      identical(system(a), system(b), `REFERENCE_${label}_PI_SYSTEM_STABLE`);
      history(a, b);
    }
  });
}
