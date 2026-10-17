/** One dormant, fixed isolated build operation. CI intent is not authority. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildMounts, captureBuildInputs, captureDerivedOutput, captureOutputs, digest, identity, outputFiles, sameOutputIdentity, type BuildFile } from "./ci-build-boundary";
import { selectBuildPackages } from "./publishable-packages";
import { ensureWorkspaceLease } from "./workspace-lease.mjs";

type Options = { directories?: string[]; jobs: 1 | 2; force: boolean };
type Qualification = {
  version: 1; activation: "unqualified" | "qualified"; image: string;
  producer: Record<string, string>; configuration: Record<string, string>;
  installation: string | null; bun: string | null; node: { path: string; sha256: string | null };
  ambientEvidence: string | null; compatibilityEvidence: string | null; hostedCostEvidence: string | null;
};
const policyPath = join(import.meta.dir, "ci-build-qualification.json");
const fixedImage = "mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";
const producerPaths = ["scripts/build.ts", "scripts/build-execution.ts", "scripts/build-receipt.ts", "scripts/bin-modes.ts", "scripts/publishable-packages.ts", "scripts/workspace-lease.mjs",
  "scripts/ci-build-boundary.ts", "scripts/ci-build-operation.ts", "scripts/ci-build-entry.ts"];
const configuration = (entry: BuildFile) => !/(^|\/)node_modules(?:\/|$)/.test(entry.path) &&
  (/(^|\/)package\.json$/.test(entry.path) || /(^|\/)tsconfig[^/]*\.json$/.test(entry.path) || /(^|\/)bunfig\.toml$/.test(entry.path) || entry.path.endsWith(".css"));
const launcher = '#!/bin/sh\nexec /tool/bun x --no-install "$@"\n';
function readPolicy(): Qualification {
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Qualification;
  if (policy.image !== fixedImage || policy.node.path !== "/usr/bin/node") throw new Error("Unknown fixed build operation");
  return policy;
}
function complete(policy: Qualification): boolean {
  return policy.version === 1 && policy.activation === "qualified" &&
    /^mcr\.microsoft\.com\/playwright@sha256:[0-9a-f]{64}$/.test(policy.image) &&
    [policy.installation, policy.bun, policy.node.sha256, policy.ambientEvidence, policy.compatibilityEvidence, policy.hostedCostEvidence].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) &&
    policy.node.path === "/usr/bin/node" && Object.keys(policy.producer).sort().join("\0") === [...producerPaths].sort().join("\0") && Object.keys(policy.configuration).length > 0;
}
function policyMatches(policy: Qualification, captured: ReturnType<typeof captureBuildInputs>, bun: string): boolean {
  if (!complete(policy) || policy.installation !== captured.installation || policy.bun !== bun) return false;
  const byPath = new Map(captured.records.map(entry => [entry.path, entry]));
  if (!producerPaths.every(path => byPath.get(path)?.kind === "file" && policy.producer[path] === identity(byPath.get(path)))) return false;
  const actual = Object.fromEntries(captured.records.filter(configuration).map(entry => [entry.path, identity(entry)]));
  return identity(actual) === identity(Object.fromEntries(Object.entries(policy.configuration).sort(([a], [b]) => a.localeCompare(b))));
}

function docker(config: string, ...argv: string[]) {
  // The daemon selection/configuration is also fixed: no remote context,
  // inherited registry credentials, CLI plugins or user Docker configuration.
  const result = Bun.spawnSync(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "--config", config, ...argv], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
  if (result.exitCode !== 0) throw new Error(`Fixed build Docker ${argv[0]} failed`);
  return new TextDecoder().decode(result.stdout).trim();
}
function imagePresent(image: string, config: string) {
  const records = JSON.parse(docker(config, "image", "inspect", image)) as Array<{ RepoDigests?: string[] }>;
  if (records.length !== 1 || !records[0]!.RepoDigests?.includes(image)) throw new Error("Fixed build image manifest is unavailable");
}
function workspaceScope(root: string) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Unsupported fixed build platform");
  const directory = lstatSync(root), socket = lstatSync("/var/run/docker.sock");
  if (!directory.isDirectory() || !socket.isSocket()) throw new Error("Unsupported fixed build ownership");
  return { root: realpathSync(root), directory: { dev: directory.dev, ino: directory.ino }, uid: process.getuid!(), gid: process.getgid!(),
    boot: digest(readFileSync("/proc/sys/kernel/random/boot_id")), kernel: digest(readFileSync("/proc/sys/kernel/osrelease")),
    dockerSocket: { dev: socket.dev, ino: socket.ino }, platform: process.platform, arch: process.arch };
}
function operationReceipt(root: string, value: unknown) {
  // Observations cannot turn a safe ordinary fallback into a build failure.
  // Successful reuse authority is persisted separately and is mandatory.
  try {
    const path = join(root, "tmp", `ci-build-operation-${randomUUID()}-probe.json`); mkdirSync(join(root, "tmp"), { recursive: true });
    writeFileSync(`${path}.writing`, JSON.stringify(value)); renameSync(`${path}.writing`, path);
    return path;
  } catch { console.error("Isolated CI build observation unavailable."); }
}
function ownedDirectory(root: string, path: string, privateMode = false) {
  const suffix = relative(root, path);
  if (!suffix || suffix.startsWith("..")) throw new Error("Invalid owned build state");
  let current = root;
  for (const name of suffix.split("/")) {
    current = join(current, name);
    const before = lstatSync(current, { throwIfNoEntry: false });
    if (!before) mkdirSync(current, { mode: current === path && privateMode ? 0o700 : 0o755 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error("Build state is not privately owned");
  }
  if (privateMode && (lstatSync(path).mode & 0o777) !== 0o700) throw new Error("Build state permissions are not private");
}
function ownedJSON(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid owned build receipt");
  const bytes = readFileSync(path);
  return { sha256: digest(bytes), value: JSON.parse(bytes.toString("utf8")) };
}
function successfulProducer(producer: any, selected: string[], policy: Qualification, bun: string, qualificationOnly: boolean): boolean {
  if (producer?.version !== 1 || producer.code !== 0 || producer.runtime?.bun !== bun || producer.runtime?.node?.path !== policy.node.path ||
    (!qualificationOnly && producer.runtime?.node?.sha256 !== policy.node.sha256) || producer.topology !== "checked-after-child-exit" || producer.receipts?.length !== 1) return false;
  const receipt = producer.receipts[0]?.value;
  return receipt?.kind === "workspace-build" && receipt.state === "complete" && receipt.success === true && receipt.code === 0 &&
    Array.isArray(receipt.packages) && identity(receipt.packages.map((pkg: any) => pkg.name).sort()) === identity([...selected].sort()) &&
    receipt.packages.every((pkg: any) => pkg.state === "complete" && Array.isArray(pkg.children) &&
      pkg.children.length === (["ui-kit", "ui-react"].includes(pkg.name) ? 2 : 1) &&
      pkg.children.filter((child: any) => child.compiler === "tsc" && child.code === 0).length === 1 &&
      pkg.children.filter((child: any) => child.compiler === "css" && child.code === 0).length === (["ui-kit", "ui-react"].includes(pkg.name) ? 1 : 0));
}
function writableCleanup(path: string) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(path)) writableCleanup(join(path, name));
  }
  rmSync(path, { recursive: true });
}

/** Invoked only after the normal host workspace write lease is acquired. */
export async function attemptCiBuild(root: string, options: Options): Promise<number | undefined> {
  if (process.env.BRAIN_CI_BUILD_OPERATION !== "isolated-v1") return;
  if (["NODE_OPTIONS", "NODE_PATH", "NAPI_RS_NATIVE_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BUN_OPTIONS", "BUN_INSTALL_CACHE_DIR"].some(name => process.env[name] !== undefined)) {
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unsupported", action: "ordinary-rebuild", reason: "producer-runtime-override" });
    return;
  }
  let policy: Qualification;
  try { policy = readPolicy(); }
  catch {
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unsupported", action: "ordinary-rebuild", reason: "qualification-unavailable" });
    return;
  }
  if (!complete(policy)) {
    console.log("Isolated CI build is unqualified; rebuilding normally.");
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unqualified", action: "ordinary-rebuild", reason: "qualification-unavailable" });
    return;
  }
  return await execute(root, options, policy, false);
}

async function execute(root: string, options: Options, policy: Qualification, qualificationOnly: boolean): Promise<number | undefined> {
  const started = performance.now(), session = randomUUID(), name = `brain-ci-build-${session}`;
  const selected = selectBuildPackages(root, options.directories).map(pkg => pkg.dir);
  let state: string, dockerConfig: string;
  try {
    const directory = join(root, "tmp", "isolated-ci-build"); ownedDirectory(root, directory, true);
    state = mkdtempSync(join(directory, "operation-"));
    dockerConfig = join(state, "docker-config"); mkdirSync(dockerConfig, { mode: 0o700 });
  } catch (error) {
    if (qualificationOnly) throw error;
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unsupported", action: "ordinary-rebuild", reason: "private-state-unavailable" });
    return;
  }
  let preserve = qualificationOnly, containerKnown = false, drained = false;
  const phases: Record<string, number> = {};
  try {
    const captureStart = performance.now(), input = join(state, "input");
    const captured = captureBuildInputs(root, input);
    const bun = readFileSync(realpathSync(process.execPath)), bunHash = digest(bun);
    phases.captureMs = performance.now() - captureStart;
    if (!qualificationOnly && !policyMatches(policy, captured, bunHash)) {
      operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unsupported", action: "ordinary-rebuild", reason: "captured-policy-mismatch", phases });
      return;
    }
    imagePresent(policy.image, dockerConfig);
    const scope = workspaceScope(root);
    const key = identity({ version: 1, inputs: captured.sha256, image: policy.image, bun: bunHash, bunVersion: Bun.version, policy: identity(policy), jobs: options.jobs, scope });
    const stampDirectory = join(root, "tmp", "ci-build-cache");
    if (!qualificationOnly) ownedDirectory(root, stampDirectory, true);
    const reused: string[] = [], pending: string[] = [], previousOutputs: Record<string, string> = {};
    for (const pkg of selected) {
      let matches = false;
      if (!qualificationOnly && !options.force) try {
        const stamp = ownedJSON(join(stampDirectory, `${pkg}.json`)).value;
        if (!/^[0-9a-f-]{36}$/.test(stamp.producerSession)) throw new Error("Missing producer ownership");
        const producerReceipt = ownedJSON(join(stampDirectory, `${stamp.producerSession}.json`));
        const prior = producerReceipt.value;
        matches = stamp.version === 1 && stamp.key === key && stamp.operation === "fixed-isolated-ci-v1" &&
          producerReceipt.sha256 === stamp.receipt && prior.version === 1 && prior.operation === stamp.operation &&
          prior.session === stamp.producerSession && prior.key === key && prior.image === policy.image && prior.drained === true &&
          Array.isArray(prior.compiled) && prior.compiled.includes(pkg) && prior.outputs?.[pkg] === stamp.output &&
          successfulProducer(prior.producer, prior.compiled, policy, bunHash, false) &&
          sameOutputIdentity(join(root, "packages", pkg, "dist"), stamp.output);
        if (matches) previousOutputs[pkg] = stamp.output;
      } catch { /* Missing, partial or changed output is a miss. */ }
      (matches ? reused : pending).push(pkg);
    }
    phases.lookupMs = performance.now() - captureStart - phases.captureMs!;
    for (const pkg of reused) console.log(`Up to date packages/${pkg} (qualified isolated operation)`);
    if (!pending.length) {
      operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "reused", key, selected, reused, compiled: [], phases, elapsedMs: performance.now() - started });
      return 0;
    }
    // CSS package exports can consume another selected package's dist. These
    // are checked, same-key derived intermediates, never arbitrary host output.
    const derived: Record<string, string> = {}, derivedIdentities: Record<string, string> = {};
    for (const pkg of reused) {
      const destination = join(state, "derived", pkg);
      const records = captureDerivedOutput(join(root, "packages", pkg, "dist"), destination, previousOutputs[pkg]!);
      derived[pkg] = destination; derivedIdentities[pkg] = identity(records);
    }
    const { mounts, topology, rootNames } = buildMounts(input, state, captured.packages, derived);
    const tool = join(state, "tool"); mkdirSync(tool, { mode: 0o700 });
    writeFileSync(join(tool, "bun"), bun, { mode: 0o755, flag: "wx" }); chmodSync(join(tool, "bun"), 0o755);
    writeFileSync(join(tool, "bunx"), launcher, { mode: 0o755, flag: "wx" }); chmodSync(join(tool, "bunx"), 0o755);
    const hostFiles = join(state, "host-files"); mkdirSync(hostFiles, { mode: 0o700 });
    for (const [file, bytes] of Object.entries({ hosts: "127.0.0.1 localhost brain-build\n::1 localhost\n", hostname: "brain-build\n", "resolv.conf": "" })) writeFileSync(join(hostFiles, file), bytes, { flag: "wx" });
    const entryPath = join(state, "entry.json"), canary = join(state, "ambient-canary"); writeFileSync(canary, "Odysseus stays outside the build");
    const uid = process.getuid!(), gid = process.getgid!();
    const argv = ["run", "--name", name, "--label", `brain-ci-build-session=${session}`, "--pull=never", "--read-only", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${uid}:${gid}`, "--hostname", "brain-build", "--cpus=2", "--memory=4g", "--pids-limit=256", "--shm-size=64m",
      "--tmpfs", `/repo:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid},size=64m`, "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777,size=256m"];
    const allMounts = [...mounts, { source: tool, target: "/tool", readonly: true }, { source: entryPath, target: "/operation/entry.json", readonly: true },
      ...["hosts", "hostname", "resolv.conf"].map(file => ({ source: join(hostFiles, file), target: `/etc/${file}`, readonly: true }))];
    writeFileSync(entryPath, JSON.stringify({ version: 1, originalRoot: root, canary, selected: pending, jobs: options.jobs, topology, rootNames, node: policy.node.path,
      readonlyTargets: allMounts.filter(mount => mount.readonly).map(mount => mount.target), writableTargets: allMounts.filter(mount => !mount.readonly).map(mount => mount.target) }));
    for (const mount of allMounts) {
      if (/[\r\n,]/.test(mount.source + mount.target)) throw new Error("Unsupported fixed build mount path");
      argv.push("--mount", `type=bind,src=${mount.source},dst=${mount.target}${mount.readonly ? ",readonly" : ""}`);
    }
    argv.push("--workdir", "/repo", policy.image, "/usr/bin/env", "-i", "PATH=/tool:/usr/bin:/bin", "HOME=/tmp/home", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TZ=UTC", "/tool/bun", "/repo/scripts/ci-build-entry.ts");
    writeFileSync(join(state, "invocation.json"), JSON.stringify({ version: 1, session, key, argv, mounts: allMounts, captured, derived: derivedIdentities, runtime: { image: policy.image, bun: bunHash }, scope, qualificationOnly }, null, 2));
    const compileStart = performance.now();
    const child = Bun.spawn(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "--config", dockerConfig, ...argv], { stdout: "inherit", stderr: "inherit", env: { PATH: "/usr/bin:/bin" } });
    containerKnown = true;
    let interrupted = false;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const interrupt = () => { interrupted = true; try { docker(dockerConfig, "stop", "--time", "5", name); } catch { /* Finally retains state unless drain is verified. */ } };
    for (const signal of signals) process.on(signal, interrupt);
    let code: number;
    try { code = await child.exited; } finally { for (const signal of signals) process.off(signal, interrupt); }
    phases.producerMs = performance.now() - compileStart;
    const status = JSON.parse(docker(dockerConfig, "inspect", name)) as Array<{ State: { Running: boolean }; Config: { Image: string; Labels: Record<string, string> };
      HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string; Privileged: boolean; CapDrop: string[]; SecurityOpt: string[]; Tmpfs: Record<string, string> };
      Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> }>;
    if (status.length !== 1 || status[0]!.Config.Labels["brain-ci-build-session"] !== session || status[0]!.State.Running) throw new Error("Build container did not drain");
    drained = true;
    const actual = status[0]!, host = actual.HostConfig;
    if (actual.Config.Image !== policy.image || host.ReadonlyRootfs !== true || host.NetworkMode !== "none" || host.Privileged !== false ||
      !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.some(value => value === "no-new-privileges" || value === "no-new-privileges=true") ||
      identity(Object.keys(host.Tmpfs ?? {}).sort()) !== identity(["/repo", "/tmp"])) throw new Error("Actual build container boundary changed");
    const actualBinds = actual.Mounts.filter(mount => mount.Type === "bind").map(mount => ({ source: mount.Source, target: mount.Destination, readonly: !mount.RW })).sort((a, b) => a.target.localeCompare(b.target));
    if (actual.Mounts.some(mount => !["bind", "tmpfs"].includes(mount.Type)) || identity(actualBinds) !== identity([...allMounts].sort((a, b) => a.target.localeCompare(b.target)))) throw new Error("Actual build mounts differ from captured inputs");
    if (interrupted || code !== 0) throw new Error(`Isolated compiler failed (${code})`);
    const producer = JSON.parse(readFileSync(join(state, "diagnostics/isolated-producer.json"), "utf8"));
    if (!successfulProducer(producer, pending, policy, bunHash, qualificationOnly)) throw new Error("Consumed runtime or compiler receipt mismatch");
    const outputs: Record<string, string> = {}, publishStart = performance.now();
    for (const pkg of pending) {
      const staged = join(state, "validated", pkg);
      outputs[pkg] = identity(captureOutputs(join(state, "parents", pkg, "dist"), staged));
    }
    if (!qualificationOnly) {
      for (const pkg of pending) {
        const staged = join(state, "validated", pkg);
        const destination = join(root, "packages", pkg, "dist");
        rmSync(destination, { recursive: true, force: true }); renameSync(staged, destination);
        if (identity(outputFiles(destination)) !== outputs[pkg]) throw new Error("Published build output changed");
      }
      // No new package stamp is written until every selected publication and
      // its verification have completed after the real container drained.
      const record = JSON.stringify({ version: 1, operation: "fixed-isolated-ci-v1", session, key, image: policy.image, drained: true, compiled: pending, derived: derivedIdentities, outputs, producer });
      writeFileSync(join(stampDirectory, `${session}.json`), record, { flag: "wx", mode: 0o600 });
      for (const pkg of pending) {
        const stamp = join(stampDirectory, `${pkg}.json`);
        writeFileSync(`${stamp}.writing`, JSON.stringify({ version: 1, operation: "fixed-isolated-ci-v1", key, output: outputs[pkg], producerSession: session, receipt: digest(record) }), { mode: 0o600 }); renameSync(`${stamp}.writing`, stamp);
      }
    }
    phases.publishMs = performance.now() - publishStart;
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: qualificationOnly ? "unqualified" : "compiled", action: qualificationOnly ? "qualification-only" : "publish", session, key, selected, reused, compiled: pending, outputs, producer, phases, elapsedMs: performance.now() - started });
    if (qualificationOnly) console.log(`Unqualified build artifacts retained at ${state}; no reuse stamp or workspace output published.`);
    return 0;
  } catch (error) {
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: containerKnown ? "failed" : "unsupported", action: containerKnown ? "fail" : "ordinary-rebuild", reason: containerKnown ? "producer-incomplete" : "boundary-unavailable", phases });
    if (!containerKnown && !qualificationOnly) return;
    throw error;
  } finally {
    if (containerKnown) {
      try {
        const status = JSON.parse(docker(dockerConfig, "inspect", name)) as Array<{ State: { Running: boolean }; Config: { Labels: Record<string, string> } }>;
        if (status.length !== 1 || status[0]!.Config.Labels["brain-ci-build-session"] !== session) throw new Error("Unknown container ownership");
        if (status[0]!.State.Running) docker(dockerConfig, "stop", "--time", "5", name);
        docker(dockerConfig, "wait", name); drained = true;
        docker(dockerConfig, "rm", name);
      } catch { preserve = true; }
    }
    if (containerKnown && !drained) preserve = true;
    if (!preserve) writableCleanup(state);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.shift() !== "--qualify") throw new Error("Only the fixed --qualify operation is available");
  const options: Options = { jobs: 1, force: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--for" && options.directories === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) options.directories = args[++index]!.split(",");
    else if (/^--jobs=[12]$/.test(arg)) options.jobs = Number(arg.slice(7)) as 1 | 2;
    else throw new Error("Unsupported fixed qualification argument");
  }
  const root = resolve(import.meta.dir, "..");
  const coordinated = await ensureWorkspaceLease(root, "write");
  if (coordinated !== undefined) process.exit(coordinated);
  // This path emits evidence only. It cannot authorize reuse, write stamps,
  // change qualification, or replace the ordinary workspace's dist outputs.
  process.exitCode = await execute(root, options, readPolicy(), true) ?? 1;
}
