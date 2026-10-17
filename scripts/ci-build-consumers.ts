/** Fixed offline transport for the existing nineteen-package consumer probes. */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, lstatSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, posix } from "node:path";
import ts from "typescript";
import { buildRead } from "./ci-build-files";
import { captureOutputs, identity } from "./ci-build-boundary";
// Extra React-18 records require actual reviewed offline tarball provenance.
// An empty map refuses them; no registry request fills this prerequisite.
const extraConsumerIntegrities: Record<string, string> = {};
type Catalog = { version: 1; purpose: "offline-packed-consumer-cache"; packages: {name: string; version: string; integrity: string; tarball: string}[] };
export function offlinePackInstallArgs(argv: readonly string[], bun: string, cwd: string, packages: readonly string[]): string[] | undefined {
  if (argv[0] !== bun || argv[1] !== "add") return;
  const main = cwd === "/repo/tmp/pack-work/brainkit-consumer", react18 = cwd === "/repo/tmp/pack-work/brainkit-react18-consumer";
  if (!main && !react18) throw new Error("Unexpected packed installer location");
  const specs = argv.slice(2), tarballs = specs.filter(value => value.endsWith(".tgz"));
  for (const path of tarballs) {
    assert(/^\/repo\/tmp\/pack-work\/brainkit-tarballs\/[a-z0-9-]+\.tgz$/.test(path), "CI_BUILD_PACK_TARBALL_LOCATION");
    assert(packages.includes(path.split("/").at(-1)!.slice(0, -4)), "CI_BUILD_PACK_TARBALL_PACKAGE");
  }
  const other = specs.filter(value => !value.endsWith(".tgz"));
  const allowed = main ? [["react", "react-dom"], ["-d", "@types/bun", "@types/react", "@types/react-dom"]] : [["react@^18", "react-dom@^18"], ["-d", "@types/react@^18", "@types/react-dom@^18"]];
  assert(allowed.some(expected => identity(expected) === identity(other)), "CI_BUILD_ONLY_KNOWN_PACK_INSTALLERS");
  if (other[0] === "-d") assert.equal(tarballs.length, 0); else assert(tarballs.length > 0);
  return [bun, "add", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/repo/tmp/consumer-cache", ...specs];
}
export function prepareBuildConsumers(root: string, directory: string) {
  const supplied = join(root, "tmp/ci-build-consumer-cache");
  if (!existsSync(join(supplied, "catalog.json"))) throw new Error("Missing verified offline packed-consumer cache; no acquisition is permitted");
  const catalog = JSON.parse(buildRead(join(supplied, "catalog.json"), undefined, 4 * 1024 * 1024).bytes.toString("utf8")) as Catalog;
  assert.equal(catalog.version, 1); assert.equal(catalog.purpose, "offline-packed-consumer-cache"); assert(Array.isArray(catalog.packages) && catalog.packages.length > 0);
  const lock = ts.parseConfigFileTextToJson("bun.lock", buildRead(join(root, "bun.lock")).bytes.toString("utf8")); assert(!lock.error);
  const locked = new Map<string, string>();
  for (const entry of Object.values(lock.config.packages ?? {}) as any[]) if (Array.isArray(entry) && typeof entry[0] === "string") {
    const integrity = entry.findLast(value => typeof value === "string" && value.startsWith("sha512-")); if (integrity) locked.set(entry[0], integrity);
  }
  const destination = join(directory, "consumer-input"); mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, "tarballs"), { mode: 0o700 });
  for (const pkg of catalog.packages) {
    assert(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name) && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i.test(pkg.version));
    const expected = locked.get(`${pkg.name}@${pkg.version}`) ?? extraConsumerIntegrities[`${pkg.name}@${pkg.version}`];
    assert(expected && expected === pkg.integrity, "CI_BUILD_CONSUMER_TARBALL_HAS_REVIEWED_INTEGRITY");
    assert(/^tarballs\/[0-9a-f]{64}\.tgz$/.test(pkg.tarball));
    const bytes = buildRead(join(supplied, pkg.tarball)).bytes;
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, expected);
    writeFileSync(join(destination, pkg.tarball), bytes, { flag: "wx", mode: 0o600 });
  }
  const records = captureOutputs(join(supplied, "cache"), join(destination, "cache"));
  writeFileSync(join(destination, "catalog.json"), JSON.stringify(catalog), { flag: "wx", mode: 0o600 });
  return { source: destination, identity: identity({ records, catalog }), catalog };
}
/** Necessary physical-payload verification for the supported hoisted layout.
 * Isolated hidden stores, package aliases, payload links and unknown sidecars
 * are explicitly unsupported. This does not flatten or rewrite dependencies.
 */
export function verifyConsumerTree(modules: string, archives: ReadonlyMap<string, ReadonlyMap<string, string>>) {
  const payloads: {name: string; version: string; identity: string; directory: string}[] = [];
  const verified = new Set<string>(), bins: {name: string; path: string}[] = [], declaredBins = new Map<string, Set<string>>();
  assert(lstatSync(modules).isDirectory(), "CI_BUILD_PACK_MODULES_ROOT_PHYSICAL");
  const root = realpathSync(modules); assert.equal(root, modules, "CI_BUILD_PACK_MODULES_ROOT_CANONICAL");
  const scanModules = (directory: string) => {
    assert(lstatSync(directory).isDirectory(), "CI_BUILD_PACK_MODULES_PHYSICAL_DIRECTORY");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (name === ".bin") {
        assert(stat.isDirectory(), "CI_BUILD_PACK_BIN_DIRECTORY_PHYSICAL");
        for (const bin of readdirSync(path).sort()) {
          const file = join(path, bin); assert(lstatSync(file).isSymbolicLink(), "CI_BUILD_PACK_BIN_ALIAS_ONLY");
          assert(!readlinkSync(file).startsWith("/"), "CI_BUILD_PACK_BIN_ALIAS_RELATIVE");
          bins.push({name: bin, path: realpathSync(file)});
        }
        continue;
      }
      assert(!name.startsWith("."), "CI_BUILD_PACK_HIDDEN_INSTALL_LAYOUT_UNSUPPORTED");
      if (name.startsWith("@")) {
        assert(stat.isDirectory(), "CI_BUILD_PACK_SCOPE_PHYSICAL");
        for (const child of readdirSync(path).sort()) { assert(!child.startsWith("."), "CI_BUILD_PACK_HIDDEN_SCOPE_UNSUPPORTED"); scanPackage(join(path, child)); }
      } else scanPackage(path);
    }
  };
  const scanPackage = (directory: string) => {
    assert(lstatSync(directory).isDirectory(), "CI_BUILD_PACK_PACKAGE_ALIAS_UNSUPPORTED");
    const manifest = JSON.parse(buildRead(join(directory, "package.json")).bytes.toString("utf8"));
    const expected = archives.get(`${manifest.name}@${manifest.version}`);
    assert(expected, "CI_BUILD_PACK_DEPENDENCY_IS_REVIEWED");
    const bundled = [...expected.keys()].some(path => path.startsWith("node_modules/"));
    const actual = new Map<string, string>();
    const walk = (base: string, prefix = "") => {
      for (const name of readdirSync(base).sort()) {
        const file = join(base, name), path = prefix ? `${prefix}/${name}` : name, stat = lstatSync(file);
        // Only an unbundled package-root dependency tree is separate from its
        // archive. Every vendor/.../node_modules and bundled byte stays in it.
        if (!prefix && name === "node_modules" && !bundled) { scanModules(file); continue; }
        if (stat.isDirectory()) walk(file, path);
        else {
          assert(stat.isFile(), "CI_BUILD_PACK_INSTALLED_PAYLOAD_REGULAR");
          actual.set(path, createHash("sha256").update(buildRead(file).bytes).digest("hex")); verified.add(file);
        }
      }
    };
    walk(directory);
    assert.deepEqual([...actual].sort(([a],[b])=>a.localeCompare(b)), [...expected].sort(([a],[b])=>a.localeCompare(b)), "CI_BUILD_PACK_CACHE_PAYLOAD_MATCHES_VERIFIED_TARBALL");
    const commands = typeof manifest.bin === "string" ? { [manifest.name.split("/").at(-1)]: manifest.bin } : manifest.bin ?? {};
    for (const [name, target] of Object.entries(commands)) {
      assert(typeof target === "string" && !posix.isAbsolute(target) && !target.includes("\\") && !posix.normalize(target).startsWith("../"), "CI_BUILD_PACK_BIN_DECLARATION_LOCAL");
      const file = join(directory, target); assert(verified.has(file), "CI_BUILD_PACK_BIN_PAYLOAD_VERIFIED");
      const targets = declaredBins.get(name) ?? new Set<string>(); targets.add(file); declaredBins.set(name, targets);
    }
    payloads.push({name: manifest.name, version: manifest.version, identity: identity([...actual].sort(([a],[b])=>a.localeCompare(b))), directory: relative(root,directory)});
  };
  scanModules(root);
  for (const bin of bins) assert(verified.has(bin.path) && declaredBins.get(bin.name)?.has(bin.path), "CI_BUILD_PACK_BIN_TARGET_IS_VERIFIED_DECLARED_PAYLOAD");
  return payloads;
}
/** Called only inside the fixed image, before any installed consumer imports. */
export async function runBuildConsumers(packages: string[]) {
  const { ciPack } = await import("./ci-pack");
  const catalog = JSON.parse(buildRead("/consumer-input/catalog.json", undefined, 4 * 1024 * 1024).bytes.toString("utf8")) as Catalog;
  // Consumer-only bulk/cache/extraction bytes use the owned disk-backed
  // diagnostics mount. The production /tmp tmpfs and bounds stay unchanged.
  cpSync("/consumer-input/cache", "/repo/tmp/consumer-cache", { recursive: true, dereference: false });
  mkdirSync("/repo/tmp/consumer-temp", { mode: 0o700 });
  process.env.TMPDIR = "/repo/tmp/consumer-temp";
  const work = "/repo/tmp/pack-work"; mkdirSync(work, { mode: 0o700 });
  const transport = Bun as unknown as { spawn: (...args: any[]) => any }, original = transport.spawn;
  const installers: {original: string[]; actual: string[]; cwd: string; code?: number}[] = [];
  const verifiedArchives = new Map<string, Map<string, string>>();
  const { listPublishablePackages } = await import("./publishable-packages");
  const firstParty = listPublishablePackages("/repo");
  const archiveFiles = (archive: string) => {
    if (verifiedArchives.has(archive)) return verifiedArchives.get(archive)!;
    const run = (args: string[]) => { const result = spawnSync("/usr/bin/tar", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" }); assert(!result.error && result.status === 0, "CI_BUILD_PACK_ARCHIVE_READ"); return result.stdout.toString(); };
    const names = run(["-tzf", archive]).trim().split("\n");
    assert(names.every(name => (name === "package" || name.startsWith("package/")) && !name.includes("\\") && posix.normalize(name).replace(/\/$/, "") === name.replace(/\/$/, "") && !name.split("/").includes("..")), "CI_BUILD_PACK_ARCHIVE_PATHS");
    assert(run(["-tvzf", archive]).trim().split("\n").every(line => /^[d-]/.test(line)), "CI_BUILD_PACK_ARCHIVE_REGULAR_ONLY");
    const extracted = `/repo/tmp/verified-archives/${identity(archive)}`; mkdirSync(extracted, { recursive: true, mode: 0o700 });
    run(["-xzf", archive, "-C", extracted, "--no-same-owner", "--no-same-permissions"]);
    const files = new Map<string, string>();
    const walk = (directory: string, path = "") => {
      for (const name of readdirSync(directory).sort()) {
        const file = join(directory, name), relative = path ? `${path}/${name}` : name, stat = lstatSync(file);
        if (stat.isDirectory()) walk(file, relative);
        else { assert(stat.isFile(), "CI_BUILD_PACK_PAYLOAD_REGULAR_ONLY"); files.set(relative, createHash("sha256").update(buildRead(file).bytes).digest("hex")); }
      }
    };
    walk(join(extracted, "package")); verifiedArchives.set(archive, files); return files;
  };
  const actualPayloads: {name: string; version: string; identity: string; directory: string}[] = [];
  const verifyInstalled = (cwd: string) => {
    // Every physical installed package is checked before ciPack can import.
    // Unknown hidden stores/aliases are unsupported, never version-only proof.
    const archives = new Map<string, ReadonlyMap<string, string>>();
    for (const pkg of firstParty) archives.set(`${pkg.manifest.name}@${pkg.manifest.version}`, archiveFiles(join(work, "brainkit-tarballs", `${pkg.dir}.tgz`)));
    for (const pkg of catalog.packages) archives.set(`${pkg.name}@${pkg.version}`, archiveFiles(`/consumer-input/${pkg.tarball}`));
    actualPayloads.push(...verifyConsumerTree(join(cwd, "node_modules"), archives));
  };
  transport.spawn = (...args: any[]) => {
    if (!Array.isArray(args[0])) return original(...args);
    const actual = offlinePackInstallArgs(args[0], process.execPath, args[1]?.cwd ?? "", packages);
    if (!actual) return original(...args);
    const observation = { original: [...args[0]], actual, cwd: args[1].cwd, code: undefined as number | undefined }; installers.push(observation);
    const child = original(actual, args[1]);
    const exited = child.exited.then(async (code: number) => { observation.code = code; if (code === 0) await verifyInstalled(args[1].cwd); return code; });
    return new Proxy(child, { get(target, key) { if (key === "exited") return exited; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
  };
  try {
    const node = original(["/usr/bin/node", "-p", "process.versions.node"], { stdout: "pipe", stderr: "pipe" });
    const [version, code] = await Promise.all([new Response(node.stdout).text(), node.exited]); assert.equal(code, 0); assert(Bun.semver.satisfies(version.trim(), ">=24.0.0"), "CI_BUILD_PACK_NODE_MATCHES_CI");
    await ciPack("/repo", work);
    assert.equal(installers.length, 4, "CI_BUILD_ALL_PACK_INSTALLERS_OFFLINE"); assert(installers.every(child => child.code === 0));
    return { version: 1, purpose: "qualification-consumers", authority: "none", completed: true, packages, node: version.trim(), installers, actualPayloads, registryAcquisition: "disabled-by-offline-native-installer-and-network-namespace" };
  } finally { transport.spawn = original; }
}
