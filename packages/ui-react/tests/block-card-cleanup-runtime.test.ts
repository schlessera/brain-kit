import { expect, test } from "bun:test";
import { join } from "node:path";

test("BlockCard async work settles before its native render fixture removes the DOM", async () => {
  const child = Bun.spawn([
    process.execPath, "test", "--timeout", "30000",
    join(import.meta.dir, "render/block-card.test.tsx"),
    "--test-name-pattern", "(track|map): the contract accepts the payload",
    "--rerun-each", "20",
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const output = stdout + stderr;
  expect(output.match(/\(pass\) BlockCard > (?:track|map): the contract accepts the payload/g)).toHaveLength(40);
  // Nonempty behavior cases precede the intended lifecycle assertions; a
  // load failure or unrelated exit cannot substitute for the mutation.
  expect(output).not.toContain("An update to TrackBlockCard inside a test was not wrapped in act");
  expect(output).not.toContain("An update to MapBlockCard inside a test was not wrapped in act");
  expect(output).not.toContain("window is not defined");
  expect(code, output).toBe(0);
});
