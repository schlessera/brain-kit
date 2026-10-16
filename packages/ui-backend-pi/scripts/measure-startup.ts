/** Keyless, network-denied real Pi worker startup measurement. */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const arg = process.argv[2] ?? "--runs=3";
if (process.argv.length > 3 || !/^--runs=[1-9]\d?$/.test(arg)) throw new Error("Usage: bun packages/ui-backend-pi/scripts/measure-startup.ts [--runs=1..99]");
const runs = Number(arg.slice(7));
const receipts: unknown[] = [];
for (let run = 0; run < runs; run++) {
  const fixture = mkdtempSync(join(tmpdir(), "pi-startup-"));
  try {
    const home = join(fixture, "home"); mkdirSync(home);
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/root", "--bind", home, "/root",
      process.execPath, "--preload", join(root, "scripts/test-network-child-preload.ts"),
      join(root, "packages/ui-backend-pi/tests/fixtures/startup-probe.ts"), fixture], {
      cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: "/root" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Pi startup measurement exited ${code}: ${err || out}`);
    receipts.push(JSON.parse(out.trim().split("\n").at(-1)!));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ runs, receipts }, null, 2));
