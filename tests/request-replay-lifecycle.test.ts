/** Real Bun stream ownership with a controlled transport, including failing-first safety. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

for (const scenario of ["direct", "ordinary", "unread", "cleanup-error", "transport-unread-error", "manual", "replay307", "rewrite303", "open307", "rewrite-open303", "transport-error", "redirect-error", "limit", "refusal", "proxy", "malformed", "response-error", "hooks"]) {
  test(`request replay lifecycle: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "request-replay-"));
    try {
      // The dedicated alias lets the probe put its independent no-HTTP sentinel
      // below a fresh guard, as the existing network guard regression probes do.
      const runtime = join(dir, "probe-runtime");
      symlinkSync(process.execPath, runtime);
      const hookFile = join(dir, "probe.test.ts");
      if (scenario === "hooks") writeFileSync(hookFile, `import { test } from "bun:test";
        test("caught refusal", async () => {
          await fetch("https://escape.example.invalid/ithaca").catch(() => {});
          console.log("CAUGHT_REFUSAL_CALLBACK_COMPLETED");
        });`);
      const args = scenario === "hooks" ? ["test", "--preload", join(import.meta.dir, "helpers/network-sentinels.ts"),
        "--preload", join(import.meta.dir, "../scripts/test-network-preload.ts"), hookFile] :
        [join(import.meta.dir, "helpers/request-replay-probe.ts"), scenario];
      const child = spawn(runtime, args, {
        cwd: dir, env: { PATH: process.env.PATH! }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
      let code: number | null;
      try {
        code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      } finally { clearTimeout(watchdog); }
      if (scenario === "hooks") {
        expect(output).toContain("CAUGHT_REFUSAL_CALLBACK_COMPLETED");
        expect(output).toContain("(fail) caught refusal");
        expect(output).toContain("NATIVE_CALLS=[]");
      } else expect(output).toContain("REPLAY_PROBE_OK=" + scenario);
      expect(code, output).toBe(["proxy", "refusal", "hooks"].includes(scenario) ? 1 : 0);
      if (["proxy", "refusal", "hooks"].includes(scenario)) expect(output).toContain("Offline test guard");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
