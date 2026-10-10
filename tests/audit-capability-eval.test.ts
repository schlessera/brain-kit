import { expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixtures, prepare, DAY } from "../scripts/evals/audit-capabilities/fixtures";
import { capability, applyFixtureCandidate } from "../scripts/evals/audit-capabilities/prototype";
import { controlReport } from "../scripts/evals/audit-capabilities/run";

// The shipped-command assertions this file used to hold live in
// tests/audit-shipped-capabilities.test.ts (#1386).

test("draft document groups stay separate across tuning and held-out fixtures", () => {
  const tuning = new Set(fixtures.filter(f => f.split === "tuning").map(f => f.group));
  expect(tuning.size).toBeGreaterThan(0);
  expect(fixtures.filter(f => f.split === "held-out").length).toBeGreaterThan(0);
  for (const f of fixtures.filter(f => f.split === "held-out")) expect(tuning.has(f.group)).toBe(false);
});

for (const f of fixtures) test(`${f.id}: capability follows actual handlers, never the finding message`, () => {
  const p = prepare(f);
  try {
    const c = capability(p.root, p.taxonomy, f.finding, DAY);
    expect(c.handlerAvailable).toBe(f.available);
    expect(c.executionAuthorized).toBe(false);
    expect(c.suggestion.length).toBeGreaterThan(0);
    for (const [path, raw] of Object.entries(f.files)) expect(readFileSync(join(p.root, path), "utf8")).toBe(raw);
  } finally { p.close(); }
});

test("unsupported TODO cannot invoke a real registry writer even with fixture authorization", () => {
  const f = fixtures.find(f => f.id === "todo-tuning")!;
  const p = prepare(f);
  try {
    const r = applyFixtureCandidate(p.root, p.taxonomy, f.finding, DAY, true);
    expect(r.written).toEqual([]);
    expect(readFileSync(join(p.root, f.finding.path), "utf8")).toBe(f.files[f.finding.path]!);
  } finally { p.close(); }
});

test("escaping symlinks never become available registry handlers", () => {
  const p = prepare(fixtures[0]!); const outside = prepare(fixtures[0]!);
  try {
    symlinkSync(outside.root, join(p.root, "linked"));
    const c = capability(p.root, p.taxonomy, { ...fixtures[0]!.finding, path: "linked/rituals/_index.md" }, DAY);
    expect(c.reason).toBe("unsafe or aggregate path");
    expect(c.handlerAvailable).toBe(false);
  } finally { p.close(); outside.close(); }
});

test("offline controls do not manufacture live quality, savings or adoption measurements", () => {
  const r = controlReport(); expect(r.cases).toBe(14); expect(r.expectedHandlers).toBe(2);
  expect(r.results).toHaveLength(14); expect(r.results.every(row => row.correct)).toBe(true); expect(r.adoption).toBe("not measured");
  expect(Object.keys(r.live)).toHaveLength(9);
  for (const value of Object.values(r.live)) expect(value).toBeNull();
});
