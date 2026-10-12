import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { maintenanceLaunch, probeWorkerHost, runMaintenanceWorker } from "@schlessera/brain-ui-sdk/internal";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createHostBoundary } from "../src/brain/host-boundary";
import { createBrainClient } from "../src/brain/client";
import { assertMirrorStorage, syncMirrorPath, syncTransportCommand } from "../src/brain/sync-mirror";
import { createHostExecution } from "../src/brain/host-execution";
import { createUiDb } from "../src/db/client";

const ROOT = resolve(import.meta.dir, "../../..");
const TOKEN = "fixture-sync-token-never-for-the-brain";
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/sync-mirror-probe-"));
  try { expect(probeWorkerHost(root), "this security proof requires the actual worker boundary").toEqual({ ok: true }); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", "-C", root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args],
    { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function fixture() {
  const root = mkdtempSync(join(ROOT, "tmp/sync-mirror-")); roots.push(root);
  const brain = join(root, "brain");
  const remote = join(root, "remote.git");
  const state = join(root, "state"); mkdirSync(state);
  cpSync(join(ROOT, "packages/core/fixtures/corpus"), brain, { recursive: true });
  mkdirSync(remote);
  git(remote, "init", "--bare", "-b", "main");
  git(brain, "init", "-b", "main");
  git(brain, "config", "user.name", "Odysseus");
  git(brain, "config", "user.email", "odysseus@ithaca.example");
  writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/\nbrain.db*\nhelper.ts\nfilter.conf\n*.sentinel\n");
  writeFileSync(join(brain, ".gitattributes"), "notes/harbor.md filter=sentinel\n");
  const original = readFileSync(join(brain, "brain.config.ts"), "utf8");
  writeFileSync(join(brain, "brain.config.ts"), original.replace('"@schlessera/brain"', JSON.stringify(join(ROOT, "packages/core/src/index.ts")))
    .replace("profile: {", 'agentRunner: "fixture-unavailable",\n  profile: {'));
  git(brain, "add", "."); git(brain, "commit", "-m", "Harbor notebook");
  git(brain, "remote", "add", "origin", remote); git(brain, "push", "origin", "main");
  const other = join(root, "other"); git(root, "clone", remote, other);
  mkdirSync(join(other, "notes"), { recursive: true });
  writeFileSync(join(other, "notes/sea.md"), "---\ntitle: Sea\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\nTelemachus watches the tide.\n");
  git(other, "add", "."); git(other, "commit", "-m", "Watch the tide"); git(other, "push", "origin", "main");
  const helper = `import { appendFileSync, readFileSync } from "node:fs";
let home; try { home = readFileSync(${JSON.stringify(join(state, "credential"))}, "utf8"); } catch { home = "masked"; }
appendFileSync(process.cwd() + "/config.sentinel", JSON.stringify({ env: process.env, home }) + "\\n");\n`;
  writeFileSync(join(state, "credential"), TOKEN, { mode: 0o600 });
  writeFileSync(join(brain, "helper.ts"), helper);
  writeFileSync(join(brain, "brain.config.ts"), `import "./helper.ts";\n` + readFileSync(join(brain, "brain.config.ts"), "utf8"));
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/harbor.md"), "---\ntitle: Harbor\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\nPenelope checks the ropes.\n");
  writeFileSync(join(brain, ".gitattributes"), "notes/harbor.md filter=sentinel\n");
  writeFileSync(join(brain, "filter.conf"), `[filter "sentinel"]\n\tclean = "sh -c 'printf \\\"filter:%s\\\\n\\\" \\\"$BRAIN_UI_SYNC_GITHUB_TOKEN\\\" >> filter.sentinel; cat'"\n\tsmudge = cat\n\trequired = true\n`);
  git(brain, "config", "include.path", "../filter.conf");
  mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
  const cli = join(brain, "node_modules/.bin/brain");
  writeFileSync(cli, `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(ROOT, "packages/core/src/cli/brain.ts"))});\n`); chmodSync(cli, 0o755);
  return { root, brain, remote, state, dbPath: join(state, "ui.db") };
}

/** Real loopback smart-HTTP Git; neither the CGI process nor the remote needs a credential. */
function fixtureRemote(root: string, remote: string, received?: string[]) {
  git(remote, "config", "http.receivepack", "true");
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    received?.push(`${request.method} ${url.pathname}`);
    const body = new Uint8Array(await request.arrayBuffer());
    const child = Bun.spawn(["/usr/bin/git", "http-backend"], { stdin: body, stdout: "pipe", stderr: "pipe", env: {
      PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length),
    } });
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) return new Response(stderr, { status: 500 });
    const bytes = new Uint8Array(output);
    const separator = Buffer.from(bytes).indexOf("\r\n\r\n");
    if (separator < 0) return new Response("missing CGI headers", { status: 500 });
    const headers = new Headers(); let status = 200;
    for (const line of new TextDecoder().decode(bytes.slice(0, separator)).split("\r\n")) {
      const colon = line.indexOf(":"); const name = line.slice(0, colon); const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers.append(name, value);
    }
    return new Response(bytes.slice(separator + 4), { status, headers });
  } });
}

test("full hosted sync commits, pulls and pushes while config and included filter see no credential", async () => {
  const f = fixture();
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.dbPath });
  expect(boundary.isolated()).toBe(true);
  const server = fixtureRemote(f.root, f.remote);
  git(f.brain, "remote", "set-url", "origin", `${server.url}remote.git`);
  const old = process.env.BRAIN_UI_SYNC_GITHUB_TOKEN;
  process.env.BRAIN_UI_SYNC_GITHUB_TOKEN = TOKEN;
  try {
    const client = createBrainClient({ brainPath: f.brain, boundary, exec: {} });
    const result = await client.sync().catch(error => { throw new Error(JSON.stringify(error.result) + "\n" + error.message); });
    expect(result.result?.run.status, JSON.stringify(result)).toBe("complete");
    expect(git(f.remote, "show", "main:notes/harbor.md")).toContain("Penelope checks the ropes.");
    expect(git(f.brain, "rev-parse", "HEAD")).toBe(git(f.remote, "rev-parse", "main"));
    expect(readFileSync(join(f.brain, "notes/sea.md"), "utf8"), "REMOTE_CONTENT_PULLED").toContain("Telemachus watches the tide.");
    const sentinel = readFileSync(join(f.brain, "config.sentinel"), "utf8");
    expect(sentinel, "CONFIG_HELPER_RAN").toContain('"home":"masked"');
    expect(sentinel, "SYNC_CREDENTIAL_ABSENT: helper environment and host files contain no credential").not.toContain(TOKEN);
    const filter = readFileSync(join(f.brain, "filter.sentinel"), "utf8");
    expect(filter, "INCLUDED_FILTER_RAN_UNCREDENTIALED").toContain("filter:");
    expect(filter, "FILTER_CREDENTIAL_ABSENT").not.toContain(TOKEN);
    const mirror = syncMirrorPath(f.brain, f.dbPath);
    expect(readFileSync(join(mirror, "config"), "utf8"), "HOST_CONFIG_HAS_NO_INCLUDES_OR_CREDENTIAL").not.toMatch(/include|credential|token/);
    expect(git(mirror, "fsck", "--full", "--strict")).toBe("");
  } finally { server.stop(true); if (old === undefined) delete process.env.BRAIN_UI_SYNC_GITHUB_TOKEN; else process.env.BRAIN_UI_SYNC_GITHUB_TOKEN = old; }
}, 120_000);

test("credentialed transport mounts no brain, Git config or broad host ancestor, and cannot evaluate the included filter", async () => {
  const f = fixture();
  const mirror = join(f.state, "transport.git"); mkdirSync(mirror); git(mirror, "init", "--bare", "-b", "main");
  const transport = syncTransportCommand({ brain: f.brain, mirror, remote: "https://github.com/odyssey-fixtures/brain.git", env: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN }, args: ["fsck", "--full", "--strict"] });
  const argv = workerCommand(maintenanceLaunch(transport));
  const mounts: string[] = [];
  for (let index = 0; index < argv.length; index++) if (["--bind", "--ro-bind"].includes(argv[index]!)) mounts.push(argv[index + 1]!);
  expect(mounts, "TRANSPORT_MOUNTS_EXCLUDE_BRAIN").not.toContain(f.brain);
  expect(mounts).not.toContain(join(f.brain, ".git"));
  expect(mounts).not.toContain("/");
  const command = ["/bin/sh", "-c", `test ! -e "$1" && test ! -e "$1/.git/config" && test "$BRAIN_SYNC_TOKEN" = "$2" && printf TRANSPORT_BOUNDARY_OK`, "probe", f.brain, TOKEN];
  const result = await runMaintenanceWorker({ ...transport, command });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout, "REAL_TRANSPORT_CANNOT_READ_BRAIN_AND_HAS_ITS_KEY").toBe("TRANSPORT_BOUNDARY_OK");
  expect(existsSync(join(f.brain, "filter.sentinel")), "NO_FILTER_IN_TRANSPORT").toBe(false);
});

test("linked objects, refs and object alternates are rejected before transport admits credentials", () => {
  const f = fixture();
  const mirror = join(f.state, "mirror.git"); mkdirSync(mirror); git(mirror, "init", "--bare", "-b", "main");
  const link = join(mirror, "refs/heads/main"); symlinkSync(join(f.state, "credential"), link);
  expect(() => assertMirrorStorage(mirror), "LINKED_REF_REFUSED").toThrow("linked"); rmSync(link);
  const alternate = join(mirror, "objects/info/alternates"); writeFileSync(alternate, `${join(f.brain, ".git/objects")}\n`);
  expect(() => assertMirrorStorage(mirror), "ALTERNATES_REFUSED").toThrow("alternates"); rmSync(alternate);
  symlinkSync(f.brain, join(mirror, "objects/aa"));
  expect(() => assertMirrorStorage(mirror), "LINKED_OBJECT_REFUSED").toThrow("linked");
});

test("maintenance cannot write mirror config or hooks; a background writer cannot survive into credentialed transport", async () => {
  const f = fixture();
  const mirror = syncMirrorPath(f.brain, f.dbPath);
  const poison = join(f.brain, "poison.sentinel");
  writeFileSync(join(f.brain, "helper.ts"), readFileSync(join(f.brain, "helper.ts"), "utf8") + `
for (const name of ["config", "HEAD", "hooks/pre-receive"]) {
  try { require("node:fs").writeFileSync(${JSON.stringify(mirror)} + "/" + name, "poison"); require("node:fs").appendFileSync(${JSON.stringify(poison)}, "WROTE " + name + "\\n"); }
  catch (error) { require("node:fs").appendFileSync(${JSON.stringify(poison)}, name + ":" + error.code + "\\n"); }
}
// The namespace init reaps this descendant when the CLI exits. It cannot
// race the host's storage validation after runMaintenanceWorker settles.
Bun.spawn(["/bin/sh", "-c", ${JSON.stringify('sleep 1; printf poisoned > "$1"')}, "child", ${JSON.stringify(join(mirror, "objects/info/alternates"))}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
`);
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.dbPath });
  let syncError: unknown;
  await createBrainClient({ brainPath: f.brain, boundary, exec: {} }).sync().catch(error => { syncError = error; });
  expect(readFileSync(poison, "utf8"), "MIRROR_METADATA_IMMUTABLE").not.toContain("WROTE");
  if (syncError) throw syncError;
  await Bun.sleep(1_100);
  expect(existsSync(join(mirror, "objects/info/alternates")), "MAINTENANCE_CHILD_GONE_BEFORE_TRANSPORT").toBe(false);
  expect(git(f.remote, "show", "main:notes/harbor.md")).toContain("Penelope checks the ropes.");
}, 120_000);

test("a regular corrupt object fails host fsck before the external remote is pushed", async () => {
  const f = fixture();
  const mirror = syncMirrorPath(f.brain, f.dbPath);
  const received: string[] = [];
  const server = fixtureRemote(f.root, f.remote, received);
  git(f.brain, "remote", "set-url", "origin", `${server.url}remote.git`);
  writeFileSync(join(f.brain, "helper.ts"), readFileSync(join(f.brain, "helper.ts"), "utf8") + `
require("node:fs").mkdirSync(${JSON.stringify(join(mirror, "objects/aa"))}, { recursive: true });
require("node:fs").writeFileSync(${JSON.stringify(join(mirror, "objects/aa", "0".repeat(38)))}, "not a compressed git object");
`);
  try {
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.dbPath });
    await expect(createBrainClient({ brainPath: f.brain, boundary, exec: {} }).sync(), "CORRUPT_OBJECT_FSCK_REFUSED").rejects.toThrow(/inflate|corrupt|unable to unpack|bad object/);
    expect(received, "NO_PUSH_AFTER_FAILED_FSCK").not.toContain("POST /remote.git/git-receive-pack");
  } finally { server.stop(true); }
}, 120_000);

test("a sync launch that fails during preparation releases the writer gate for another request", async () => {
  const f = fixture();
  const db = createUiDb(f.dbPath);
  const execution = createHostExecution({ brainPath: f.brain, dbPath: f.dbPath, exec: { wrapper: join(f.root, "missing-wrapper") } });
  try {
    execution.attach(db);
    await expect(execution.boundary.launch({ argv: ["/bin/true"], env: { PATH: "/usr/bin:/bin" }, credentials: false,
      gate: "exclusive", sync: true, purpose: "failed-start sync" })).rejects.toThrow("does not exist");
    let hold: Awaited<ReturnType<NonNullable<ReturnType<typeof execution.gate>>["acquire"]>> | undefined;
    await expect(execution.gate()!.acquire("exclusive", "next request", { signal: AbortSignal.timeout(1_000) })
      .then(next => { hold = next; return true; }), "GATE_REUSABLE_AFTER_FAILED_SYNC_START").resolves.toBe(true);
    hold!.release();
  } finally { db.close(); }
});

test("an abort immediately after gate acquisition starts no sync worker and releases the gate", async () => {
  const f = fixture();
  const db = createUiDb(f.dbPath);
  const execution = createHostExecution({ brainPath: f.brain, dbPath: f.dbPath, exec: {} });
  const controller = new AbortController();
  try {
    execution.attach(db);
    const gate = execution.gate()!;
    const acquire = gate.acquire.bind(gate);
    const intercepted = spyOn(gate, "acquire").mockImplementation(async (...args) => {
      const hold = await acquire(...args);
      controller.abort(new Error("aborted at gate handoff"));
      return hold;
    });
    try {
      await expect(execution.boundary.launch({ argv: ["/bin/sh", "-c", 'printf started > "$1"', "probe", join(f.brain, "started.sentinel")],
        env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "exclusive", sync: true,
        purpose: "aborted sync", signal: controller.signal }).then(async worker => {
          worker.kill("SIGKILL");
          await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
          return worker;
        }), "ABORT_AT_GATE_PREVENTS_SYNC_START").rejects.toThrow("aborted at gate handoff");
    } finally { intercepted.mockRestore(); }
    expect(existsSync(join(f.brain, "started.sentinel")), "ABORTED_SYNC_NEVER_EXECUTED").toBe(false);
    const next = await gate.acquire("exclusive", "next request", { signal: AbortSignal.timeout(1_000) }); next.release();
  } finally { db.close(); }
});

test("worker-created object alternates are refused before any credentialed transport evaluates them", async () => {
  const f = fixture();
  const mirror = syncMirrorPath(f.brain, f.dbPath);
  writeFileSync(join(f.brain, "helper.ts"), readFileSync(join(f.brain, "helper.ts"), "utf8") + `
require("node:fs").writeFileSync(${JSON.stringify(join(mirror, "objects/info/alternates"))}, ${JSON.stringify(join(f.brain, ".git/objects") + "\n")});
`);
  const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.dbPath });
  await expect(createBrainClient({ brainPath: f.brain, boundary, exec: {} }).sync(), "ALTERNATES_REFUSED_BEFORE_TRANSPORT")
    .rejects.toThrow("sync mirror object alternates are forbidden");
  expect(git(f.remote, "show", "main:notes/sea.md")).toContain("Telemachus watches the tide.");
  expect(Bun.spawnSync(["/usr/bin/git", "--git-dir", f.remote, "cat-file", "-e", "main:notes/harbor.md"],
    { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).exitCode,
    "ALTERNATES_NEVER_PUSHED").not.toBe(0);
}, 120_000);
