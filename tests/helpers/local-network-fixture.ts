/** A test-owned local interface, never an external route or host-network escape. */
import { watchdogMs } from "../../scripts/test-deadlines";
import { expect } from "bun:test";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

export async function localNetworkFixture(file: string, name: string): Promise<boolean> {
  if (networkInterfaces().fixture0?.some(entry => entry.address === "198.18.0.2")) return false;
  const setup = `ip link set lo up
if ! ip link add fixture0 type dummy 2>/dev/null; then
  ip link add fixture0 type veth peer name fixture1
  ip link set fixture1 addrgenmode none
  ip link set fixture1 up
fi
ip link set fixture0 addrgenmode none
ip address add 198.18.0.2/32 dev fixture0 noprefixroute
ip link set fixture0 up
test -z "$(ip -4 route show table main)"
test -z "$(ip -6 route show table main)"
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"`;
  const child = Bun.spawn(["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "sh", "-eu", "-c", setup,
    "local-network-fixture", process.execPath, "test", "--no-env-file", "--timeout", String(watchdogMs(30_000)), file,
    "-t", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], {
    cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, "LOCAL_NETWORK_FIXTURE_RUNS: " + stdout + stderr).toBe(0);
  expect(stderr, "LOCAL_NETWORK_FIXTURE_EXECUTES_ITS_CASE").toMatch(/\b1 pass\b/);
  return true;
}
