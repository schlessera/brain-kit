/** Parent/child calendar agreement at fixed instants (#718/#719). */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const PROVIDER_KEYS = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY"];

for (const { timezone, instant, expected } of [
  { timezone: undefined, instant: "2026-09-30T22:35:00Z", expected: "2026-09-30" },
  { timezone: "UTC", instant: "2026-09-30T22:35:00Z", expected: "2026-09-30" },
  { timezone: "Asia/Tokyo", instant: "2026-09-30T22:35:00Z", expected: "2026-10-01" },
  { timezone: "America/Los_Angeles", instant: "2026-10-01T00:35:00Z", expected: "2026-09-30" },
]) {
  test(`actual sync child shares the test calendar with TZ=${timezone ?? "absent"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-calendar-"));
    try {
      const clock = join(dir, "clock.ts");
      writeFileSync(clock, `
        const NativeDate = Date;
        const instant = NativeDate.parse(${JSON.stringify(instant)});
        globalThis.Date = class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [instant])); }
          static now() { return instant; }
        };
        process.on("exit", () => console.error("FIXTURE_ENV=" + JSON.stringify({
          keys: ${JSON.stringify(PROVIDER_KEYS)}.filter(key => process.env[key] !== undefined),
          guarded: globalThis.fetch.name === "offlineFetch"
        })));
      `);
      // Simulate a non-UTC machine's default without relying on the CI host.
      // The harness's explicit TZ must win; no fetch destination is rewritten.
      const bun = join(dir, "bun");
      writeFileSync(bun, `#!/bin/sh\nif [ -z "\${TZ+x}" ]; then export TZ=Etc/GMT-2; fi\nexec ${shellQuote(process.execPath)} --preload ${shellQuote(clock)} "$@"\n`);
      chmodSync(bun, 0o755);
      const file = join(dir, "calendar.test.ts");
      writeFileSync(file, `
        import { test, expect, setSystemTime } from "bun:test";
        import { readFileSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { localDate } from ${JSON.stringify(join(ROOT, "packages/core/src/lib/sync/run.ts"))};
        import { runCli } from ${JSON.stringify(join(ROOT, "packages/core/tests/cli-harness.ts"))};
        import { brainWithRemote, cleanupFixtures } from ${JSON.stringify(join(ROOT, "packages/core/tests/sync-fixture.ts"))};
        test("the actual CLI writes the parent's fixed calendar date", async () => {
          setSystemTime(new Date(${JSON.stringify(instant)}));
          try {
            const { root } = brainWithRemote();
            const note = "notes/quick-note-eagle.md";
            const path = join(root, note);
            writeFileSync(path, readFileSync(path, "utf8") + "\\nFixed calendar fixture.\\n");
            expect(${JSON.stringify(PROVIDER_KEYS)}.filter(key => process.env[key] === "fixture-bogus-key"))
              .toHaveLength(${PROVIDER_KEYS.length});
            expect(localDate()).toBe(${JSON.stringify(expected)});
            const result = await runCli(root, ["sync", "commit", "--json"], { PATH: ${JSON.stringify(`${dir}:${process.env.PATH!}`)} });
            expect(result.code, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout).bumped).toEqual([note]);
            expect(readFileSync(path, "utf8")).toContain("updated: " + localDate());
            const receipt = JSON.parse(result.stderr.match(/FIXTURE_ENV=(.+)/)[1]);
            expect(receipt.keys).toEqual([]);
            expect(receipt.guarded).toBe(true);
          } finally { setSystemTime(); cleanupFixtures(); }
        });
      `);
      const env: Record<string, string> = { PATH: process.env.PATH! };
      for (const key of PROVIDER_KEYS) env[key] = "fixture-bogus-key";
      if (timezone !== undefined) env.TZ = timezone;
      const proc = Bun.spawn([process.execPath, "run", "test", file], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("production localDate keeps each user's calendar across both sides of UTC midnight", async () => {
  for (const [timezone, instant, expected] of [
    ["UTC", "2026-09-30T22:35:00Z", "2026-09-30"],
    ["Asia/Tokyo", "2026-09-30T22:35:00Z", "2026-10-01"],
    ["America/Los_Angeles", "2026-10-01T00:35:00Z", "2026-09-30"],
  ]) {
    const program = `import {localDate} from ${JSON.stringify(join(ROOT, "packages/core/src/lib/sync/run.ts"))}; console.log(localDate(new Date(${JSON.stringify(instant)})));`;
    const proc = Bun.spawn([process.execPath, "-e", program], { env: { PATH: process.env.PATH!, TZ: timezone! }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe(expected!);
  }
});
