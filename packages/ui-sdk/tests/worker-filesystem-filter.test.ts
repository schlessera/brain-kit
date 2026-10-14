import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_FILESYSTEM_FILTER_PROGRAM, workerFilesystemFilter, workerFilesystemFilterRefusal } from "../src/server/worker-filesystem-filter.js";
import { WorkerHostError, workerBootstrap, workerCommand } from "../src/server/worker-launcher.js";

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-filesystem-filter-"));
  return { root, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

function asBtrfs(root: string) {
  const real = fs.statfsSync(root);
  return spyOn(fs, "statfsSync").mockReturnValue({ ...real, type: 0x9123683e });
}

describe("Btrfs worker filesystem filter selection", () => {
  test("a governed worker cannot accidentally replace its live writable root with a startup view", () => {
    const f = fixture();
    try {
      expect(() => workerCommand({ brainPath: f.root, command: ["/bin/true"], env: {},
        sandbox: { brain: f.root, restricted: false, profile: "governed", areas: [], scratchAliasesRemoved: [], protection: { paths: [], ancestors: [] } },
        startupView: { brain: f.root, root: f.root, storage: { root: f.root, retain() {}, release() {} }, cleanup() {} },
      }), "GOVERNED_LIVE_ROOT_CANNOT_BE_REPLACED").toThrow("shared live brain");
    } finally { f.cleanup(); }
  });
  test("ordinary filesystems preserve the original launcher", () => {
    const f = fixture();
    try {
      const stat = spyOn(fs, "statfsSync").mockReturnValue({ ...fs.statfsSync(f.root), type: 0xef53 });
      try { expect(workerFilesystemFilter(f.root, ["/bin/true"])).toEqual(["/bin/true"]); }
      finally { stat.mockRestore(); }
    } finally { f.cleanup(); }
  });

  test("direct commands and bootstrap include the same fixed filter before bubblewrap", () => {
    const f = fixture(), stat = asBtrfs(f.root);
    try {
      const input = { brainPath: f.root, command: ["/bin/true"], env: {} };
      const direct = workerCommand(input);
      expect(direct.slice(1, 5)).toEqual(["-I", "-S", "-c", WORKER_FILESYSTEM_FILTER_PROGRAM]);
      expect(direct[5]).toBe(Bun.which("bwrap")!);
      expect(JSON.parse(workerBootstrap(input).env.BRAIN_WORKER_LAUNCH!).argv).toEqual(direct);
    } finally { stat.mockRestore(); f.cleanup(); }
  });

  test("the private output namespace entry cannot bypass the filter", () => {
    const f = fixture(), stat = asBtrfs(f.root);
    try {
      const argv = workerCommand({ brainPath: f.root, command: ["/bin/true"], env: {}, areaOutput: {
        source: f.root, storage: { root: f.root, mount: "/tmp/odysseus-staging", namespacePid: 1234,
          allowanceBytes: 1024 * 1024, retain() {}, release() {} },
      } });
      expect(argv.slice(1, 5)).toEqual(["-I", "-S", "-c", WORKER_FILESYSTEM_FILTER_PROGRAM]);
      expect(argv[5]).toBe(Bun.which("nsenter")!);
      expect(argv).toContain(Bun.which("bwrap")!);
    } finally { stat.mockRestore(); f.cleanup(); }
  });

  test("host transport preserves its existing command", () => {
    const f = fixture(), mirror = fixture(), stat = asBtrfs(f.root);
    try {
      const argv = workerCommand({ brainPath: f.root, command: ["/bin/true"], env: {},
        transport: { mirror: mirror.root, readPaths: [], writePaths: [] } });
      expect(argv[0]).toBe(Bun.which("bwrap")!);
      expect(argv).not.toContain(WORKER_FILESYSTEM_FILTER_PROGRAM);
    } finally { stat.mockRestore(); mirror.cleanup(); f.cleanup(); }
  });

  test("a missing trusted Python refuses with the existing WorkerHostError", () => {
    const f = fixture(), stat = asBtrfs(f.root), which = Bun.which;
    const lookup = spyOn(Bun, "which").mockImplementation((name, options) => name === "python3" ? null : which(name, options));
    try {
      expect(() => workerCommand({ brainPath: f.root, command: ["/bin/true"], env: {} })).toThrow(WorkerHostError);
      expect(() => workerCommand({ brainPath: f.root, command: ["/bin/true"], env: {} })).toThrow("Python 3 and libseccomp.so.2");
    } finally { lookup.mockRestore(); stat.mockRestore(); f.cleanup(); }
  });

  test("an unqualified architecture refuses before execution", () => {
    const f = fixture(), stat = asBtrfs(f.root), descriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
    try {
      Object.defineProperty(process, "arch", { ...descriptor, value: "arm64" });
      expect(() => workerCommand({ brainPath: f.root, command: ["/bin/true"], env: {} })).toThrow("qualify this architecture");
    } finally { Object.defineProperty(process, "arch", descriptor); stat.mockRestore(); f.cleanup(); }
  });

  test("the actual probe's named setup refusal remains readable", () => {
    expect(workerFilesystemFilterRefusal("BRAIN_BTRFS_FILTER_REFUSED: libseccomp runtime missing\n")).toBe("libseccomp runtime missing");
    expect(workerFilesystemFilterRefusal("other refusal\n")).toBeUndefined();
  });
});

describe("actual filesystem ioctl filter runtime", () => {
  // The fixed Python programs import no repository code, make no network
  // requests and operate only on this disposable directory descriptor.
  test("denies every topology request including high request bits, then execs a productive child", () => {
    const f = fixture(), python = Bun.which("python3");
    try {
      expect(python).not.toBeNull();
      fs.writeFileSync(join(f.root, "sitecustomize.py"), "raise RuntimeError('brain Python configuration ran')\n");
      const program = String.raw`import ctypes, errno, json, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
requests = (0x50009401, 0x5000940e, 0x5000940f, 0x50009417, 0x50009418, 0x4008941a, 0x5000943f)
errors = []
for request in requests:
    for value in (request, request | (1 << 32)):
        ctypes.set_errno(0)
        result = libc.syscall(ctypes.c_long(16), ctypes.c_long(fd), ctypes.c_ulong(value), ctypes.c_void_p(0))
        assert result == -1
        errors.append(ctypes.get_errno())
os.close(fd)
assert "PYTHONPATH" not in os.environ and "PYTHONHOME" not in os.environ
with open(sys.argv[1] + "/odysseus.md", "w") as output:
    output.write("Odysseus: Ithaca, 2026-07-12.\n")
print(json.dumps(errors))`;
      const child = Bun.spawnSync([python!, "-I", "-S", "-c", WORKER_FILESYSTEM_FILTER_PROGRAM,
        python!, "-I", "-S", "-c", program, f.root], {
        cwd: "/", env: { PYTHONPATH: f.root, PYTHONHOME: f.root }, stdout: "pipe", stderr: "pipe", timeout: 5_000,
      });
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString()), "BTRFS_IOCTL_DENIED").toEqual(Array(14).fill(1));
      expect(fs.readFileSync(join(f.root, "odysseus.md"), "utf8")).toBe("Odysseus: Ithaca, 2026-07-12.\n");
    } finally { f.cleanup(); }
  });
});
