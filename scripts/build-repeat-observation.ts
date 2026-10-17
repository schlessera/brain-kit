/** Fixed observed workload/output identity, never a build admission or cache key. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

type Unknown = { state: "unknown" };
type Inventory = { state: "known"; sha256: string; entries: number; bytes: number };
const unknown = (): Unknown => ({ state: "unknown" });
const MAX_ENTRIES = 32768, MAX_BYTES = 256 * 1024 * 1024, MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Reads real entries only: aliases, missing files and limits remain unknown. */
export function observedInventory(root: string, paths: readonly string[]): Inventory | Unknown {
  try {
    const hash = createHash("sha256"); let entries = 0, scheduled = 0, bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    function visit(path: string) {
      const name = relative(root, path).replaceAll("\\", "/");
      if (isAbsolute(name) || name.startsWith("../") || name === ".." || realpathSync(path) !== path) throw Error("Outside observed workload");
      const stat = lstatSync(path);
      entries++;
      if (stat.isSymbolicLink()) throw Error("Unknown observed entry");
      hash.update(JSON.stringify([name, stat.mode & 0o7777, stat.isDirectory() ? "directory" : "file"]) + "\n");
      if (stat.isDirectory()) {
        const directory = opendirSync(path), children: string[] = [];
        try {
          for (let child = directory.readSync(); child; child = directory.readSync()) {
            if (++scheduled > MAX_ENTRIES) throw Error("Unknown observed entry count");
            children.push(child.name);
          }
        } finally { directory.closeSync(); }
        for (const child of children.sort()) visit(join(path, child));
      } else {
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (bytes += stat.size) > MAX_BYTES) throw Error("Unknown observed size");
        const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = fstatSync(descriptor), content = createHash("sha256");
          if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size || opened.mode !== stat.mode || opened.mtimeMs !== stat.mtimeMs) throw Error("Observed entry changed before reading");
          let remaining = stat.size;
          while (remaining) {
            const size = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
            if (!size) throw Error("Observed entry shrank during reading");
            content.update(buffer.subarray(0, size)); remaining -= size;
          }
          if (readSync(descriptor, buffer, 0, 1, null) !== 0) throw Error("Observed entry grew during reading");
          const after = fstatSync(descriptor), named = lstatSync(path);
          if (after.size !== stat.size || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || named.ino !== stat.ino) throw Error("Observed entry changed during reading");
          hash.update(content.digest());
        } finally { closeSync(descriptor); }
      }
    }
    for (const path of [...paths].sort()) {
      if (++scheduled > MAX_ENTRIES) throw Error("Unknown observed entry count");
      visit(resolve(root, path));
    }
    return { state: "known", sha256: hash.digest("hex"), entries, bytes };
  } catch { return unknown(); }
}

// Only object/index reads: status/diff could execute configured clean filters.
function gitObservation(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" });
  const run = (args: string[]) => {
    const child = Bun.spawnSync(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    if (child.exitCode !== 0 || child.signalCode) throw Error("Git object observation unavailable");
    return child.stdout;
  };
  const [head, tree, extra] = run(["rev-parse", "HEAD", "HEAD^{tree}"]).toString().trim().split("\n");
  if (extra !== undefined || !/^[a-f0-9]{40}$/.test(head!) || !/^[a-f0-9]{40}$/.test(tree!)) throw Error("Unknown Git identity");
  const index = run(["ls-files", "--stage", "-z"]);
  if (index.toString().split("\0").filter(Boolean).some(entry => !/^[0-7]{6} [a-f0-9]{40} 0\t/.test(entry))) throw Error("Ambiguous Git index");
  return { head, tree, indexSha256: createHash("sha256").update(index).digest("hex"), cleanWorktree: "unknown" as const };
}

/** Deliberately bounded context; external dependency contents are not attested. */
export function observedBuildContext(root: string, packages: readonly string[]) {
  try {
    const git = gitObservation(root);
    const inputs = observedInventory(root, ["package.json", "bun.lock", "tsconfig.json",
      ...["build.ts", "build-receipt.ts", "build-repeat-observation.ts", "bin-modes.ts", "publishable-packages.ts", "workspace-lease.mjs"].map(file => `scripts/${file}`),
      ...packages.flatMap(name => [`packages/${name}/src`, `packages/${name}/package.json`, `packages/${name}/tsconfig.build.json`])]);
    if (inputs.state !== "known") return unknown();
    const tools = [{ name: "typescript", files: ["package.json", "bin/tsc", "lib/tsc.js", "lib/_tsc.js"] }];
    if (packages.some(name => name === "ui-react" || name === "ui-kit")) tools.push({ name: "@tailwindcss/cli", files: ["package.json", "dist/index.mjs"] });
    const compilerEntries = tools.map(tool => {
      const directory = resolve(Bun.resolveSync(`${tool.name}/package.json`, root), "..");
      const inventory = observedInventory(directory, tool.files);
      if (inventory.state !== "known") throw Error("Unknown compiler entry");
      return { name: tool.name, ...inventory };
    });
    const dependency = statSync(join(root, "node_modules"));
    const lock = observedInventory(root, ["bun.lock"]);
    if (lock.state !== "known") return unknown();
    const launchers = ["bunx", "node"].map(name => {
      const executable = Bun.which(name);
      if (!executable) throw Error("Missing observed launcher");
      const path = realpathSync(executable), metadata = statSync(path);
      if (!metadata.isFile() || !(metadata.mode & 0o111)) throw Error("Unknown observed launcher");
      return { name, pathSha256: createHash("sha256").update(path).digest("hex"), dev: metadata.dev, ino: metadata.ino,
        size: metadata.size, mode: metadata.mode & 0o7777, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
    });
    const value = { git, inputs, compilerEntries, dependency: { dev: dependency.dev, ino: dependency.ino },
      runtime: { bun: Bun.version, revision: Bun.revision }, launchers, lock };
    return { state: "known" as const, sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"), ...value };
  } catch { return unknown(); }
}

export function observedBuildOutputs(root: string, packages: readonly string[]) {
  return observedInventory(root, packages.map(name => `packages/${name}/dist`));
}
