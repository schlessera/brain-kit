/** The installed CLI runs only inside a kernel-enforced offline namespace. */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("a refused nested worker host reports its first cause before runtime capture", async () => {
  const script = [
    "const { workerHostBoundary } = await import(" + JSON.stringify(join(import.meta.dir, "../packages/ui-sdk/src/server/worker-launcher.ts")) + ");",
    'workerHostBoundary.probe = () => ({ ok: false, requirement: "Odysseus controlled nested namespace refusal" });',
    "await import(" + JSON.stringify(join(import.meta.dir, "fixtures/runtime-placement-probe.ts")) + ");",
  ].join("\n");
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
    "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(errors, "NESTED_WORKER_HOST_FIRST_CAUSE").toContain("OWNED_CLAUDE_NESTED_WORKER_HOST_REQUIRED");
  expect(errors).toContain("Odysseus controlled nested namespace refusal");
  expect(errors).toContain("AppArmor label:");
  expect(output, "no placement receipt on an unsupported host").toBe("");
});

test("same installed Claude runtime under /tmp retains the measured request and private worker", async () => {
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
    join(import.meta.dir, "fixtures/runtime-placement-probe.ts")],
    { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `OWNED_CLAUDE_OFFLINE_RUNTIME_PROOF: ${errors}`).toBe(0);
  const receipt = JSON.parse(output);
  console.log(`OWNED_RUNTIME_RECEIPT ${JSON.stringify(receipt)}`);
  expect(receipt.networkInterfaces).toEqual(["lo"]);
  expect(receipt.placements).toBe(2);
  expect(receipt.measuredRequests).toBe(2);
  expect(receipt.runtimeDigests).toEqual([receipt.installedDigest, receipt.installedDigest]);
  expect(receipt.cliVersions).toEqual([receipt.installedVersion, receipt.installedVersion]);
}, 120_000);
