import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBrainSurface } from "../scripts/evals/smart-capture/brain-fixture";
import { getContext, initContext, setContext } from "../packages/core/src/lib/context";
import { addCommand } from "../packages/core/src/cli/commands/add";
import { chooseThreshold, observe } from "../scripts/evals/smart-capture/metrics";
import { parseFrontmatter } from "../packages/core/src/lib/frontmatter-parse";
import { capture, deterministic, documents, fixtures, hybrid, MODEL, needsInference, prepare, request, scripted, snapshot, taxonomy } from "../scripts/evals/smart-capture/pipeline";

beforeEach(() => setSystemTime(new Date("2026-07-12T04:40:00Z")));
afterEach(() => setSystemTime());
const find = (id: string) => fixtures.find(f => f.id === id)!;
function retained(root: string, content: string) {
  return documents(root).some(d => parseFrontmatter(d.raw).content.includes(content.trim()));
}
test("the reviewed input shape covers custom/module types, ambiguity, tags, injection and a large state", () => {
  expect(fixtures).toHaveLength(26);
  expect(fixtures.filter(f => f.split === "tuning")).toHaveLength(8);
  expect(fixtures.filter(f => f.split === "held-out")).toHaveLength(18);
  expect(taxonomy.types.study!.owner).toBe("module:fixture-study");
  expect(taxonomy.types.ritual!.owner).toBe("user");
  expect(fixtures.find(f => f.category === "large-state")!.files["studies/holdout-bearings.md"]!.length).toBeGreaterThan(5000);
  expect(new Set(fixtures.map(f => f.category))).toEqual(new Set(["exact-title", "near-title", "custom-type", "module-type", "no-match", "duplicate-title", "explicit-fields", "injection", "multiple-targets", "append-disabled", "minimal-pair", "unknown-tags", "explicit-title", "requested-rewrite", "large-state", "unsupported-type", "negation"]));
});
for (const f of fixtures) test(`real hybrid control preserves full capture and pre-existing bodies: ${f.id}`, async () => {
  const p = await prepare(f);
  try {
    const plan = hybrid(f, p.root, scripted(f, p.root), 0.9);
    const out = await capture(f, p.root, plan);
    expect(retained(p.root, f.content)).toBe(true);
    for (const [path, raw] of Object.entries(f.files)) {
      const actual = readFileSync(join(p.root, path), "utf8");
      expect(parseFrontmatter(actual).content).toContain(parseFrontmatter(raw).content.trim());
      if (path !== f.expected.appendTarget) expect(actual).toBe(raw);
    }
    expect(out.action).toBe(f.expected.appendTarget ? "appended" : "created");
    expect(out.action === "appended" ? out.path : null).toBe(f.expected.appendTarget);
    expect(out.reviewTarget).toBe(f.expected.reviewTarget);
    if (!f.generation) {
      expect(out.type).toBe(f.expected.type);
      expect([...parseFrontmatter(readFileSync(join(p.root, out.path), "utf8")).data.tags].sort()).toEqual([...f.expected.tags].sort());
    }
  } finally { p.close(); }
});
test("complete expected append bytes are independent of the planner and writer", async () => {
  const f = find("t-exact"), p = await prepare(f);
  try {
    const expected = "---\ntype: project\ntitle: Raft departure\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [\"raft\", \"departure\"]\nstatus: active\n---\n\nCalypso has supplied timber and a sail. Odysseus checks the lashings before leaving Ogygia.\n\n## 2026-07-12 Update\n\nRaft departure\n\nOdysseus checked the mast support.\n";
    await capture(f, p.root, deterministic(f, p.root));
    expect(readFileSync(join(p.root, "projects/active/raft.md"), "utf8")).toBe(expected);
  } finally { p.close(); }
});
test("a provider's content-losing complete target cannot touch the disk", async () => {
  const f = find("t-exact"), p = await prepare(f);
  try {
    const plan = deterministic(f, p.root);
    plan.proposedRaw = plan.proposedRaw!.replace("Calypso has supplied timber and a sail. Odysseus checks the lashings before leaving Ogygia.\n\n", "");
    await capture(f, p.root, plan);
    expect(readFileSync(join(p.root, "projects/active/raft.md"), "utf8")).toBe(f.files["projects/active/raft.md"]!);
    expect(retained(p.root, f.content)).toBe(true);
  } finally { p.close(); }
});
test("a complete target dropping the capture also preserves target and original inbox body", async () => {
  const f = find("h-exact"), p = await prepare(f);
  try {
    const plan = deterministic(f, p.root); plan.proposedRaw = f.files["projects/active/court.md"];
    await capture(f, p.root, plan);
    expect(readFileSync(join(p.root, "projects/active/court.md"), "utf8")).toBe(f.files["projects/active/court.md"]!);
    expect(retained(p.root, f.content)).toBe(true);
  } finally { p.close(); }
});
test("a second exact-title target arriving after planning prevents an append", async () => {
  const f = find("h-exact"), p = await prepare(f);
  try {
    const plan = deterministic(f, p.root), original = f.files["projects/active/court.md"]!;
    writeFileSync(join(p.root, "projects/active/z-court-second.md"), original.replace("Penelope keeps", "A second record keeps"));
    await capture(f, p.root, plan);
    expect(readFileSync(join(p.root, "projects/active/court.md"), "utf8")).toBe(original);
    expect(retained(p.root, f.content)).toBe(true);
  } finally { p.close(); }
});
test("stale target bytes and changed metadata are preserved rather than appended", async () => {
  const f = find("t-exact"), p = await prepare(f);
  try {
    const plan = deterministic(f, p.root), changed = f.files["projects/active/raft.md"]!.replace("status: active", "status: paused");
    writeFileSync(join(p.root, "projects/active/raft.md"), changed);
    await capture(f, p.root, plan);
    expect(readFileSync(join(p.root, "projects/active/raft.md"), "utf8")).toBe(changed);
    expect(retained(p.root, f.content)).toBe(true);
  } finally { p.close(); }
});
test("an escaping target and a changed frontmatter field cannot authorize a write", async () => {
  const f = find("t-exact"), p = await prepare(f);
  try {
    for (const change of ["path", "metadata"]) {
      const plan = deterministic(f, p.root);
      if (change === "path") plan.target = "../outside.md";
      else plan.proposedRaw = plan.proposedRaw!.replace("status: active", "status: archived");
      await capture(f, p.root, plan);
      expect(readFileSync(join(p.root, "projects/active/raft.md"), "utf8")).toBe(f.files["projects/active/raft.md"]!);
      expect(retained(p.root, f.content)).toBe(true);
    }
  } finally { p.close(); }
});
test("missing, invalid, unknown model and provider failure use the same safe capture", async () => {
  const f = find("h-near");
  for (const result of [
    { outcome: "no_key" as const, answers: null, durationMs: 0 },
    { outcome: "timeout" as const, answers: null, durationMs: 10 },
    { outcome: "bad_response" as const, answers: null, durationMs: 1 },
    { outcome: "network_error" as const, answers: null, durationMs: 1 },
    { outcome: "answered" as const, model: "jev-other", answers: {}, durationMs: 1 },
  ]) {
    const p = await prepare(f);
    try {
      const baseline = deterministic(f, p.root);
      expect(hybrid(f, p.root, result, 0.9)).toEqual(baseline);
      await capture(f, p.root, hybrid(f, p.root, result, 0.9));
      expect(retained(p.root, f.content)).toBe(true);
      expect(snapshot(p.root)["projects/active/court.md"]).toBe(f.files["projects/active/court.md"]!);
    } finally { p.close(); }
  }
});
test("explicit fields and unique exact titles bypass the classifier; generation stays reserved", async () => {
  for (const id of ["t-exact", "h-explicit", "h-rewrite"]) {
    const f = find(id), p = await prepare(f);
    try { expect(needsInference(f, p.root)).toBe(false); } finally { p.close(); }
  }
});
test("request exposes only current configured types, candidates, explicit none and bounded per-tag judgments", async () => {
  const f = find("h-near"), p = await prepare(f);
  try {
    const r = request(f, p.root);
    expect(r.model).toBe(MODEL);
    expect(r.questions.type!.type).toBe("choice");
    expect(r.questions.target!.type).toBe("choice");
    expect(Object.keys(r.questions)).toHaveLength(11);
    expect((r.questions.target as any).criteria.none).toBeTruthy();
    expect(JSON.stringify(r.state)).toContain("Penelope keeps the court stores ledger");
    expect((r.state as Record<string, unknown>).capture).toBe(f.content);
  } finally { p.close(); }
});
test("actual fixture module loads through current CLI context and shipped add skill", async () => {
  const f = find("t-module"), p = await prepare(f);
  let previous = null;
  try { previous = getContext(); } catch { /* An uninitialised test process has no context. */ }
  try {
    const source = new URL("../", import.meta.url).pathname;
    installBrainSurface(p.root, source);
    const brain = await initContext({ root: p.root });
    expect(brain.taxonomy.types.study!.owner).toBe("module:fixture-study");
    expect(brain.taxonomy.appendMatchTypes()).toEqual(["project"]);
    expect(readFileSync(join(p.root, ".claude/skills/add/SKILL.md"), "utf8")).toBe(readFileSync(join(source, "packages/core/skills/add/SKILL.md"), "utf8"));
    let prompt = "", cwd = "";
    const agentRunner = { id: "fixture", capabilities: { streaming: false, skills: true }, async run(p: string, options: { cwd: string }) { prompt = p; cwd = options.cwd; return "Captured"; } };
    await addCommand.run([f.content, "--smart"], { brain, json: true, agentRunner });
    expect(prompt).toBe(`/add ${f.content}`);
    expect(cwd).toBe(p.root);
  } finally { setContext(previous); p.close(); }
});
test("real disk observation catches incorrect target writes even when source is retained", async () => {
  const f = find("h-ambiguous"), p = await prepare(f);
  try {
    const plan = deterministic(f, p.root);
    await capture(f, p.root, plan);
    const baseline = observe(f, p.root, plan);
    expect(baseline.contentLoss).toBe(false); expect(baseline.wrongTargetAppend).toBe(false);
    writeFileSync(join(p.root, "projects/active/orchard.md"), f.files["projects/active/orchard.md"]! + f.content);
    const changed = observe(f, p.root, plan);
    expect(changed.contentLoss).toBe(false); expect(changed.wrongTargetAppend).toBe(true);
  } finally { p.close(); }
});
test("held-out answers cannot calibrate; absent or unsafe semantic judgments cannot pass", async () => {
  const f = find("t-custom"), p = await prepare(f);
  try {
    const good = scripted(f, p.root);
    expect(chooseThreshold([{ fixture: f, plan: t => hybrid(f, p.root, good, t) }])).toBe(0.7);
    expect(() => chooseThreshold([{ fixture: find("h-recurring"), plan: t => hybrid(f, p.root, good, t) }])).toThrow("Held-out");
    const wrong = structuredClone(good);
    if (wrong.answers!.type!.type === "choice") wrong.answers!.type!.choice = "study";
    expect(chooseThreshold([{ fixture: f, plan: t => hybrid(f, p.root, wrong, t) }])).toBeNull();
  } finally { p.close(); }
});
