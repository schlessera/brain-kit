import { expect } from "bun:test";
import { chmodSync, chownSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveNativeBrainManager } from "../../../ui-sdk/src/server/native-brain-manager.js";
import { hostOutputStagingLimits } from "../../../ui-sdk/src/server/worker-state-limits.js";
const store = "/brain-fixture/ordinary-identity", brain = join(store, "brain");
function command(argv: string[]) {
  const child = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0); return child.stdout.toString();
}
if (process.argv[2] === "--child") {
  expect(process.getuid!()).toBe(21001);
  const { probeWorkerHost } = await import("../../../ui-sdk/src/server/worker-launcher.js");
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
  // #2297 owns the observed restricted-helper refusal; do not lock that bug in.
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
  await import("./ordinary-identity-ws.js");
} else {
  expect(process.getuid!()).toBe(0);
  // The preceding manager proof owns a different brain and leaves its private
  // worker files intact. Bootstrap this case in a fresh store with normal Git
  // ownership checks, then transfer only this case's root to the app identity.
  mkdirSync(store, { mode: 0o755 });
  command(["btrfs", "subvolume", "create", brain]);
  mkdirSync("/identity-fixture", { recursive: true }); chownSync("/identity-fixture", 21001, 21001); chmodSync("/identity-fixture", 0o2775);
  for (const path of ["notes", ".brain/scratch", "node_modules/.bin"]) mkdirSync(join(brain, path), { recursive: true });
  writeFileSync(join(brain, "brain.config.ts"), 'export default {profile:{name:"Odysseus",cliTitle:"Odysseus notebook"}};\n');
  writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/\n");
  writeFileSync(join(brain, "notes/voyage.md"), "---\ntype: note\ntitle: Return to Ithaca\nupdated: 2026-07-12\n---\nOdysseus prepares the voyage.\n");
  const cli = join(brain, "node_modules/.bin/brain");
  writeFileSync(cli, '#!/usr/local/bin/bun\nawait import("/repo/packages/core/src/cli/brain.ts");\n'); chmodSync(cli, 0o755);
  command(["git", "init", "-q", brain]);
  command(["git", "-C", brain, "add", "."]);
  command(["git", "-C", brain, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Prepare the Ithaca voyage"]);
  command(["chown", "-R", "21001:21001", brain]);
  chmodSync(brain, 0o2775); chmodSync(join(brain, "notes"), 0o2775); chmodSync(join(brain, ".brain"), 0o2775); chmodSync(join(brain, ".brain/scratch"), 0o2775);
  const show = command(["btrfs", "subvolume", "show", brain]);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show)![1]!.replaceAll("-", "");
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(command(["btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]))![1]!;
  mkdirSync("/native-runtime", { mode: 0o755, recursive: true });
  const staging = hostOutputStagingLimits({});
  const service = await serveNativeBrainManager({ storePath: store, devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath: "/native-runtime/server-ws-manager.sock",
    appUid: 21001, appGid: 21001, workerUid: 21002, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  let foreignRequests = 0;
  const foreign = Bun.serve({ unix: "/identity-fixture/foreign-relay.sock", fetch() { foreignRequests++; return new Response("ithaca"); } });
  chownSync("/identity-fixture/foreign-relay.sock", 0, 21001); chmodSync("/identity-fixture/foreign-relay.sock", 0o660);
  try {
    const child = Bun.spawn(["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--groups=21003", process.execPath, "--preload", "/repo/scripts/test-network-child-preload.ts", import.meta.filename, "--child"], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/identity-server-private", BRAIN_UI_WORKER_IDENTITY_HELPER: "/usr/local/bin/identity-helper" }, stdout: "pipe", stderr: "pipe", timeout: 90000 });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    writeFileSync("/proof/server.stdout", output); writeFileSync("/proof/server.stderr", errors);
    console.log(JSON.stringify({ foreignProbeRequests: foreignRequests }));
    expect(code, errors).toBe(0); expect(foreignRequests, "FOREIGN_PROBE_LISTENER_NEVER_CONTACTED").toBe(0); console.log(output);
  } finally {
    foreign.stop(true); await service.close();
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
