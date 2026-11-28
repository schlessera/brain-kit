import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diagramNativeDockerArgs } from "../scripts/diagram-export-producer.mjs";
import { nativeHostDockerArgs } from "../scripts/prove-native-host.ts";
import { workerIdentityDockerArgs } from "../scripts/prove-worker-identity.ts";
import { captureRenderArgs } from "../scripts/capture.ts";
import { workspaceLeaseDockerArgs } from "../scripts/workspace-lease-container.ts";

function bindSources(argv: string[]): string[] {
  return argv.flatMap((arg, index) => {
    if (arg === "-v") return [argv[index + 1]!.split(":")[0]!];
    if (arg === "--mount" && argv[index + 1]!.startsWith("type=bind,")) {
      return [argv[index + 1]!.split(",").find(value => value.startsWith("source="))!.slice(7)];
    }
    return [];
  });
}
const repo = "/fixture/repo", bun = "/fixture/bin/bun";

test("native host Docker bind sources remain stable across backend/run identities", () => {
  const argv = ["run-claude-uid0-first", "run-pi-uid1000-second"].map(run =>
    nativeHostDockerArgs(repo, `${repo}/tmp/native-host-proof/${run}`, "1000", "pi", false, false, bun));
  expect(bindSources(argv[0]!), "NATIVE_HOST_BIND_SOURCES_STABLE").toEqual(bindSources(argv[1]!));
});

test("worker identity Docker bind sources remain stable including every diagnostic variant", () => {
  for (const variants of [{ db: false, boot: false, prune: false, inventory: false, scratch: false },
    { db: true, boot: false, prune: false, inventory: false, scratch: false },
    { db: false, boot: true, prune: true, inventory: false, scratch: false },
    { db: false, boot: false, prune: false, inventory: true, scratch: false },
    { db: false, boot: true, prune: false, inventory: false, scratch: true }]) {
    const argv = ["run-first", "run-second"].map(run =>
      workerIdentityDockerArgs(repo, `${repo}/tmp/worker-identity-proof/${run}`, run, "native-image", false, variants, bun));
    expect(bindSources(argv[0]!), "WORKER_IDENTITY_BIND_SOURCES_STABLE").toEqual(bindSources(argv[1]!));
  }
});

test("capture Docker bind sources remain stable across staging and runner identities", () => {
  const argv = ["first", "second"].map(run => captureRenderArgs(repo, "/fixture/fonts", `${repo}/tmp/capture-share/.capture-${run}`, bun, "browser-image", `${repo}/tmp/.capture-runner-${run}`));
  expect(bindSources(argv[0]!), "CAPTURE_BIND_SOURCES_STABLE").toEqual(bindSources(argv[1]!));
});

test("workspace lease Docker bind sources remain stable across fresh fixture identities", () => {
  const argv = ["first", "second"].map(run => workspaceLeaseDockerArgs(`${repo}/tmp/workspace-lease-container/run-${run}`, "browser-image", "1000:1000"));
  expect(bindSources(argv[0]!), "WORKSPACE_LEASE_BIND_SOURCES_STABLE").toEqual(bindSources(argv[1]!));
});

test("native diagram producer copies private inputs without binding fresh host paths", () => {
  const argv = ["first", "second"].map(run => diagramNativeDockerArgs(repo, `/tmp/producer-${run}/source`, { image: "browser-image" },
    { source: `source-${run}`, modules: `modules-${run}`, output: `output-${run}`, runtime: `runtime-${run}` }, `container-${run}`, "fixture program"));
  expect(bindSources(argv[0]!), "NATIVE_DIAGRAM_BIND_SOURCES_STABLE").toEqual(bindSources(argv[1]!));
  expect(bindSources(argv[0]!)).toEqual([]);
  for (const args of argv) {
    expect(args).toContain("--read-only"); expect(args).toContain("--network=none");
    expect(args.filter(value => value.includes(",readonly"))).toHaveLength(3);
  }
});

test("a proof run under the checkout is masked at its second name below /repo (#4301)", () => {
  const repo = "/srv/odysseus/brain-kit", bun = "/opt/bun/bun";
  const argv = nativeHostDockerArgs(repo, `${repo}/tmp/native-host-proof/run-claude-uid1000-ithaca`, "1000", "claude", false, false, bun);
  expect(argv.join(" "), "NATIVE_HOST_REPO_ARTIFACT_MASKED").toContain("--mount type=tmpfs,destination=/repo/tmp/native-host-proof,tmpfs-mode=0555");
  expect(nativeHostDockerArgs(repo, "/var/tmp/run-outside", "1000", "claude", false, false, bun).join(" "), "OUTSIDE_CHECKOUT_NOTHING_TO_MASK").not.toContain("type=tmpfs,destination=/repo");
});

test("an identity run keeps /fixture-variants readable for setup.sh, as a private copy, while its source is detached (#4973 r4 F52)", () => {
  // The script's filesystem commands are recorded, not run: the plan is what is pinned.
  const shims = mkdtempSync(join(tmpdir(), "odysseus-stable-run-"));
  try {
    const log = join(shims, "plan.log");
    for (const command of ["mkdir", "mount", "umount", "touch", "cp"]) {
      writeFileSync(join(shims, command), `#!/bin/sh\necho "${command} $*" >> "${log}"\n`); chmodSync(join(shims, command), 0o755);
    }
    const run = Bun.spawnSync(["/bin/sh", resolve(import.meta.dir, "../scripts/native-proof/stable-run.sh"), "run-ithaca", "identity", "--", "/bin/sh", "-c", `echo "exec setup.sh" >> "${log}"`],
      { env: { PATH: `${shims}:/usr/bin:/bin` } });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const plan = readFileSync(log, "utf8").trim().split("\n");
    const at = (line: string) => plan.indexOf(line);
    expect(at("umount -l /fixture-variants /fixture-runs"), plan.join("\n")).toBeGreaterThan(-1);
    // Copied before the source detaches, then bound back at the same name, read-only.
    expect(at("cp -a /fixture-variants/. /fixture-copy/"), "F52_COPIED_BEFORE_DETACH").toBeLessThan(at("umount -l /fixture-variants /fixture-runs"));
    expect(at("mount -o remount,ro /fixture-copy")).toBeLessThan(at("umount -l /fixture-variants /fixture-runs"));
    expect(at("mount --bind /fixture-copy /fixture-variants"), "F52_FIXTURE_VARIANTS_BACK_FOR_SETUP").toBeGreaterThan(at("umount -l /fixture-variants /fixture-runs"));
    expect(at("mount --bind /fixture-copy /fixture-variants")).toBeLessThan(at("exec setup.sh"));
    // Nothing detaches the copy's name before setup.sh runs.
    expect(plan.slice(at("mount --bind /fixture-copy /fixture-variants")).filter(line => line.startsWith("umount") && line.includes("/fixture-variants")), "F52_NOT_DETACHED_AGAIN").toEqual([]);
  } finally { rmSync(shims, { recursive: true, force: true }); }
});
