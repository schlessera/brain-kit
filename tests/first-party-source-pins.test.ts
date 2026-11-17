// Browser proof retention and the audited source pins that qualified it are
// retired (#4107, maintainer decision 2026-11-16). A pin was a SHA-256 of
// first-party source held in a script, so every product change to a pinned
// file turned `unit` red until its hash was recomputed. Nothing in the tooling
// may pin first-party source again, and a byte change to a file that used to
// be pinned must leave planning and the tooling tests that read it green.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { closureSelects, discoverBrowserClosures } from "../scripts/browser-input-closure";
import { FILE_INPUT_TESTS, planUnitChecks, selectBrowserClosures, workspaces } from "../scripts/ci-plan";

const root = resolve(import.meta.dir, "..");
const fixtures: string[] = [];
afterAll(() => { for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return new TextDecoder().decode(child.stdout);
}
const worktreeFiles = () => git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")
  .filter(file => file && lstatSync(join(root, file), { throwIfNoEntry: false }));

// Source a tool could pin: code and configuration that a product or tooling
// change edits. Fonts, images and captured fixture data are identities of
// third-party bytes, and a fixture manifest may record them.
const SOURCE = /\.(?:[cm]?[jt]sx?|css|ya?ml|sh|py|toml)$|(?:^|\/)(?:package|tsconfig(?:\.[^/]+)?)\.json$/;
const FIXTURE = /(?:^|\/)fixtures\//;
// Where a pin would live: the tooling and its tests, in the root and in each package.
const HOLDER = /^(?:scripts|tests)\/|^packages\/[^/]+\/(?:scripts|tests)\//;
const HOLDER_TEXT = /\.(?:[cm]?[jt]sx?|json|py|sh|ya?ml)$/;
// Archived measurement records name the inputs they measured. No test compares
// them with the current tree, so a digest there cannot fail a later change.
const RECORD = /^scripts\/measurements\//;
// The capture font lock records the downloaded third-party stylesheet beside
// the fonts it names; `bun run capture:fonts` rewrites both together.
const THIRD_PARTY = new Set(["scripts/captures/font-lock.json pins scripts/captures/fonts.css"]);

test("no script or test holds the SHA-256 of a first-party source file", () => {
  const files = worktreeFiles().filter(file => lstatSync(join(root, file)).isFile());
  const digests = new Map<string, string>();
  for (const file of files) if (SOURCE.test(file) && !FIXTURE.test(file)) digests.set(createHash("sha256").update(readFileSync(join(root, file))).digest("hex"), file);
  const holders = files.filter(file => HOLDER.test(file) && HOLDER_TEXT.test(file) && !RECORD.test(file));
  // The scan must read the files the pins lived in, or an empty inventory passes vacuously.
  expect(holders, "SCAN_COVERS_THE_SELECTION_TOOLING").toContain("scripts/browser-input-closure.ts");
  expect(digests.size, "SCAN_HASHES_PRODUCT_SOURCE").toBeGreaterThan(1000);
  const pins = holders.flatMap(holder => [...new Set(readFileSync(join(root, holder), "utf8").match(/\b[0-9a-f]{64}\b/g) ?? [])]
    .filter(literal => digests.has(literal)).map(literal => `${holder} pins ${digests.get(literal)}`)).filter(pin => !THIRD_PARTY.has(pin));
  expect(pins, "FIRST_PARTY_SOURCE_STAYS_UNPINNED").toEqual([]);
});

/** A copy of the working tree that resolves workspace packages inside itself. */
function fixtureTree(): string {
  const copy = mkdtempSync(join(tmpdir(), "odysseus-unpinned-source-"));
  fixtures.push(copy);
  for (const file of worktreeFiles()) {
    const from = join(root, file), to = join(copy, file);
    mkdirSync(dirname(to), { recursive: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
  // Installed packages stay shared and read-only; a link into the repository
  // (a workspace package) is re-pointed at the copy, so the copy's source is
  // what resolution, planning and the tests below read.
  const link = (directory: string) => {
    mkdirSync(join(copy, directory), { recursive: true });
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const name = join(directory, entry.name), from = join(root, name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && entry.name.startsWith("@")) { link(name); continue; }
      const target = entry.isSymbolicLink() ? resolve(dirname(from), readlinkSync(from)) : from;
      const inside = relative(root, target);
      symlinkSync(!isAbsolute(inside) && !inside.startsWith("..") && !inside.split("/").includes("node_modules") ? join(copy, inside) : target, join(copy, name));
    }
  };
  for (const directory of ["node_modules", ...readdirSync(join(root, "packages")).map(name => `packages/${name}/node_modules`)])
    if (existsSync(join(root, directory))) link(directory);
  // The file-reading tests list the tree through Git.
  git(copy, "init", "-q"); git(copy, "add", "-A");
  return copy;
}

test("a byte change to product source a binding used to pin fails neither planning nor the tests that read it", async () => {
  // Both were pinned by the dispatch binding; the planner's file-input table named the second.
  const changed = ["packages/ui-react/src/ws-client/inbound.ts", "packages/ui-react/src/hooks/websocket-handlers/chat.ts"];
  const copy = fixtureTree();
  for (const file of changed) {
    appendFileSync(join(copy, file), "\n// A product edit: the bytes differ, the behaviour does not.\n");
    expect(readFileSync(join(copy, file), "utf8"), `FIXTURE_CHANGES_BYTES:${file}`).not.toBe(readFileSync(join(root, file), "utf8"));
  }

  // Planning: the change selects every browser category, from closures discovered in the copy.
  const closures = discoverBrowserClosures(copy);
  for (const file of changed) expect(closures.browser.files, `CLOSURE_DISCOVERED_IN_THE_COPY:${file}`).toContain(file);
  for (const category of ["browser", "layout", "endurance"] as const)
    expect(closureSelects(changed, closures[category], false), `CLOSURE_SELECTS_WITHOUT_THE_BROAD_RULE:${category}`).toBe(true);
  const plan = selectBrowserClosures(planUnitChecks(changed, workspaces(copy), copy), closures);
  expect(plan.global, "PRODUCT_EDIT_STAYS_AN_AFFECTED_PLAN").toBe(false);
  expect(plan.local, "PRODUCT_EDIT_SELECTS_ITS_CATEGORIES").toMatchObject({ fullTests: true, browser: true, layout: true, endurance: true, captures: true });

  // The unit tier's tooling tests: the root tests the planner's own table says
  // read these files as bytes. A pin test has to be listed there to be selected,
  // so a new one would run here and fail on the changed bytes.
  const readers = Object.entries(FILE_INPUT_TESTS)
    .filter(([test, inputs]) => test.startsWith("tests/") && changed.some(file => inputs.some(input => input.test(file)))).map(([test]) => test).sort();
  expect(readers.length, "PLANNER_NAMES_ROOT_TESTS_THAT_READ_THE_CHANGE").toBeGreaterThan(0);
  for (const test of readers) expect(plan.tests, `READER_IS_SELECTED:${test}`).toContain(test);
  const child = Bun.spawn([process.execPath, "scripts/test.ts", "--timeout", "30000", ...readers], { cwd: copy, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `TOOLING_TESTS_PASS_ON_CHANGED_PRODUCT_BYTES\n${(out + err).split("\n").filter(line => /\(fail\)|^error|✗/.test(line)).slice(0, 20).join("\n")}\n${(out + err).slice(-2000)}`).toBe(0);
}, 240_000);
