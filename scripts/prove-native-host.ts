/** Required offline Btrfs/Unix-manager hosted proof; missing prerequisites fail. */
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export const NATIVE_PROOF_IMAGE = "brain-kit-native-runtime:1";
export const NATIVE_PROOF_NAME = "native managed hosted admission";

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Native hosted proof requires its qualified Linux x86_64 runtime.");
    if (!Bun.which("docker")) throw Error("Native hosted proof requires Docker; run scripts/ci-runtime-setup.sh before offline proof.");
    const root = resolve(import.meta.dir, ".."), output = join(root, "tmp", "native-host-proof");
    mkdirSync(output, { recursive: true });
    const artifact = mkdtempSync(join(output, "run-"));
    const image = Bun.spawnSync(["docker", "image", "inspect", NATIVE_PROOF_IMAGE], { stdout: "ignore", stderr: "pipe" });
    if (image.exitCode !== 0) throw Error("Native proof image is absent; prepare scripts/native-proof/Dockerfile before entering offline runtime.");
    const lease = join(root, "tmp", "workspace-operation"); mkdirSync(lease, { recursive: true, mode: 0o700 });
    const args = ["docker", "run", "--rm", "--pull=never", "--network=none",
      "--cap-drop=ALL", ...["SYS_ADMIN", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID"].map(value => `--cap-add=${value}`),
      "--security-opt=no-new-privileges", `--security-opt=seccomp=${join(root, "scripts/native-proof/seccomp.json")}`,
      "--security-opt=systempaths=unconfined", "--device=/dev/loop-control", "--device-cgroup-rule=b 7:1790 rwm",
      "--mount", `type=bind,source=${artifact},target=/proof`,
      "--mount", `type=bind,source=${realpathSync(process.execPath)},target=/usr/local/bin/bun,readonly`,
      "--mount", `type=bind,source=${root},target=/repo,readonly`,
      "--mount", `type=bind,source=${lease},target=/repo/tmp/workspace-operation`,
      "--workdir=/repo", NATIVE_PROOF_IMAGE, "/repo/scripts/native-proof/fixture.py"];
    console.log(`Native hosted proof artifacts: ${artifact}`);
    const child = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    const code = await child.exited;
    if (code !== 0) throw Error(`Native hosted proof failed (${code}); inspect ${artifact}. No skipped or absent runtime is passing proof.`);
    const receipt = await Bun.file(join(artifact, "native-fixture.json")).json() as { kind: string; mounted?: boolean; attached?: boolean; loopCreated?: boolean; backingExists?: boolean; errors?: string[] }[];
    const cleanup = receipt.at(-1);
    if (cleanup?.kind !== "cleanup" || cleanup.mounted !== false || cleanup.attached !== false || cleanup.loopCreated !== false || cleanup.backingExists !== false || cleanup.errors?.length !== 0)
      throw Error("Native hosted proof did not provide complete owned-resource cleanup evidence.");
  } catch (error) { console.error(error); process.exit(1); }
}
