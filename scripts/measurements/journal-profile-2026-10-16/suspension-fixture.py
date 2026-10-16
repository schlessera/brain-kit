"""Own one finite loop filesystem, run guarded hosted proof, and release only it."""
import fcntl, hashlib, json, os, pathlib, signal, stat, struct, subprocess, sys, time

BACKEND = sys.argv[1] if len(sys.argv) >= 2 else "claude"
if BACKEND not in ("claude", "pi"): raise RuntimeError("Unknown fixed native backend selection")
os.environ["BRAIN_NATIVE_PROOF_BACKEND"] = BACKEND
APP_UID = sys.argv[2] if len(sys.argv) == 3 else "1000"
if APP_UID not in ("0", "1000"): raise RuntimeError("Unknown native app UID proof selection")
os.environ["BRAIN_NATIVE_PROOF_APP_UID"] = APP_UID
ROOT = pathlib.Path("/proof")
STORE = pathlib.Path("/brain-fixture")
DEVICE = pathlib.Path("/dev/brain-native-proof-loop")
MINOR = 1752
CAPACITY = 4 * 1024 ** 3
BACKING = pathlib.Path("/native-backing/fixture.img")
receipts = []

def interrupted(signum, _frame):
    raise RuntimeError("Native fixture interrupted by signal " + str(signum))

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def record(kind, **facts):
    receipts.append(dict(kind=kind, **facts))
    (ROOT / "native-fixture.json").write_text(json.dumps(receipts, indent=2))
    print(json.dumps(receipts[-1]), flush=True)

def run(argv, timeout=20):
    began = time.monotonic()
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        output, error = child.communicate(timeout=timeout)
    except BaseException:
        if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise
    record("command", argv=argv, code=child.returncode, ms=(time.monotonic()-began)*1000,
           stdout=output.decode(errors="backslashreplace")[-4000:], stderr=error.decode(errors="backslashreplace")[-4000:])
    if child.returncode:
        raise RuntimeError("Native proof command failed: " + repr(argv))
    return output

control = loop = image = None
created = attached = mounted = False
failure = None
outer_quota = pathlib.Path("/proc/sys/user/max_user_namespaces").read_text()
try:
    if os.getuid() != 0 or pathlib.Path("/sys/block/loop1752").exists():
        raise RuntimeError("Native proof requires an unused exact loop1790 and its root fixture owner")
    try: apparmor_label = pathlib.Path("/proc/self/attr/current").read_text().strip()
    except OSError as error: apparmor_label = "unavailable: " + str(error)
    expected_apparmor = json.loads((ROOT / "native-environment.json").read_text())["apparmor"]
    if expected_apparmor and apparmor_label != "brain-kit-native-proof (enforce)":
        raise RuntimeError("NATIVE_APPARMOR_NAMED_PROFILE_ENFORCED: " + apparmor_label)
    record("environment", kernel=os.uname().release,
           capabilities=next(x.strip() for x in pathlib.Path("/proc/self/status").read_text().splitlines() if x.startswith("CapEff:")),
           network=pathlib.Path("/proc/net/dev").read_text(), usernsQuota=outer_quota, apparmor=apparmor_label,
           bwrapVersion=subprocess.check_output(["/usr/bin/bwrap", "--version"]).decode().strip(),
           bwrapSha256=hashlib.sha256(pathlib.Path("/usr/bin/bwrap").read_bytes()).hexdigest())
    BACKING.parent.mkdir(mode=0o755)
    image = os.open(BACKING, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    os.posix_fallocate(image, 0, CAPACITY)
    info = os.fstat(image)
    if info.st_blocks * 512 < CAPACITY: raise RuntimeError("Native proof backing must be fully allocated")
    control = os.open("/dev/loop-control", os.O_RDWR)
    fcntl.ioctl(control, 0x4c80, MINOR); created = True
    os.mknod(DEVICE, stat.S_IFBLK | 0o600, os.makedev(7, MINOR))
    loop = os.open(DEVICE, os.O_RDWR)
    fcntl.ioctl(loop, 0x4c00, image); attached = True
    kernel = bytearray(232); fcntl.ioctl(loop, 0x4c05, kernel, True)
    # Keep the loop descriptor open for exact cleanup. If the entire Docker
    # owner is killed, autoclear still prevents a dangling backing attachment.
    struct.pack_into("=I", kernel, 52, 4)
    fcntl.ioctl(loop, 0x4c04, kernel)
    fcntl.ioctl(loop, 0x4c05, kernel, True)
    identity = struct.unpack_from("=QQQQQIIII", kernel)
    if identity[0] != info.st_dev or identity[1] != info.st_ino or identity[5] != MINOR:
        raise RuntimeError("Native proof loop does not match its exclusively created backing")
    record("owned-loop", identity=identity, bytes=info.st_size, allocated=info.st_blocks*512)
    run(["mkfs.btrfs", "-K", "-f", str(DEVICE)])
    os.fchmod(image, 0o644)
    marker = b"Odysseus fictional native backing marker."
    os.pwrite(image, marker, 0)
    os.fsync(image)
    record("alternate-backing", path=str(BACKING), uid=os.fstat(image).st_uid, mode=oct(os.fstat(image).st_mode & 0o777), parentMode=oct(BACKING.parent.stat().st_mode & 0o777), marker=marker.decode())
    STORE.mkdir(mode=0o755)
    run(["mount", "-t", "btrfs", "-o", "nosuid,nodev,nodiscard", str(DEVICE), str(STORE)]); mounted = True
    run(["btrfs", "subvolume", "create", str(STORE / "brain")])
    os.environ["BRAIN_JOURNAL_PROFILE_OWNED"] = "1752"
    run(["/usr/local/bin/bun", "run", "test", "/repo/scripts/profiling/journal-suspension.test.ts"], timeout=1200)
except BaseException as error:
    failure = error
    record("failure", detail=str(error))
finally:
    errors = []
    if mounted:
        try: run(["umount", str(STORE)]); mounted = False
        except BaseException as error: errors.append(str(error))
    if attached and not mounted:
        try:
            current = bytearray(232); fcntl.ioctl(loop, 0x4c05, current, True)
            if struct.unpack_from("=QQQQQIIII", current) != identity: raise RuntimeError("Owned loop identity changed before cleanup")
            fcntl.ioctl(loop, 0x4c01); attached = False
        except BaseException as error: errors.append(str(error))
    if loop is not None: os.close(loop)
    if created and not attached:
        try: fcntl.ioctl(control, 0x4c81, MINOR); created = False
        except BaseException as error: errors.append(str(error))
    if control is not None: os.close(control)
    if image is not None: os.close(image)
    if not mounted and not attached and BACKING.exists(): BACKING.unlink()
    after_quota = pathlib.Path("/proc/sys/user/max_user_namespaces").read_text()
    record("parent-userns-quota", before=outer_quota, after=after_quota, unchanged=outer_quota == after_quota)
    if outer_quota != after_quota: errors.append("NATIVE_CONTAINER_USERNS_QUOTA_UNCHANGED")
    record("cleanup", mounted=mounted, attached=attached, loopCreated=created, backingExists=BACKING.exists(), errors=errors)
    if errors and failure is None: failure = RuntimeError("Native proof cleanup failed")
if failure is not None: raise failure
