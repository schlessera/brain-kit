/** Required offline reference-pool proof on owned Btrfs loop volumes (#2428); missing prerequisites fail. */
import { chmodSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NATIVE_PROOF_IMAGE } from "./prove-native-host.js";

export function referencePoolDockerArgs(root: string, artifact: string, apparmor: boolean, bun: string): string[] {
  return ["docker", "run", "--rm", "--pull=never", "--network=none", "--cap-drop=ALL",
    // SETUID/SETGID/SETFCAP (root maps uid 0) and unconfined system paths let the real transport workers (#2429) map their
    // user namespace and mount their own /proc, as in the native host proof.
    ...["SYS_ADMIN", "MKNOD", "DAC_OVERRIDE", "FOWNER", "CHOWN", "KILL", "SETUID", "SETGID", "SETFCAP"].map(value => `--cap-add=${value}`),
    "--security-opt=no-new-privileges", `--security-opt=seccomp=${join(root, "scripts/native-proof/seccomp.json")}`,
    ...(apparmor ? ["--security-opt=apparmor=brain-kit-native-proof"] : []), "--security-opt=systempaths=unconfined",
    "--device=/dev/loop-control", "--device-cgroup-rule=b 7:2428 rwm", "--device-cgroup-rule=b 7:2429 rwm",
    "--mount", `type=bind,source=${dirname(artifact)},target=/proof-runs`,
    "--mount", `type=bind,source=${bun},target=/usr/local/bin/bun,readonly`,
    "--mount", `type=bind,source=${root},target=/repo,readonly`,
    "--workdir=/repo", "--entrypoint=/bin/sh", NATIVE_PROOF_IMAGE, "/repo/scripts/native-proof/stable-run.sh", basename(artifact), "host",
    "python3", "/repo/scripts/native-proof/reference-pool-fixture.py"];
}

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Reference pool proof requires its qualified Linux x86_64 runtime.");
    if (process.argv.length !== 2) throw Error("Usage: prove-reference-pool.ts");
    if (!Bun.which("docker")) throw Error("Reference pool proof requires Docker; run scripts/ci-runtime-setup.sh --native before offline proof.");
    const image = Bun.spawnSync(["docker", "image", "inspect", NATIVE_PROOF_IMAGE], { stdout: "ignore", stderr: "pipe" });
    if (image.exitCode !== 0) throw Error("Native proof image is absent; prepare scripts/native-proof/Dockerfile before entering offline runtime.");
    const security = Bun.spawnSync(["docker", "info", "--format", "{{json .SecurityOptions}}"], { stdout: "pipe", stderr: "pipe" });
    if (security.exitCode !== 0) throw Error("Cannot inspect Docker runtime security prerequisites.");
    const apparmor = (JSON.parse(new TextDecoder().decode(security.stdout)) as string[]).some(value => value.startsWith("name=apparmor"));
    const root = resolve(import.meta.dir, ".."), output = join(root, "tmp", "reference-pool-proof");
    mkdirSync(output, { recursive: true });
    const artifact = mkdtempSync(join(output, "run-pool-")); chmodSync(artifact, 0o755);
    console.log(`Reference pool proof artifacts: ${artifact}`);
    const child = Bun.spawn(referencePoolDockerArgs(root, artifact, apparmor, realpathSync(process.execPath)), { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, forward);
    const code = await child.exited;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, forward);
    if (code !== 0) throw Error(`Reference pool proof failed with exit ${code}; inspect ${artifact}.`);
    console.log("Reference pool proof passed.");
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exitCode = 1; }
}
