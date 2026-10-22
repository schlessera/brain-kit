import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const CUPS = "/var/snap/cups/common/run/cups.sock";

test("all worker profiles hide every /var socket while explicit runtime files still execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-var-sockets-"));
  try {
    mkdirSync(join(root, "brain"));
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/run", "--tmpfs", "/var", "--tmpfs", "/opt", "--bind", root, "/opt/odysseus-var-fixture",
      ...(existsSync(CUPS) ? ["--ro-bind", CUPS, CUPS] : []),
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/worker-var-sockets.ts")],
    { cwd: ROOT, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr || stdout).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      control: boolean; hostControls: boolean[]; workers: Record<string, { exit: number; stderr: string;
        runtime: string; runtimeWrite: string; hostSockets: string[]; cups: string | boolean | null; sockets: string[] }>;
    };
    expect(result.control, "UNMASKED_SOCKET_POSITIVE_CONTROL").toBe(true);
    expect(result.hostControls, "VAR_HOST_SOCKETS_LISTENING").toEqual([true, true, true, true]);
    console.log("VAR_SOCKET_RECEIPT=" + JSON.stringify(result.workers));
    for (const profile of ["governed", "strict", "maintenance"] as const) {
      const row = result.workers[profile]!;
      expect(row.exit, row.stderr).toBe(0);
      expect(row.runtime, `${profile}: VAR_EXPLICIT_RUNTIME_INPUT_READABLE`).toBe("Odysseus reaches Ithaca");
      expect(row.runtimeWrite, `${profile}: VAR_EXPLICIT_RUNTIME_INPUT_READ_ONLY`).toBe("EROFS");
      expect(row.sockets.sort(), `${profile}: SOCKET_WALK_ONLY_APPROVED_RELAY_AND_PROXY`).toEqual(profile === "maintenance" ? []
        : ["/run/brain-egress/inference.sock", "/run/brain-egress/proxy.sock"]);
      expect(row.hostSockets, `${profile}: VAR_HOST_SOCKET_CONNECTIONS_REFUSED`).toEqual(["ENOENT", "ENOENT", "ENOENT", "ENOENT"]);
      if (existsSync(CUPS)) expect(row.cups, `${profile}: VAR_CUPS_SOCKET_UNREACHABLE`).toBe("ENOENT");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
