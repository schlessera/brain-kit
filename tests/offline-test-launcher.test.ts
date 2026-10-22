import { expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const launcher = join(root, "scripts/test-offline.sh");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Match the launcher's prerequisite without loading a host module. Hosts without
// it must prove refusal; initialized hosts still exercise every setup assertion.
const dummyAvailable = statSync("/sys/module/dummy", { throwIfNoEntry: false })?.isDirectory() ?? false;
const missingDriver = "dummy driver is not initialized; refusing module autoload that can change host interfaces";

function expectMissingDriver(result: { code: number; out: string; err: string }) {
  expect(result.code, result.err).toBe(1);
  expect(result.err).toContain(missingDriver);
  expect(result.err).not.toContain("offline-test: links and addresses");
  expect(result.out).toBe("");
}

async function run(args: string[], env = process.env, prefix: string[] = []) {
  const child = Bun.spawn([...prefix, "bash", launcher, ...args], { cwd: root, env, stdin: new TextEncoder().encode("Odysseus\n"), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

function ip(...args: string[]) {
  const result = Bun.spawnSync(["ip", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

function stableAddresses(rows: Array<{ ifname: string; addr_info: Array<Record<string, unknown>> }>) {
  // Address lifetimes can tick while a namespace command runs.
  return rows.map(row => ({ ifname: row.ifname, addr_info: row.addr_info.map(info =>
    Object.fromEntries(Object.entries(info).filter(([key]) => !key.endsWith("_life_time")))) }));
}

for (const mount of [false, true]) test(`offline launcher preserves caller state through ${dummyAvailable ? "network isolation" : "missing-driver refusal"} (mount=${mount})`, async () => {
  const caller = { user: readlinkSync("/proc/self/ns/user"), net: readlinkSync("/proc/self/ns/net"), mount: readlinkSync("/proc/self/ns/mnt") };
  const links = ip("-json", "link", "show");
  const addresses = ip("-json", "address", "show");
  const result = await run([...(mount ? ["--mount"] : []), "--", "bash", "-eu", "-c", `
    read -r line
    test "$line" = Odysseus
    test "$1" = 'Penelope keeps $the loom; *'
    test "$OFFLINE_FIXTURE" = Ithaca
    readlink /proc/self/ns/user /proc/self/ns/net /proc/self/ns/mnt
    id -u
    id -g
    umask
    pwd
    ip -json link show
    ip -json address show
    ip -json -4 route show table main
    ip -json -6 route show table main
    sed -n '/^Cap/p' /proc/self/status
  `, "offline-fixture", "Penelope keeps $the loom; *"], { ...process.env, OFFLINE_FIXTURE: "Ithaca" });
  if (!dummyAvailable) {
    expectMissingDriver(result);
  } else {
    expect(result.code, result.err).toBe(0);
    const [user, net, mnt, uid, gid, mask, cwd, linkRows, addressRows, v4, v6, ...caps] = result.out.trim().split("\n");
    expect(user).not.toBe(caller.user); expect(net).not.toBe(caller.net);
    if (mount) expect(mnt).not.toBe(caller.mount); else expect(mnt).toBe(caller.mount);
    expect(Number(uid)).toBe(process.getuid!()); expect(Number(gid)).toBe(process.getgid!());
    expect(parseInt(mask!, 8)).toBe(process.umask()); expect(cwd).toBe(root);
    const childLinks = JSON.parse(linkRows!);
    expect(childLinks.map((row: { ifname: string }) => row.ifname).sort()).toEqual(["lo", "proof-dummy"]);
    for (const row of childLinks) expect(row.flags).toContain("UP");
    const dummy = JSON.parse(addressRows!).find((row: { ifname: string }) => row.ifname === "proof-dummy");
    expect(dummy.addr_info).toEqual([expect.objectContaining({ family: "inet", local: "198.18.0.1", prefixlen: 32, noprefixroute: true })]);
    expect(JSON.parse(v4!)).toEqual([]); expect(JSON.parse(v6!)).toEqual([]);
    expect(caps).toHaveLength(5);
    for (const cap of caps) expect(cap).toMatch(/^Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+0+$/);
    expect(result.err).toContain("offline-test: IPv4 main routes");
    expect(result.err).toContain("offline-test: IPv6 main routes");
  }
  expect(readlinkSync("/proc/self/ns/user")).toBe(caller.user);
  expect(readlinkSync("/proc/self/ns/net")).toBe(caller.net);
  expect(readlinkSync("/proc/self/ns/mnt")).toBe(caller.mount);
  expect(ip("-json", "link", "show")).toEqual(links);
  expect(stableAddresses(ip("-json", "address", "show"))).toEqual(stableAddresses(addresses));
});

for (const mount of [false, true]) test(`offline launcher refuses dummy-driver autoload before Bun starts (mount=${mount})`, async () => {
  // Hide sysfs only in a private mount namespace. Stop every ip call so even a
  // broken refusal cannot autoload a module on a host that lacks the driver.
  const dir = mkdtempSync(join(tmpdir(), "odysseus-offline-driver-"));
  try {
    writeFileSync(join(dir, "ip"), '#!/bin/bash\necho UNGUARDED_INTERFACE_OPERATION >&2\nexit 99\n', { mode: 0o755 });
    const result = await run([...(mount ? ["--mount"] : []), "--", process.execPath, "-e", 'console.log("UNEXPECTED_BUN_START")'],
      { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      ["unshare", "--user", "--map-current-user", "--keep-caps", "--mount", "--propagation=private", "--", "bash", "-euc", `
      mount -t tmpfs -o size=64k tmpfs /sys/module
      exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
    `, "offline-fixture"]);
    expectMissingDriver(result);
    expect(result.err).not.toContain("UNGUARDED_INTERFACE_OPERATION");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test(`offline launcher ${dummyAvailable ? "preserves the command's nonzero exit" : "refuses a nonzero command without the dummy driver"}`, async () => {
  const result = await run(["sh", "-c", "echo COMMAND_STARTED; exit 23"]);
  if (!dummyAvailable) expectMissingDriver(result);
  else {
    expect(result.code, result.err).toBe(23);
    expect(result.out).toBe("COMMAND_STARTED\n");
  }
});

// Faults change real namespace/tool behavior. The given Bun command must never start.
for (const fault of ["IPv4 route", "IPv6 route", "capabilities", "network namespace"] as const) {
  const driverRefusesFirst = !dummyAvailable && fault !== "network namespace";
  test(`offline launcher refuses ${driverRefusesFirst ? `missing driver before ${fault} setup` : fault} before Bun starts`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "odysseus-offline-"));
    const realIp = Bun.which("ip")!, realUnshare = Bun.which("unshare")!;
    const failure = fault === "IPv4 route" ? "IPv4 main route table must be empty"
      : fault === "IPv6 route" ? "IPv6 main route table must be empty"
      : fault === "capabilities" ? "must be zero before starting the command" : "network namespace is not separate from the caller";
    try {
      if (fault === "capabilities") {
        writeFileSync(join(dir, "setpriv"), '#!/bin/bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
      } else if (fault === "network namespace") {
        writeFileSync(join(dir, "unshare"), `#!/bin/bash
args=()
for arg in "$@"; do if [[ "$arg" != --net ]]; then args+=("$arg"); fi; done
exec ${quote(realUnshare)} "\${args[@]}"
`, { mode: 0o755 });
        // A missing separation guard must not be allowed to change caller links.
        writeFileSync(join(dir, "ip"), '#!/bin/bash\necho UNGUARDED_INTERFACE_OPERATION >&2\nexit 99\n', { mode: 0o755 });
      } else {
        writeFileSync(join(dir, "ip"), `#!/bin/bash
set -eu
${quote(realIp)} "$@"
if [[ "$*" == 'link set dev proof-dummy up' ]]; then
  ${quote(realIp)} ${fault === "IPv4 route" ? "-4 route add 192.0.2.0/24" : "-6 route add 2001:db8::/64"} dev proof-dummy
fi
`, { mode: 0o755 });
      }
      const result = await run([process.execPath, "-e", 'console.log("UNEXPECTED_BUN_START")'], { ...process.env, PATH: `${dir}:${process.env.PATH}` });
      if (driverRefusesFirst) expectMissingDriver(result);
      else {
        expect(result.code, result.err).toBe(1);
        expect(result.err).toContain(failure);
      }
      expect(result.err).not.toContain("UNGUARDED_INTERFACE_OPERATION");
      expect(result.out).not.toContain("UNEXPECTED_BUN_START");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("offline launcher requires a command and rejects unknown options", async () => {
  for (const args of [[], ["--"], ["--unknown", "bun"]]) {
    const result = await run(args);
    expect(result.code).toBe(1); expect(result.err).toContain("Usage:");
    expect(result.err).not.toContain("offline-test: links and addresses");
  }
});
