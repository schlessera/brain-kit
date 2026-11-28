/** The shared GitHub CLI wrapper and repository resolver of the repository scripts (#4731), against a stub `gh` on PATH. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REPO, gh, realGh, resolveRepository } from "../scripts/lib/gh";

let bin = "", path: string | undefined;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "scripts-gh-"));
  // `echo <words>` prints them padded; `stdin` echoes stdin; `fail <code>` writes to stderr and exits with it.
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1" in
  echo) shift; printf '  %s  \\n' "$*" ;;
  stdin) cat ;;
  fail) echo "  Odysseus is lost at sea  " >&2; exit "$2" ;;
  silent) exit "$2" ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
});
afterAll(() => {
  if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
  if (bin) rmSync(bin, { recursive: true, force: true });
});

test("resolveRepository prefers the flag, then BRAIN_KIT_REPOSITORY, then the default", () => {
  expect(resolveRepository({ flag: "odysseus/raft", env: { BRAIN_KIT_REPOSITORY: "odysseus/ship" } }), "FLAG_WINS").toBe("odysseus/raft");
  expect(resolveRepository({ env: { BRAIN_KIT_REPOSITORY: "odysseus/ship" } }), "VARIABLE_OVER_DEFAULT").toBe("odysseus/ship");
  expect(resolveRepository({ env: {} }), "DEFAULT_LAST").toBe(DEFAULT_REPO);
});

test("gh resolves raw stdout, or trimmed stdout on request", async () => {
  expect(await gh(["echo", "Ithaca"]), "RAW_STDOUT").toBe("  Ithaca  \n");
  expect(await gh(["echo", "Ithaca"], { trim: true }), "TRIMMED_STDOUT").toBe("Ithaca");
});

test("gh passes input to stdin", async () => {
  expect(await gh(["stdin"], { input: "Penelope weaves\n" }), "STDIN_REACHED").toBe("Penelope weaves\n");
  expect(await gh(["stdin"]), "NO_STDIN").toBe("");
});

test("gh rejects with the default message or the caller's", async () => {
  await expect(gh(["fail", "3"]), "DEFAULT_MESSAGE").rejects.toThrow("gh fail 3 failed (3):\nOdysseus is lost at sea");
  await expect(gh(["fail", "4"], { error: (_args, _code, stderr) => stderr.trim() }), "TRIMMED_STDERR_MESSAGE").rejects.toThrow(/^Odysseus is lost at sea$/);
  await expect(gh(["fail", "5"], { error: (args, _code, stderr) => `gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim()}` }), "PREFIXED_MESSAGE")
    .rejects.toThrow(/^gh fail 5 failed: Odysseus is lost at sea$/);
  await expect(gh(["silent", "6"], { error: (_args, code, stderr) => stderr.trim() || `gh exited ${code}` }), "EXIT_CODE_MESSAGE").rejects.toThrow(/^gh exited 6$/);
});

test("realGh returns the exit code and both streams without throwing", () => {
  expect(realGh(["fail", "7"]), "REAL_GH_RESULT").toEqual({ code: 7, stdout: "", stderr: "  Odysseus is lost at sea  \n" });
});
