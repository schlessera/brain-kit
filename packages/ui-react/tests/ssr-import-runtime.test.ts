import { expect, test } from "bun:test";

// A package import must finish naturally in a server process. An import-only
// check misses a browser channel that keeps Bun alive after evaluation.
test("a server import finishes naturally without a browser inventory channel", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'await import("@schlessera/brain-ui-react"); console.log("UI import complete")'], {
    cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(out, "the public package actually loaded").toContain("UI import complete");
    expect(err).toBe("");
    expect(code, "a server import exits naturally instead of holding an inventory channel").toBe(0);
  } finally { clearTimeout(deadline); }
}, 10000);
