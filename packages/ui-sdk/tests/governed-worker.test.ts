import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, linkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareWorkerSandbox, workerCommand } from "../src/server/worker-launcher.js";
import { createFixtureWorkerStartupView as createWorkerStartupView } from "./helpers/worker-startup-view-fixture.js";
import { workerSandboxNote } from "../src/server/worker-sandbox.js";
import { resolveWorkerProtection } from "../src/server/worker-protection.js";
import { protectedPaths } from "../src/server/protected-paths.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const brain = mkdtempSync(join(tmpdir(), "governed-worker-")); roots.push(brain);
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), "Athena sets the policy.\n");
  writeFileSync(join(brain, "harbor.md"), "Odysseus arrives.\n");
  return brain;
}
test("governed worker writes ordinary Markdown while the policy stays read-only", () => {
  const brain = fixture();
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
  const argv = workerCommand({ brainPath: brain, sandbox, env: {}, command: ["/bin/sh", "-c",
    'printf "Odysseus departs.\\n" > harbor.md || exit 41; if printf attack > context/policies/governance.md; then exit 42; fi'] });
  const child = Bun.spawnSync(argv, { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(readFileSync(join(brain, "harbor.md"), "utf8")).toBe("Odysseus departs.\n");
  expect(readFileSync(join(brain, "context/policies/governance.md"), "utf8")).toBe("Athena sets the policy.\n");
});

test("every protected file resists writes, aliases, replacement and ancestor rename in a real worker", () => {
  const brain = fixture();
  const directories = new Set(["context/policies", ".git/hooks", ".git/info", ".git/modules", "node_modules"]);
  const protectedFiles: string[] = [];
  for (const path of protectedPaths()) {
    const file = directories.has(path) ? `${path}/sentinel` : path;
    mkdirSync(join(brain, file, ".."), { recursive: true });
    writeFileSync(join(brain, file), "Athena protects this input.\n");
    protectedFiles.push(file);
  }
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
  expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const commands = protectedFiles.map(file => `
    if printf attack > ${quote(file)} 2>/dev/null; then echo WRITE:${quote(file)}; exit 41; fi
    if ln ${quote(file)} alias.md 2>/dev/null; then echo HARDLINK:${quote(file)}; exit 42; fi
    ln -s ${quote(file)} alias.md || exit 43
    if printf attack > alias.md 2>/dev/null; then echo SYMLINK:${quote(file)}; exit 44; fi
    rm alias.md || exit 45
    printf attack > replacement.md
    if mv -T replacement.md ${quote(file)} 2>/dev/null; then echo REPLACE:${quote(file)}; exit 46; fi
    rm -f replacement.md
  `).join("\n");
  const ancestors = sandbox.protection!.ancestors.map(path => `if mv -T ${quote(path)} ${quote(`${path}-moved`)} 2>/dev/null; then echo ANCESTOR:${quote(path)}; exit 47; fi`).join("\n");
  const child = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", `${commands}\n${ancestors}`] }), { cwd: "/", env: {}, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
  for (const path of protectedFiles) expect(readFileSync(join(brain, path), "utf8")).toBe("Athena protects this input.\n");
});

test("a linked protected root falls back to strict with the cause", () => {
  for (const kind of ["symlink", "hardlink"] as const) {
    const brain = fixture();
    writeFileSync(join(brain, "source.md"), "Odysseus.\n");
    if (kind === "symlink") symlinkSync("source.md", join(brain, "brain.config.ts"));
    else linkSync(join(brain, "source.md"), join(brain, "brain.config.ts"));
    const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
    expect(sandbox.profile).toBe("strict");
    expect(sandbox.fallbackReason).toContain(kind === "symlink" ? "symlink" : "hardlinked");
  }
});

test("governed peers may consume a protected name created after launch", async () => {
  const brain = fixture();
  const first = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
  // Launch reconciliation sees no new protected name yet.
  const second = prepareWorkerSandbox(brain, { profile: "governed", areas: [], appearedPaths: [] });
  const reader = Bun.spawn(workerCommand({ brainPath: brain, sandbox: second, env: {}, command: ["/bin/sh", "-c",
    'printf ready > reader-ready.md; for i in $(seq 1 200); do if test -f writer-done.md; then if test -s .mcp.json; then cat .mcp.json; exit 0; fi; exit 43; fi; sleep 0.01; done; exit 44'] }),
    { env: {}, stdout: "pipe", stderr: "pipe" });
  const writer = Bun.spawn(workerCommand({ brainPath: brain, sandbox: first, env: {}, command: ["/bin/sh", "-c",
    'for i in $(seq 1 200); do if test -f reader-ready.md; then printf "{\\"mcpServers\\":{\\"odysseus\\":{\\"command\\":\\"/bin/true\\"}}}" > .mcp.json; printf done > writer-done.md; exit 0; fi; sleep 0.01; done; exit 45'] }),
    { env: {}, stdout: "pipe", stderr: "pipe" });
  const [writerExit, readerExit, output, errors] = await Promise.all([writer.exited, reader.exited,
    new Response(reader.stdout).text(), new Response(reader.stderr).text()]);
  expect(writerExit, "first governed worker created the file after the reader was inside its worker").toBe(0);
  expect(readerExit, `GOVERNED_PEER_CONFIG_VISIBLE: ${output} ${errors}`).toBe(0);
  expect(output).toContain("odysseus");
});

test.each(["governed", "strict"] as const)("%s secret masks survive the last brain bind", profile => {
  const brain = fixture();
  writeFileSync(join(brain, ".env"), "ODYSSEUS_SECRET=must-stay-hidden\n");
  const view = profile === "strict" ? createWorkerStartupView(brain) : undefined;
  try {
    const sandbox = prepareWorkerSandbox(brain, { profile, areas: [] });
    const child = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, startupView: view, env: {},
      command: ["/bin/sh", "-c", "cat .env || :"] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString(), "SECRET_MASK_AFTER_FINAL_BIND").toBe("");
  } finally { view?.cleanup(); }
});

test("governed context names exactly the resolved protection list", () => {
  const brain = fixture();
  const original = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
  const extra = { rel: "notes/athena.md", mode: "read_only" as const, reason: "Athena's custom rule" };
  const sandbox = { ...original, protection: { ...original.protection!, paths: [...original.protection!.paths, extra] } };
  const note = workerSandboxNote(sandbox);
  expect(note).toContain("**Profile: `governed`.**");
  for (const path of sandbox.protection.paths) expect(note).toContain(`- \`${path.rel}\`: ${path.reason}`);
  expect(workerSandboxNote(original)).not.toContain("notes/athena.md");
});

test("the governed /run mask refuses a host Unix socket", async () => {
  const brain = fixture();
  const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--dev", "/dev", "--tmpfs", "/run",
    process.execPath, "--config=/dev/null", "--no-env-file", resolve(import.meta.dir, "../../../tests/fixtures/governed-socket-probe.ts"), brain],
    { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, errors + output).toBe(0);
  expect(JSON.parse(output.trim()), "HOST_SOCKET_MASKED").toEqual({ code: 0, hits: 0 });
});


test("a missing protection root reports a strict fallback instead of throwing", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "odysseus-missing-protection-")), "absent");
  try {
    const result = resolveWorkerProtection(missing);
    expect(result.reason, "MISSING_PROTECTION_ROOT_REFUSAL").toBe("protected paths could not be verified: ENOENT");
    expect(result.protection).toEqual({ paths: [], ancestors: [] });
  } finally { rmSync(join(missing, ".."), { recursive: true, force: true }); }
});


test("provider folder topology pins its root and ancestors while preserving live writes", () => {
  const brain = fixture();
  mkdirSync(join(brain, "group/private"), { recursive: true });
  writeFileSync(join(brain, "group/private/identity.md"), "Odysseus private identity.\n");
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
  expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
  expect(workerSandboxNote(sandbox)).toContain("Keep these folders and their ancestors in place: `group/private`");
  const child = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", `
    if mv group/private group/moved-private 2>/dev/null; then echo ROOT_RENAMED; exit 41; fi
    if mv group group-moved 2>/dev/null; then echo ANCESTOR_RENAMED; exit 42; fi
    printf 'Athena private addition.\\n' > group/private/new.md || exit 43
    printf 'Odysseus public addition.\\n' > group/public.md || exit 44
  `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, `PROVIDER_FOLDER_TOPOLOGY_SURVIVES_NATIVE_WRITER: ${child.stdout.toString()} ${child.stderr.toString()}`).toBe(0);
  expect(readFileSync(join(brain, "group/private/new.md"), "utf8")).toBe("Athena private addition.\n");
  expect(readFileSync(join(brain, "group/public.md"), "utf8")).toBe("Odysseus public addition.\n");
});


test("unverified provider folder topology selects strict without materializing missing roots", () => {
  for (const kind of ["missing", "symlink", "hardlink", "linked-child"] as const) {
    const brain = fixture();
    if (kind !== "missing") {
      mkdirSync(join(brain, "group/private"), { recursive: true });
      writeFileSync(join(brain, "outside.md"), "Odysseus original.\n");
      if (kind === "symlink") { rmSync(join(brain, "group/private"), { recursive: true }); symlinkSync("../outside.md", join(brain, "group/private")); }
      if (kind === "hardlink") linkSync(join(brain, "outside.md"), join(brain, "group/private/alias.md"));
      if (kind === "linked-child") symlinkSync("../../outside.md", join(brain, "group/private/alias.md"));
    }
    const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
    expect(sandbox.profile, `UNVERIFIED_PROVIDER_FOLDER_REFUSES_GOVERNED_TOPOLOGY: ${kind}`).toBe("strict");
    expect(sandbox.fallbackReason).toContain("protected paths could not be verified");
    if (kind === "missing") expect(existsSync(join(brain, "group")), "ABSENT_PROVIDER_FOLDER_IS_NOT_MATERIALIZED").toBe(false);
  }
});

test("a provider folder swapped before launch is not pinned under its stale inspection", () => {
  const brain = fixture(); mkdirSync(join(brain, "group/private"), { recursive: true });
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
  renameSync(join(brain, "group/private"), join(brain, "group/held")); mkdirSync(join(brain, "group/private"));
  expect(() => workerCommand({ brainPath: brain, sandbox, env: {}, command: ["/bin/true"] }), "STALE_PROVIDER_FOLDER_TOPOLOGY_REFUSES_LAUNCH").toThrow("provider folder topology changed before launch");
});


test("root and ancestor pins keep live peer additions behind a fixed directory cover", async () => {
  const brain = fixture(); mkdirSync(join(brain, "group/private"), { recursive: true });
  writeFileSync(join(brain, "group/private/identity.md"), "Odysseus private identity.\n");
  const prepare = () => prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
  const sandbox = prepare(); expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
  const argv = workerCommand({ brainPath: brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
    'printf "READY\\n"; IFS= read -r go; cat group/private/born.md 2>/dev/null || :; cat group/public.md'] });
  // A fixed fixture cover exercises topology only. Production provider routing remains inactive.
  argv.splice(argv.lastIndexOf("--clearenv"), 0, "--tmpfs", join(brain, "group/private"), "--remount-ro", join(brain, "group/private"));
  const reader = Bun.spawn(argv, { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stream = reader.stdout.getReader(); let output = "";
  const errors = new Response(reader.stderr).text();
  const ready = async () => {
    while (!output.includes("READY\n")) { const next = await stream.read(); if (next.done) throw Error("Provider folder reader exited before readiness"); output += new TextDecoder().decode(next.value); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Provider folder reader readiness timed out")), 5000); })]);
    clearTimeout(timer);
    const writer = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox: prepare(), env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", `
      mv -T group/private group/moved-private 2>/dev/null; printf 'root=%s\\n' "$?"
      mkdir -p group/private
      mv -T group group-moved 2>/dev/null; printf 'ancestor=%s\\n' "$?"
      mkdir -p group/private
      printf 'Athena new private marker.\\n' > group/private/born.md || exit 43
      printf 'Odysseus public witness.\\n' > group/public.md || exit 44
      ln group/private/born.md public-alias.md 2>/dev/null; printf 'alias=%s\\n' "$?"
    `] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(writer.exitCode, writer.stderr.toString()).toBe(0);
    reader.stdin.write("go\n"); reader.stdin.end();
    for (;;) { const next = await stream.read(); if (next.done) break; output += new TextDecoder().decode(next.value); }
    expect(await reader.exited, await errors).toBe(0);
    expect(output, "ALL_WRITER_ROOT_AND_ANCESTOR_PINS_KEEP_LIVE_PRIVATE_CHILD_HIDDEN").not.toContain("Athena new private marker");
    expect(output, "PERMITTED_SIBLING_REMAINS_LIVE").toContain("Odysseus public witness");
    expect(writer.stdout.toString(), "ROOT_ANCESTOR_AND_OUTSIDE_HARDLINK_REFUSALS").toBe("root=1\nancestor=1\nalias=1\n");
    expect(readFileSync(join(brain, "group/private/born.md"), "utf8"), "ALLOWED_PEER_RETAINS_PRIVATE_SUBTREE_WRITES").toBe("Athena new private marker.\n");
  } finally { clearTimeout(timer); reader.kill(); await reader.exited; await errors; stream.releaseLock(); }
});
