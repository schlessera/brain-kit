import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkout } from "../scripts/proof-inputs";
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
    await writeFile(resolve(dir, "vitest.config.mjs"), `export default { test: {
      reporters: ["default", [${JSON.stringify(resolve(root, "scripts/proof-case-report.mjs"))}, { output: ${JSON.stringify(output)} }]],
      projects: ["proof-one", "proof-two"].map(name => ({ test: { name, root: ${JSON.stringify(dir)}, include: ["case.test.ts"] } }))
    }};`);
    const run = async (failure: boolean) => {
      // Bun's child preload does not instrument Node. Isolate this real Node
      // runner and all its workers at the OS boundary, with loopback only.
      const child = Bun.spawn(["unshare", "--user", "--map-root-user", "--net", "sh", "-c", 'ip link set lo up && exec "$@"', "proof-case-fixture",
        Bun.which("node")!, resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", resolve(dir, "vitest.config.mjs")], {
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
