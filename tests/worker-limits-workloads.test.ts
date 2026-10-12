/**
 * The four first-party workloads pass under the default worker limits, and
 * this records how much of them each one used (#1660): a Claude Code turn and
 * a pi turn with a shell tool, a `brain index` of the fixture corpus and a
 * Chromium render through `brain render`. The fixture runs behind an offline
 * network namespace: its workers keep the host network of the ordinary
 * envelope, and the only server they can reach is the loopback inference
 * fixture. Peaks land in tmp/worker-limit-workloads.json.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundledClaudeBinary } from "../packages/ui-server/tests/helpers/claude-binary";

const ROOT = join(import.meta.dir, "..");
const chromium = process.env.PUPPETEER_EXECUTABLE_PATH ?? [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
if (!chromium && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("The worker-limit workloads require real Chrome");
if (!chromium) console.warn("worker-limit workloads: no Chrome installed, so the Chromium render is not measured");

let run: { limits: unknown; inferenceCalls: number; results: Record<string, any> } | undefined;
async function workloads() {
  if (run) return run;
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-limit-workloads-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/worker-limits-workloads.ts"),
      root, bundledClaudeBinary(), ...(chromium ? [chromium] : [])],
    { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    run = JSON.parse(out.trim().split("\n").at(-1)!);
    return run!;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

afterAll(() => {
  if (!run) return;
  writeFileSync(join(ROOT, "tmp/worker-limit-workloads.json"), JSON.stringify(run, null, 2));
  console.log("worker-limit workloads", JSON.stringify(Object.fromEntries(Object.entries(run.results)
    .map(([name, r]) => [name, { exit: r.exit, peakRss: r.peakRss, seconds: r.seconds, limitHits: r.limitHits }]))));
});

describe("first-party workloads under the default worker limits", () => {
  const passes = (r: any) => {
    expect(r.code).toBe(0);
    expect(r.exit as number, String(r.stderr)).toBe(0);
    expect(r.peakRssBytes).toBeGreaterThan(0);
    expect(r.limitHits).toEqual([]);
  };

  test("a Claude Code turn with a shell tool", async () => {
    const r = (await workloads()).results["claude-turn"];
    passes(r);
    expect(r.answered as boolean, String(r.stderr)).toBe(true);
  }, 300_000);

  test("a pi turn with a shell tool", async () => {
    const r = (await workloads()).results["pi-turn"];
    passes(r);
    expect(r.answered as boolean, String(r.stderr)).toBe(true);
  }, 300_000);

  test("brain index of the fixture corpus", async () => passes((await workloads()).results["brain-index"]), 300_000);

  test.skipIf(!chromium)("a Chromium render through brain render", async () =>
    passes((await workloads()).results["chromium-render"]), 300_000);

  test("both turns ran their shell tool through the loopback fixture", async () => {
    // One tool call and one answer each: four inference requests.
    expect((await workloads()).inferenceCalls).toBe(4);
  }, 300_000);
});
