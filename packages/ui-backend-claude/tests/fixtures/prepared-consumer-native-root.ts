import { expect } from "bun:test";
import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveNativeBrainManager } from "../../../ui-sdk/src/server/native-brain-manager.js";
import { hostOutputStagingLimits } from "../../../ui-sdk/src/server/worker-state-limits.js";
const brain = "/brain-fixture/brain";
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
  console.log(JSON.stringify({ actualHelperProbes: { governed, strict, ordinary, restricted } }));
  expect(governed.ok, "ACTUAL_MANAGED_GOVERNED_IDENTITY_PROBE").toBe(true);
  expect(ordinary.ok, "ACTUAL_MANAGED_ORDINARY_IDENTITY_RELAY_REACHABLE").toBe(true);
  process.argv.push("--managed");
  await import("./server-host-relay-probe.js");
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
  const git = ["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--clear-groups", "/usr/bin/env", "HOME=/identity-server-private", "/usr/bin/git"];
  command([...git, "init", "-q", brain]);
  command([...git, "-C", brain, "add", "--", "brain.config.ts", ".gitignore", "notes/voyage.md"]);
  const staged = Bun.spawnSync([...git, "-C", brain, "diff", "--cached", "--quiet"], { stdout: "pipe", stderr: "pipe" });
  expect([0, 1], staged.stderr.toString()).toContain(staged.exitCode);
  if (staged.exitCode === 1) command([...git, "-C", brain, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Prepare the Ithaca voyage"]);
  chmodSync(brain, 0o2775); chmodSync(join(brain, "notes"), 0o2775); chmodSync(join(brain, ".brain"), 0o2775); chmodSync(join(brain, ".brain/scratch"), 0o2775);
  const show = command(["btrfs", "subvolume", "show", brain]);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show)![1]!.replaceAll("-", "");
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(command(["btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]))![1]!;
  mkdirSync("/native-runtime", { mode: 0o755, recursive: true });
  const staging = hostOutputStagingLimits({});
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath: process.argv.includes("--cleanup-failure") ? "/native-runtime/prepared-consumer-cleanup-manager.sock" : "/native-runtime/prepared-consumer-manager.sock",
    appUid: 21001, appGid: 21001, workerUid: 21002, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  try {
    await (await import("./native-checkpoint-route-probe.js")).qualifyNativeCheckpointRoutes(brain, service.socketPath);
    if (process.argv.includes("--guards-only")) process.exitCode = 0;
    else {
    const child = Bun.spawn(["/usr/bin/setpriv", "--reuid=21001", "--regid=21001", "--clear-groups", process.execPath, "--preload", "/repo/scripts/test-network-child-preload.ts", import.meta.filename, "--child", ...(process.argv.includes("--cleanup-failure") ? ["cleanup-failure"] : [])], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/identity-server-private", BRAIN_UI_WORKER_IDENTITY_HELPER: "/usr/local/bin/identity-helper" }, stdout: "pipe", stderr: "pipe", timeout: 90000 });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    writeFileSync("/proof/server.stdout", output); writeFileSync("/proof/server.stderr", errors);
    expect(code, errors).toBe(0);
    const proof = JSON.parse(output.trim().split("\n").at(-1)!);
    const expectedRequests = [
      { credential: 0, model: "claude-haiku-4-5", history: 1 }, { credential: 1, model: "claude-sonnet-4-6", history: 3 },
      { credential: 2, model: "claude-haiku-4-5", history: 5 },
    ];
    const count = process.argv.includes("--cleanup-failure") ? 2 : 3;
    expect(proof.requests, "ACTUAL_NATIVE_PREPARED_CONSUMER_CREDENTIAL_MODEL_HISTORY").toEqual(expectedRequests.slice(0, count));
    expect(proof.refreshes, "ACTUAL_NATIVE_PREPARED_CONSUMER_ONE_REFRESH").toBe(count === 3 ? 1 : 0);
    expect(proof.cleanupFailures.length, "ACTUAL_NATIVE_RELEASE_FAILURE_RETAINED").toBe(count === 3 ? 0 : 1);
    expect(proof.results.length).toBe(count);
    expect(proof.results.every((result: any) => result.outcome === "success" && result.sessionId === proof.sessionId), "ACTUAL_NATIVE_PREPARED_CONSUMER_SUCCESS").toBe(true);
    expect(proof.observations.length, "ACTUAL_NATIVE_PREPARED_CONSUMER_OBSERVATIONS").toBe(count);
    console.log(output);
    }
  } finally { await service.close(); }
}
