/**
 * Concurrent Claude worker turns, each with a private, size-limited
 * runtime-state tmpfs (#1625). Every scenario runs actual workers through the
 * real launcher, in a private user and mount namespace whose `/dev/shm` is
 * Docker's default 64 MiB tmpfs: the workers must not use it at all.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MiB = 1024 * 1024;
const TIMEOUT = 60_000;

function spawnProbe(scenario: string, root: string, ...extra: string[]) {
  return Bun.spawn(["unshare", "--user", "--map-root-user", "--mount", "--", "/bin/sh", "-c",
    'mount -t tmpfs -o size=64m tmpfs /dev/shm && exec "$0" "$@"', process.execPath,
    "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(ROOT, "tests/fixtures/worker-state-tmpfs-probe.ts"), scenario, root, ...extra],
    { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
}

async function probe(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "worker-state-tmpfs-"));
  try {
    const child = spawnProbe(scenario, root);
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, err || out).toBe(0);
    const receipt = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(receipt.shmTotal).toBe(64 * MiB);
    expect(receipt.shmUnchanged, "no worker state lands on the shared /dev/shm").toBe(true);
    expect(receipt.shmLeftover).toBe(0);
    expect(receipt.heldAfter, "every reservation is released").toBe(0);
    return receipt;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a budget of one allowance refuses the second parallel turn as worker_state_busy before launch; Retry runs it", async () => {
  const r = await probe("contend");
  expect(r.secondClass).toBe("worker_state_busy");
  expect(r.secondRefused).toContain("1 running conversation holds 64 MiB of the server's 64 MiB budget");
  expect(r.heldDuringFirst).toBe(64 * MiB);
  expect(r.first.exit).toEqual({ code: 0, signal: null });
  expect(r.first.failure).toBeUndefined();
  expect(r.againRefused).toBeNull();
  expect(r.again.exit).toEqual({ code: 0, signal: null });
  expect(r.tails).toEqual(["{\"text\":\"The horse is inside the walls\"}", "{\"text\":\"Home at last\"}"]);
}, TIMEOUT);

test("two parallel 30 MiB conversations each get their own 64 MiB tmpfs, run and persist", async () => {
  const r = await probe("fit");
  expect(r.refused).toEqual([null, null]);
  expect(r.held, "both full allowances are reserved").toBe(128 * MiB);
  for (const result of r.results) {
    expect(result.exit).toEqual({ code: 0, signal: null });
    expect(result.failure).toBeUndefined();
    expect(result.out).toBe(`tmpfs ${(64 * MiB) / 4096}`);
  }
  expect(r.tails).toEqual(["{\"text\":\"Circe\"}", "{\"text\":\"Calypso\"}"]);
}, TIMEOUT);

test("a turn that outgrows its allowance hits its own limit, is named worker_state_exceeded, and the other turn is untouched", async () => {
  const r = await probe("grow");
  expect(r.grower.out).toMatch(/^full-at-\d+$/);
  expect(r.grower.failure?.errorClass).toBe("worker_state_exceeded");
  expect(r.grower.failure?.message).toContain("64 MiB allowance");
  // What it wrote fits the allowance with the settings file, and is kept.
  expect(r.grownSaved).toBeLessThanOrEqual(64 * MiB - 4096);
  expect(r.grownSaved).toBeGreaterThan(60 * MiB);
  expect(r.holder.exit).toEqual({ code: 0, signal: null });
  expect(r.holder.failure).toBeUndefined();
  expect(r.holderTail).toBe("{\"text\":\"Still at Troy\"}");
}, TIMEOUT);

test("an overridden 8 MiB allowance is the mounted limit and the size refusal", async () => {
  const r = await probe("override");
  expect(r.tooLargeRefused).toContain("does not fit the worker's 8 MiB runtime-state allowance");
  expect(r.fits.out.split("\n")).toEqual([`tmpfs ${(8 * MiB) / 4096}`, "flood=1"]);
  expect(r.fits.failure?.errorClass).toBe("worker_state_exceeded");
}, TIMEOUT);

test("a server killed mid-turn leaves no worker and no runtime state behind", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-state-crash-"));
  const marker = `brain-worker-crash-${Date.now()}`;
  const running = () => readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).filter(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker); } catch { return false; }
  });
  try {
    const child = spawnProbe("crash", root, marker);
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes("\"ready\":true")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("\"ready\":true");
    expect(running().length, "the worker runs").toBeGreaterThan(0);
    child.kill("SIGKILL");
    await child.exited;
    const deadline = Date.now() + 5_000;
    while (running().length && Date.now() < deadline) await Bun.sleep(50);
    expect(running(), "--die-with-parent takes the sandbox and its private tmpfs with the server").toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, TIMEOUT);

test("links a worker plants in its runtime state are refused at copy-out, which runs only after its namespace is gone", async () => {
  const r = await probe("planted");
  for (const [name, outcome] of Object.entries(r.outcomes) as [string, any][]) {
    expect(outcome.exit, name).toEqual({ code: 0, signal: null });
    expect(outcome.error, name).toBeNull();
    expect(outcome.failure?.errorClass, name).toBe(name === "full and planted"
      ? "worker_state_exceeded" : "worker_state_save_refused");
    expect(outcome.failure.message, name).toMatch(/alias|special|redirected/);
    expect(outcome.failure.message, name).toMatch(/not (?:be )?saved in full/);
    expect(outcome.savedEntries, `${name}: nothing was exported`).toEqual([]);
  }
  // The late swap lands mid-turn; the copy-out reads only the final tree, after every writer is gone.
  expect(r.outcomes["late swap"].out).toBe("planted");
  const both = r.outcomes["full and planted"];
  expect(both.failure.errorClass).toBe("worker_state_exceeded");
  expect(both.failure.message).toContain("could not be saved in full either");
  expect(both.failure.message).not.toContain("is kept");
  expect(r.victim).toBe("Penelope's loom\n");
}, TIMEOUT);

test("each worker's /tmp is a private tmpfs of its turn-temp allowance, admitted in the same ledger (#1703)", async () => {
  const r = await probe("turn-temp");
  expect(r.first.failure, "turn-temp ENOSPC must not claim runtime-state loss").toBeUndefined();
  // The first worker floods its /tmp: the filesystem stops it at its own 8 MiB, not the host's.
  const [mount, flooded, free] = r.first.out.split("\n");
  expect(mount).toBe(`tmpfs ${(8 * MiB) / 4096} 4096`);
  expect(flooded).toBe("dd=1");
  expect(free).toBe("free=0");
  expect(r.first.exit).toEqual({ code: 0, signal: null });
  expect(r.turnTempHeldDuringFirst).toBe(8 * MiB);
  expect(r.stateHeldDuringFirst).toBe(64 * MiB);
  // A second turn while the turn-temp budget is held is refused before launch, holding nothing.
  expect(r.secondClass).toBe("worker_state_busy");
  expect(r.secondRefused).toContain("Not enough worker turn-temp capacity for this turn right now");
  expect(r.secondRefused).toContain("1 running conversation holds 8 MiB of the server's 8 MiB budget");
  expect(r.heldAfterRefusal).toEqual({ state: 64 * MiB, turnTemp: 8 * MiB });
  // Retry once the first has finished runs it.
  expect(r.againRefused).toBeNull();
  expect(r.again.exit).toEqual({ code: 0, signal: null });
  expect(r.tails).toEqual(["{\"text\":\"Scylla\"}", "{\"text\":\"Charybdis\"}"]);
}, TIMEOUT);
