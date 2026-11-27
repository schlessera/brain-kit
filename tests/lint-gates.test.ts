/**
 * The AST gates `bun run lint` runs in one process (#4673): a fixture tree with
 * one planted violation per gate fails the aggregate with the same text the
 * standalone gate prints, and a gate that throws does not stop the others.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { IN_PROCESS, runLints } from "../scripts/lint";

const SCRIPTS = resolve(import.meta.dir, "../scripts");
const imported = 'import { useChatStore } from "./stores/chat-store.js";\n';
const upward = 'import { ChatPage } from "../components/chat/chat-page.js";\nexport const page = ChatPage;\n';

/** One violation per gate, each in a file only that gate's rule reports; root-stores and layer-direction in `.ts` and `.tsx`. */
const PLANTED: Record<string, { files: Record<string, string>; needles: string[] }> = {
  "check-env-access.ts": { files: { "packages/core/src/home.ts": "export const home = () => process.env.HOME;\n" }, needles: ["packages/core/src/home.ts:1:"] },
  "check-frontmatter-parse.ts": { files: { "scripts/matter.ts": 'import matter from "gray-matter";\nexport const parse = matter;\n' }, needles: ["scripts/matter.ts:1:"] },
  "check-inline-containment.ts": { files: { "packages/core/src/inside.ts": "export const inside = (root: string, path: string) => path.startsWith(`${root}/`);\n" }, needles: ["packages/core/src/inside.ts:1:"] },
  "check-module-casts.ts": { files: { "packages/module-odyssey/src/cast.ts": "type FooConfig = { crew: number };\nexport const crew = (ctx: { config: unknown }) => (ctx.config as FooConfig).crew;\n" }, needles: ["packages/module-odyssey/src/cast.ts:2:"] },
  "check-kit-purity.ts": { files: { "packages/ui-kit/src/fetch.ts": 'export const load = () => fetch("/api/voyage");\n' }, needles: ["packages/ui-kit/src/fetch.ts:1:"] },
  "check-raw-buttons.ts": { files: { "packages/ui-react/src/raw.tsx": 'export const Raft = () => <button type="button">Sail</button>;\n' }, needles: ["packages/ui-react/src/raw.tsx:1:"] },
  "check-root-stores.ts": { files: { "packages/ui-react/src/static.ts": `${imported}export const draft = () => useChatStore.getState();\n`,
    "packages/ui-react/src/static-view.tsx": `${imported}export const Draft = () => <p>{useChatStore.getState().draft}</p>;\n` }, needles: ["packages/ui-react/src/static.ts", "packages/ui-react/src/static-view.tsx"] },
  "check-layer-direction.ts": { files: { "packages/ui-react/src/lib/up.ts": upward, "packages/ui-react/src/lib/up-view.tsx": upward },
    needles: ["packages/ui-react/src/lib/up.ts:1:", "packages/ui-react/src/lib/up-view.tsx:1:"] },
  "check-unused-exports.ts": { files: { "packages/ui-server/src/probe.ts": "export const probe = 1;\n" }, needles: ["packages/ui-server/src/probe.ts:1: `probe`"] },
  "check-import-cycles.ts": { files: { "packages/core/src/ithaca.ts": 'import { troy } from "./troy";\nexport const ithaca = () => troy;\n',
    "packages/core/src/troy.ts": 'import { ithaca } from "./ithaca";\nexport const troy = () => ithaca;\n' }, needles: ["packages/core/src/ithaca.ts\n  packages/core/src/troy.ts"] },
};
const SUPPORT: Record<string, string> = {
  "packages/core/package.json": JSON.stringify({ name: "@fixture/core", exports: { ".": { bun: "./src/index.ts" } } }),
  "packages/core/src/index.ts": "",
  "packages/ui-server/package.json": JSON.stringify({ name: "@fixture/ui-server", exports: { ".": { bun: "./src/index.ts" } } }),
  "packages/ui-server/src/index.ts": "",
  "packages/ui-kit/package.json": JSON.stringify({ name: "@fixture/ui-kit", exports: { ".": { bun: "./src/index.ts" } } }),
  "packages/ui-kit/src/index.ts": "",
  "packages/ui-react/package.json": JSON.stringify({ name: "@fixture/ui-react", exports: { ".": { bun: "./src/index.ts" } } }),
  "packages/ui-react/src/index.ts": "",
  "packages/ui-react/src/components/chat/chat-page.tsx": "export const ChatPage = () => null;\n",
  "packages/core/src/lib/harbour.ts": "export const harbour = 1;\n",
  "packages/ui-react/src/stores/chat-store.ts": "export const useChatStore = Object.assign(() => null, { getState: () => ({ draft: \"\" }) });\n",
  "packages/module-odyssey/package.json": JSON.stringify({ name: "@fixture/module-odyssey" }),
};

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lint-gates-"));
  for (const [file, text] of Object.entries({ ...SUPPORT, ...Object.fromEntries(Object.values(PLANTED).flatMap(entry => Object.entries(entry.files))) })) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  for (const args of [["init", "-q"], ["add", "."]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
  }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

/** What the in-process runner prints for `lints`, split by stream, and whether it failed. */
async function inProcess(lints: string[], load?: Parameters<typeof runLints>[2]) {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...parts: unknown[]) => { out.push(parts.join(" ")); };
  console.error = (...parts: unknown[]) => { err.push(parts.join(" ")); };
  try { return { failed: await runLints(root, lints, load), out, err }; }
  finally { console.log = log; console.error = error; }
}

/** What `bun scripts/<gate> <root>` prints on its own. */
function standalone(gate: string) {
  const run = Bun.spawnSync([process.execPath, join(SCRIPTS, gate), root], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

test("every AST gate runs in process", () => {
  expect([...IN_PROCESS].sort(), "IN_PROCESS_GATES").toEqual(Object.keys(PLANTED).sort());
});

test.each(Object.keys(PLANTED))("%s: a planted violation fails the aggregate with the standalone text", async gate => {
  const alone = standalone(gate);
  expect(alone.code, "STANDALONE_FAILS").toBe(1);
  for (const needle of PLANTED[gate]!.needles) expect(alone.err, "STANDALONE_REPORTS_THE_PLANTED_VIOLATION").toContain(needle);
  const together = await inProcess([gate]);
  expect(together.failed, "AGGREGATE_FAILS").toBe(true);
  const text = (lines: string[]) => lines.map(line => `${line}\n`).join("");
  expect(text(together.out), "AGGREGATE_STDOUT_IS_THE_STANDALONE_STDOUT").toBe(`\n== ${gate}\n${alone.out}`);
  expect(text(together.err), "AGGREGATE_STDERR_IS_THE_STANDALONE_STDERR").toBe(alone.err);
}, 60_000);

test("a gate that throws fails the run without stopping the gates after it", async () => {
  const gates = ["check-env-access.ts", "check-raw-buttons.ts"];
  const result = await inProcess(gates, async path => path.endsWith("check-env-access.ts")
    ? { lintGate: () => { throw new Error("Odysseus lost the chart"); } } : import(path));
  expect(result.failed, "THROWING_GATE_FAILS_THE_RUN").toBe(true);
  expect(result.err[0], "THROW_REPORTED").toStartWith("scripts/check-env-access.ts threw: Error: Odysseus lost the chart");
  expect(result.out, "NEXT_GATE_STILL_RUNS").toContain("\n== check-raw-buttons.ts");
  expect(result.err.join("\n"), "NEXT_GATE_STILL_REPORTS").toContain("packages/ui-react/src/raw.tsx:1:");
});

describe("one view of the tree for every gate but leakage (#4674)", () => {
  // Built from pieces so this file itself holds neither a raw invisible character nor a leakage string.
  const zeroWidth = String.fromCharCode(0x200b);
  const deployHost = ["coo", "lify-1"].join("");
  let tree = "";
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "lint-tree-"));
    const files: Record<string, string> = {
      ".gitignore": "tmp/\n",
      "packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
      "packages/core/src/index.ts": "export const ithaca = 1;\n",
      "packages/core/src/gone.ts": "export const gone = 1;\n",
      "packages/ui-react/src/lib/gone.ts": "export const gone = 1;\n",
      "evals/voyage/matter.ts": 'import matter from "gray-matter";\nexport const parse = matter;\n',
    };
    for (const [file, text] of Object.entries(files)) { mkdirSync(join(tree, dirname(file)), { recursive: true }); writeFileSync(join(tree, file), text); }
    for (const args of [["init", "-q"], ["add", "."]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: tree, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      expect(git.exitCode, git.stderr.toString()).toBe(0);
    }
    // Untracked and not ignored; ignored under a package's src/; tracked but deleted in the working tree.
    writeFileSync(join(tree, "packages/core/src/untracked.ts"), `export const sail = "w${zeroWidth}ind";\n`);
    mkdirSync(join(tree, "packages/core/src/tmp"), { recursive: true });
    writeFileSync(join(tree, "packages/core/src/tmp/scratch.ts"), `export const home = process.env.HOME;\nexport const host = "${deployHost}";\n`);
    rmSync(join(tree, "packages/core/src/gone.ts")); rmSync(join(tree, "packages/ui-react/src/lib/gone.ts"));
  });
  afterAll(() => { if (tree) rmSync(tree, { recursive: true, force: true }); });

  test("an untracked file is checked for invisible characters and an ignored file is scanned by no gate", async () => {
    const { scanRepo } = await import("../scripts/check-invisibles");
    expect(scanRepo(tree).map(f => f.file), "UNTRACKED_FILE_CHECKED_FOR_INVISIBLES").toEqual(["packages/core/src/untracked.ts"]);
    const { scanPackages } = await import("../scripts/check-env-access");
    expect(scanPackages(tree).map(f => f.file), "IGNORED_FILE_NOT_SCANNED_BY_ENV_ACCESS").toEqual([]);
    const all = await inTree([...IN_PROCESS]);
    expect([...all.out, ...all.err].join("\n"), "IGNORED_FILE_NOT_SCANNED_BY_ANY_GATE").not.toContain("tmp/scratch.ts");
  });

  test("a tracked file deleted in the working tree is skipped without an error by every gate", async () => {
    const { scanRepo } = await import("../scripts/check-invisibles");
    expect(() => scanRepo(tree), "INVISIBLES_SKIPS_DELETED").not.toThrow();
    const all = await inTree([...IN_PROCESS]);
    expect([...all.out, ...all.err].join("\n"), "NO_GATE_NAMES_THE_DELETED_FILES").not.toMatch(/gone\.ts|threw|ENOENT/);
  });

  test("a direct gray-matter import under evals/ fails the frontmatter gate", async () => {
    const { scanTree } = await import("../scripts/check-frontmatter-parse");
    expect(scanTree(tree).map(f => `${f.file}:${f.rule}`), "EVALS_SCANNED_FOR_FRONTMATTER").toEqual(["evals/voyage/matter.ts:1"]);
  });

  test("leakage still walks the whole tree, ignored files included", async () => {
    const { scanTree } = await import("../scripts/check-leakage");
    expect(scanTree(tree).map(f => f.file), "LEAKAGE_SCANS_IGNORED_FILES").toContain("packages/core/src/tmp/scratch.ts");
  });

  async function inTree(lints: string[]) {
    const out: string[] = [], err: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...parts: unknown[]) => { out.push(parts.join(" ")); };
    console.error = (...parts: unknown[]) => { err.push(parts.join(" ")); };
    try { await runLints(tree, lints); return { out, err }; }
    finally { console.log = log; console.error = error; }
  }
});
