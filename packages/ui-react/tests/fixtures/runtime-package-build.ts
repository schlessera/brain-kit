/** Checked same-invocation preparation, otherwise the ordinary fresh builder. */
import { invocationBuild, externalSpeechDelegation } from "../../../../scripts/test-invocation";
import { inheritWorkspaceLease } from "../../../../scripts/workspace-lease.mjs";
import { runtimeHookPhases } from "./runtime-hook-phases";
export { externalSpeechDelegation };

export async function runtimePackageBuild(root: string, directories: readonly string[], hook: ReturnType<typeof runtimeHookPhases>,
  consume?: (stream: ReadableStream<Uint8Array>) => Promise<string>): Promise<[string, string, number]> {
  const started = performance.now();
  const receipt = invocationBuild(root, directories);
  const admissionMs = performance.now() - started;
  if (receipt) {
    const detail = { disposition: "attested", invocation: receipt.nonce, parentBuildPid: receipt.build.pid, parentBuildId: receipt.build.id, admissionMs };
    hook.report("package-build", "start", detail);
    hook.report("package-build", "complete", detail);
    return ["", "", 0];
  }
  hook.report("package-build", "admission", { disposition: "built", admissionMs });
  const build = Bun.spawn([process.execPath, "scripts/build.ts", "--for", directories.join(",")],
    inheritWorkspaceLease({ cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const result = await hook.child("package-build", build, consume);
  const resource = build.resourceUsage();
  hook.report("package-build", "cost", { disposition: "built", childPid: build.pid, durationMs: performance.now() - started,
    cpuUserUs: resource ? Number(resource.cpuTime.user) : undefined, cpuSystemUs: resource ? Number(resource.cpuTime.system) : undefined, maxRssBytes: resource ? Number(resource.maxRSS) : undefined });
  if (result[2] !== 0 || build.signalCode) throw new Error(`Runtime package build failed (${result[2]}, ${build.signalCode ?? "no signal"}): ${result[0]}\n${result[1]}`);
  return result;
}
