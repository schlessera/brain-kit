import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, captureOffline, history, identical, main, noInternalNotes, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";

let captures: Captures;
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-probe.ts")); }, 180_000);

test("Claude captures three real resumed interactive turns and a tool result", () => {
  for (const [name, capture] of Object.entries(captures)) {
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
