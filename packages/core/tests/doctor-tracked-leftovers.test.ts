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
  git("-c", "user.name=Alex Example", "-c", "user.email=alex@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
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
  expect(check.fix).toBe("untrack them (the files stay on disk), then commit: git rm --cached -- cv.aux 'my cv.out'");
});

test("a clean repository passes", async () => {
  const check = await leftoversCheck(repo({ "cv.md": "# CV\n" }));
  expect(check).toMatchObject({ status: "pass", detail: "no committed tool leftovers" });
});
