/**
 * Concurrent Claude worker turns on a real, size-limited `/dev/shm` (#1625).
 * Each scenario runs in a private user and mount namespace with Docker's
 * default 64 MiB tmpfs mounted over `/dev/shm`, and launches actual workers
 * through the real launcher. No turn may fail with `ENOSPC`, and the tmpfs is
 * never filled.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MiB = 1024 * 1024;
const TIMEOUT = 60_000;

async function probe(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "worker-state-tmpfs-"));
  try {
    const child = Bun.spawn(["unshare", "--user", "--map-root-user", "--mount", "--", "/bin/sh", "-c",
      'mount -t tmpfs -o size=64m tmpfs /dev/shm && exec "$0" "$@"', process.execPath,
      "--preload", join(ROOT, "scripts/test-network-child-preload.ts"), join(ROOT, "tests/fixtures/worker-state-tmpfs-probe.ts"), scenario, root],
      { cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, err || out).toBe(0);
    const receipt = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(receipt.total).toBe(64 * MiB);
    expect(out + err).not.toContain("ENOSPC");
    expect(receipt.lowestFree, "the shared tmpfs is never filled").toBeGreaterThan(0);
    expect(receipt.leftover, "every state directory is removed").toBe(0);
    return receipt;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("two parallel turns whose state exceeds 64 MiB: the second refuses by name before launch, then runs after the first", async () => {
  const r = await probe("contend");
  expect(r.secondClass).toBe("worker_state_busy");
  expect(r.secondRefused).toContain("1 other conversation running");
  expect(r.first.exit).toEqual({ code: 0, signal: null });
  expect(r.first.failure).toBeUndefined();
  expect(r.againRefused).toBeNull();
  expect(r.again.exit).toEqual({ code: 0, signal: null });
  expect(r.tails).toEqual(["{\"text\":\"The horse is inside the walls\"}", "{\"text\":\"Home at last\"}"]);
}, TIMEOUT);

test("two parallel turns whose state fits 64 MiB both run and persist", async () => {
  const r = await probe("fit");
  expect(r.refused).toEqual([null, null]);
  for (const result of r.results) { expect(result.exit).toEqual({ code: 0, signal: null }); expect(result.failure).toBeUndefined(); }
  expect(r.tails).toEqual(["{\"text\":\"Circe\"}", "{\"text\":\"Calypso\"}"]);
}, TIMEOUT);

test("a turn that grows past its reservation is stopped by name before the tmpfs runs out under the other turn", async () => {
  const r = await probe("grow");
  expect(r.grower.failure?.errorClass).toBe("worker_state_exceeded");
  expect(r.grower.exit.signal).toBe("SIGKILL");
  expect(r.holder.exit).toEqual({ code: 0, signal: null });
  expect(r.holder.failure).toBeUndefined();
}, TIMEOUT);
