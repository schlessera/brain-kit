import { expect } from "bun:test";
import { chmodSync, chownSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { serveNativeBrainManager } from "../../../ui-sdk/src/server/native-brain-manager.js";
import { hostOutputStagingLimits } from "../../../ui-sdk/src/server/worker-state-limits.js";
const brain = "/brain-fixture/brain";
const sharedGit = process.argv.includes("--shared-git");
const sharedPhase = sharedGit ? process.argv.find(arg => arg.startsWith("--shared-phase="))?.slice("--shared-phase=".length) : undefined;
if (sharedPhase && !["private", "fresh", "warm", "strict"].includes(sharedPhase)) throw Error("Unknown shared Git fixture phase");
const privateGitInputs = process.argv.includes("--private-git-inputs");
function command(argv: string[]) {
  const child = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0); return child.stdout.toString();
}
if (process.argv[2] === "--index-child") {
  await import("../maintenance-index-refusals.native.js");
} else if (process.argv[2] === "--child") {
  expect(process.getuid!()).toBe(21001);
  const { probeWorkerHost } = await import("../../../ui-sdk/src/server/worker-launcher.js");
  if (sharedPhase && sharedPhase !== "fresh") {
    const profile = sharedPhase === "strict" ? "strict" : "governed";
    const probe = probeWorkerHost(brain, { profile, stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
    expect(probe, "SHARED_PHASE_ACTUAL_SEPARATE_IDENTITY").toMatchObject({ ok: true, identity: "separate_uid", workerUid: 21002 });
    console.log(JSON.stringify({ actualSharedPhaseIdentity: { phase: sharedPhase, profile, probe } }));
  } else {
    const governed = probeWorkerHost(brain, { profile: "governed", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
    const ordinary = probeWorkerHost(brain, { stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
    const strict = probeWorkerHost(brain, { profile: "strict", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
    const restricted = probeWorkerHost(brain, { restricted: true, stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
    const ordinaryDefault = probeWorkerHost(brain);
    console.log(JSON.stringify({ actualHelperProbes: { governed, strict, ordinary, ordinaryDefault, restricted } }));
    expect(governed.ok, "ACTUAL_MANAGED_GOVERNED_IDENTITY_PROBE").toBe(true);
    expect(ordinary.ok, "ACTUAL_MANAGED_ORDINARY_IDENTITY_RELAY_REACHABLE").toBe(true);
    expect(ordinaryDefault.ok, "ACTUAL_DEFAULT_ORDINARY_IDENTITY_RELAY_REACHABLE").toBe(true);
    expect(strict.ok, "ACTUAL_MANAGED_STRICT_IDENTITY_PROBE").toBe(true);
    expect(restricted, "ACTUAL_MANAGED_RESTRICTED_IDENTITY_RELAY_REACHABLE").toMatchObject({ ok: true, identity: "separate_uid", workerUid: 21002 });
    const { rmSync } = await import("node:fs");
    const spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!, spawn = Bun.spawn;
    const prefix = "s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o660);s.listen(1)";
    const faults = {
      socket_mode: "s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o666);s.listen(1)",
      socket_group: "s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o660);os.chown(sys.argv[1],-1,21003);s.listen(1)",
      socket_owner: "os.rename('/identity-fixture/foreign-relay.sock',sys.argv[1]);s.bind(sys.argv[1]+'.unused');s.listen(1)",
      socket_alias: "s.bind(sys.argv[1]+'.bound');os.symlink(sys.argv[1]+'.bound',sys.argv[1]);os.chmod(sys.argv[1],0o660);s.listen(1)",
      directory_mode: "s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o660);os.chmod(os.path.dirname(sys.argv[1]),0o755);s.listen(1)",
      directory_alias: "s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o660);os.rename(os.path.dirname(sys.argv[1]),os.path.dirname(sys.argv[1])+'.bound');os.symlink(os.path.dirname(sys.argv[1])+'.bound',os.path.dirname(sys.argv[1]));s.listen(1)",
    };
    for (const [name, replacement] of Object.entries(faults)) {
      let actual = false, alias: string | undefined, launched = false;
      Object.defineProperty(Bun, "spawn", { ...spawnDescriptor, value: (...args: any[]) => {
        const first = args[0], argv = Array.isArray(first) ? first : first.cmd, options = Array.isArray(first) ? args[1] : first;
        if (options?.env?.BRAIN_WORKER_LAUNCH) launched = true;
        if (typeof argv?.[4] === "string" && argv[4].includes(prefix)) {
          actual = true;
          const next = [...argv]; next[4] = next[4].replace(prefix, replacement);
          if (name === "directory_alias") alias = join(String(argv[5]), "..") + ".bound";
          return Reflect.apply(spawn, Bun, [Array.isArray(first) ? next : { ...first, cmd: next }, ...args.slice(1)]);
        }
        return Reflect.apply(spawn, Bun, args);
      } });
      try {
        const refused = probeWorkerHost(brain, { stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
        expect(actual, `ACTUAL_PROBE_FAULT_EXECUTED_${name}`).toBe(true);
        expect(refused, `ACTUAL_PROBE_IPC_REJECTED_${name}`).toEqual({ ok: false, requirement: "worker_identity_relay_probe_invalid" });
        expect(launched, `ACTUAL_PROBE_REFUSES_BEFORE_PAYLOAD_${name}`).toBe(false);
      } finally { Object.defineProperty(Bun, "spawn", spawnDescriptor); if (alias) rmSync(alias, { recursive: true, force: true }); }
    }
    console.log(JSON.stringify({ actualPrivateRelayFaults: Object.keys(faults) }));
    await import("../restricted-relay-qualification.native.js");
  }
  if (privateGitInputs && (!sharedPhase || sharedPhase === "private")) await import("../private-git-inputs.native.js");
  if (!sharedPhase || sharedPhase === "fresh") await import("./ordinary-identity-ws.js" + (sharedGit ? "?shared-git=1" : ""));
  if (!sharedPhase || sharedPhase === "warm") await import("./ordinary-identity-ws.js" + (sharedGit ? "?profile=governed&warm=1&shared-git=1" : "?profile=governed&warm=1"));
  if (!sharedPhase || sharedPhase === "strict") await import("./ordinary-identity-ws.js" + (sharedGit ? "?profile=strict&shared-git=1" : "?profile=strict"));
} else {
  expect(process.getuid!()).toBe(0);
  mkdirSync("/identity-fixture", { recursive: true }); chownSync("/identity-fixture", 21001, 21001); chmodSync("/identity-fixture", 0o2775);
  for (const path of ["notes", ".brain/scratch", "node_modules/.bin"]) mkdirSync(join(brain, path), { recursive: true });
  writeFileSync(join(brain, "brain.config.ts"), 'export default {profile:{name:"Odysseus",cliTitle:"Odysseus notebook"}};\n');
  writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/\n");
  writeFileSync(join(brain, "notes/voyage.md"), "---\ntype: note\ntitle: Return to Ithaca\nupdated: 2026-07-12\n---\nOdysseus prepares the voyage.\n");
  const cli = join(brain, "node_modules/.bin/brain");
  writeFileSync(cli, '#!/usr/local/bin/bun\nawait import("/repo/packages/core/src/cli/brain.ts");\n'); chmodSync(cli, 0o755);
  for (const owned of [brain, join(brain, "notes"), join(brain, ".brain"), join(brain, ".brain/scratch"),
    join(brain, "node_modules"), join(brain, "node_modules/.bin"), join(brain, "brain.config.ts"),
    join(brain, ".gitignore"), join(brain, "notes/voyage.md"), cli]) chownSync(owned, 21001, 21001);
  const git = ["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--clear-groups", "/usr/bin/env", "HOME=/identity-server-private",
    ...(sharedGit ? ["/bin/sh", "-c", 'umask 0002; exec "$@"', "shared-git-command"] : []), "/usr/bin/git"];
  if (sharedGit) {
    expect(existsSync(join(brain, ".git")), "SHARED_GIT_CREATED_FRESH_WITHOUT_PRIVATE_METADATA_REWRITE").toBe(false);
    // Hosting owns this creation envelope; setgid precedes Git creation.
    chmodSync(brain, 0o2775);
    command(["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--clear-groups", "/usr/bin/env", "HOME=/identity-server-private", "/bin/sh", "-c",
      'umask 0002; exec /usr/bin/git init --shared=group -q "$1"', "shared-git-init", brain]);
  } else command([...git, "init", "-q", brain]);
  command([...git, "-C", brain, "add", "--", "brain.config.ts", ".gitignore", "notes/voyage.md"]);
  const staged = Bun.spawnSync([...git, "-C", brain, "diff", "--cached", "--quiet"], { stdout: "pipe", stderr: "pipe" });
  expect([0, 1], staged.stderr.toString()).toContain(staged.exitCode);
  if (staged.exitCode === 1) command([...git, "-C", brain, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Prepare the Ithaca voyage"]);
  chmodSync(brain, 0o2775); chmodSync(join(brain, "notes"), 0o2775); chmodSync(join(brain, ".brain"), 0o2775); chmodSync(join(brain, ".brain/scratch"), 0o2775);
  if (privateGitInputs) command([...git, "-C", brain, "config", "core.hooksPath", "private-hooks"]);
  if (sharedGit) {
    const nodes = [".git", ".git/objects", ".git/refs", ".git/config", ".git/HEAD", ".git/index", ".git/COMMIT_EDITMSG"].map(path => {
      const info = lstatSync(join(brain, path));
      expect(info.uid, "INITIAL_SHARED_GIT_SERVER_OWNER").toBe(21001);
      expect(info.gid, "INITIAL_SHARED_GIT_COMMON_GROUP").toBe(21001);
      expect(info.mode & 0o020, "INITIAL_SHARED_GIT_GROUP_WRITABLE").toBe(0o020);
      expect(info.mode & 0o002, "INITIAL_SHARED_GIT_NOT_WORLD_WRITABLE").toBe(0);
      if (info.isDirectory()) expect(info.mode & 0o2000, "INITIAL_SHARED_GIT_SETGID").toBe(0o2000);
      return { path, uid: info.uid, gid: info.gid, mode: (info.mode & 0o7777).toString(8) };
    });
    expect(command([...git, "-C", brain, "config", "core.sharedRepository"]).trim()).toBe("1");
    console.log(JSON.stringify({ initialDocumentedSharedGit: { serverUid: 21001, workerUid: 21002, sharedGid: 21001, nodes } }));
    // Deliberately present host-only Git credentials and a failing global hook.
    // The real credential-free consumer must neither read nor select them.
    mkdirSync("/identity-server-private/global-git-hooks", { mode: 0o700 });
    for (const [path, bytes, mode] of [
      [".gitconfig", "[credential]\n helper = !printf odysseus-host-only\n[core]\n hooksPath = /identity-server-private/global-git-hooks\n", 0o600],
      [".git-credentials", "Odysseus fictional Git credential\n", 0o600],
      ["global-git-hooks/pre-commit", "#!/bin/sh\nexit 97\n", 0o700],
    ] as const) {
      const target = join("/identity-server-private", path);
      writeFileSync(target, bytes, { mode }); chownSync(target, 21001, 21001);
    }
    chownSync("/identity-server-private/global-git-hooks", 21001, 21001);
  }
  const show = command(["btrfs", "subvolume", "show", brain]);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show)![1]!.replaceAll("-", "");
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(command(["btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]))![1]!;
  mkdirSync("/native-runtime", { mode: 0o755, recursive: true });
  const staging = hostOutputStagingLimits({});
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath: "/native-runtime/server-ws-manager.sock",
    appUid: 21001, appGid: 21001, workerUid: 21002, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  const restrictedRelays: Array<ReturnType<typeof Bun.serve>> = [];
  for (const [name, directoryUid, directoryGid, socketUid, socketGid] of [
    ["directory-owner", 0, 21001, 21001, 21001], ["directory-group", 21001, 21003, 21001, 21001],
    ["socket-owner", 21001, 21001, 0, 21001], ["socket-group", 21001, 21001, 21001, 21003],
  ] as const) {
    const directory = `/identity-fixture/restricted-${name}`;
    mkdirSync(directory, { mode: 0o750 });
    restrictedRelays.push(Bun.serve({ unix: join(directory, "relay.sock"), fetch: () => new Response("unexpected") }));
    chownSync(directory, directoryUid, directoryGid); chmodSync(directory, 0o750);
    chownSync(join(directory, "relay.sock"), socketUid, socketGid); chmodSync(join(directory, "relay.sock"), 0o660);
  }
  let foreignRequests = 0;
  const foreign = Bun.serve({ unix: "/identity-fixture/foreign-relay.sock", fetch() { foreignRequests++; return new Response("ithaca"); } });
  chownSync("/identity-fixture/foreign-relay.sock", 0, 21001); chmodSync("/identity-fixture/foreign-relay.sock", 0o660);
  try {
    const phases = sharedGit && process.argv[2] !== "--index-controls" ? [...(privateGitInputs ? ["private"] : []), "fresh", "warm", "strict"] : [undefined];
    let aggregateOutput = "", aggregateErrors = "";
    for (const phase of phases) {
      const started = performance.now();
      const child = Bun.spawn(["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--groups=21003", process.execPath, "--preload", "/repo/scripts/test-network-child-preload.ts", import.meta.filename,
        process.argv[2] === "--index-controls" ? "--index-child" : "--child", ...(sharedGit ? ["--shared-git"] : []), ...(privateGitInputs ? ["--private-git-inputs"] : []), ...(phase ? [`--shared-phase=${phase}`] : [])], {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/identity-server-private", BRAIN_UI_WORKER_IDENTITY_HELPER: "/usr/local/bin/identity-helper" }, stdout: "pipe", stderr: "pipe", timeout: 90000 });
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      aggregateOutput += output; aggregateErrors += errors;
      writeFileSync("/proof/server.stdout", aggregateOutput); writeFileSync("/proof/server.stderr", aggregateErrors);
      writeFileSync("/proof/ordinary-server.stdout", aggregateOutput); writeFileSync("/proof/ordinary-server.stderr", aggregateErrors);
      if (sharedGit) {
        writeFileSync("/proof/shared-git-server.stdout", aggregateOutput); writeFileSync("/proof/shared-git-server.stderr", aggregateErrors);
        if (phase) { writeFileSync(`/proof/shared-git-${phase}-server.stdout`, output); writeFileSync(`/proof/shared-git-${phase}-server.stderr`, errors); }
        console.log(JSON.stringify({ sharedGitPhase: phase, code, ms: performance.now() - started }));
      }
      console.log(JSON.stringify({ foreignProbeRequests: foreignRequests }));
      expect(code, errors).toBe(0); expect(foreignRequests, "FOREIGN_PROBE_LISTENER_NEVER_CONTACTED").toBe(0); console.log(output);
    }
  } finally {
    foreign.stop(true); for (const relay of restrictedRelays) relay.stop(true); await service.close();
    const deadline = Date.now() + 5000;
    for (;;) {
      const records = readdirSync("/run/brain-identity-fixture");
      const sources = existsSync("/run/brain-identity-mounts") ? readdirSync("/run/brain-identity-mounts") : [];
      const workers = readdirSync("/proc").filter(name => /^[0-9]+$/.test(name)).filter(name => {
        try { const status = readFileSync(`/proc/${name}/status`, "utf8"); return /^Uid:\s+21002\s/m.test(status) && !/^State:\s+Z/m.test(status); } catch { return false; }
      });
      if (!records.length && !sources.length && !workers.length) { console.log(JSON.stringify({ ordinaryIdentityCleanup: "pass", records: 0, sources: 0, workers: 0 })); break; }
      if (Date.now() > deadline) throw Error("ORDINARY_IDENTITY_OWNED_RESOURCES_REMAIN");
      await Bun.sleep(20);
    }
  }
}
