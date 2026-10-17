import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const mode of ["subscriber", "queued"]) test(`worker snapshot overflow sends one classified error from ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
  try {
    const messages = [
      { type: "init", backend: { brainPath: root }, env: { caps: {} },
        sessionId: "11111111-1111-4111-8111-111111111111", resume: false, agentFiles: {} },
      { type: "prompt", text: "Return to Ithaca" },
    ];
    const input = join(root, "stdin"), output = join(root, "stdout"), diagnostic = join(root, "stderr");
    writeFileSync(input, messages.map(m => JSON.stringify(m)).join("\n") + "\n");
    // Regular-file stdio also works where the host disallows Bun socket pipes.
    const fds = [openSync(input, "r"), openSync(output, "w"), openSync(diagnostic, "w")];
    let code: number;
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker-snapshot-probe.ts"), root, mode],
        { stdin: fds[0], stdout: fds[1], stderr: fds[2] });
      code = await child.exited;
    } finally { fds.forEach(fd => closeSync(fd)); }
    const stdout = readFileSync(output, "utf8"), stderr = readFileSync(diagnostic, "utf8");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const received = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(received.filter(frame => frame.type === "startup_timing").map(frame => frame.phase))
      // The snapshot fixture substitutes the session runtime, so no resources load.
      .toEqual(["worker_started", "session", "initialize"]);
    const frames = received.filter(frame => frame.type !== "startup_timing");
    expect(frames[0].type).toBe("ready");
    expect(frames.filter(f => ["error", "done", "snapshot"].includes(f.type))).toEqual([
      { type: "error", errorClass: "session_too_large",
        message: "This conversation exceeds the pi worker session size limit. Continue in a new conversation." },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
