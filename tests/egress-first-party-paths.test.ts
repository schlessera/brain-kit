/**
 * The egress gate's first-party measurement (#1665): each path a governed
 * worker uses runs through the turn proxy from a real private network
 * namespace, and the socket walk finds only the relay and proxy sockets. The
 * whole fixture runs in its own network namespace with a fixture /etc/hosts
 * and /run, so the only reachable servers are its loopback fixtures.
 * Results land in tmp/egress-first-party-paths.json.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ORIGIN_HOST = "ithaca.odysseus.test";
const chromium = process.env.PUPPETEER_EXECUTABLE_PATH ?? [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
if (!chromium && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("The egress measurement requires real Chrome");
if (!chromium) console.warn("egress measurement: no Chrome installed, so the Chromium path is not measured");

type Row = { exit: number; stdout: string; stderr: string; records: Array<{ method: string; host: string; port: number; bytes: number; outcome: string; accounting: string }> };
let measured: { originPort: number; sshPort: number; calls: string[]; hostConnections: number; results: Record<string, Row> } | undefined;
async function measure() {
  if (measured) return measured;
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/egress-first-party-"));
  try {
    const hosts = join(root, "hosts");
    writeFileSync(hosts, `127.0.0.1 localhost\n127.0.0.1 ${ORIGIN_HOST}\n::1 localhost\n`);
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/run", "--ro-bind", hosts, "/etc/hosts", process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/egress-first-party-paths.ts"),
      join(root, "fixture"), ...(chromium ? [chromium] : [])],
    { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    measured = JSON.parse(out.trim().split("\n").at(-1)!);
    return measured!;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

afterAll(() => {
  if (!measured) return;
  writeFileSync(join(ROOT, "tmp/egress-first-party-paths.json"), JSON.stringify(measured, null, 2));
});

/** A path passed when its worker succeeded and the proxy saw its opaque CONNECT. */
function throughProxy(row: Row | undefined, port: number) {
  expect(row, "EGRESS_PATH_MEASURED").toBeDefined();
  expect(row!.exit, row!.stderr).toBe(0);
  const connects = row!.records.filter(record => record.method === "CONNECT" && record.host === ORIGIN_HOST && record.port === port);
  expect(connects.length, "EGRESS_PATH_RECORDED_CONNECT").toBeGreaterThan(0);
  expect(connects.every(record => record.outcome === "completed" && record.accounting === "opaque_bytes" && record.bytes > 0)).toBe(true);
}

describe("first-party egress paths through the turn proxy", () => {
  test("curl over HTTPS", async () => {
    const run = await measure();
    throughProxy(run.results.curl, run.originPort);
    expect(run.results.curl!.stdout).toContain("Odysseus reaches Ithaca");
  }, 300_000);

  test("git over HTTPS", async () => {
    const run = await measure();
    throughProxy(run.results.gitHttps, run.originPort);
    expect(run.results.gitHttps!.stdout, "EGRESS_GIT_HTTPS_CLONED").toBe("Odysseus charts the return to Ithaca.\n");
    expect(run.calls).toContain("GET /voyage.git/info/refs");
  }, 300_000);

  test("git over SSH through the CONNECT helper", async () => {
    const run = await measure();
    throughProxy(run.results.gitSsh, run.sshPort);
    expect(run.results.gitSsh!.stdout, "EGRESS_GIT_SSH_CLONED").toBe("Odysseus charts the return to Ithaca.\n");
  }, 300_000);

  test("the brain CLI's embedding provider", async () => {
    const run = await measure();
    throughProxy(run.results.brainProvider, run.originPort);
    expect(run.calls.some(call => call.endsWith(":batchEmbedContents")), "EGRESS_BRAIN_PROVIDER_REACHED").toBe(true);
  }, 300_000);

  test.skipIf(!chromium)("headless Chromium", async () => {
    const run = await measure();
    throughProxy(run.results.chromium, run.originPort);
    expect(run.results.chromium!.stdout, "EGRESS_CHROMIUM_PAGE").toContain("Odysseus reaches Ithaca");
  }, 300_000);

  test.each(["governed", "strict"])("the %s socket walk finds no host socket below a mask and reaches no host socket", async profile => {
    const run = await measure();
    const row = run.results[`socketWalk_${profile}`]!;
    expect(row.exit, row.stderr).toBe(0);
    const walk = JSON.parse(row.stdout.trim().split("\n").at(-1)!) as {
      run: unknown; home: unknown; masked: string[]; outside: string[]; complete: boolean; reachable: Record<string, unknown> };
    expect(walk.run, "EGRESS_HOST_RUN_SOCKET_UNREACHABLE").not.toBe(true);
    expect(walk.home, "EGRESS_HOST_HOME_SOCKET_UNREACHABLE").not.toBe(true);
    expect(run.hostConnections).toBe(0);
    expect(walk.masked.sort(), "EGRESS_SOCKET_WALK_MASKS_HOLD_ONLY_APPROVED")
      .toEqual(["/run/brain-egress/inference.sock", "/run/brain-egress/proxy.sock"]);
    // A socket outside the masks that accepts a connection is an unrecorded
    // way out. The bounded walk's coverage and visible sockets are reported.
    console.log(`EGRESS_SOCKET_WALK_OUTSIDE_MASKS_${profile}=${JSON.stringify({ complete: walk.complete, reachable: walk.reachable })}`);
    expect(Object.keys(walk.reachable).filter(path => walk.reachable[path] === true), "EGRESS_SOCKET_WALK_NO_REACHABLE_HOST_SOCKET").toEqual([]);
  }, 300_000);
});
