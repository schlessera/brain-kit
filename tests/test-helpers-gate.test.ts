/**
 * The shared-test-helper gate (scripts/check-test-helpers.ts, #4835): a test
 * file uses the shared owner of a test need instead of a local copy, and the
 * baseline of remaining copies only shrinks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { BASELINE, baselineProblems, readBaseline, scanSource, scanTree, type BaselineEntry } from "../scripts/check-test-helpers";

const ROOT = resolve(import.meta.dir, "..");
const GATE = resolve(import.meta.dir, "../scripts/check-test-helpers.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: Record<string, string>, baseline: BaselineEntry[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "test-helpers-gate-"));
  roots.push(root);
  for (const [file, text] of Object.entries({ ...files, [BASELINE]: JSON.stringify(baseline) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const runGate = (root: string) => {
  const child = Bun.spawnSync({ cmd: [process.execPath, GATE, root], stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stderr: child.stderr.toString() };
};

const SLEEPING_WAIT = [
  "const ships: string[] = [];",
  "async function waitFor(cond: () => boolean): Promise<void> {",
  "  for (let i = 0; i < 200; i++) {",
  "    if (cond()) return;",
  "    await new Promise((r) => setTimeout(r, 5));",
  "  }",
  '  throw new Error("waitFor timed out");',
  "}",
  "",
].join("\n");
const names = (text: string, file = "packages/ui-server/tests/a.test.ts") => scanSource(file, text).map((site) => site.name);

describe("the polling-helper rule", () => {
  test("a new local sleeping waitFor fails with the file and the helper name", () => {
    const root = tree({ "packages/ui-server/tests/ws-ithaca.test.ts": SLEEPING_WAIT });
    expect(scanTree(root).findings).toEqual([{ rule: "polling-helper", file: "packages/ui-server/tests/ws-ithaca.test.ts", line: 2, name: "waitFor" }]);
    const gate = runGate(root);
    expect(gate.code).toBe(1);
    expect(gate.stderr).toContain("packages/ui-server/tests/ws-ithaca.test.ts:2: waitFor");
  });

  test("every refused shape: declarations, function-valued consts and one-liners, under each name", () => {
    expect(names(SLEEPING_WAIT)).toEqual(["waitFor"]);
    expect(names("export async function until(cond: () => boolean, timeoutMs = 2000) {\n  while (!cond()) await Bun.sleep(5);\n}\n")).toEqual(["until"]);
    expect(names("function poll(check: () => boolean) { for (;;) { if (check()) return; Bun.sleepSync(1); sleep(1); } }\n")).toEqual(["poll"]);
    expect(names("  const waitUntil = async (check: () => boolean) => { while (!check()) await Bun.sleep(5); };\n")).toEqual(["waitUntil"]);
    expect(names("const eventually = (check: () => boolean) => new Promise<void>(r => setImmediate(r));\n")).toEqual(["eventually"]);
    expect(names("const until = async function (check: () => boolean) { while (!check()) await Bun.sleep(5); };\n")).toEqual(["until"]);
  });

  test("a deadline value, a helper that never sleeps, a method and a comment are not helpers", () => {
    for (const text of [
      "const until = Date.now() + 45_000;\nwhile (!done) { if (Date.now() > until) throw new Error(); await Bun.sleep(10); }\n",
      "const until = performance.now() + 500;\nawait new Promise(r => setTimeout(r, 1));\n",
      "async function until(page: Page, predicate: string) {\n  await page.waitForFunction(predicate);\n}\nawait new Promise(r => setTimeout(r, 1));\n",
      "const harness = { until: async (check: () => boolean) => { while (!check()) await Bun.sleep(5); } };\n",
      "// async function waitFor(cond) { await Bun.sleep(5); }\n",
      'const note = "function until() { setTimeout(); }";\n',
    ]) expect({ text, sites: names(text) }).toEqual({ text, sites: [] });
  });

  test("the shared owners are not refused", () => {
    expect(scanSource("tests/helpers/until.ts", SLEEPING_WAIT)).toEqual([]);
    expect(scanSource("tests/helpers/planning-control.ts", SLEEPING_WAIT)).toEqual([]);
    expect(scanSource("tests/helpers/other.ts", SLEEPING_WAIT)).toHaveLength(1);
  });

  test("only test trees are scanned", () => {
    const root = tree({
      "packages/core/src/a.ts": SLEEPING_WAIT,
      "scripts/a.ts": SLEEPING_WAIT,
      "packages/core/tests/node_modules/a.ts": SLEEPING_WAIT,
      "packages/core/tests/notes.md": SLEEPING_WAIT,
      "packages/core/tests/fixtures/deep/a.tsx": SLEEPING_WAIT,
      "tests/helpers/b.ts": SLEEPING_WAIT,
    });
    expect(scanTree(root).findings.map((site) => site.file)).toEqual(["packages/core/tests/fixtures/deep/a.tsx", "tests/helpers/b.ts"]);
  });
});

describe("the boot-config rule", () => {
  // Spelled through CALL so this file's own source holds no boot literal.
  const CALL = "resolveServerConfig";
  const BOOT = `const config = ${CALL}({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: brain, DB_PATH: ":memory:" });\n`;

  test("a new boot literal fails with the file name", () => {
    const root = tree({ "packages/ui-server/tests/ithaca-boot.test.ts": `import { ${CALL} } from '../src/config/env';\n` + BOOT });
    expect(scanTree(root).findings).toEqual([{ rule: "boot-config", file: "packages/ui-server/tests/ithaca-boot.test.ts", line: 2, name: "resolveServerConfig" }]);
    const gate = runGate(root);
    expect(gate.code).toBe(1);
    expect(gate.stderr).toContain("packages/ui-server/tests/ithaca-boot.test.ts:2: resolveServerConfig");
  });

  test("a literal over several lines, or inside a child program's source, is still one", () => {
    expect(scanSource("tests/a.test.ts", `${CALL}(\n  {\n    HOST: host,\n    AUTH_MODE: 'none',\n  })\n`).map((site) => site.line)).toEqual([1]);
    expect(scanSource("tests/a.test.ts", "const program = `config:" + CALL + "({AUTH_MODE:'none',HOST:'127.0.0.1',BRAIN_PATH:${JSON.stringify(brain)}})`;\n")).toHaveLength(1);
  });

  test("config resolution that does not boot a keyless app is not refused", () => {
    for (const text of [
      `${CALL}({ AUTH_MODE: "password", BRAIN_PATH: brain });\n`,
      `${CALL}({ HOST: "0.0.0.0" });\n`,
      `${CALL}(baseEnv);\n`,
      `${CALL}({ ...baseEnv, AGENT_BACKEND: "gemini" });\n`,
    ]) expect({ text, sites: scanSource("tests/a.test.ts", text) }).toEqual({ text, sites: [] });
    expect(scanSource("packages/ui-server/tests/helpers/test-config.ts", BOOT)).toEqual([]);
  });
});

describe("the tmp-path rule", () => {
  // Spelled through TMP so this file's own source holds no such path.
  const TMP = "tmpdir()";

  test("a new unmarked path under tmpdir() fails with the file and line", () => {
    const root = tree({ "packages/core/tests/ithaca-temp.test.ts": `const root = "x";\nconst db = join(${TMP}, "ithaca.db");\n` });
    expect(scanTree(root).findings).toEqual([{ rule: "tmp-path", file: "packages/core/tests/ithaca-temp.test.ts", line: 2, name: `join(${TMP}` }]);
    const gate = runGate(root);
    expect(gate.code).toBe(1);
    expect(gate.stderr).toContain(`packages/core/tests/ithaca-temp.test.ts:2: join(${TMP}`);
    expect(scanSource("tests/a.test.ts", `const db = resolve(os.${TMP}, "ithaca.db");\n`)).toHaveLength(1);
  });

  test("a marked line, a marker on the line above and a mkdtemp argument pass", () => {
    for (const text of [
      `const missing = join(${TMP}, "no-such-chrome"); // tmp-path: an executable that must not exist\n`,
      `// tmp-path: an executable that must not exist\nconst missing = join(${TMP}, "no-such-chrome");\n`,
      `const root = mkdtempSync(join(${TMP}, "prefix-"));\n`,
      `const root = await mkdtemp(resolve(${TMP}, "prefix-"));\n`,
    ]) expect({ text, sites: scanSource("tests/a.test.ts", text) }).toEqual({ text, sites: [] });
    expect(scanSource("tests/a.test.ts", `// tmp-path:\nconst missing = join(${TMP}, "no-such-chrome");\n`), "A_MARKER_NEEDS_A_REASON").toHaveLength(1);
    expect(scanSource("tests/helpers/temp.ts", `const db = join(${TMP}, "ithaca.db");\n`)).toEqual([]);
  });
});

describe("the baseline", () => {
  const file = "packages/ui-server/tests/ws-ithaca.test.ts";
  const entry = (count: number): BaselineEntry => ({ rule: "polling-helper", file, count, reason: "follow-up slice of the Ithaca tests" });

  test("a listed file at its count passes", () => {
    const root = tree({ [file]: SLEEPING_WAIT }, [entry(1)]);
    expect(scanTree(root)).toEqual({ findings: [], miscounted: [], problems: [] });
    expect(runGate(root).code).toBe(0);
  });

  test("an entry larger than the file's real count fails as stale", () => {
    const root = tree({ [file]: SLEEPING_WAIT }, [entry(2)]);
    expect(scanTree(root).miscounted).toEqual([{ rule: "polling-helper", file, expected: 2, actual: 1 }]);
    const gate = runGate(root);
    expect(gate.code).toBe(1);
    expect(gate.stderr).toContain(`${file}: ${BASELINE} records 2 polling-helper site(s), found 1; the entry is stale`);
  });

  test("an entry for a file with no site left fails as stale", () => {
    const root = tree({ [file]: "export {};\n" }, [entry(1)]);
    expect(scanTree(root).miscounted).toEqual([{ rule: "polling-helper", file, expected: 1, actual: 0 }]);
  });

  test("a file over its entry fails with every site", () => {
    const root = tree({ [file]: SLEEPING_WAIT + SLEEPING_WAIT.replace("waitFor(cond", "until(cond") }, [entry(1)]);
    expect(scanTree(root).findings.map((site) => `${site.line}:${site.name}`)).toEqual(["2:waitFor", "10:until"]);
    expect(runGate(root).code).toBe(1);
  });

  test("an entry with an unknown rule, no reason, or out of order is refused", () => {
    expect(baselineProblems([{ rule: "polling", file, count: 1, reason: "follow-up slice" }])[0]).toContain('no rule is named "polling"');
    expect(baselineProblems([{ ...entry(1), reason: "" }])[0]).toContain("needs a one-line reason");
    expect(baselineProblems([{ ...entry(1), count: 0 }])[0]).toContain("positive whole number");
    expect(baselineProblems([entry(1), { ...entry(1), file: "packages/a.test.ts" }])[0]).toContain("sorted by rule, then file");
    expect(baselineProblems([entry(1), entry(1)])[0]).toContain("no duplicates");
  });

  test("the repository's tree matches its baseline, and every entry names a reason", () => {
    expect(scanTree(ROOT)).toEqual({ findings: [], miscounted: [], problems: [] });
    for (const listed of readBaseline(ROOT)) expect(listed.reason.length).toBeGreaterThan(10);
  });
});
