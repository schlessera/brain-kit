/** The only program run by the fixed CI build container. Not a plugin host. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./ci-build-boundary";
import { executeBuild } from "./build-execution";
import { listPublishablePackages } from "./publishable-packages";
import { ensureWorkspaceLease } from "./workspace-lease.mjs";

type Entry = {
  version: 1; originalRoot: string; canary: string; selected: string[]; jobs: 1 | 2;
  topology: Record<string, string[]>; rootNames: string[]; node: string;
  readonlyTargets: string[]; writableTargets: string[];
};
if (import.meta.main) {
  const coordinated = await ensureWorkspaceLease("/repo", "write");
  if (coordinated !== undefined) process.exit(coordinated);
  process.umask(0o022);
  const entry = JSON.parse(readFileSync("/operation/entry.json", "utf8")) as Entry;
  assert.equal(entry.version, 1);
  assert(!existsSync(entry.originalRoot), "CI_BUILD_ORIGINAL_CHECKOUT_UNMOUNTED");
  assert(!existsSync(entry.canary), "CI_BUILD_HOST_DATA_UNMOUNTED");
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map(line => {
    const parts = line.split(" "), separator = parts.indexOf("-");
    assert(separator > 5, "CI_BUILD_MOUNTINFO_FORMAT");
    const target = parts[4]!.replace(/\\([0-7]{3})/g, (_, value: string) => String.fromCharCode(parseInt(value, 8)));
    return { target, options: parts[5]!, type: parts[separator + 1]!, rootIdentity: digest(parts[3]!) };
  });
  for (const target of entry.readonlyTargets) assert(mounts.some(mount => mount.target === target && mount.options.split(",").includes("ro")), "CI_BUILD_SOURCE_MOUNT_READONLY");
  for (const target of entry.writableTargets) assert(mounts.some(mount => mount.target === target && mount.options.split(",").includes("rw")), "CI_BUILD_ONLY_PRIVATE_WRITABLE_MOUNT");
  assert(mounts.some(mount => mount.target === "/" && mount.options.split(",").includes("ro")), "CI_BUILD_IMAGE_ROOT_READONLY");
  assert.equal(Bun.which("node"), entry.node, "CI_BUILD_NODE_LOOKUP_FIXED");
  assert.equal(Bun.which("bunx"), "/tool/bunx", "CI_BUILD_LAUNCHER_LOOKUP_FIXED");
  assert.equal(realpathSync("/repo/node_modules/.bin/tsc"), "/repo/node_modules/typescript/bin/tsc", "CI_BUILD_LOCAL_TYPESCRIPT_OWNER");
  assert.equal(realpathSync("/repo/node_modules/.bin/tailwindcss"), "/repo/node_modules/@tailwindcss/cli/dist/index.mjs", "CI_BUILD_LOCAL_CSS_OWNER");
  assert.deepEqual(readdirSync("/repo").sort(), entry.rootNames, "CI_BUILD_ROOT_TOPOLOGY");
  assert.deepEqual(readdirSync("/repo/packages").sort(), Object.keys(entry.topology).sort(), "CI_BUILD_PACKAGE_TOPOLOGY");
  for (const [pkg, names] of Object.entries(entry.topology)) {
    assert.deepEqual(readdirSync(`/repo/packages/${pkg}`).sort(), names, "CI_BUILD_INITIAL_PACKAGE_TOPOLOGY");
  }
  const runtime = { bun: digest(readFileSync("/tool/bun")), node: { path: entry.node, sha256: digest(readFileSync(entry.node)) } };
  mkdirSync("/tmp/home", { mode: 0o700 }); mkdirSync("/tmp/cache", { mode: 0o700 });
  process.env.TMPDIR = "/tmp"; process.env.XDG_CACHE_HOME = "/tmp/cache";
  const packages = listPublishablePackages("/repo").filter(pkg => entry.selected.includes(pkg.dir));
  assert.equal(packages.length, entry.selected.length, "CI_BUILD_ONLY_VALIDATED_PENDING_PACKAGES");
  const code = await executeBuild("/repo", packages, entry.jobs);
  assert.deepEqual(readdirSync("/repo").sort(), entry.rootNames, "CI_BUILD_NO_UNKNOWN_ROOT_OUTPUT");
  assert.deepEqual(readdirSync("/repo/packages").sort(), Object.keys(entry.topology).sort(), "CI_BUILD_NO_UNKNOWN_PACKAGE");
  for (const [pkg, names] of Object.entries(entry.topology)) {
    const expected = [...names, ...(entry.selected.includes(pkg) ? ["dist"] : [])].sort();
    assert.deepEqual(readdirSync(`/repo/packages/${pkg}`).sort(), expected, "CI_BUILD_NO_UNKNOWN_PACKAGE_OUTPUT");
    assert.equal(statSync(`/repo/packages/${pkg}`).mode & 0o777, 0o700, "CI_BUILD_PRIVATE_PARENT_MODE");
  }
  const receipts = readdirSync("/repo/tmp").filter(name => /^build-\d+-[0-9a-f-]+-probe\.json$/.test(name)).sort()
    .map(name => ({ name, value: JSON.parse(readFileSync(join("/repo/tmp", name), "utf8")) }));
  writeFileSync("/repo/tmp/isolated-producer.json", JSON.stringify({ version: 1, code, runtime, receipts, mounts, topology: "checked-after-child-exit" }));
  process.exitCode = code;
}
