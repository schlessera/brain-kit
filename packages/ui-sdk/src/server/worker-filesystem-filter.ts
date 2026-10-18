/** Btrfs topology management belongs to the trusted host, never a worker. */
import { realpathSync, statfsSync } from "node:fs";

const BTRFS_MAGIC = 0x9123683e;
const REFUSAL = "BRAIN_BTRFS_FILTER_REFUSED: ";

/** Fixed first-party bootstrap: no brain imports, inherited descriptor or user code. */
export const WORKER_FILESYSTEM_FILTER_PROGRAM = String.raw`import os, platform, sys
os.chdir("/")
os.environ.clear()
def main():
    import ctypes
    if platform.machine() != "x86_64" or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError("Btrfs worker filesystem filtering is qualified only on Linux x86_64 with 64-bit Python; qualify this architecture before enabling native managed storage")
    try:
        lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    except OSError:
        raise RuntimeError("Btrfs workers require libseccomp.so.2; install the host libseccomp runtime before enabling native managed storage") from None
    class Compare(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint), ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_arch_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_arch_resolve_name.restype = ctypes.c_uint32
    lib.seccomp_arch_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    lib.seccomp_arch_add.restype = ctypes.c_int
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Compare)]
    lib.seccomp_rule_add_array.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    if libc.prctl(38, 1, 0, 0, 0):
        raise RuntimeError("Btrfs worker no_new_privs could not be established")
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx:
        raise RuntimeError("Btrfs worker seccomp filter could not be allocated")
    try:
        # Add compat architectures before rules; libseccomp translates syscall numbers.
        for architecture in ("x86_64", "x86", "x32"):
            token = lib.seccomp_arch_resolve_name(architecture.encode())
            if not token:
                raise RuntimeError("libseccomp cannot resolve " + architecture)
            result = lib.seccomp_arch_add(ctx, token)
            if result not in (0, -17):
                raise RuntimeError("libseccomp cannot filter " + architecture)
        ioctl = lib.seccomp_syscall_resolve_name(b"ioctl")
        if ioctl < 0:
            raise RuntimeError("libseccomp cannot resolve ioctl")
        # SNAP_CREATE, SUBVOL_CREATE, SNAP_DESTROY and their V2 forms, SETFLAGS.
        # ioctl takes an unsigned 32-bit request: high register bits must not bypass denial.
        requests = (0x50009401, 0x5000940e, 0x5000940f, 0x50009417, 0x50009418, 0x4008941a, 0x5000943f)
        for request in requests:
            compare = Compare(1, 7, 0xffffffff, request)
            if lib.seccomp_rule_add_array(ctx, 0x50001, ioctl, 1, ctypes.byref(compare)):
                raise RuntimeError("Btrfs worker ioctl rule could not be installed")
        if lib.seccomp_load(ctx):
            raise RuntimeError("Btrfs worker seccomp filter could not be loaded")
    finally:
        lib.seccomp_release(ctx)
    # Python reintroduces SIGPIPE/SIGXFSZ ignores after the bootstrap reset.
    # Restore every catchable disposition only after installing the filter;
    # preserve the inherited signal mask and the uncatchable signals.
    import signal
    for number in signal.valid_signals() - {signal.SIGKILL, signal.SIGSTOP}:
        signal.signal(number, signal.SIG_DFL)
    os.execve(sys.argv[1], sys.argv[1:], {})
try:
    main()
except Exception as error:
    sys.stderr.write("BRAIN_BTRFS_FILTER_REFUSED: " + str(error) + "\n")
    sys.exit(125)
`;

/** Called for canonical brain roots; transport workers never evaluate or mount one. */
export function workerFilesystemFilter(brain: string, command: readonly string[]): string[] {
  if (statfsSync(brain).type !== BTRFS_MAGIC) return [...command];
  if (process.arch !== "x64") {
    throw new Error("Btrfs worker filesystem filtering is qualified only on Linux x86_64; qualify this architecture before enabling native managed storage");
  }
  const found = Bun.which("python3");
  if (!found) throw new Error("Btrfs workers require Python 3 and libseccomp.so.2 on the trusted host");
  const python = realpathSync(found);
  if (python === brain || python.startsWith(`${brain}/`)) {
    throw new Error("Btrfs worker filtering requires a trusted Python outside the brain");
  }
  return [python, "-I", "-S", "-c", WORKER_FILESYSTEM_FILTER_PROGRAM, ...command];
}

/** Keep a failed actual probe's runtime dependency/filter requirement visible. */
export function workerFilesystemFilterRefusal(stderr: string): string | undefined {
  const line = stderr.split("\n").find(value => value.startsWith(REFUSAL));
  return line?.slice(REFUSAL.length).trim();
}
