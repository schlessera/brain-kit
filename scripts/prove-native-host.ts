/** Required offline Btrfs/Unix-manager hosted proof; missing prerequisites fail. */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
    if (selected.some(value => !["--backend=claude", "--backend=pi", "--app-uid=0", "--app-uid=1000", "--retain-index-namespace"].includes(value)) || new Set(selected.map(value => value.split("=")[0])).size !== selected.length)
      throw Error("Usage: prove-native-host.ts [--backend=claude|--backend=pi] [--app-uid=0|--app-uid=1000] [--retain-index-namespace]");
    const backends = selected.find(value => value.startsWith("--backend="))?.slice(10);
    const appUid = selected.find(value => value.startsWith("--app-uid="))?.slice(10);
    const retainIndexNamespace = selected.includes("--retain-index-namespace");
    if (retainIndexNamespace && (backends !== "pi" || appUid !== "0"))
      throw Error("--retain-index-namespace requires explicit --backend=pi --app-uid=0; it intentionally reproduces a failed automatic index");
    const image = Bun.spawnSync(["docker", "image", "inspect", NATIVE_PROOF_IMAGE], { stdout: "ignore", stderr: "pipe" });
    if (image.exitCode !== 0) throw Error("Native proof image is absent; prepare scripts/native-proof/Dockerfile before entering offline runtime.");
    const security = Bun.spawnSync(["docker", "info", "--format", "{{json .SecurityOptions}}"], { stdout: "pipe", stderr: "pipe" });
    if (security.exitCode !== 0) throw Error("Cannot inspect Docker runtime security prerequisites.");
    const apparmor = (JSON.parse(new TextDecoder().decode(security.stdout)) as string[]).some(value => value.startsWith("name=apparmor"));
    // One owned loop at a time: the first backend must prove cleanup before the next.
    for (const uid of appUid ? [appUid] : ["1000", "0"]) for (const backend of backends ? [backends] : ["claude", "pi"]) {
      const artifact = mkdtempSync(join(output, `run-${backend}-uid${uid}-`));
      // The operator may differ from either fixed app UID; cap0 children need traversal.
      chmodSync(artifact, 0o755);
      writeFileSync(join(artifact, "native-environment.json"), JSON.stringify({ backend, appUid: Number(uid), apparmor, profile: apparmor ? "brain-kit-native-proof" : null }));
      if (!apparmor) console.log("AppArmor unavailable: this runtime provides no enforced AppArmor qualification.");
      const lease = join(root, "tmp", "workspace-operation"); mkdirSync(lease, { recursive: true, mode: 0o700 });
      const args = ["docker", "run", "--rm", "--pull=never", "--network=none",
        ...(retainIndexNamespace ? ["--env=BRAIN_NATIVE_PROOF_RETAIN_INDEX_NAMESPACE=1"] : []),
        "--cap-drop=ALL", ...(uid === "0" ? ["--cap-add=SETFCAP"] : []), ...["SYS_ADMIN", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID"].map(value => `--cap-add=${value}`),
        "--security-opt=no-new-privileges", `--security-opt=seccomp=${join(root, "scripts/native-proof/seccomp.json")}`,
        ...(apparmor ? ["--security-opt=apparmor=brain-kit-native-proof"] : []),
        "--security-opt=systempaths=unconfined", "--device=/dev/loop-control", "--device-cgroup-rule=b 7:1790 rwm",
        "--mount", `type=bind,source=${artifact},target=/proof`,
        "--mount", `type=bind,source=${realpathSync(process.execPath)},target=/usr/local/bin/bun,readonly`,
        "--mount", `type=bind,source=${root},target=/repo,readonly`,
        "--mount", `type=bind,source=${lease},target=/repo/tmp/workspace-operation`,
        "--workdir=/repo", NATIVE_PROOF_IMAGE, "/repo/scripts/native-proof/fixture.py", backend, uid];
      console.log(`Native ${backend} uid ${uid} hosted proof artifacts: ${artifact}`);
      const runnerQuota = readFileSync("/proc/sys/user/max_user_namespaces", "utf8");
      const child = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      const signals = ["SIGINT", "SIGTERM"] as const;
      const forward = (signal: NodeJS.Signals) => child.kill(signal);
      for (const signal of signals) process.on(signal, forward);
      let code: number, runnerQuotaChanged = false;
      try { code = await child.exited; }
      finally {
        for (const signal of signals) process.off(signal, forward);
        const after = readFileSync("/proc/sys/user/max_user_namespaces", "utf8");
        writeFileSync(join(artifact, "runner-quota.json"), JSON.stringify({ before: runnerQuota, after, unchanged: runnerQuota === after }));
        runnerQuotaChanged = runnerQuota !== after;
      }
      if (runnerQuotaChanged) throw Error("NATIVE_RUNNER_USERNS_QUOTA_UNCHANGED");
      if (code !== 0) throw Error(`Native hosted proof failed (${code}); inspect ${artifact}. No skipped or absent runtime is passing proof.`);
      const receipt = await Bun.file(join(artifact, "native-fixture.json")).json() as { kind: string; mounted?: boolean; attached?: boolean; loopCreated?: boolean; backingExists?: boolean; errors?: string[] }[];
      const cleanup = receipt.at(-1);
      if (cleanup?.kind !== "cleanup" || cleanup.mounted !== false || cleanup.attached !== false || cleanup.loopCreated !== false || cleanup.backingExists !== false || cleanup.errors?.length !== 0)
        throw Error("Native hosted proof did not provide complete owned-resource cleanup evidence.");
    }
  } catch (error) { console.error(error); process.exit(1); }
}
