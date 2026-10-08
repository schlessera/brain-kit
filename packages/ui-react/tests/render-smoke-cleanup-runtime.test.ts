import { expect, test } from "bun:test";
import { join } from "node:path";

test("RunDetail work is flushed before its native render fixture unregisters the DOM", async () => {
  // A fresh guarded process exposes the actual end-of-file DOM teardown;
  // another render file's globals cannot mask leaked scheduler work here.
  const child = Bun.spawn([
    process.execPath, "test", "--timeout", "30000",
    join(import.meta.dir, "render/render-smoke.test.tsx"),
    "--test-name-pattern", "live approval and terminal frames",
    "--rerun-each", "20",
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const output = stdout + stderr;
  expect(output.match(/\(pass\) live approval and terminal frames/g)).toHaveLength(20);
  // Check the lifecycle signal first: an unrelated child exit cannot stand
  // in for the intended guard's mutation failure.
  expect(output).not.toContain("An update to RunDetail inside a test was not wrapped in act");
  expect(output).not.toContain("window is not defined");
  expect(code, output).toBe(0);
});
