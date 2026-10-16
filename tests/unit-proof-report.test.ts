import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { validateUnitReports } from "../scripts/unit-proof-report";

const ROOT = resolve(import.meta.dir, "..");

test("parallel Bun workers report every discovered file and distinguish skip from todo", async () => {
  const dir = mkdtempSync(join(ROOT, "tmp/unit-report-"));
  const files = ["a", "b"].map(name => relative(ROOT, join(dir, `${name}.test.ts`)));
  try {
    for (const [index, file] of files.entries()) writeFileSync(join(ROOT, file), `import {test,expect} from "bun:test";
import {writeFileSync} from "node:fs";
test("worker",async()=>{writeFileSync(${JSON.stringify(join(dir, `pid-${index}`))},String(process.pid));await Bun.sleep(100);expect(1).toBe(1)});
${index === 0 ? 'test.skip("skip",()=>{});test.todo("todo");' : ''}
`);
    const xml = join(dir, "report.xml"), timing = join(dir, "timings.json");
    const child = Bun.spawn([process.execPath, "run", "test", ...files.map(file => join(ROOT, file)), "--parallel=2", "--reporter=junit", `--reporter-outfile=${xml}`, `--timings=${timing}`, "--update-timings"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    expect(readFileSync(join(dir, "pid-0"), "utf8")).not.toBe(readFileSync(join(dir, "pid-1"), "utf8"));
    const report = readFileSync(xml, "utf8"), times = JSON.parse(readFileSync(timing, "utf8"));
    expect(validateUnitReports(files, report, times)).toEqual({ files: files.sort(), tests: 4, pass: 2, skip: 1, todo: 1, failures: 0 });
    expect(() => validateUnitReports(files, report.replaceAll(files[0]!, "unexpected.test.ts"), times)).toThrow("JUnit: unit file coverage differs");
    expect(() => validateUnitReports([...files, "missing.test.ts"], report, times)).toThrow("JUnit: unit file coverage differs");
    expect(() => validateUnitReports(files.slice(1), report, times)).toThrow("unexpected=");
    const incomplete = structuredClone(times); delete incomplete.files[files[0]!];
    expect(() => validateUnitReports(files, report, incomplete)).toThrow("timings: unit file coverage differs");
    const bad = structuredClone(times); bad.files[files[0]!] = -1;
    expect(() => validateUnitReports(files, report, bad)).toThrow("Invalid unit file timing");
    expect(() => validateUnitReports(files, report.replace('failures="0"', 'failures="1"'), times)).toThrow("Unit totals do not describe a passing execution");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
