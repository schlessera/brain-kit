import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cycle, fixtureSha256, prepare } from "../scripts/evals/mechanical-hygiene/fixture";
import { observeTree, treeChanges } from "../scripts/evals/mechanical-hygiene/observer";
import { workload } from "../scripts/evals/mechanical-hygiene/workload";

test("the separate workload keeps all 24 original regression bytes and includes held-out positive repairs", () => {
  expect(fixtureSha256).toBe("dab00d2da767e9bca46590e99acd4c03a04cbb1da44d4cea9e79c2f20fd67689");
  expect(workload.filter(f => f.split === "tuning")).toHaveLength(6);
  expect(workload.filter(f => f.split === "held-out")).toHaveLength(12);
  const positive = workload.filter(f => f.split === "held-out" && f.category === "status-column");
  expect(positive).toHaveLength(3);
  for (const f of positive) expect(Object.keys(f.expected).some(path => f.files[path] !== f.expected[path])).toBe(true);
});

for (const f of workload) test(`${f.id}: actual detect/plan/apply/reconcile preserves exact authored content and repeat`, async () => {
  const env = prepare(f);
  try {
    const initial = observeTree(env.root);
    await cycle(env, true);
    expect(treeChanges(initial, observeTree(env.root))).toEqual({ created: [], deleted: [], content: [], metadata: [] });
    await cycle(env);
    for (const [path, expected] of Object.entries(f.expected)) expect(readFileSync(join(env.root, path), "utf8")).toBe(expected);
    const once = observeTree(env.root);
    await cycle(env);
    expect(treeChanges(once, observeTree(env.root))).toEqual({ created: [], deleted: [], content: [], metadata: [] });
  } finally { env.close(); }
});
