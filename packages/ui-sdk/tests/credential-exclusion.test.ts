import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostCredentialExclusion } from "../src/server/credential-exclusion.js";

const roots: string[] = [];
const holds: Array<{ release(): void }> = [];
function domain() { const directory = mkdtempSync(join(tmpdir(), "odysseus-credential-exclusion-")); roots.push(directory); return { directory }; }
afterEach(() => { for (const hold of holds.splice(0)) hold.release(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("actual kernel lock survives the short helper, excludes another open description and releases exactly once", async () => {
  const scope = domain(); const first = await acquireHostCredentialExclusion({ domain: scope }); holds.push(first);
  await expect(acquireHostCredentialExclusion({ domain: scope })).rejects.toMatchObject({ reason: "busy" });
  first.release(); first.release();
  const next = await acquireHostCredentialExclusion({ domain: scope }); holds.push(next);
});

test("a waiting resolver cancels without releasing the actual owner", async () => {
  const scope = domain(); const first = await acquireHostCredentialExclusion({ domain: scope }); holds.push(first);
  const abort = new AbortController();
  const pending = acquireHostCredentialExclusion({ domain: scope, timeoutMs: 1000, signal: abort.signal });
  abort.abort(new Error("odysseus-private-reason"));
  await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  await expect(acquireHostCredentialExclusion({ domain: scope })).rejects.toMatchObject({ reason: "busy" });
});

test("another actual process is excluded until holder exit and can acquire the retained inode after a crash", async () => {
  const scope = domain();
  const source = new URL("../src/server/credential-exclusion.ts", import.meta.url).href;
  const script = `const {acquireHostCredentialExclusion}=await import(${JSON.stringify(source)});
    const lease=await acquireHostCredentialExclusion({domain:${JSON.stringify(scope)}});console.log("locked");await Bun.stdin.text();lease.release();`;
  const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], {
    cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(); const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("locked\n");
    await expect(acquireHostCredentialExclusion({ domain: scope })).rejects.toMatchObject({ reason: "busy" });
    child.kill("SIGKILL"); await child.exited;
    const next = await acquireHostCredentialExclusion({ domain: scope }); holds.push(next);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally { child.kill("SIGKILL"); await child.exited; }
});

for (const unsafe of ["directory-permissions", "lock-symlink", "lock-permissions"] as const) test(`credential exclusion rejects ${unsafe}`, async () => {
  const scope = domain();
  if (unsafe === "directory-permissions") chmodSync(scope.directory, 0o755);
  else {
    const path = join(scope.directory, "credentials.lock");
    if (unsafe === "lock-symlink") { const target = join(scope.directory, "odysseus-target"); writeFileSync(target, "", { mode: 0o600 }); symlinkSync(target, path); }
    else writeFileSync(path, "", { mode: 0o644 });
  }
  await expect(acquireHostCredentialExclusion({ domain: scope })).rejects.toMatchObject({ reason: "unavailable" });
});
