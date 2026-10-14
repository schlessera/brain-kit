/** Required offline Btrfs/Unix-manager hosted proof; missing prerequisites fail. */
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const NATIVE_PROOF_IMAGE = "brain-kit-native-runtime:1";
export const NATIVE_PROOF_NAME = "native managed hosted admission";

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Native hosted proof requires its qualified Linux x86_64 runtime.");
    if (!Bun.which("docker")) throw Error("Native hosted proof requires Docker; run scripts/ci-runtime-setup.sh before offline proof.");
    const root = resolve(import.meta.dir, ".."), output = join(root, "tmp", "native-host-proof");
    mkdirSync(output, { recursive: true });
    const selected = process.argv.slice(2);
    const backends = selected.length === 0 ? ["claude", "pi"] : selected.length === 1 && ["--backend=claude", "--backend=pi"].includes(selected[0]!) ? [selected[0]!.slice(10)] : (() => { throw Error("Usage: prove-native-host.ts [--backend=claude|--backend=pi]"); })();
    const image = Bun.spawnSync(["docker", "image", "inspect", NATIVE_PROOF_IMAGE], { stdout: "ignore", stderr: "pipe" });
    if (image.exitCode !== 0) throw Error("Native proof image is absent; prepare scripts/native-proof/Dockerfile before entering offline runtime.");
    const security = Bun.spawnSync(["docker", "info", "--format", "{{json .SecurityOptions}}"], { stdout: "pipe", stderr: "pipe" });
    if (security.exitCode !== 0) throw Error("Cannot inspect Docker runtime security prerequisites.");
    const apparmor = (JSON.parse(new TextDecoder().decode(security.stdout)) as string[]).some(value => value.startsWith("name=apparmor"));
    // One owned loop at a time: the first backend must prove cleanup before the next.
    for (const backend of backends) {
      const artifact = mkdtempSync(join(output, `run-${backend}-`));
      writeFileSync(join(artifact, "native-environment.json"), JSON.stringify({ backend, apparmor, profile: apparmor ? "brain-kit-native-proof" : null }));
      if (!apparmor) console.log("AppArmor unavailable: this runtime provides no enforced AppArmor qualification.");
      const lease = join(root, "tmp", "workspace-operation"); mkdirSync(lease, { recursive: true, mode: 0o700 });
      const args = ["docker", "run", "--rm", "--pull=never", "--network=none",
        "--cap-drop=ALL", ...["SYS_ADMIN", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID"].map(value => `--cap-add=${value}`),
        "--security-opt=no-new-privileges", `--security-opt=seccomp=${join(root, "scripts/native-proof/seccomp.json")}`,
        ...(apparmor ? ["--security-opt=apparmor=brain-kit-native-proof"] : []),
        "--security-opt=systempaths=unconfined", "--device=/dev/loop-control", "--device-cgroup-rule=b 7:1790 rwm",
        "--mount", `type=bind,source=${artifact},target=/proof`,
        "--mount", `type=bind,source=${realpathSync(process.execPath)},target=/usr/local/bin/bun,readonly`,
        "--mount", `type=bind,source=${root},target=/repo,readonly`,
        "--mount", `type=bind,source=${lease},target=/repo/tmp/workspace-operation`,
        "--workdir=/repo", NATIVE_PROOF_IMAGE, "/repo/scripts/native-proof/fixture.py", backend];
      console.log(`Native ${backend} hosted proof artifacts: ${artifact}`);
      const child = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      const signals = ["SIGINT", "SIGTERM"] as const;
      const forward = (signal: NodeJS.Signals) => child.kill(signal);
      for (const signal of signals) process.on(signal, forward);
      let code: number;
      try { code = await child.exited; }
      finally { for (const signal of signals) process.off(signal, forward); }
      if (code !== 0) throw Error(`Native hosted proof failed (${code}); inspect ${artifact}. No skipped or absent runtime is passing proof.`);
      const receipt = await Bun.file(join(artifact, "native-fixture.json")).json() as { kind: string; mounted?: boolean; attached?: boolean; loopCreated?: boolean; backingExists?: boolean; errors?: string[] }[];
      const cleanup = receipt.at(-1);
      if (cleanup?.kind !== "cleanup" || cleanup.mounted !== false || cleanup.attached !== false || cleanup.loopCreated !== false || cleanup.backingExists !== false || cleanup.errors?.length !== 0)
        throw Error("Native hosted proof did not provide complete owned-resource cleanup evidence.");
    }
  } catch (error) { console.error(error); process.exit(1); }
}
