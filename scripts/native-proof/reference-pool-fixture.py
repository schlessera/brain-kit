"""Own a brain store and a separate sparse reference pool volume, run the pool proof, release only them."""
import ctypes, fcntl, json, os, pathlib, signal, stat, struct, subprocess, sys, time

# The pool qualification by default; the integrated app proof (#2751) on request.
PROOFS = {"reference-pool.native.ts": 600, "reference-integration.native.ts": 1200}
PROOF = sys.argv[1] if len(sys.argv) > 1 else "reference-pool.native.ts"
if PROOF not in PROOFS: raise RuntimeError("Unknown reference pool proof selection")

ROOT = pathlib.Path("/proof")
BACKING = pathlib.Path("/native-backing")
STORE, POOL = pathlib.Path("/brain-fixture"), pathlib.Path("/reference-pool")
# The integrated app proof keeps the hosted store size, above the app's 2 GiB free-space floor.
LOOPS = {"store": (2428, BACKING / "store.img", (4 if PROOF == "reference-integration.native.ts" else 1) * 1024 ** 3, True),
         "pool": (2429, BACKING / "pool.img", 2 * 1024 ** 3, False)}
receipts = []

def interrupted(signum, _frame):
    raise RuntimeError("Reference pool fixture interrupted by signal " + str(signum))
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def record(kind, **facts):
    receipts.append(dict(kind=kind, **facts))
    (ROOT / "reference-pool-fixture.json").write_text(json.dumps(receipts, indent=2))
    print(json.dumps(receipts[-1]), flush=True)

def run(argv, timeout=30, env=None):
    began = time.monotonic()
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env)
    try: output, _ = child.communicate(timeout=timeout)
    except BaseException:
        if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
        child.communicate(); raise
    text = output.decode(errors="backslashreplace")
    (ROOT / ("command-%02d.log" % len(receipts))).write_text(text)
    record("command", argv=argv, code=child.returncode, ms=round((time.monotonic() - began) * 1000), tail=text[-3000:])
    if child.returncode: raise RuntimeError("Reference pool command failed: " + repr(argv[:3]))
    return output

state = {name: {"created": False, "attached": False, "fd": None, "identity": None} for name in LOOPS}
mounted, control, failure = [], None, None
try:
    if os.getuid() != 0 or any(pathlib.Path("/sys/block/loop%d" % minor).exists() for minor, *_ in LOOPS.values()):
        raise RuntimeError("Reference pool proof requires unused exact loop2428/loop2429 and its root fixture owner")
    record("environment", kernel=os.uname().release, btrfs=subprocess.check_output(["btrfs", "--version"]).decode().strip(),
           capabilities=next(x.strip() for x in pathlib.Path("/proc/self/status").read_text().splitlines() if x.startswith("CapEff:")))
    BACKING.mkdir(mode=0o755)
    control = os.open("/dev/loop-control", os.O_RDWR)
    for name, (minor, path, size, allocate) in LOOPS.items():
        image = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        # The store keeps its existing fully allocated requirement; the pool is deliberately sparse.
        if allocate: os.posix_fallocate(image, 0, size)
        else: os.ftruncate(image, size)
        info = os.fstat(image)
        fcntl.ioctl(control, 0x4c80, minor); state[name]["created"] = True
        device = pathlib.Path("/dev/brain-%s-loop" % name)
        os.mknod(device, stat.S_IFBLK | 0o600, os.makedev(7, minor))
        loop = os.open(device, os.O_RDWR); state[name]["fd"] = loop
        fcntl.ioctl(loop, 0x4c00, image); state[name]["attached"] = True
        kernel = bytearray(232); fcntl.ioctl(loop, 0x4c05, kernel, True)
        struct.pack_into("=I", kernel, 52, 4); fcntl.ioctl(loop, 0x4c04, kernel)
        fcntl.ioctl(loop, 0x4c05, kernel, True)
        identity = struct.unpack_from("=QQQQQIIII", kernel); state[name]["identity"] = identity
        if identity[0] != info.st_dev or identity[1] != info.st_ino or identity[5] != minor:
            raise RuntimeError("Reference pool loop does not match its exclusively created backing")
        os.close(image)
        record("owned-loop", name=name, minor=minor, bytes=size, allocated=os.stat(path).st_blocks * 512)
        run(["mkfs.btrfs", "-K", "-f", str(device)])
    STORE.mkdir(mode=0o755); POOL.mkdir(mode=0o755)
    run(["mount", "-t", "btrfs", "-o", "nosuid,nodev,nodiscard", "/dev/brain-store-loop", str(STORE)]); mounted.append(STORE)
    run(["btrfs", "subvolume", "create", str(STORE / "brain")])
    run(["mount", "-t", "btrfs", "-o", "nosuid,nodev,discard=async", "/dev/brain-pool-loop", str(POOL)]); mounted.append(POOL)
    # Operator provisioning: btrfs-progs 6.6 has no `quota enable --simple`, so
    # use BTRFS_IOC_QUOTA_CTL with BTRFS_QUOTA_CTL_ENABLE_SIMPLE_QUOTA directly.
    top = os.open(POOL, os.O_RDONLY | os.O_DIRECTORY)
    try: fcntl.ioctl(top, 0xC0109428, struct.pack("<QQ", 4, 0))
    finally: os.close(top)
    (BACKING / "ledger").mkdir(mode=0o755)
    record("provisioned", store=str(STORE), pool=str(POOL), mode=pathlib.Path("/sys/fs/btrfs").joinpath(
        subprocess.check_output(["btrfs", "filesystem", "show", "--raw", str(POOL)]).decode().split("uuid: ")[1].split()[0], "qgroups/mode").read_text().strip())
    env = dict(os.environ, BRAIN_REFERENCE_POOL_ARTIFACTS=str(ROOT))
    run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/scripts/native-proof/" + PROOF], timeout=PROOFS[PROOF], env=env)
except BaseException as error:
    failure = error
    record("failure", detail=str(error))
finally:
    errors = []
    for path in reversed(mounted[:]):
        try: run(["umount", str(path)]); mounted.remove(path)
        except BaseException as error: errors.append(str(error))
    for name in ("pool", "store"):
        item, (minor, path, _, _) = state[name], LOOPS[name]
        if item["attached"]:
            try:
                current = bytearray(232); fcntl.ioctl(item["fd"], 0x4c05, current, True)
                if struct.unpack_from("=QQQQQIIII", current) != item["identity"]: raise RuntimeError("Owned loop identity changed before cleanup")
                fcntl.ioctl(item["fd"], 0x4c01); item["attached"] = False
            except BaseException as error: errors.append(str(error))
        if item["fd"] is not None: os.close(item["fd"])
        if item["created"] and not item["attached"]:
            for _ in range(20):
                try: fcntl.ioctl(control, 0x4c81, minor); item["created"] = False; break
                except OSError: time.sleep(0.25)
            if item["created"]: errors.append("loop%d remained" % minor)
        if not item["attached"] and path.exists(): path.unlink()
    if control is not None: os.close(control)
    record("cleanup", mounted=[str(path) for path in mounted], loops={name: item["created"] for name, item in state.items()}, errors=errors)
    if errors and failure is None: failure = RuntimeError("Reference pool cleanup failed")
if failure is not None: raise failure
