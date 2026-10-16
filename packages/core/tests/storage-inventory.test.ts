import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "odysseus-storage-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cli = resolve(import.meta.dir, "../src/cli/brain.ts");
async function inventory(root: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, "storage", "inventory", "--json"], {
    env: { ...process.env, BRAIN_ROOT: root, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}

test("inventory counts hidden attachments and hard-link entries separately from physical objects without executing config", async () => {
  const root = fixture();
  writeFileSync(join(root, "brain.config.ts"), "throw new Error(\"CONFIG_MUST_NOT_EXECUTE\");");
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, ".hidden", "raft.PDF"), ""); truncateSync(join(root, ".hidden", "raft.PDF"), 5_000_001);
  linkSync(join(root, ".hidden", "raft.PDF"), join(root, "copy.pdf"));
  writeFileSync(join(root, "boundary.pdf"), ""); truncateSync(join(root, "boundary.pdf"), 5_000_000);
  symlinkSync(root, join(root, "loop"));
  const result = await inventory(root);
  expect(result.status, "COMPLETE_BOUNDED_SCAN").toBe("complete");
  const pdfs = result.entries.filter((entry: any) => entry.pdfOver5MB);
  expect(pdfs.map((entry: any) => entry.path).sort(), "STRICT_DECIMAL_THRESHOLD").toEqual([".hidden/raft.PDF", "copy.pdf"]);
  expect(pdfs[0].objectId, "HARDLINK_IDENTITY").toBe(pdfs[1].objectId);
  expect(result.totals.entryLogicalBytes - result.totals.objectLogicalBytes, "OBJECT_UNION").toBe(5_000_001);
  expect(result.entries.find((entry: any) => entry.path === "loop").kind).toBe("symlink");
  expect(result.entries.some((entry: any) => entry.path.startsWith("loop/"))).toBe(false);
  expect(readFileSync(join(root, "brain.config.ts"), "utf8")).toContain("CONFIG_MUST_NOT_EXECUTE");
  const file = result.entries.find((entry: any) => entry.path === ".hidden/raft.PDF");
  expect(file.allocatedBytes).toBe(statSync(join(root, ".hidden", "raft.PDF")).blocks * 512);
});

const collectorPath = resolve(import.meta.dir, "../src/lib/storage-inventory.ts");
const { collectStorageInventory } = await import(collectorPath);
function git(root: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return child.stdout.toString().trim();
}
test("resolves real linked worktrees and approved alternates without counting shared stores twice", async () => {
  const root = fixture(), worktree = join(root, "worktree"), repo = join(root, "repo"), alternate = join(root, "alternate");
  mkdirSync(repo); mkdirSync(alternate);
  git(repo, "init"); git(alternate, "init", "--bare");
  writeFileSync(join(repo, "raft.md"), "Odysseus builds a raft.\n");
  git(repo, "add", "."); git(repo, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-m", "Raft");
  git(repo, "worktree", "add", "-b", "voyage", worktree);
  writeFileSync(join(repo, ".git", "objects", "info", "alternates"), join(alternate, "objects") + "\n");
  // Only objects/info/alternates has Git alternate semantics.
  writeFileSync(join(repo, ".git", "info", "alternates"), "/not-an-approved-store\n");
  const denied = await collectStorageInventory(worktree);
  expect(denied.status, "UNAPPROVED_GIT_STORE_PARTIAL").toBe("partial");
  expect(denied.errors.some((e: any) => e.reason === "external-git-root-not-approved")).toBe(true);
  const approved = await collectStorageInventory(worktree, { gitRoots: [repo, alternate] });
  expect(approved.status, JSON.stringify(approved.errors)).toBe("complete");
  expect(approved.roots.some((r: any) => r.path === join(repo, ".git"))).toBe(true);
  expect(approved.roots.some((r: any) => r.path === join(alternate, "objects"))).toBe(true);
  expect(new Set(approved.entries.map((e: any) => e.objectId)).size, "OVERLAPPING_GIT_ROOT_UNION").toBe(approved.entries.length);
  const again = await collectStorageInventory(worktree, { gitRoots: [repo, alternate] });
  expect(again.revision, "STABLE_OBSERVATION_REVISION").toBe(approved.revision);
  expect(again.scanId).not.toBe(approved.scanId);
});

test("pages are deterministic and finite; entry, depth and cancellation limits stay partial", async () => {
  const root = fixture();
  for (let i = 0; i < 215; i++) writeFileSync(join(root, `raft-${String(i).padStart(3, "0")}.md`), "raft");
  const all = await collectStorageInventory(root);
  expect(all.status).toBe("complete");
  const pages = all.pages.filter((page: any) => page.parentId === "brain:");
  expect(pages.map((page: any) => page.entryIds.length)).toEqual([200, 15]);
  expect(pages[0].nextCursor).toBe(pages[1].cursor);
  expect(pages.flatMap((page: any) => page.entryIds)).toEqual(all.entries.filter((entry: any) => entry.parentId === "brain:").map((entry: any) => entry.id));
  const bounded = await collectStorageInventory(root, { limits: { entries: 12 } });
  expect(bounded.entries.length).toBe(12);
  expect(bounded.status, "ENTRY_BUDGET_PARTIAL").toBe("partial");
  expect(bounded.totals.lowerBound).toBe(true);
  mkdirSync(join(root, "deep", "deeper"), { recursive: true });
  const deep = await collectStorageInventory(root, { limits: { depth: 1 } });
  expect(deep.errors.some((e: any) => e.reason === "depth-budget")).toBe(true);
  const controller = new AbortController(); controller.abort();
  const cancelled = await collectStorageInventory(root, { signal: controller.signal });
  expect(cancelled.status, "CANCELLED_IS_PARTIAL").toBe("partial");
  expect(cancelled.errors[0].reason).toBe("cancelled");
  expect(cancelled.entries).toEqual([]);
});

test("actual same-device bind mount is refused while an explicitly configured root remains visible", async () => {
  const root = fixture(); mkdirSync(join(root, "mounted")); mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "secret.pdf"), "Odysseus map");
  const script = `const {collectStorageInventory}=await import(${JSON.stringify(collectorPath)}); console.log(JSON.stringify(await collectStorageInventory(${JSON.stringify(root)})));`;
  const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--bind", join(root, "source"), join(root, "mounted"), "--proc", "/proc", "--dev", "/dev", process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  const result = JSON.parse(out);
  expect(result.status, "BIND_MOUNT_PARTIAL").toBe("partial");
  expect(result.errors).toContainEqual({ path: "mounted", reason: "mount-boundary" });
  expect(result.entries.some((e: any) => e.path.startsWith("mounted/"))).toBe(false);
  expect(result.entries.some((e: any) => e.path === "source/secret.pdf")).toBe(true);
});

test("real EACCES and FIFO entries cannot become an empty successful subtree", async () => {
  const { chmodSync } = await import("node:fs");
  const root = fixture(), secret = join(root, "unreadable");
  mkdirSync(secret); writeFileSync(join(secret, "raft.md"), "Odysseus");
  const fifo = Bun.spawnSync(["mkfifo", join(root, "pipe")], { stdout: "pipe", stderr: "pipe" });
  expect(fifo.exitCode, fifo.stderr.toString()).toBe(0);
  chmodSync(secret, 0);
  try {
    const result = await collectStorageInventory(root);
    expect(result.status, "REAL_EACCES_PARTIAL").toBe("partial");
    expect(result.errors).toContainEqual({ path: "unreadable", reason: "EACCES" });
    expect(result.entries.find((entry: any) => entry.path === "pipe").kind).toBe("special");
    expect(result.totals.lowerBound).toBe(true);
  } finally { chmodSync(secret, 0o700); }
});

test("cancellation kills and reaps a real stalled Git child", async () => {
  const { chmodSync, existsSync } = await import("node:fs");
  const root = fixture(), bin = join(root, "bin"), pidPath = join(root, "git-pid"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);\n`);
  chmodSync(join(bin, "git"), 0o755);
  const script = `const {collectStorageInventory}=await import(${JSON.stringify(collectorPath)});
const controller=new AbortController(); const result=collectStorageInventory(${JSON.stringify(root)},{signal:controller.signal});
const end=Date.now()+3000; while(!require("node:fs").existsSync(${JSON.stringify(pidPath)})&&Date.now()<end) await Bun.sleep(5);
controller.abort(); console.log(JSON.stringify(await result));`;
  const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0); expect(existsSync(pidPath)).toBe(true);
  const result = JSON.parse(out);
  expect(result.status, "RUNNING_CANCEL_PARTIAL").toBe("partial");
  expect(result.errors.some((e: any) => e.reason === "cancelled")).toBe(true);
  const pid = Number(readFileSync(pidPath, "utf8"));
  expect(() => process.kill(pid, 0), "GIT_CHILD_REAPED").toThrow();
});

test("directory replacement with an outside symlink never traverses its target", async () => {
  const { spyOn } = await import("bun:test");
  const fs = await import("node:fs");
  const root = fixture(), outside = fixture();
  mkdirSync(join(root, "raft")); writeFileSync(join(root, "raft", "inside.md"), "Odysseus");
  writeFileSync(join(outside, "outside.pdf"), "Athena");
  const original = fs.openSync;
  let swapped = false;
  const spy = spyOn(fs, "openSync").mockImplementation(((path: any, flags: any, mode: any) => {
    if (!swapped && String(path).startsWith("/proc/self/fd/") && String(path).endsWith("/raft")) {
      swapped = true; fs.renameSync(join(root, "raft"), join(root, "old-raft")); symlinkSync(outside, join(root, "raft"));
    }
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  try {
    const result = await collectStorageInventory(root);
    expect(swapped).toBe(true);
    expect(result.entries.some((entry: any) => entry.path.endsWith("outside.pdf")), "NO_SYMLINK_SWAP_TRAVERSAL").toBe(false);
    expect(result.status, "CHANGING_DIRECTORY_PARTIAL").toBe("partial");
  } finally { spy.mockRestore(); }
});

test("an explicit root alias is canonicalized once and has the same object union", async () => {
  const root = fixture(), aliases = fixture(); writeFileSync(join(root, "raft.md"), "Odysseus");
  symlinkSync(root, join(aliases, "brain"));
  const direct = await collectStorageInventory(root), alias = await collectStorageInventory(join(aliases, "brain"));
  expect(alias.status).toBe("complete"); expect(alias.revision).toBe(direct.revision);
  expect(alias.totals).toEqual(direct.totals); expect(alias.roots[0].path).toBe(root);
});

test("allocation agrees with independent du while filesystem capacity stays a separate observation", async () => {
  const { statfsSync } = await import("node:fs");
  const root = fixture(); writeFileSync(join(root, "raft.md"), "Odysseus builds a raft.\n");
  writeFileSync(join(root, "sparse.pdf"), ""); truncateSync(join(root, "sparse.pdf"), 8_000_000);
  linkSync(join(root, "raft.md"), join(root, "raft-copy.md"));
  const result = await collectStorageInventory(root);
  const du = Bun.spawnSync(["du", "-s", "-B1", root], { stdout: "pipe", stderr: "pipe" });
  expect(du.exitCode, du.stderr.toString()).toBe(0);
  expect(result.totals.objectAllocatedBytes, "INDEPENDENT_DU_OBJECT_ALLOCATION").toBe(Number(du.stdout.toString().split(/\s/)[0]));
  const fs = statfsSync(root), capacity = result.capacities[0];
  if (fs.type === 0x794c7630) { expect(capacity.totalBytes).toBeNull(); expect(capacity.reason).toBe("overlay-capacity-not-attributable"); }
  else {
    expect(capacity.totalBytes).toBe(fs.blocks * fs.bsize);
    expect(capacity.usedBytes + capacity.freeBytes).toBe(capacity.totalBytes);
    expect(capacity.availableBytes).toBeLessThanOrEqual(capacity.freeBytes);
  }
  expect(capacity.quota).toBeNull(); expect(capacity.quotaReason).toBe("unsupported");
});

test("CLI cancellation returns partial evidence and leaves no stalled Git process", async () => {
  const { chmodSync, existsSync } = await import("node:fs");
  const root = fixture(), bin = join(root, "bin"), pidPath = join(root, "git-pid"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);\n`); chmodSync(join(bin, "git"), 0o755);
  const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath, cli, "storage", "inventory", "--json"], { env: { ...process.env, BRAIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(pidPath) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(pidPath), "LIVE_GIT_CHILD_BEFORE_CANCEL").toBe(true);
    // Resolve the actual CLI through the worker parent so the bwrap supervisor
    // receives no signal and the CLI coordinator performs normal cancellation.
    const gitPid = Number(readFileSync(pidPath, "utf8"));
    const stat = readFileSync(`/proc/${gitPid}/stat`, "utf8");
    const workerPid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const workerStat = readFileSync(`/proc/${workerPid}/stat`, "utf8");
    const cliPid = Number(workerStat.slice(workerStat.lastIndexOf(")") + 2).split(" ")[1]);
    process.kill(cliPid, "SIGTERM");
    const [out, err, code] = await Promise.all([output, errors, child.exited]);
    expect(code, err).toBe(0);
    const result = JSON.parse(out); expect(result.status).toBe("partial"); expect(result.totals.lowerBound).toBe(true);
    expect(result.errors).toContainEqual({ path: "", reason: "cancelled" });
    expect(() => process.kill(gitPid, 0), "CLI_GIT_CHILD_REAPED").toThrow();
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("error buffers and elapsed-time exhaustion are finite partial observations", async () => {
  const { chmodSync } = await import("node:fs");
  const root = fixture();
  for (let i = 0; i < 6; i++) { mkdirSync(join(root, `closed-${i}`)); chmodSync(join(root, `closed-${i}`), 0); }
  try {
    const errors = await collectStorageInventory(root, { limits: { errors: 2 } });
    expect(errors.status).toBe("partial"); expect(errors.errors.length).toBe(2); expect(errors.omittedErrors).toBe(4);
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n"); chmodSync(join(bin, "git"), 0o755);
    const script = `const {collectStorageInventory}=await import(${JSON.stringify(collectorPath)}); console.log(JSON.stringify(await collectStorageInventory(${JSON.stringify(root)},{limits:{milliseconds:100}})));`;
    const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const timed = JSON.parse(out);
    expect(timed.status, "ELAPSED_BUDGET_PARTIAL").toBe("partial");
    expect(timed.errors.some((error: any) => error.reason === "time-budget" || error.reason === "git-budget")).toBe(true);
  } finally { for (let i = 0; i < 6; i++) chmodSync(join(root, `closed-${i}`), 0o700); }
});
