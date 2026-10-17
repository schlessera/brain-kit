/** One dormant, fixed isolated build operation. CI intent is not authority. */
import { dockerControl as docker, inspectOwnedBuildContainer, removeOwnedBuildContainer } from "./ci-build-lifetime";
import { buildRead } from "./ci-build-files";
import { buildMaterial, buildProducerPaths, matchingBuildReceipt, operationFor, sameBuildMaterial, successfulBuildProducer, type BuildMaterial } from "./ci-build-state";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, openSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildMounts, captureBuildInputs, captureDerivedOutput, captureOutputs, digest, identity, outputFiles, sameOutputIdentity } from "./ci-build-boundary";
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
const producerPaths = buildProducerPaths;
const launcher = '#!/bin/sh\nexec /tool/bun x --no-install "$@"\n';
// Run once before Bun and its lease coordinator can initialize HOME.
const entryLauncher = '#!/bin/sh\nset -eu\numask 077\n/usr/bin/mkdir -m 0700 /tmp/home /tmp/cache\nexec /tool/bun /repo/scripts/ci-build-entry.ts\n';
function readPolicy(): Qualification {
  const policy = JSON.parse(buildRead(policyPath, undefined, 1024 * 1024).bytes.toString("utf8")) as Qualification;
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
  return complete(policy) && sameBuildMaterial(buildMaterial(captured.records, captured.installation, bun), policy as BuildMaterial);
}

function imagePresent(image: string, config: string) {
  const records = JSON.parse(docker(config, "image", "inspect", image)) as Array<{ RepoDigests?: string[] }>;
  if (records.length !== 1 || !records[0]!.RepoDigests?.includes(image)) throw new Error("Fixed build image manifest is unavailable");
}
function workspaceScope(root: string) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Unsupported fixed build platform");
  if (process.getuid!() === 0 || process.getgid!() === 0) throw new Error("Fixed build requires non-root UID and GID");
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
  const { bytes, stat } = buildRead(path, undefined, 16 * 1024 * 1024);
  if (stat.uid !== BigInt(process.getuid!())) throw new Error("Invalid owned build receipt");
  return { sha256: digest(bytes), value: JSON.parse(bytes.toString("utf8")) };
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

type PrivateProof = { workspace: string; domain: string; candidate?: BuildMaterial; node?: string; results: any[];
  trace?: Awaited<ReturnType<typeof import("./ci-build-trace").prepareBuildTrace>>;
  consumers?: Awaited<ReturnType<typeof import("./ci-build-consumers").prepareBuildConsumers>> };
async function execute(root: string, options: Options, policy: Qualification, qualificationOnly: boolean, proof?: PrivateProof): Promise<number | undefined> {
  if (process.getuid!() === 0 || process.getgid!() === 0) {
    if (qualificationOnly) throw new Error("Fixed build requires non-root UID and GID");
    operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unsupported", action: "ordinary-rebuild", reason: "non-root-context-required" });
    return;
  }
  if (proof && (!qualificationOnly || proof.workspace !== root || !/^[0-9a-f-]{36}$/.test(proof.domain))) throw new Error("Invalid private qualification workspace");
  const purpose = qualificationOnly ? "qualification" : "production", operation = operationFor(purpose), domain = proof?.domain ?? "workspace";
  const diagnostic = proof?.trace ? "trace" : proof?.consumers ? "consumers" : undefined;
  const publish = (!qualificationOnly || proof !== undefined) && !diagnostic;
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
  let preserve = qualificationOnly, containerKnown = false, drained = false, removed = false, interrupted = false;
  let child: ReturnType<typeof Bun.spawn> | undefined, containerID: string | undefined;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const interrupt = () => {
    interrupted = true;
    try {
      if (containerKnown && !removed) {
        const owned = inspectOwnedBuildContainer(dockerConfig, containerID ?? name, session); containerID = owned.id;
        docker(dockerConfig, "stop", "--time", "5", owned.id);
      }
    }
    catch { preserve = true; }
    finally { try { child?.kill("SIGTERM"); } catch { preserve = true; } }
  };
  // Keep ownership handlers installed through cleanup and publication.
  for (const signal of signals) process.on(signal, interrupt);
  const cleanup = () => {
    try {
      const owned = inspectOwnedBuildContainer(dockerConfig, containerID ?? name, session); containerID = owned.id;
      removeOwnedBuildContainer(dockerConfig, owned.id, session);
      drained = true; removed = true;
      writeFileSync(join(state, "cleanup.json"), JSON.stringify({ version: 1, session, containerID, drained, removed }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      preserve = true;
      operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "failed", action: "fail", session, reason: removed ? "cleanup-audit-unavailable" : "owned-container-cleanup-incomplete", drained, removed });
      throw error;
    }
  };
  const phases: Record<string, number> = {};
  const perform = async (): Promise<number | undefined> => {
    try {
      const captureStart = performance.now(), input = join(state, "input");
      const captured = captureBuildInputs(root, input);
      const executable = buildRead(realpathSync(process.execPath)), loaded = statSync("/proc/self/exe", { bigint: true });
      if (executable.stat.dev !== loaded.dev || executable.stat.ino !== loaded.ino) throw new Error("Captured Bun differs from running executable");
      const bun = executable.bytes, bunHash = digest(bun);
      phases.captureMs = performance.now() - captureStart;
      const material = buildMaterial(captured.records, captured.installation, bunHash);
      const { buildDataRefusals } = await import("./ci-build-data");
      const dataRefusals = buildDataRefusals(input, captured.records);
      if (dataRefusals.length || (!qualificationOnly && !policyMatches(policy, captured, bunHash)) || (proof?.candidate && !sameBuildMaterial(material, proof.candidate))) {
        operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "unsupported", action: "ordinary-rebuild", reason: "captured-policy-mismatch", phases });
        return;
      }
      imagePresent(policy.image, dockerConfig);
      const scope = workspaceScope(root);
      const key = identity({ version: 1, purpose, domain, inputs: captured.sha256, image: policy.image, bun: bunHash, bunVersion: Bun.version, policy: identity(policy), jobs: options.jobs, scope });
      const stampDirectory = join(root, "tmp", proof ? "ci-build-qualification-cache" : "ci-build-cache");
      if (publish) ownedDirectory(root, stampDirectory, true);
      const reused: string[] = [], pending: string[] = [], previousOutputs: Record<string, string> = {};
      for (const pkg of selected) {
        let matches = false;
        if ((publish || proof?.consumers) && !options.force) try {
          const stamp = ownedJSON(join(stampDirectory, `${pkg}.json`)).value;
          if (!/^[0-9a-f-]{36}$/.test(stamp.producerSession)) throw new Error("Missing producer ownership");
          const producerReceipt = ownedJSON(join(stampDirectory, `${stamp.producerSession}.json`));
          const prior = producerReceipt.value;
          matches = matchingBuildReceipt(stamp, prior, producerReceipt.sha256, { purpose, domain, key, image: policy.image, pkg, node: { path: policy.node.path, sha256: proof?.node ?? policy.node.sha256 }, bun: bunHash }) &&
            sameOutputIdentity(join(root, "packages", pkg, "dist"), stamp.output);
          if (matches) previousOutputs[pkg] = stamp.output;
        } catch { /* Missing, partial or changed output is a miss. */ }
        (matches ? reused : pending).push(pkg);
      }
      phases.lookupMs = performance.now() - captureStart - phases.captureMs!;
      for (const pkg of reused) console.log(`Up to date packages/${pkg} (qualified isolated operation)`);
      if (proof?.consumers && pending.length) throw new Error("Consumer proof requires every current output's successful same-operation receipt");
      if (!pending.length && !proof?.consumers) {
        const value = { version: 1, kind: "isolated-ci-build", purpose, domain, authority: qualificationOnly ? "none" : "qualified-production", state: qualificationOnly ? "unqualified-private-repeat" : "reused", key, selected, reused, compiled: [], phases, elapsedMs: performance.now() - started };
        proof?.results.push(value);
        operationReceipt(root, value);
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
      writeFileSync(join(tool, "entry.sh"), entryLauncher, { mode: 0o700, flag: "wx" }); chmodSync(join(tool, "entry.sh"), 0o700);
      const hostFiles = join(state, "host-files"); mkdirSync(hostFiles, { mode: 0o700 });
      for (const [file, bytes] of Object.entries({ hosts: "127.0.0.1 localhost brain-build\n::1 localhost\n", hostname: "brain-build\n", "resolv.conf": "" })) writeFileSync(join(hostFiles, file), bytes, { flag: "wx" });
      const entryPath = join(state, "entry.json"), canary = join(state, "ambient-canary"); writeFileSync(canary, "Odysseus stays outside the build");
      const uid = process.getuid!(), gid = process.getgid!();
      const argv = ["run", "--name", name, "--label", `brain-ci-build-session=${session}`, "--pull=never", "--read-only", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${uid}:${gid}`, "--hostname", "brain-build", "--cpus=2", "--memory=4g", "--pids-limit=256", "--shm-size=64m",
        "--tmpfs", `/repo:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid},size=64m`, "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777,size=256m"];
      const consumerWork = join(state, "diagnostics/consumer-work");
      if (proof?.consumers) mkdirSync(consumerWork, { mode: 0o700 });
      const diagnosticMounts = proof?.trace ? [{ source: proof.trace.source, target: "/trace", readonly: true }] : proof?.consumers ? [{ source: proof.consumers.source, target: "/consumer-input", readonly: true }, { source: consumerWork, target: "/consumer-work", readonly: false }] : [];
      const allMounts = [...mounts, ...diagnosticMounts, { source: tool, target: "/tool", readonly: true }, { source: entryPath, target: "/operation/entry.json", readonly: true },
        ...["hosts", "hostname", "resolv.conf"].map(file => ({ source: join(hostFiles, file), target: `/etc/${file}`, readonly: true }))];
      writeFileSync(entryPath, JSON.stringify({ version: 1, mode: proof?.consumers ? "consumers" : "build", uid, gid, originalRoot: root, canary, selected: pending, jobs: options.jobs, topology, rootNames, node: policy.node.path,
        readonlyTargets: allMounts.filter(mount => mount.readonly).map(mount => mount.target), writableTargets: allMounts.filter(mount => !mount.readonly).map(mount => mount.target) }));
      for (const mount of allMounts) {
        if (/[\r\n,]/.test(mount.source + mount.target)) throw new Error("Unsupported fixed build mount path");
        argv.push("--mount", `type=bind,src=${mount.source},dst=${mount.target}${mount.readonly ? ",readonly" : ""}`);
      }
      argv.push("--workdir", "/repo", policy.image, "/usr/bin/env", "-i", "PATH=/tool:/usr/bin:/bin", "HOME=/tmp/home", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TZ=UTC", "/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "300s", ...(proof?.trace?.command ?? ["/bin/sh", "/tool/entry.sh"]));
      writeFileSync(join(state, "invocation.json"), JSON.stringify({ version: 1, session, key, argv, mounts: allMounts, captured, derived: derivedIdentities, runtime: { image: policy.image, bun: bunHash }, diagnostic: diagnostic ? { kind: diagnostic, identity: proof?.trace?.identity ?? proof?.consumers?.identity } : undefined, lifetime: { producerSeconds: 300, killGraceSeconds: 5, clientSeconds: 330, dockerControlMilliseconds: 10_000 }, scope, qualificationOnly }, null, 2));
      const compileStart = performance.now();
      child = Bun.spawn(["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "330s", "/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "--config", dockerConfig, ...argv], { stdout: "inherit", stderr: "inherit", env: { PATH: "/usr/bin:/bin" } });
      containerKnown = true;
      const code = await child.exited;
      phases.producerMs = performance.now() - compileStart;
      const owned = inspectOwnedBuildContainer(dockerConfig, containerID ?? name, session); containerID = owned.id;
      if (owned.running) throw new Error("Build container did not drain");
      drained = true;
      const actual = owned.record, host = actual.HostConfig;
      writeFileSync(join(state, "container-boundary.json"), JSON.stringify({ version: 1, session, containerID, actual }, null, 2), { flag: "wx", mode: 0o600 });
      if (actual.Config.Image !== policy.image || actual.Config.User !== `${uid}:${gid}` || host.ReadonlyRootfs !== true || host.NetworkMode !== "none" || host.Privileged !== false ||
        !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.some(value => value === "no-new-privileges" || value === "no-new-privileges=true") ||
        identity(Object.keys(host.Tmpfs ?? {}).sort()) !== identity(["/repo", "/tmp"])) throw new Error("Actual build container boundary changed");
      const actualBinds = actual.Mounts.filter(mount => mount.Type === "bind").map(mount => ({ source: mount.Source, target: mount.Destination, readonly: !mount.RW })).sort((a, b) => a.target.localeCompare(b.target));
      if (actual.Mounts.some(mount => !["bind", "tmpfs"].includes(mount.Type)) || identity(actualBinds) !== identity([...allMounts].sort((a, b) => a.target.localeCompare(b.target)))) throw new Error("Actual build mounts differ from captured inputs");
      if (interrupted || code !== 0) throw new Error(`Isolated compiler failed (${code})`);
      const producer = ownedJSON(join(state, "diagnostics/isolated-producer.json")).value;
      const runtime = producer.runtime;
      if (runtime?.bun !== bunHash || runtime?.node?.path !== policy.node.path || ((proof?.node ?? policy.node.sha256) && runtime.node.sha256 !== (proof?.node ?? policy.node.sha256))) throw new Error("Consumed runtime mismatch");
      if (proof?.consumers) {
        if (producer.kind !== "packed-consumers" || producer.code !== 0 || producer.consumers?.completed !== true || identity(producer.consumers.packages) !== identity(selected)) throw new Error("Packed consumer receipt mismatch");
      } else if (!successfulBuildProducer(producer, pending, { path: policy.node.path, sha256: qualificationOnly ? proof?.node ?? null : policy.node.sha256 }, bunHash)) throw new Error("Consumed compiler receipt mismatch");
      // Removal is part of success, not best-effort work after publication.
      cleanup();
      if (interrupted) throw new Error("Isolated compiler interrupted before publication");
      const outputs: Record<string, string> = {}, publishStart = performance.now();
      for (const pkg of pending) {
        const staged = join(state, "validated", pkg);
        outputs[pkg] = identity(captureOutputs(join(state, "parents", pkg, "dist"), staged));
      }
      if (publish) {
        for (const pkg of pending) {
          const staged = join(state, "validated", pkg);
          const destination = join(root, "packages", pkg, "dist");
          rmSync(destination, { recursive: true, force: true }); renameSync(staged, destination);
          if (identity(outputFiles(destination)) !== outputs[pkg]) throw new Error("Published build output changed");
        }
        // No new package stamp is written until every selected publication and
        // its verification have completed after the real container drained.
        const record = JSON.stringify({ version: 1, purpose, domain, operation, session, key, image: policy.image, drained: true, removed: true, compiled: pending, derived: derivedIdentities, outputs, producer });
        writeFileSync(join(stampDirectory, `${session}.json`), record, { flag: "wx", mode: 0o600 });
        for (const pkg of pending) {
          const stamp = join(stampDirectory, `${pkg}.json`);
          writeFileSync(`${stamp}.writing`, JSON.stringify({ version: 1, purpose, domain, operation, key, output: outputs[pkg], producerSession: session, receipt: digest(record) }), { mode: 0o600 }); renameSync(`${stamp}.writing`, stamp);
        }
      }
      phases.publishMs = performance.now() - publishStart;
      if (proof) { proof.candidate ??= material; proof.node ??= producer.runtime.node.sha256; }
      const value = { version: 1, kind: "isolated-ci-build", purpose: diagnostic ? `qualification-${diagnostic}` : purpose, domain, authority: qualificationOnly ? "none" : "qualified-production", artifactDirectory: qualificationOnly ? state : undefined, state: qualificationOnly ? "unqualified" : "compiled", action: proof ? "private-qualification-output" : qualificationOnly ? "qualification-only" : "publish", session, key, selected, reused, compiled: pending, outputs, producer, drained, removed, phases, elapsedMs: performance.now() - started };
      proof?.results.push(value); operationReceipt(root, value);
      if (qualificationOnly && !proof) console.log(`Unqualified build artifacts retained at ${state}; no reuse stamp or workspace output published.`);
      return 0;
    } catch (error) {
      if (containerKnown) preserve = true;
      operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: containerKnown ? "failed" : "unsupported", action: containerKnown ? "fail" : "ordinary-rebuild", reason: containerKnown ? "producer-incomplete" : "boundary-unavailable", phases });
      if (!containerKnown && (!qualificationOnly || proof)) return;
      throw error;
    }
  };
  let result: number | undefined, failure: unknown, failed = false;
  try { result = await perform(); } catch (error) { failure = error; failed = true; }
  let cleanupError: unknown;
  try {
    if (containerKnown && !removed) {
      try { cleanup(); }
      catch (error) {
        preserve = true; cleanupError = error;
        operationReceipt(root, { version: 1, kind: "isolated-ci-build", state: "failed", action: "fail", session, reason: "owned-container-cleanup-incomplete", drained, removed: false, phases });
      }
    }
    if (containerKnown && (!drained || !removed)) preserve = true;
    if (!preserve) writableCleanup(state);
  } catch (error) { cleanupError = error; }
  finally { for (const signal of signals) process.off(signal, interrupt); }
  if (cleanupError) throw cleanupError;
  if (failed) throw failure;
  return result;
}

/** Fixed evidence controller. It can publish only inside its own fresh workspace. */
async function qualifyPrivateBuild(root: string): Promise<number> {
  const owner = join(root, "tmp", "isolated-ci-build"); ownedDirectory(root, owner, true);
  const directory = mkdtempSync(join(owner, "qualification-")), workspace = join(directory, "workspace");
  const source = captureBuildInputs(root, workspace), domain = randomUUID();
  const gitEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
  const git = (args: string[], input?: Buffer) => {
    const result = spawnSync("/usr/bin/git", ["--no-lazy-fetch", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { cwd: workspace, env: gitEnv, input, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Private qualification Git setup failed");
  };
  const templates = join(directory, "git-template"); mkdirSync(templates, { mode: 0o700 });
  git(["init", "--quiet", `--template=${templates}`]);
  const paths = source.records.filter(entry => entry.kind !== "directory" && !/(^|\/)node_modules(?:\/|$)/.test(entry.path)).map(entry => entry.path);
  git(["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], Buffer.from(paths.join("\0") + "\0"));
  const lock = join(workspace, "tmp/workspace-operation/output.lock"); mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const fd = openSync(lock, "a+", 0o600), held = fstatSync(fd);
  const previous = { lease: process.env.BRAIN_WORKSPACE_LEASE, path: process.env.PATH };
  const proof: PrivateProof = { workspace, domain, results: [] }, policy = readPolicy();
  const tool = join(directory, "ordinary-tool"); mkdirSync(tool, { mode: 0o700 });
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(tool, "bunx"), `#!/bin/sh\nexec ${quote(process.execPath)} x --no-install "$@"\n`, { mode: 0o700, flag: "wx" });
  const resultPath = join(directory, "qualification.json");
  try {
    const acquired = spawnSync("/usr/bin/flock", ["--exclusive", "--timeout", "10", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 12_000 });
    if (acquired.error || acquired.status !== 0) throw new Error("Private qualification lease unavailable");
    process.env.BRAIN_WORKSPACE_LEASE = JSON.stringify({ mode: "write", fd, dev: held.dev, ino: held.ino, ownerPid: process.pid, ownerFd: fd });
    process.env.PATH = `${tool}:${dirname(process.execPath)}:/usr/bin:/bin`;
    const run = async (label: string, options: Options = { jobs: 1, force: false }) => {
      const start = performance.now(), before = proof.results.length;
      const code = await execute(workspace, options, policy, true, proof);
      if (code === undefined) {
        const args = [process.execPath, join(workspace, "scripts/build.ts"), `--jobs=${options.jobs}`, ...(options.force ? ["--force"] : []), ...(options.directories ? ["--for", options.directories.join(",")] : [])];
        // Bun's default spawn environment retains startup values. Explicitly
        // forward the private lease/PATH established by this controller.
        const child = Bun.spawn(args, { cwd: workspace, stdin: "ignore", stdout: "inherit", stderr: "inherit", env: { ...process.env } });
        const fallback = await child.exited;
        if (fallback !== 0) throw new Error(`Private unsupported-context ordinary build failed (${fallback})`);
        const result = { label, purpose: "qualification", authority: "none", state: "unsupported-ordinary-rebuild", elapsedMs: performance.now() - start };
        proof.results.push(result); return result as any;
      }
      assert.equal(code, 0, `CI_BUILD_PRIVATE_${label}_EXIT`); assert.equal(proof.results.length, before + 1);
      const result = proof.results.at(-1); result.label = label;
      if (result.artifactDirectory) {
        const { compactBuildEvidence } = await import("./ci-build-evidence");
        Object.assign(result, compactBuildEvidence(workspace, directory, result));
      }
      return result;
    };
    // Validate the fixed offline consumer prerequisite before any expensive arm.
    const { prepareBuildConsumers } = await import("./ci-build-consumers");
    const consumerInputs = prepareBuildConsumers(root, directory);
    const { prepareBuildTrace, classifyBuildTrace } = await import("./ci-build-trace");
    const traceInputs = prepareBuildTrace(directory);
    const cold = await run("cold", { jobs: 1, force: true }); assert.equal(cold.compiled.length, 19); assert.equal(cold.reused.length, 0);
    const outputs = Object.fromEntries(source.packages.map(pkg => [pkg, identity(outputFiles(join(workspace, "packages", pkg, "dist")))]));
    const repeat = await run("unchanged"); assert.equal(repeat.compiled.length, 0, "CI_BUILD_UNCHANGED_HAS_NO_COMPILER_CHILDREN"); assert.equal(repeat.reused.length, 19);
    for (const pkg of source.packages) assert.equal(identity(outputFiles(join(workspace, "packages", pkg, "dist"))), outputs[pkg], "CI_BUILD_REPEAT_PRESERVES_OUTPUT");
    // Check expensive consumer compatibility before the later causal controls,
    // so a real packing failure does not repeat every independent build arm.
    proof.consumers = consumerInputs;
    try { await run("packed-consumers"); } finally { delete proof.consumers; }
    const consumers = proof.results.at(-1);
    const dist = join(workspace, "packages/common/dist"), entry = outputFiles(dist).find(file => file.kind === "file")!;
    assert(entry); const file = join(dist, entry.path);
    const changes = [
      { name: "delete", change: () => rmSync(file) },
      { name: "edit", change: () => writeFileSync(file, "// Odysseus keeps the harbour ledger.\n") },
      { name: "extra", change: () => writeFileSync(join(dist, "odysseus-extra.js"), "export const harbour='Ithaca';\n") },
      { name: "mode", change: () => chmodSync(file, entry.mode ^ 0o100) },
    ];
    for (const mutation of changes) {
      mutation.change(); const recovered = await run(`output-${mutation.name}`);
      assert.deepEqual(recovered.compiled, ["common"], "CI_BUILD_OUTPUT_DAMAGE_REBUILDS_ONLY_AFFECTED"); assert.equal(recovered.reused.length, 18);
      assert.equal(identity(outputFiles(dist)), outputs.common, "CI_BUILD_OUTPUT_DAMAGE_RECOVERED");
    }
    rmSync(join(workspace, "packages/ui-react/dist/styles.css"));
    const css = await run("css-derived-recovery", { jobs: 1, force: false, directories: ["ui-react"] });
    assert.deepEqual(css.compiled, ["ui-react"], "CI_BUILD_VALID_DERIVED_DEPENDENCIES_HAVE_NO_CHILDREN"); assert(css.reused.includes("ui-kit"));
    const force = await run("force", { jobs: 2, force: true }); assert.equal(force.compiled.length, 19); assert.equal(force.reused.length, 0);
    const marker = join(workspace, "packages/common/src/qualification-marker.ts");
    writeFileSync(marker, 'export const cargo = 1; export const harbour=(x?:{name?:string})=>x?.name??"Ithaca";\n', { flag: "wx" });
    try {
      const changed = await run("source-change"); assert.equal(changed.compiled.length, 19, "CI_BUILD_SOURCE_CHANGE_REBUILDS_SELECTION");
      const consume = () => {
        const child = spawnSync("/usr/bin/node", ["--input-type=module", "-e", `import {cargo} from ${JSON.stringify(join(workspace, "packages/common/dist/qualification-marker.js"))};console.log(cargo)`], { timeout: 10_000 });
        assert.equal(child.status, 0); return Number(child.stdout.toString().trim());
      };
      assert.equal(consume(), 1);
      const configPath = join(workspace, "tsconfig.json"), configBytes = buildRead(configPath).bytes;
      const aliased = join(directory, "aliased-tsconfig.json"), config = JSON.parse(configBytes.toString("utf8"));
      config.compilerOptions.target = "ES2019";
      writeFileSync(aliased, JSON.stringify(config), { flag: "wx", mode: 0o600 });
      try {
        rmSync(configPath); symlinkSync("../aliased-tsconfig.json", configPath);
        const alias = await run("effective-config-alias", { jobs: 1, force: false, directories: ["common"] });
        assert.equal(alias.state, "unsupported-ordinary-rebuild", "CI_BUILD_EFFECTIVE_ALIAS_REFUSES_REUSE");
        assert.equal(consume(), 1);
        assert(!buildRead(join(workspace, "packages/common/dist/qualification-marker.js")).bytes.toString().includes("?."), "CI_BUILD_ALIASED_TARGET_REACHES_ACTUAL_CONSUMER");
      } finally { rmSync(configPath, { force: true }); writeFileSync(configPath, configBytes); }
      await run("restored-config", { jobs: 1, force: false, directories: ["common"] });
      assert(buildRead(join(workspace, "packages/common/dist/qualification-marker.js")).bytes.toString().includes("?."), "CI_BUILD_ORIGINAL_TARGET_RESTORED");
      const compiler = join(workspace, "node_modules/typescript/lib/_tsc.js"), original = buildRead(compiler).bytes;
      const anchor = "function emitNumericOrBigIntLiteral(node) {"; assert.equal(original.toString().split(anchor).length, 2);
      try {
        writeFileSync(compiler, original.toString().replace(anchor, anchor + '\n    if(node.text === "1"){writeStringLiteral("2");return;}'));
        const rejected = await run("installed-compiler", { jobs: 1, force: false, directories: ["common"] });
        assert.equal(rejected.state, "unsupported-ordinary-rebuild", "CI_BUILD_INSTALLED_DRIFT_REFUSES_REUSE"); assert.equal(consume(), 2, "CI_BUILD_ACTUAL_CHANGED_COMPILER_CONSUMER");
      } finally { writeFileSync(compiler, original); }
      await run("restored-compiler", { jobs: 1, force: false, directories: ["common"] }); assert.equal(consume(), 1);
    } finally { rmSync(marker, { force: true }); }
    const restored = await run("restored-source"); assert.equal(restored.compiled.length, 19);
    for (const pkg of source.packages) assert.equal(identity(outputFiles(join(workspace, "packages", pkg, "dist"))), outputs[pkg], "CI_BUILD_ORIGINAL_SOURCE_RESTORED");
    const themePath = join(workspace, "packages/ui-react/src/theme.css"), theme = buildRead(themePath).bytes;
    try {
      writeFileSync(themePath, Buffer.concat([theme, Buffer.from("\n[data-odysseus-cargo]{min-width:2319px}\n")]));
      const stylesheet = await run("nested-css-input", { jobs: 1, force: false, directories: ["ui-react"] });
      assert.equal(stylesheet.state, "unsupported-ordinary-rebuild", "CI_BUILD_NESTED_CSS_DRIFT_REFUSES_REUSE");
      assert(buildRead(join(workspace, "packages/ui-react/dist/styles.css")).bytes.toString().includes("2319px"), "CI_BUILD_NESTED_CSS_REACHES_ACTUAL_OUTPUT");
    } finally { writeFileSync(themePath, theme); }
    await run("restored-stylesheet", { jobs: 1, force: false, directories: ["ui-react"] });
    assert.equal(identity(outputFiles(join(workspace, "packages/ui-react/dist"))), outputs["ui-react"], "CI_BUILD_ORIGINAL_STYLESHEET_RESTORED");
    // Diagnostic modes use the same actual engine/boundary but cannot seed
    // either production or ordinary private-repeat receipts.
    proof.trace = traceInputs;
    try { await run("diagnostic-trace", { jobs: 1, force: true }); } finally { delete proof.trace; }
    const traced = proof.results.at(-1), trace = classifyBuildTrace(buildRead(join(traced.artifactDirectory, "diagnostics/qualification-syscalls.log"), undefined, 256 * 1024 * 1024).bytes.toString("utf8"));
    for (const pkg of source.packages) assert.equal(traced.outputs[pkg], outputs[pkg], "CI_BUILD_TRACE_ARM_PRESERVES_OUTPUT");
    writeFileSync(resultPath, JSON.stringify({ version: 1, purpose: "qualification", authority: "none", domain, workspace, results: proof.results, trace, consumers, remainingQualification: ["finite-ambient-source-audit-and-counterfactuals", "actual-owner-interruption", "browser-marker-and-default-export-consumers", "comparable-hosted-cost"], productionActivation: "unqualified" }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Private qualification evidence retained at ${directory}; production reuse remains unqualified.`);
    return 0;
  } catch (error) {
    writeFileSync(resultPath, JSON.stringify({ version: 1, purpose: "qualification", authority: "none", domain, state: "failed", results: proof.results, productionActivation: "unqualified" }, null, 2), { flag: "wx", mode: 0o600 });
    throw error;
  } finally {
    closeSync(fd);
    if (previous.lease === undefined) delete process.env.BRAIN_WORKSPACE_LEASE; else process.env.BRAIN_WORKSPACE_LEASE = previous.lease;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command !== "--qualify" && command !== "--qualify-private") throw new Error("Only fixed qualification operations are available");
  if (command === "--qualify-private" && args.length) throw new Error("The fixed private controller takes no arguments");
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
  // These paths emit evidence only. Private-repeat stamps are purpose-bound;
  // neither path changes production qualification or ordinary workspace outputs.
  process.exitCode = command === "--qualify-private" ? await qualifyPrivateBuild(root) : await execute(root, options, readPolicy(), true) ?? 1;
}
