import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const CUPS = "/var/snap/cups/common/run/cups.sock";
const WALK_CONTROL = "/opt/odysseus-var-fixture/inherited/walk-control.sock";
// A socket bind-mounted onto a file path: its directory entry is the empty
// regular file bwrap made as the mount point, so only `lstat` shows the socket.
const FILE_BOUND_CONTROL = "/opt/odysseus-file-bound/walk-control.sock";

test("all worker profiles hide every /var socket while explicit runtime files still execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-var-sockets-"));
  // Outside `root`, under the host /tmp every worker replaces, so only the
  // file-bound copy is in any view the walks read.
  const source = mkdtempSync(join(tmpdir(), "odysseus-file-bound-")), sourceSocket = join(source, "control.sock");
  const sourceServer = createServer(socket => socket.end());
  try {
    await new Promise<void>((done, reject) => { sourceServer.once("error", reject); sourceServer.listen(sourceSocket, done); });
    mkdirSync(join(root, "brain"));
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/run", "--tmpfs", "/var", "--tmpfs", "/opt", "--bind", root, "/opt/odysseus-var-fixture",
      "--ro-bind", sourceSocket, FILE_BOUND_CONTROL,
      ...(existsSync(CUPS) ? ["--ro-bind", CUPS, CUPS] : []),
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/worker-var-sockets.ts")],
    { cwd: ROOT, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr || stdout).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      control: boolean; hostControls: boolean[]; workers: Record<string, { exit: number; stderr: string;
        runtime: string; runtimeWrite: string; hostSockets: string[]; cups: string | boolean | null; sockets: string[];
        walk: { changed: number; entries: number; checked: number; ms: number } }>;
      baseline: { entries: number; skipped: number; sockets: number };
    };
    expect(result.control, "UNMASKED_SOCKET_POSITIVE_CONTROL").toBe(true);
    expect(result.hostControls, "VAR_HOST_SOCKETS_LISTENING").toEqual([true, true, true, true]);
    console.log("VAR_SOCKET_RECEIPT=" + JSON.stringify({ baseline: result.baseline, workers: result.workers }));
    for (const profile of ["governed", "strict", "maintenance"] as const) {
      const row = result.workers[profile]!;
      expect(row.exit, row.stderr).toBe(0);
      expect(row.runtime, `${profile}: VAR_EXPLICIT_RUNTIME_INPUT_READABLE`).toBe("Odysseus reaches Ithaca");
      expect(row.runtimeWrite, `${profile}: VAR_EXPLICIT_RUNTIME_INPUT_READ_ONLY`).toBe("EROFS");
      // The control is inherited from the fixture's view, so finding it proves
      // the part of the walk that lstats the baseline instead of reading it.
      expect(row.sockets, `${profile}: SOCKET_WALK_SEES_INHERITED_CONTROL`).toContain(WALK_CONTROL);
      // The file-bound control is inherited too, and only a walk that lstats
      // every mount point finds it (#2745).
      expect(row.sockets, `${profile}: SOCKET_WALK_SEES_FILE_BOUND_CONTROL`).toContain(FILE_BOUND_CONTROL);
      expect(row.sockets.filter(path => path !== WALK_CONTROL && path !== FILE_BOUND_CONTROL).sort(), `${profile}: SOCKET_WALK_ONLY_APPROVED_RELAY_AND_PROXY`)
        .toEqual(profile === "maintenance" ? [] : ["/run/brain-egress/inference.sock", "/run/brain-egress/proxy.sock"]);
      expect(row.hostSockets, `${profile}: VAR_HOST_SOCKET_CONNECTIONS_REFUSED`).toEqual(["ENOENT", "ENOENT", "ENOENT", "ENOENT"]);
      if (existsSync(CUPS)) expect(row.cups, `${profile}: VAR_CUPS_SOCKET_UNREACHABLE`).toBe("ENOENT");
    }
  } finally {
    await new Promise<void>(done => sourceServer.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
}, 180_000);
