import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../scripts/prepare-diagnostic-install.sh");
const clean = 'export const voyage = "Ithaca";\n';
const changed = 'export const voyage = "Sirens";\n';

// Real Bun installs, one local archive, no external registry or provider access.
assert.notEqual(readlinkSync("/proc/self/ns/net"), process.env.DIAGNOSTIC_PARENT_NET);
assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
{
  const root = mkdtempSync(join(tmpdir(), "diagnostic-install-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "odyssey-diagnostic", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(root, "package/index.js"), clean);
    const tar = Bun.spawnSync(["tar", "-czf", join(root, "package.tgz"), "package"], { cwd: root });
    assert.equal(tar.exitCode, 0);
    const archive = readFileSync(join(root, "package.tgz"));
    writeFileSync(join(root, "package/index.js"), changed);
    const alteredTar = Bun.spawnSync(["tar", "-czf", join(root, "altered.tgz"), "package"], { cwd: root });
    assert.equal(alteredTar.exitCode, 0);
    const alteredArchive = readFileSync(join(root, "altered.tgz"));
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    let downloads = 0;
    let corrupt = false;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname.endsWith(".tgz")) {
        downloads++;
        return new Response(corrupt ? alteredArchive : archive);
      }
      return Response.json({ name: "odyssey-diagnostic", "dist-tags": { latest: "1.0.0" }, versions: {
        "1.0.0": { name: "odyssey-diagnostic", version: "1.0.0", dist: {
          tarball: `${new URL(request.url).origin}/odyssey-diagnostic-1.0.0.tgz`, integrity,
        } },
      } });
    } });
    const cache = join(root, "shared-cache");
    const scratch = join(root, "private-caches");
    mkdirSync(scratch);
    const env = { ...process.env, BUN_INSTALL_CACHE_DIR: cache, TMPDIR: scratch };
    async function run(cwd: string, argv: string[]) {
      const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert.deepEqual({ exit, error: exit ? out + err : "" }, { exit: 0, error: "" });
    }
    const seed = join(root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "odyssey-fixture", dependencies: { "odyssey-diagnostic": "1.0.0" } }));
    writeFileSync(join(seed, ".npmrc"), `registry=http://127.0.0.1:${server.port}\n`);
    await run(seed, [process.execPath, "install", "--backend=hardlink", "--cache-dir", cache]);
    const installed = (dir: string) => join(dir, "node_modules/odyssey-diagnostic/index.js");
    const shared = [...new Bun.Glob("**/index.js").scanSync({ cwd: cache, absolute: true })][0]!;
    assert.equal(statSync(shared).ino, statSync(installed(seed)).ino);
    // Unsafe control: a diagnostic write changes the shared cache and a peer.
    const peer = join(root, "unsafe-peer.js");
    linkSync(shared, peer);
    writeFileSync(installed(seed), changed);
    assert.equal(readFileSync(shared, "utf8"), changed);
    assert.equal(readFileSync(peer, "utf8"), changed);
    const copied = join(root, "copied.js");
    cpSync(shared, copied);
    assert.equal(statSync(copied).nlink, 1);
    assert.notEqual(readFileSync(copied, "utf8"), clean);

    const lock = readFileSync(join(seed, "bun.lock"));
    const manifest = readFileSync(join(seed, "package.json"));
    const prepared: string[] = [];
    for (const name of ["first", "second"]) {
      const dir = join(root, name);
      mkdirSync(dir);
      for (const file of ["package.json", "bun.lock", ".npmrc"]) cpSync(join(seed, file), join(dir, file));
      const beforeDownloads = downloads;
      await run(dir, ["sh", script]);
      assert.ok(downloads > beforeDownloads);
      assert.equal(readFileSync(installed(dir), "utf8"), clean);
      assert.equal(statSync(installed(dir)).nlink, 1);
      assert.deepEqual(readFileSync(join(dir, "bun.lock")), lock);
      assert.deepEqual(readFileSync(join(dir, "package.json")), manifest);
      prepared.push(dir);
    }
    writeFileSync(installed(prepared[0]!), changed);
    assert.equal(readFileSync(installed(prepared[1]!), "utf8"), clean);
    assert.equal(readFileSync(shared, "utf8"), changed);
    // Refuse in-place replacement: retain the diagnostic bytes for inspection.
    const refused = Bun.spawn(["sh", script], { cwd: prepared[0], env, stdout: "pipe", stderr: "pipe" });
    const [refusedOut, refusedErr, refusedExit] = await Promise.all([new Response(refused.stdout).text(), new Response(refused.stderr).text(), refused.exited]);
    assert.equal(refusedExit, 1, refusedOut + refusedErr);
    assert.ok(refusedErr.includes("move aside the owned node_modules first"));
    assert.equal(readFileSync(installed(prepared[0]!), "utf8"), changed);
    assert.equal(existsSync(cache), true);
    corrupt = true;
    const rejected = join(root, "bad-archive");
    mkdirSync(rejected);
    for (const file of ["package.json", "bun.lock", ".npmrc"]) cpSync(join(seed, file), join(rejected, file));
    const bad = Bun.spawn(["sh", script], { cwd: rejected, env, stdout: "pipe", stderr: "pipe" });
    const [badOut, badErr, badExit] = await Promise.all([new Response(bad.stdout).text(), new Response(bad.stderr).text(), bad.exited]);
    assert.notEqual(badExit, 0);
    assert.match(badOut + badErr, /integrity/i);
    assert.deepEqual(readFileSync(join(rejected, "bun.lock")), lock);
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}
console.log("diagnostic isolation and provenance passed");
