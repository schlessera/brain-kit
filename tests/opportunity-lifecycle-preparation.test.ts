import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, lutimesSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { apply, createConfiguredLab, inspect } from "../scripts/evals/opportunity-lifecycle/prototype";
import { openDatabase } from "../packages/core/src/lib/db";
import { doc, schedule } from "../scripts/evals/opportunity-lifecycle/fixtures";
import { observe, differences } from "../scripts/evals/opportunity-lifecycle/observation";
import { cli, successful } from "../scripts/evals/opportunity-lifecycle/cli";
import { NativeEvidence } from "../scripts/evals/opportunity-lifecycle/native-evidence";
import { prepare } from "../scripts/evals/opportunity-lifecycle/prepare";
import { readFileSync } from "node:fs";

const configuration = (enabled = true, fallback = true) => JSON.stringify({ reranker: { enabled: false },
  modules: { "@schlessera/brain-module-jobs": { enabled, criteria: "work/leads/criteria.md", opportunitiesDir: "work/leads", boards: [], queries: [] } },
  taxonomy: { types: { opportunity: { dir: fallback ? null : "work/leads" } }, canonical: { currentFocus: "context/now.md" } },
}, null, 2) + "\n";
function inputs(enabled = true) {
  const focus = "- [[work/leads/ithaca/status]] — Waiting to hear back.";
  return { focus, files: { "brain.config.json": configuration(enabled, enabled),
    "work/leads/ithaca/status.md": doc("opportunity", "Tracked role", "stage: applied\n", "## Contacts\n\n| Name | Role | Relationship | Notes |\n|------|------|--------------|-------|\n\n## Notes\n\nOdysseus retains this research.\n"),
    "work/leads/ithaca/research.md": doc("opportunity", "Research", "", "Odysseus retains this research.\n"),
    "work/leads/criteria.md": doc("note", "Criteria", "", "Keep the promised return to Ithaca.\n"),
    "context/now.md": doc("context", "Current focus", "", focus + "\n"),
  } };
}

test("complete observer detects same-byte touches, same-length link retargets and binary membership", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-observation-"));
  try {
    writeFileSync(join(root, "binary.bin"), Uint8Array.from([0, 255, 195, 128]));
    symlinkSync("binary-a.bin", join(root, "pointer"));
    lutimesSync(join(root, "pointer"), 10, 10); utimesSync(join(root, "binary.bin"), 10, 10);
    const before = observe(root);
    expect(before["binary.bin"]!.bytesBase64).toBe("AP/DgA==");
    unlinkSync(join(root, "pointer")); symlinkSync("binary-b.bin", join(root, "pointer")); lutimesSync(join(root, "pointer"), 10, 10);
    utimesSync(join(root, "binary.bin"), 11, 11); writeFileSync(join(root, "unexpected.txt"), "unintended");
    const changes = differences(before, observe(root));
    expect(changes.filter(row => row.path === "pointer")).toEqual([{ path: "pointer", fields: ["linkTarget"] }]);
    expect(changes.filter(row => row.path === "binary.bin")).toEqual([{ path: "binary.bin", fields: ["mtimeNs"] }]);
    expect(changes.filter(row => row.path === "unexpected.txt")).toEqual([{ path: "unexpected.txt", fields: ["added"] }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh disk-backed module fallback agrees with actual config and pipeline CLI", async () => {
  const input = inputs(), lab = await createConfiguredLab(input.files);
  try {
    expect(lab.authority!.jobsEnabled).toBe(true);
    expect(lab.opportunitiesDir).toBe("work/leads");
    const config = successful(await cli(lab, ["config", "check", "--json"]));
    expect(JSON.parse(config.stdout).valid).toBe(true);
    expect(successful(await cli(lab, ["config", "get", "modules.@schlessera/brain-module-jobs"])).stdout).toContain("work/leads");
    const planned = inspect(lab, schedule(), input.focus);
    if (planned.outcome !== "planned") throw new Error(planned.reason);
    expect(apply(lab, planned.plan, true).outcome).toBe("applied");
    const pipeline = successful(await cli(lab, ["jobs", "pipeline", "--json"]));
    expect(JSON.parse(pipeline.stdout).index).toBe("work/leads/_index.md");
    expect(observe(lab.root)["work/leads/_index.md"]!.bytesBase64).toBeDefined();
    successful(await cli(lab, ["index", "--force"]));
    const db = openDatabase(join(lab.root, "brain.db"));
    try {
      expect(db.query("SELECT path, deadline FROM documents WHERE deadline IS NOT NULL ORDER BY path").all()).toEqual([
        { path: "work/leads/ithaca/interview-prep.md", deadline: "2026-07-20" },
        { path: "work/leads/ithaca/status.md", deadline: "2026-07-20" },
      ]);
    } finally { db.close(); }
    expect(successful(await cli(lab, ["briefing"])).stdout).toContain("2026-07-20 | work/leads/ithaca/interview-prep.md");
  } finally { lab.close(); }
}, 30000);

test("disabled module and changed configuration refuse before any lifecycle source write", async () => {
  const input = inputs(false), lab = await createConfiguredLab(input.files);
  try {
    const before = observe(lab.root);
    const inspection = inspect(lab, schedule(), input.focus);
    const result = inspection.outcome === "planned" ? apply(lab, inspection.plan, true) : inspection;
    expect(differences(before, observe(lab.root))).toEqual([]);
    expect(result).toMatchObject({ outcome: "clarify", reason: "jobs module is unavailable" });
    writeFileSync(join(lab.root, "brain.config.json"), configuration(true, false));
    const edited = observe(lab.root);
    expect(inspect(lab, schedule(), input.focus)).toMatchObject({ outcome: "clarify", reason: "configuration changed; reload before planning" });
    expect(differences(edited, observe(lab.root))).toEqual([]);
  } finally { lab.close(); }
});

test("configuration revision participates in actual sealed-plan stale-write refusal", async () => {
  const input = inputs(), lab = await createConfiguredLab(input.files);
  try {
    const planned = inspect(lab, schedule(), input.focus);
    if (planned.outcome !== "planned") throw new Error(planned.reason);
    writeFileSync(join(lab.root, "brain.config.json"), configuration(false));
    const edited = observe(lab.root);
    const result = apply(lab, planned.plan, true);
    expect(differences(edited, observe(lab.root))).toEqual([]);
    expect(result.outcome).toBe("stale");
  } finally { lab.close(); }
});

test("native error transport retains split Unicode, final unnewline-framed usage and stderr after reader failure", async () => {
  const observer = new NativeEvidence();
  const result = { type: "result", subtype: "error_max_turns", label: "Ithaca — Ω", total_cost_usd: 1.25,
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 3, outputTokens: 11, cacheReadInputTokens: 0, cacheCreationInputTokens: 1 } } };
  const text = JSON.stringify(result), omega = Buffer.from(text).indexOf(Buffer.from("Ω"));
  const script = `const b=Buffer.from(${JSON.stringify(text)});process.stderr.write("retained native failure");process.stdout.write(b.subarray(0,${omega + 1}));setTimeout(()=>{process.stdout.write(b.subarray(${omega + 1}));},40);`;
  const child = observer.spawn({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, signal: new AbortController().signal });
  let sawReaderFailure = false;
  try { for await (const _chunk of child.stdout) throw new Error("controlled SDK reader rejected"); }
  catch { sawReaderFailure = true; }
  expect(sawReaderFailure).toBe(true);
  expect(await observer.drain()).toBe(true);
  expect(observer.rawBytes().toString()).toBe(text);
  expect(observer.rawStderr().toString()).toContain("retained native failure");
  expect(observer.frames).toHaveLength(1);
  expect(observer.frames[0]!.label).toBe("Ithaca — Ω");
  const accounting = observer.accounting();
  expect(accounting.complete).toBe(true);
  expect(accounting.rows[0]!.output).toBe(11);
  expect(accounting.result!.subtype).toBe("error_max_turns");
  expect(accounting.result!.total_cost_usd).toBe(1.25);
  expect(accounting.actualAdditionalBilledUsd).toBeNull();
});

test("unknown auxiliary model and missing cache counters retain raw usage as incomplete", async () => {
  const observer = new NativeEvidence();
  const result = { type: "result", subtype: "success", modelUsage: {
    "claude-haiku-4-5": { inputTokens: 12, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    "claude-sonnet-5-5": { inputTokens: 3, outputTokens: 1 },
  } };
  const child = observer.spawn({ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(result))});`], cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, signal: new AbortController().signal });
  child.stdout.resume();
  expect(await observer.drain()).toBe(true);
  expect(observer.accounting().complete).toBe(false);
  expect(observer.accounting().rows[0]!.input).toBe(12);
  expect(observer.accounting().rows[1]!.cacheRead).toBeNull();
  expect(observer.rawBytes().toString()).toBe(JSON.stringify(result));
});

test("forced native termination retains terminal diagnostics without claiming a complete workflow receipt", async () => {
  const observer = new NativeEvidence();
  const result = { type: "result", subtype: "error_max_turns", modelUsage: {
    "claude-sonnet-5-5": { inputTokens: 4, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  } };
  const child = observer.spawn({ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(result))});setInterval(()=>{},1000);`],
    cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, signal: new AbortController().signal });
  child.stdout.resume();
  await Bun.sleep(100);
  expect(await observer.drain(20)).toBe(false);
  expect(observer.native.processes[0]!.closed).toBe(true);
  expect(observer.native.processes[0]!.forcedKill).toBe(true);
  expect(observer.accounting().complete).toBe(false);
  expect(observer.accounting().retainedResults).toHaveLength(1);
  expect(observer.accounting().rows[0]!.output).toBe(12);
  expect(observer.rawBytes().toString()).toBe(JSON.stringify(result));
});

test("fresh lifecycle preparation includes the approved common workspace in complete source/runtime inventory",()=>{
 const parent=mkdtempSync(join(tmpdir(),"lifecycle-current-workspaces-")),output=join(parent,"review");
 try{
  expect(()=>prepare(output)).not.toThrow();
  const manifest=JSON.parse(readFileSync(join(output,"manifest.json"),"utf8"));
  expect(manifest.workspaces).toHaveLength(18);
  expect(manifest.workspaces.find((w:any)=>w.root==="packages/common").manifest.kind).toBe("file");
  for(const path of ["packages/common/src/frontmatter-parse.ts","packages/common/src/env-core.ts"])expect(manifest.sources[path].kind).toBe("file");
  const corpus=JSON.parse(readFileSync(join(output,"corpus.json"),"utf8"));expect(corpus).toHaveLength(16);expect(corpus.reduce((n:number,c:any)=>n+c.checkpoints.length,0)).toBe(24);
 }finally{rmSync(parent,{recursive:true,force:true});}
});
