import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, captureOffline, history, identical, main, noInternalNotes, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";

let captures: Captures;
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-probe.ts")); }, 180_000);

test("Pi captures three real resumed interactive turns and a tool result through Responses", () => {
  for (const [name, capture] of Object.entries(captures)) {
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
  for (const name of ["control", "repository", "promotion"]) for (const [a, b] of pairs(captures[name]!)) identical(system(a), system(b), `system ${name}`);
});
test("Pi ordinary messages retain every previous request and scripted answer", () => {
  for (const name of ["control", "repository", "facts", "budget"]) for (const [a, b] of pairs(captures[name]!)) history(a, b);
});
test("Pi requests contain no internal budget notes at the backend boundary", () => {
  for (const [name, capture] of Object.entries(captures)) if (name !== "budget") noInternalNotes(capture);
});
test.failing("Pi hosted requests contain no internal budget notes (#2051)", () => { noInternalNotes(captures.budget!); });
test.failing("Pi system stays identical across device and sandbox changes (#2047)", () => {
  for (const [a, b] of pairs(captures.facts!)) identical(system(a), system(b), "system facts");
});
test.failing("Pi hosted system stays identical across ambient changes (#2047)", () => {
  for (const [a, b] of pairs(captures.budget!)) identical(system(a), system(b), "system hosted");
});
test.failing("Pi promoted answer remains the exact provider answer (#2049)", () => {
  for (const [a, b] of pairs(captures.promotion!)) history(a, b);
});
test.todo("Pi typed -> voice -> typed tools (#2048): createPiTurnRunner rejects voice before acquiring a session; no provider request exists to compare", () => {});
