/**
 * `brain doctor`'s `tracked-leftovers` check: committed tool leftovers (the
 * list in lib/tool-leftovers.ts) are reported, with the untracking command as
 * text; a clean repository passes.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

function repo(files: Record<string, string>): string {
  const root = makeTempBrain();
  temps.push(root);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
  git("init", "-q", "-b", "main");
  git("add", "-A", "--", ".", ":!node_modules");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return root;
}

async function leftoversCheck(root: string) {
  const { stdout, code } = await runCli(root, ["doctor", "--json"]);
  expect(code).toBe(0);
  const check = JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "tracked-leftovers");
  expect(check).toBeDefined();
  return check as { status: string; detail: string; fix?: string };
}

test("a committed cv.aux warns and shows the untracking command", async () => {
  const check = await leftoversCheck(repo({ "cv.aux": "\\relax\n", "my cv.out": "x" }));
  expect(check.status).toBe("warn");
  expect(check.detail).toBe("2 committed tool leftover(s): cv.aux, my cv.out");
  expect(check.fix).toBe(
    "untrack them (the files stay on disk), then commit: git --literal-pathspecs rm --cached -- cv.aux 'my cv.out'"
  );
});

test("a clean repository passes", async () => {
  const check = await leftoversCheck(repo({ "cv.md": "# CV\n" }));
  expect(check).toMatchObject({ status: "pass", detail: "no committed tool leftovers" });
});

/** Tracked paths in `root`. */
function tracked(root: string): string[] {
  return new TextDecoder()
    .decode(Bun.spawnSync(["git", "-C", root, "ls-files", "-z"]).stdout)
    .split("\0")
    .filter(Boolean);
}

/** Run the check's `fix` command in `root` and return what is tracked afterwards. */
async function runFix(root: string): Promise<string[]> {
  const check = await leftoversCheck(root);
  expect(check.status).toBe("warn");
  const command = check.fix!.slice(check.fix!.indexOf("then commit: ") + "then commit: ".length);
  const run = Bun.spawnSync(["sh", "-c", command], { cwd: root });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  return tracked(root);
}

// Review round 1: file names that are pathspec magic, a glob, or hold a newline.
test("a leftover named like pathspec magic untracks only itself", async () => {
  const root = repo({ "README.md": "# Readme\n", ":(exclude)cv.aux": "x" });
  const before = tracked(root);
  expect(before).toContain(":(exclude)cv.aux");
  expect(before.length).toBeGreaterThan(10);
  expect(await runFix(root)).toEqual(before.filter((p) => p !== ":(exclude)cv.aux"));
});

test("leftovers named as a glob or holding a newline are found and untracked, and nothing else", async () => {
  const names = ["*.aux", "line\nbreak.aux", "line\nbreak.jpg:Zone.Identifier"];
  const root = repo({ "README.md": "# Readme\n", ...Object.fromEntries(names.map((n) => [n, "x"])) });
  const before = tracked(root);
  expect(before).toEqual(expect.arrayContaining(names));
  expect((await leftoversCheck(root)).detail).toStartWith("3 committed tool leftover(s): ");
  expect(await runFix(root)).toEqual(before.filter((p) => !names.includes(p)));
});
