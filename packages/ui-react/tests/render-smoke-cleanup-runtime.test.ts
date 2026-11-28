import { expect, test } from "bun:test";
import { join } from "node:path";

test("RunDetail work is flushed before its native render fixture unregisters the DOM", async () => {
  // A fresh guarded process exposes the actual end-of-file DOM teardown;
  // another render file's globals cannot mask leaked scheduler work here.
  // Named execution counts require verbose child reporting in agent sessions.
  const child = Bun.spawn([
    process.execPath, "test", "--timeout", "30000",
    join(import.meta.dir, "render/smoke-approvals.test.tsx"),
    "--test-name-pattern", "live approval and terminal frames",
    "--rerun-each", "20",
  ], { env: { ...process.env, AGENT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

test("the smoke harness teardown unmounts a RunDetail that is still loading before it unregisters the DOM", async () => {
  // The harness unmounts each test's renders after that test, so the case
  // above leaves its file teardown nothing to drain. This fixture mounts a
  // RunDetail after its last test and answers its detail read only once the
  // teardown has started: a teardown that unregisters the DOM first lets that
  // answer update a view whose window is gone.
  const child = Bun.spawn([
    process.execPath, "test", "--timeout", "30000",
    join(import.meta.dir, "fixtures/run-detail-teardown.fixture.tsx"),
    "--rerun-each", "20",
  ], { env: { ...process.env, AGENT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const output = stdout + stderr;
  // The lifecycle signal first: a later evaluation's failure on the view left
  // behind cannot stand in for it.
  expect(output).not.toContain("An update to RunDetail inside a test was not wrapped in act");
  expect(output).not.toContain("window is not defined");
  expect(output.match(/\(pass\) .* teardown fixture mounts RunDetail only after its last test/g)).toHaveLength(20);
  expect(code, output).toBe(0);
});
