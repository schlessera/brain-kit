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
// The fixture's own deadline, inside the test's. A fixture that has not exited
// by then is killed, and the test fails naming the phase it was in rather than
// timing out with nothing to show (#3545).
const FIXTURE_DEADLINE_MS = 165_000;

/** A stream's text so far, and all of it once the stream ends. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    return text += decoder.decode();
  })();
  return { text: () => text, done };
}

test("all worker profiles hide every /var socket while explicit runtime files still execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-var-sockets-"));
  // Outside `root`, under the host /tmp every worker replaces, so only the
  // file-bound copy is in any view the walks read.
  const source = mkdtempSync(join(tmpdir(), "odysseus-file-bound-")), sourceSocket = join(source, "control.sock");
  const sourceServer = createServer(socket => socket.end());
  try {
    await new Promise<void>((done, reject) => { sourceServer.once("error", reject); sourceServer.listen(sourceSocket, done); });
    mkdirSync(join(root, "brain"));
    // `--die-with-parent` lets a kill of this bwrap stop the fixture and, through
    // each worker's own `--die-with-parent`, every worker under it.
    const child = Bun.spawn(["bwrap", "--unshare-net", "--die-with-parent", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/run", "--tmpfs", "/var", "--tmpfs", "/opt", "--bind", root, "/opt/odysseus-var-fixture",
      "--ro-bind", sourceSocket, FILE_BOUND_CONTROL,
      ...(existsSync(CUPS) ? ["--ro-bind", CUPS, CUPS] : []),
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/worker-var-sockets.ts")],
    { cwd: ROOT, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const out = collect(child.stdout), err = collect(child.stderr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([Promise.all([out.done, err.done, child.exited]).then(([, , exit]) => exit),
      new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), FIXTURE_DEADLINE_MS); })]);
    clearTimeout(timer);
    if (code === undefined) {
      child.kill("SIGKILL");
      const phases = err.text().split("\n").filter(line => line.startsWith("VAR_SOCKET_")).join("\n");
      // A fixture that printed its result but never exited is a different stall
      // from one that never finished a phase; say which.
      const printed = out.text().includes('"workers"');
      throw Error(`${printed ? "VAR_SOCKET_FIXTURE_DID_NOT_EXIT" : "VAR_SOCKET_FIXTURE_DEADLINE"} after ${FIXTURE_DEADLINE_MS} ms\n`
        + `phases:\n${phases}\nstderr tail:\n${err.text().slice(-4000)}\nstdout tail:\n${out.text().slice(-2000)}`);
    }
    const stdout = out.text(), stderr = err.text();
    expect(code, stderr || stdout).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      control: boolean; hostControls: boolean[]; workers: Record<string, { exit: number; stderr: string;
        runtime: string; runtimeWrite: string; hostSockets: string[]; cups: string | boolean | null; sockets: string[];
        walk: { changed: number; entries: number; checked: number; ms: number } }>;
      baseline: { entries: number; skipped: number; sockets: number };
    };
    expect(result.control, "UNMASKED_SOCKET_POSITIVE_CONTROL").toBe(true);
    expect(result.hostControls, "VAR_HOST_SOCKETS_LISTENING").toEqual([true, true, true, true]);
    console.log("VAR_SOCKET_RECEIPT=" + JSON.stringify({ baseline: result.baseline, workers: result.workers,
      phases: stderr.split("\n").filter(line => line.startsWith("VAR_SOCKET_PHASE ") || line.startsWith("VAR_SOCKET_CHILD ")) }));
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
