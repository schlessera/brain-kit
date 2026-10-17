/** The installed CLI runs only inside a kernel-enforced offline namespace. */
import { expect, test } from "bun:test";
import { join } from "node:path";

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
