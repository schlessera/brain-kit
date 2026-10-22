import { expect, test } from "bun:test";
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
