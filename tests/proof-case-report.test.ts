import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkout } from "../scripts/proof-inputs";
import { balanceBrowserSpecs, readBrowserCosts } from "../scripts/browser-shards";
import { caseReportProblems } from "../scripts/proof-case-report.mjs";

test("real Vitest receipts expand parameter cases, retain project ownership and refuse incomplete evidence", async () => {
  const root = resolve(import.meta.dir, "..");
  await mkdir(resolve(root, "tmp"), { recursive: true });
  const dir = await mkdtemp(resolve(root, "tmp/proof-case-fixture-"));
  const output = resolve(dir, "receipt.json");
  try {
    await writeFile(resolve(dir, "case.test.ts"), `import { expect, test } from "vitest";
      import { readlinkSync } from "node:fs";
      import { networkInterfaces } from "node:os";
      test("explicit native offline namespace", () => {
        expect(readlinkSync("/proc/self/ns/net")).not.toBe(process.env.PROOF_PARENT_NET);
        expect(Object.keys(networkInterfaces()).every(name => name === "lo")).toBe(true);
      });
      test.each([1, 2])("expanded %i", value => expect(value).toBeGreaterThan(0));
      test("same title", () => expect(true).toBe(true));
      test("same title", () => expect(false).toBe(false));
      if (process.env.PROOF_FIXTURE_FAILURE) {
        test.skip("deliberately skipped", () => expect(false).toBe(true));
        test("deliberately failed", () => expect("actual").toBe("expected"));
      }
    `);
    await writeFile(resolve(dir, "vitest.config.mjs"), `import { MeasuredBrowserSequencer } from ${JSON.stringify(resolve(root, "scripts/browser-sequencer.ts"))};
      export default { test: {
      sequence: { sequencer: MeasuredBrowserSequencer },
      reporters: ["default", [${JSON.stringify(resolve(root, "scripts/proof-case-report.mjs"))}, { output: ${JSON.stringify(output)} }]],
      projects: ["proof-one", "proof-two"].map(name => ({ test: { name, root: ${JSON.stringify(dir)}, include: ["case.test.ts"] } }))
    }};`);
    const run = async (failure: boolean, shard?: string) => {
      // Bun's child preload does not instrument Node. Isolate this real Node
      // runner and all its workers at the OS boundary, with loopback only.
      const child = Bun.spawn(["unshare", "--user", "--map-root-user", "--net", "sh", "-c", 'ip link set lo up && exec "$@"', "proof-case-fixture",
        Bun.which("node")!, resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", resolve(dir, "vitest.config.mjs"), ...(shard ? [`--shard=${shard}`] : [])], {
        cwd: dir, env: { ...process.env, PROOF_PARENT_NET: await readlink("/proc/self/ns/net"), PROOF_FIXTURE_FAILURE: failure ? "1" : "" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr, report: JSON.parse(await readFile(output, "utf8")) };
    };
    const passed = await run(false);
    expect(passed.code, passed.stderr).toBe(0);
    expect(passed.stdout).toContain("10 passed");
    const report = passed.report;
    const identity = checkout(root);
    expect(report.checkout).toEqual(identity);
    const selected = ["proof-one", "proof-two"].map(project => ({ project, file: `${dir.slice(root.length + 1)}/case.test.ts` }));
    expect(report.modules.map((module: { project: string }) => module.project).sort()).toEqual(["proof-one", "proof-two"]);
    expect(report.modules[0].cases.map((item: { name: string }) => item.name)).toEqual(["explicit native offline namespace", "expanded 1", "expanded 2", "same title", "same title"]);
    expect(caseReportProblems(report, selected, identity)).toEqual([]);
    // Production sequencer partitions execution after onTestRunStart reports
    // the whole requested domain. Expectations come from source selection.
    const key = (spec: { project: string; file: string }) => `${spec.project}::${spec.file}`;
    const partitions = balanceBrowserSpecs(selected.map(spec => ({ ...spec, key: key(spec) })), 2, readBrowserCosts())
      .map(part => part.map(({ project, file }) => ({ project, file })));
    const shardReports = [];
    for (let i = 0; i < partitions.length; i++) {
      const sharded = await run(false, `${i + 1}/2`);
      expect(sharded.code, sharded.stderr).toBe(0);
      expect(sharded.stdout).toContain("5 passed");
      expect(sharded.report.selected.map(key).sort()).toEqual(selected.map(key).sort());
      expect(sharded.report.modules.map(key).sort()).toEqual(partitions[i]!.map(key).sort());
      const selection = { version: 1 as const, requested: selected, executed: partitions[i]! };
      expect(caseReportProblems(sharded.report, selection, identity)).toEqual([]);
      // The array shorthand is strictly unsharded: it must not excuse the
      // pre-shard ownership discrepancy which exposed this regression.
      expect(caseReportProblems(sharded.report, partitions[i]!, identity)).toContain("omitted or unexpected selected case-report ownership");
      for (const field of ["requested", "executed"] as const) {
        const duplicateInput = structuredClone(selection);
        duplicateInput[field].push(duplicateInput[field][0]!);
        expect(caseReportProblems(sharded.report, duplicateInput, identity)).toContain(`duplicate independent ${field} case-report selection`);
        const emptyInput = { ...selection, [field]: [] };
        expect(caseReportProblems(sharded.report, emptyInput, identity)).toContain(`missing or invalid independent ${field} case-report selection`);
      }
      const outside = { ...selection, executed: [{ project: "absent", file: selected[0]!.file }] };
      expect(caseReportProblems(sharded.report, outside, identity)).toContain("executed case-report selection is outside requested domain");
      expect(caseReportProblems(sharded.report, { ...selection, version: 2 } as never, identity)).toContain("unknown independent case-report selection version");
      const missingRequest = { ...selection, requested: partitions[i]! };
      expect(caseReportProblems(sharded.report, missingRequest, identity)).toContain("omitted or unexpected selected case-report ownership");
      const excessExecution = { ...selection, executed: selected };
      expect(caseReportProblems(sharded.report, excessExecution, identity)).toContain("omitted or unexpected collected case-report ownership");
      for (const [field, label] of [["selected", "selected"], ["collected", "collected"], ["modules", "reported"]] as const) {
        const omittedShard = structuredClone(sharded.report); omittedShard[field].pop();
        expect(caseReportProblems(omittedShard, selection, identity)).toContain(`omitted or unexpected ${label} case-report ownership`);
      }
      shardReports.push(sharded.report);
    }
    expect(shardReports.flatMap(report => report.modules.map(key)).sort()).toEqual(selected.map(key).sort());
    const omitted = structuredClone(report); omitted.modules.pop();
    expect(caseReportProblems(omitted, selected, identity)).toContain("omitted or unexpected reported case-report ownership");
    const omittedCase = structuredClone(report); omittedCase.modules[0].cases.pop();
    expect(caseReportProblems(omittedCase, selected, identity).join("\n")).toContain("omitted or unexpected reported case");
    const duplicate = structuredClone(report); duplicate.modules[0].cases.push(duplicate.modules[0].cases[0]);
    expect(caseReportProblems(duplicate, selected, identity).join("\n")).toContain("duplicate collected case");
    const stale = structuredClone(report); stale.checkout.tree = "0".repeat(40);
    expect(caseReportProblems(stale, selected, identity)).toContain("stale or unknown case-report identity");
    const skipped = structuredClone(report); skipped.modules[0].cases[0].state = "skipped";
    expect(caseReportProblems(skipped, selected, identity).join("\n")).toContain("unproven case (skipped)");
    expect(caseReportProblems(report, selected, identity)).toEqual([]);
    const selectionPath = resolve(dir, "selection.json"), checkoutPath = resolve(dir, "checkout.json");
    await writeFile(selectionPath, JSON.stringify(selected));
    await writeFile(checkoutPath, JSON.stringify({ checkout: identity }));
    await writeFile(output, JSON.stringify(report));
    const reconcile = async () => {
      const child = Bun.spawn([Bun.which("node")!, resolve(root, "scripts/proof-case-report.mjs"), "--check", output, selectionPath, checkoutPath], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    expect((await reconcile()).code).toBe(0);
    await writeFile(output, JSON.stringify(omittedCase));
    const refused = await reconcile();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("omitted or unexpected reported case");
    const failed = await run(true);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("2 failed");
    expect(failed.report.modules.every((module: { cases: { state: string }[] }) => module.cases.some(item => item.state === "skipped"))).toBe(true);
    expect(caseReportProblems(failed.report, selected, identity).join("\n")).toContain("unproven case (failed)");
    expect(caseReportProblems(failed.report, selected, identity).join("\n")).toContain("unproven case (skipped)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
