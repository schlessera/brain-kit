/** bun experiments/2052-title-provenance/run.ts --out /tmp/title-provenance.json */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function captureTitleProvenance(disableNonessentialTraffic = false) {
  const root = resolve(import.meta.dir, "../..");
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-title-provenance-"));
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
    "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "probe.ts"), scratch, ...(disableNonessentialTraffic ? ["--disable-nonessential-traffic"] : [])], {
    cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir(), HOME: join(scratch, "home") }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Offline title probe exited ${code}: ${err || out}`);
    return JSON.parse(readFileSync(join(scratch, "report.json"), "utf8"));
  } finally { clearTimeout(timer); child.kill(); rmSync(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error("Pass --out <report.json>");
  const report = await captureTitleProvenance(process.argv.includes("--disable-nonessential-traffic"));
  writeFileSync(process.argv[outIndex + 1]!, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ sdk: report.sdkVersion, cli: report.cliVersion, requests: report.requests.length, turns: report.turns.length,
    transcriptTypes: report.transcriptTypes, helpers: report.turns.map((turn: any) => turn.titleUsage) }));
}
