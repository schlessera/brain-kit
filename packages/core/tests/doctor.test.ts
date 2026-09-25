/**
 * `brain doctor`'s `git-storage` check: it warns on a filter-branch backup
 * under refs/original/ and on loose objects above 100 MB, prints the removal
 * command as text, and never removes a ref, not even with --fix.
 */

import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { git, initRepo, refs } from "./git-fixture";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

/** A fixture brain whose MCP check passes from project config, so doctor never probes a host `claude`. */
function tempBrain(): string {
  const root = makeTempBrain();
  temps.push(root);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  return root;
}

async function gitStorage(root: string, ...flags: string[]) {
  const { stdout, code } = await runCli(root, ["doctor", "--json", ...flags]);
  expect(code).toBe(0);
  const check = JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "git-storage");
  expect(check).toBeDefined();
  return check as { id: string; status: string; detail: string; fix?: string };
}

test("a planted refs/original backup warns, names the ref, and shows the removal as text", async () => {
  const root = tempBrain();
  initRepo(root);
  const before = refs(root);
  expect(before.some((r) => r.startsWith("refs/original/refs/heads/main "))).toBe(true);

  const check = await gitStorage(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("refs/original/refs/heads/main");
  expect(check.fix).toContain("git update-ref --stdin");
  expect(check.fix).toContain("cannot be undone");
  expect(refs(root)).toEqual(before);

  // --fix repairs what it can; this is not one of them.
  await gitStorage(root, "--fix");
  expect(refs(root)).toEqual(before);
});

test("a repository with no backup ref and few loose objects passes", async () => {
  const root = tempBrain();
  initRepo(root, { backup: false });
  const check = await gitStorage(root);
  expect(check.status).toBe("pass");
  expect(check.detail).toContain("no refs/original backups");
});

test("a brain that is not a git repository passes", async () => {
  const check = await gitStorage(tempBrain());
  expect(check).toEqual({ id: "git-storage", status: "pass", detail: "not a git repository" });
});

test("loose objects above 100 MB warn and point at brain maintain", async () => {
  const root = tempBrain();
  initRepo(root, { backup: false });
  // Random bytes do not compress, so the loose object is as large on disk.
  const blob = join(root, "big.bin");
  writeFileSync(blob, randomBytes(101 * 1024 * 1024));
  git(root, "hash-object", "-w", blob);
  const check = await gitStorage(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toMatch(/^1 loose object\(s\) use 10\d\.\d MB$/);
  expect(check.fix).toBe("run `brain maintain` to pack them");
});
