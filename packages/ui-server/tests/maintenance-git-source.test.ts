import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectOwnedGitAttributes, parseMaintenanceGitSources, parseMaintenanceGitFailure, reportMaintenanceGitFailure, reportOwnedGitFailure } from "../src/brain/maintenance-git-source.js";
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
    if (kind === "utf8") {
      const info = lstatSync(join(root, ".gitattributes"));
      expect(parseMaintenanceGitFailure(result.error)).toEqual({ phase: "attrs", errorClass: "Error", errno: "unknown",
        attrs: { rootClass: "other", depth: 1, uid: info.uid, gid: info.gid, mode: info.mode & 0o7777, type: "file" } });
    }
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
  const base = { rootIdentity: "1:2", repository: true, config: [], hookNames: [], attributes: [], withheld: [] };
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

test("attribute refusal metadata accepts only bounded fixed topology fields", () => {
  const attrs = { rootClass: ".brain", depth: 2, uid: 21001, gid: 21001, mode: 0o700, type: "directory" };
  const encode = (value: unknown) => JSON.stringify({ phase: "attrs", errorClass: "Error", errno: "EACCES", attrs: value }) + "\nConcrete Git source collection refused\n";
  expect(parseMaintenanceGitFailure(encode(attrs))).toEqual({ phase: "attrs", errorClass: "Error", errno: "EACCES", attrs });
  for (const invalid of [{ ...attrs, path: "Odysseus hidden worker stderr" }, { ...attrs, rootClass: "Odysseus hidden worker stderr" },
    { ...attrs, depth: 258 }, { ...attrs, depth: 1.5 }, { ...attrs, uid: -1 }, { ...attrs, gid: 0x100000000 },
    { ...attrs, mode: 0o10000 }, { ...attrs, type: "Odysseus hidden worker stderr" }, null]) {
    const actual = parseMaintenanceGitFailure(encode(invalid));
    expect(actual, "ATTR_FAILURE_TOPOLOGY_NEVER_FORWARDS_UNBOUNDED_OR_ARBITRARY_FIELDS").toEqual({ phase: "unknown", errorClass: "unknown", errno: "unknown" });
    expect(JSON.stringify(actual)).not.toContain("Odysseus hidden worker stderr");
  }
});


test("collector refusal uses injected structured logging without forwarding untrusted stderr", async () => {
  const { createRecordingLoggerProvider } = await import("../src/observability/loggers.js");
  const logs = createRecordingLoggerProvider(), log = logs.getLogger("maintenance");
  const attrs = { rootClass: ".brain", depth: 3, uid: 65534, gid: 21001, mode: 0o700, type: "directory" };
  reportMaintenanceGitFailure(log, { exitCode: 1, killed: false,
    stderr: JSON.stringify({ phase: "attrs", errorClass: "Error", errno: "EACCES", attrs }) + "\nConcrete Git source collection refused\n" });
  const records = logs.records();
  expect(records.length, "COLLECTOR_REFUSAL_REACHES_INJECTED_LOGGER").toBe(1);
  expect(records[0]).toMatchObject({ severity: "WARN", body: "maintenance Git source collection refused", attributes: {
    "maintenance.git.exitCode": 1, "maintenance.git.killed": false, "maintenance.git.phase": "attrs",
    "maintenance.git.errorClass": "Error", "maintenance.git.errno": "EACCES", "maintenance.git.rootClass": ".brain",
    "maintenance.git.depth": 3, "maintenance.git.uid": 65534, "maintenance.git.gid": 21001, "maintenance.git.mode": 0o700,
    "maintenance.git.type": "directory",
  } });
  reportMaintenanceGitFailure(log, { exitCode: Infinity, killed: true, stderr: "Odysseus hidden worker stderr" });
  expect(logs.records()[1]!.attributes).toEqual({ "maintenance.git.exitCode": -256, "maintenance.git.killed": true,
    "maintenance.git.phase": "unknown", "maintenance.git.errorClass": "unknown", "maintenance.git.errno": "unknown" });
  expect(JSON.stringify(logs.records())).not.toContain("Odysseus hidden worker stderr");
  reportMaintenanceGitFailure(undefined, { exitCode: 1, stderr: "" });
});

const stampOf = (path: string) => { const info = lstatSync(path); return `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; };
const owned = (root: string, withheld: { path: string; stamp: string }[], attributes: { path: string; data: string }[] = [], maximum = 1024 ** 2) => {
  const info = lstatSync(root), rootIdentity = `${info.dev}:${info.ino}`;
  return collectOwnedGitAttributes(root, { rootIdentity, repository: true, config: [], hookNames: [], attributes, withheld }, maximum, rootIdentity);
};
test("an unsearchable directory is withheld for its owner, never entered or treated as absent policy", () => fixture((root, home) => {
  if (process.geteuid?.() === 0) return; // Root bypasses the permission this control needs.
  mkdirSync(join(root, "private/nested"), { recursive: true });
  writeFileSync(join(root, "private/nested/.gitattributes"), "*.md odysseus=ithaca\n");
  chmodSync(join(root, "private"), 0);
  try {
    const result = collect(root, home); expect(result.code, result.error).toBe(0);
    const answer = parseMaintenanceGitSources(result.output, 1024 ** 2, result.identity);
    expect(answer.attributes, "WORKER_NEVER_ENTERS_WITHHELD_DIRECTORY").toEqual([]);
    expect(answer.withheld, "UNSEARCHABLE_DIRECTORY_WITHHELD_WITH_OBSERVED_IDENTITY").toEqual([{ path: "private", stamp: stampOf(join(root, "private")) }]);
  } finally { chmodSync(join(root, "private"), 0o700); }
}));
test("the owner reads only nested attributes below the exact withheld directory", () => fixture(root => {
  mkdirSync(join(root, "private/nested/node_modules"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "private/.gitattributes"), "*.md odysseus=ithaca\n", { mode: 0o600 });
  writeFileSync(join(root, "private/nested/.gitattributes"), "*.txt penelope=loom\n", { mode: 0o600 });
  writeFileSync(join(root, "private/nested/node_modules/.gitattributes"), "*.js ignored=yes\n", { mode: 0o600 });
  writeFileSync(join(root, "private/result.md"), "Odysseus private voyage\n", { mode: 0o600 });
  const answer = owned(root, [{ path: "private", stamp: stampOf(join(root, "private")) }], [{ path: ".gitattributes", data: "* text\n" }]);
  expect(answer.withheld).toEqual([]);
  expect(answer.attributes, "OWNER_READS_ONLY_WITHHELD_ATTRIBUTES").toEqual([{ path: ".gitattributes", data: "* text\n" },
    { path: "private/.gitattributes", data: "*.md odysseus=ithaca\n" }, { path: "private/nested/.gitattributes", data: "*.txt penelope=loom\n" }]);
  expect(JSON.stringify(answer)).not.toContain("Odysseus private voyage");
  expect(lstatSync(join(root, "private")).mode & 0o777, "OWNER_READ_PRESERVES_PRIVATE_MODES").toBe(0o700);
  expect(() => parseMaintenanceGitSources(JSON.stringify(answer), 1024 ** 2, answer.rootIdentity)).not.toThrow();
}));
test("the owner read refuses replaced identities, aliases, foreign roots and bound overflow", () => {
  const cases = ["replaced", "directory-alias", "ancestor-alias", "attribute-alias", "attribute-hardlink", "foreign-root", "bound"] as const;
  for (const kind of cases) fixture((root, home) => {
    const secret = join(home, "server-secret"); writeFileSync(secret, "Odysseus private server sentinel", { mode: 0o600 });
    mkdirSync(join(root, "outer/private"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "outer/private/.gitattributes"), "*.md odysseus=ithaca\n", { mode: 0o600 });
    let path = "outer/private", stamp = stampOf(join(root, path));
    if (kind === "replaced") { rmSync(join(root, path), { recursive: true }); mkdirSync(join(root, path), { mode: 0o700 }); }
    if (kind === "directory-alias") { symlinkSync(join(root, path), join(root, "alias")); path = "alias"; stamp = stampOf(join(root, "alias")); }
    if (kind === "ancestor-alias") { symlinkSync(join(root, "outer"), join(root, "link")); path = "link/private"; }
    if (kind === "attribute-alias") { rmSync(join(root, path, ".gitattributes")); symlinkSync(secret, join(root, path, ".gitattributes")); stamp = stampOf(join(root, path)); }
    if (kind === "attribute-hardlink") { rmSync(join(root, path, ".gitattributes")); linkSync(secret, join(root, path, ".gitattributes")); stamp = stampOf(join(root, path)); }
    let failure: unknown;
    try {
      if (kind === "foreign-root") {
        const info = lstatSync(home), foreign = `${info.dev}:${info.ino}`;
        collectOwnedGitAttributes(home, { rootIdentity: foreign, repository: true, config: [], hookNames: [], attributes: [], withheld: [{ path, stamp }] }, 1024 ** 2, lstatSync(root).dev + ":" + lstatSync(root).ino);
      } else owned(root, [{ path, stamp }], [], kind === "bound" ? 200 : 1024 ** 2);
    } catch (error) { failure = error; }
    expect(failure, `OWNER_READ_REFUSES_${kind}`).toBeInstanceOf(Error);
    expect(String(failure), kind).toContain("Concrete Git source collection refused");
    expect(JSON.stringify((failure as { diagnostic?: unknown }).diagnostic ?? null), kind).not.toContain("Odysseus private server sentinel");
  });
});
test("the receipt parser refuses withheld paths that escape, nest or carry malformed identities", () => {
  const base = { rootIdentity: "1:2", repository: true, config: [], hookNames: [], attributes: [] as { path: string; data: string }[] };
  const stamp = "1:3:16832:2:0:1792657436952.9451:1792657436952";
  expect(parseMaintenanceGitSources(JSON.stringify({ ...base, withheld: [{ path: ".brain/scratch/private", stamp }] }), 4096, "1:2").withheld).toHaveLength(1);
  for (const [withheld, attributes] of [
    [[{ path: "../private", stamp }], []], [[{ path: ".git/hooks", stamp }], []], [[{ path: "private", stamp: "odysseus" }], []],
    [[{ path: "private", stamp }, { path: "private/nested", stamp }], []], [[{ path: "private", stamp }], [{ path: "private/.gitattributes", data: "" }]],
    [[{ path: "private", stamp, extra: true }], []], [[{ path: "private", stamp }, { path: "private", stamp }], []],
  ] as const) expect(() => parseMaintenanceGitSources(JSON.stringify({ ...base, attributes, withheld }), 4096, "1:2"), JSON.stringify(withheld)).toThrow();
  expect(() => parseMaintenanceGitSources(JSON.stringify({ ...base, repository: false, attributes: [], config: [], withheld: [{ path: "private", stamp }] }), 4096, "1:2")).toThrow();
});

test("owner-read refusal reaches the injected logger with only fixed topology fields", async () => {
  const { createRecordingLoggerProvider } = await import("../src/observability/loggers.js");
  const logs = createRecordingLoggerProvider(), log = logs.getLogger("maintenance");
  fixture(root => {
    mkdirSync(join(root, "private"), { mode: 0o700 });
    try { owned(root, [{ path: "private", stamp: "0:0:0:0:0:0:0" }]); } catch (error) { reportOwnedGitFailure(log, error); }
  });
  const info = { uid: process.getuid!(), gid: process.getgid!() };
  expect(logs.records().map(row => [row.body, row.attributes]), "OWNER_READ_REFUSAL_IS_REPORTED").toEqual([["maintenance Git owner input refused", {
    "maintenance.git.phase": "owner", "maintenance.git.errorClass": "Error", "maintenance.git.errno": "unknown", "maintenance.git.rootClass": "private",
    "maintenance.git.depth": 1, "maintenance.git.uid": info.uid, "maintenance.git.gid": info.gid, "maintenance.git.mode": 0o700, "maintenance.git.type": "directory" }]]);
});
