import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseMaintenanceGitSources, parseMaintenanceGitFailure } from "../src/brain/maintenance-git-source.js";
const entry = resolve(import.meta.dir, "../src/brain/maintenance-git-source.ts");
const git = Bun.which("git")!;
function fixture(run: (root: string, home: string) => void) {
  const base = mkdtempSync(join(tmpdir(), "git-source-test-")), root = join(base, "brain"), home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  try {
    const init = Bun.spawnSync([git, "init", "-q", root], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode, init.stderr.toString()).toBe(0); run(root, home);
  } finally { rmSync(base, { recursive: true, force: true }); }
}
function collect(root: string, home: string, maximum = 1024 ** 2, expected?: string, binary = git) {
  const info = lstatSync(root), identity = expected ?? `${info.dev}:${info.ino}`;
  const child = Bun.spawnSync([process.execPath, "--config=/dev/null", "--no-env-file", entry, binary, String(maximum), identity], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  return { code: child.exitCode, output: child.stdout.toString(), error: child.stderr.toString(), identity };
}
test("collects exact nested attributes and repository hook names through the fixed collector executable", () => fixture((root, home) => {
  mkdirSync(join(root, "private"), { mode: 0o700 });
  writeFileSync(join(root, "private/.gitattributes"), "*.md odysseus=ithaca\n", { mode: 0o600 });
  writeFileSync(join(root, ".git/hooks/odysseus-reply"), "Odysseus private hook bytes", { mode: 0o600 });
  const result = collect(root, home); expect(result.code, result.error).toBe(0);
  const answer = parseMaintenanceGitSources(result.output, 1024 ** 2, result.identity);
  expect(answer.repository).toBe(true); expect(answer.attributes).toEqual([{ path: "private/.gitattributes", data: "*.md odysseus=ithaca\n" }]);
  expect(answer.hookNames).toContain("odysseus-reply"); expect(result.output).not.toContain("Odysseus private hook bytes");
  expect(lstatSync(join(root, "private")).mode & 0o777).toBe(0o700); expect(lstatSync(join(root, "private/.gitattributes")).mode & 0o777).toBe(0o600);
}));
test("foreign root refuses before executing the fixed Git runtime", () => fixture((root, home) => {
  const program = join(home, "git-control"), marker = join(home, "git-executed");
  writeFileSync(program, `#!/bin/sh\nprintf executed > '${marker}'\nexit 0\n`, { mode: 0o700 });
  const result = collect(root, home, 1024 ** 2, "0:0", program);
  expect(result.code).not.toBe(0); expect(existsSync(marker), "FOREIGN_ROOT_REFUSES_BEFORE_GIT").toBe(false);
}));
test("never enumerates an outside-brain configured hook path", () => fixture((root, home) => {
  writeFileSync(join(home, "odysseus-host-hook"), "Odysseus host private input");
  const set = Bun.spawnSync([git, "-C", root, "config", "core.hooksPath", home], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(set.exitCode).toBe(0); const result = collect(root, home); expect(result.code, result.error).toBe(0);
  expect(parseMaintenanceGitSources(result.output, 1024 ** 2, result.identity).hookNames).toEqual([]);
  expect(result.output).not.toContain("odysseus-host-hook"); expect(result.output).not.toContain("Odysseus host private input");
}));
test("refuses foreign roots, aliased attributes/hooks/config and invalid UTF-8 explicitly", () => {
  for (const kind of ["root", "attribute", "hooks", "config", "utf8"] as const) fixture((root, home) => {
    if (kind === "attribute") symlinkSync(".git/config", join(root, ".gitattributes"));
    if (kind === "hooks") { rmSync(join(root, ".git/hooks"), { recursive: true }); symlinkSync(home, join(root, ".git/hooks")); }
    if (kind === "config") { rmSync(join(root, ".git/config")); symlinkSync(join(home, "config"), join(root, ".git/config")); }
    if (kind === "utf8") writeFileSync(join(root, ".gitattributes"), Buffer.from([0xff]));
    const result = collect(root, home, 1024 ** 2, kind === "root" ? "0:0" : undefined);
    expect(result.code, kind).not.toBe(0); expect(result.output, kind).toBe(""); expect(result.error, kind).toContain("Concrete Git source collection refused");
  });
});
test("serialized receipt and depth bounds refuse rather than omit attribute policy", () => {
  fixture((root, home) => {
    writeFileSync(join(root, ".gitattributes"), "\u0001".repeat(2048));
    expect(collect(root, home, 4096).code, "SERIALIZED_GIT_INPUT_BOUND").not.toBe(0);
  });
  fixture((root, home) => {
    let path = root;
    for (let depth = 0; depth < 258; depth++) { path = join(path, "a"); mkdirSync(path); }
    expect(collect(root, home).code, "GIT_INPUT_DEPTH_BOUND").not.toBe(0);
  });
});
test("receipt parser rejects escaping, duplicate and foreign attribute records", () => {
  const base = { rootIdentity: "1:2", repository: true, config: [], hookNames: [], attributes: [] };
  for (const paths of [["../.gitattributes"], [".gitattributes", ".gitattributes"], [".git/config"]]) {
    expect(() => parseMaintenanceGitSources(JSON.stringify({ ...base, attributes: paths.map(path => ({ path, data: "" })) }), 4096, "1:2")).toThrow();
  }
  expect(() => parseMaintenanceGitSources(JSON.stringify(base), 4096, "3:4")).toThrow();
});

test("fixed Git failure diagnostics never forward malicious stderr properties or bytes", () => {
  const unknown = { phase: "unknown", errorClass: "unknown", errno: "unknown" };
  for (const text of [
    JSON.stringify({ phase: "attrs", errorClass: "Error", errno: "EACCES", private: "Odysseus hidden worker stderr" }) + "\nConcrete Git source collection refused\n",
    JSON.stringify({ phase: "Odysseus hidden worker stderr", errorClass: "Error", errno: "EACCES" }) + "\nConcrete Git source collection refused\n",
    "Odysseus hidden worker stderr", "x".repeat(513), "null\nConcrete Git source collection refused\n",
  ]) {
    const receipt = parseMaintenanceGitFailure(text);
    expect(receipt, "UNTRUSTED_GIT_FAILURE_STDERR_NOT_FORWARDED").toEqual(unknown);
    expect(JSON.stringify(receipt)).not.toContain("Odysseus hidden worker stderr");
  }
  expect(parseMaintenanceGitFailure('{"phase":"attrs","errorClass":"Error","errno":"EACCES"}\nConcrete Git source collection refused\n'))
    .toEqual({ phase: "attrs", errorClass: "Error", errno: "EACCES" });
  fixture((root, home) => {
    const program = join(home, "git-refusal");
    writeFileSync(program, '#!/bin/sh\nprintf "Odysseus hidden worker stderr" >&2\nexit 23\n', { mode: 0o700 });
    const result = collect(root, home, 1024 ** 2, undefined, program);
    expect(result.code).not.toBe(0); expect(result.output).toBe("");
    expect(result.error).not.toContain("Odysseus hidden worker stderr"); expect(result.error).not.toContain(root);
    expect(parseMaintenanceGitFailure(result.error)).toEqual({ phase: "config", errorClass: "Error", errno: "unknown" });
  });
});
