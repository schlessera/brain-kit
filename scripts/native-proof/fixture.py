"""Own one finite loop filesystem, run guarded hosted proof, and release only it."""
import errno, fcntl, hashlib, json, os, pathlib, signal, stat, struct, subprocess, sys, time

BACKEND = sys.argv[1] if len(sys.argv) >= 2 else "claude"
if BACKEND not in ("claude", "pi"): raise RuntimeError("Unknown fixed native backend selection")
os.environ["BRAIN_NATIVE_PROOF_BACKEND"] = BACKEND
APP_UID = sys.argv[2] if len(sys.argv) == 3 else "1000"
if APP_UID not in ("0", "1000"): raise RuntimeError("Unknown native app UID proof selection")
os.environ["BRAIN_NATIVE_PROOF_APP_UID"] = APP_UID
# The #2834 observation cell makes 220 model requests; the #2848 timing cell
# waits for the earlier turns' index refresh before its turn.
HOSTED_TIMEOUT = 1500 if os.environ.get("BRAIN_NATIVE_PROOF_OBSERVATION_TIMING") == "1" else 300 if os.environ.get("BRAIN_NATIVE_PROOF_APPLY_TIMING") == "1" else 180
ROOT = pathlib.Path("/proof")
STORE = pathlib.Path("/brain-fixture")
DEVICE = pathlib.Path("/dev/brain-native-proof-loop")
MINOR = 1790
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

def observe(stage, **facts):
    # Diagnostics must never change fixture cleanup or replace its exception.
    try: record("loop-boundary", stage=stage, monoNs=time.monotonic_ns(), **facts)
    except BaseException: pass

def remove_evidence(error):
    if not isinstance(error, OSError) or error.errno != errno.EBUSY: return
    child = None
    def terminate():
        try:
            if child.poll() is not None: return "reaped"
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: child.wait(timeout=0.2); return "reaped"
            except subprocess.TimeoutExpired: return "unknown: kill sent; child may remain in uninterruptible I/O"
        except BaseException as diagnostic: return "unknown: " + type(diagnostic).__name__
    try:
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "/repo/scripts/native-proof/loop-evidence.py"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        try: output, _ = child.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            lifetime = terminate()
            observe("remove-ebusy", unknown="collector-timeout", childLifetime=lifetime)
            return
        if child.returncode or len(output) > 262144:
            observe("remove-ebusy", unknown="collector-failed-or-oversized", code=child.returncode)
        else: observe("remove-ebusy", sample=json.loads(output))
    except BaseException as diagnostic:
        lifetime = terminate() if child is not None else "not-started"
        observe("remove-ebusy", unknown=type(diagnostic).__name__, childLifetime=lifetime)
    finally:
        if child is not None:
            try:
                if child.stdout is not None: child.stdout.close()
            except BaseException as diagnostic: observe("remove-ebusy", unknown=type(diagnostic).__name__)


# Absolute repo path also works for generated fixture variants.
import importlib.util
_spec = importlib.util.spec_from_file_location("owned_remove", "/repo/scripts/native-proof/owned-remove.py")
owned_remove = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(owned_remove)
node_identity = entry_identity = entry = None
remove_receipt = {}
control = loop = image = None
created = attached = mounted = False
failure = None
outer_quota = pathlib.Path("/proc/sys/user/max_user_namespaces").read_text()
try:
    if os.getuid() != 0 or pathlib.Path("/sys/block/loop1790").exists():
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
    entry = pathlib.Path("/sys/dev/block/7:1790").resolve(strict=True)
    entry_identity = owned_remove.identity(entry)
    if not stat.S_ISDIR(entry_identity[4]):
        entry_identity = None
        raise RuntimeError("Owned sysfs initial capture is not a directory")
    os.mknod(DEVICE, stat.S_IFBLK | 0o600, os.makedev(7, MINOR))
    node_identity = owned_remove.identity(DEVICE)
    if not stat.S_ISBLK(node_identity[4]) or node_identity[5] != os.makedev(7, MINOR):
        node_identity = None
        raise RuntimeError("Owned device initial capture is not the exact block node")
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
    # The #2834 timing turn alone makes 220 tool calls, each one model request.
    run(["/usr/local/bin/bun", "run", "test", str(pathlib.Path(__file__).with_name("hosted-app.test.ts"))], timeout=HOSTED_TIMEOUT)
except BaseException as error:
    failure = error
    record("failure", detail=str(error))
finally:
    errors = []
    observe("cleanup-enter")
    if mounted:
        observe("unmount-enter")
        try: run(["umount", str(STORE)]); mounted = False
        except BaseException as error: errors.append(str(error))
    observe("unmount-settled", mounted=mounted)
    if attached and not mounted:
        try:
            current = bytearray(232); fcntl.ioctl(loop, 0x4c05, current, True)
            if struct.unpack_from("=QQQQQIIII", current) != identity: raise RuntimeError("Owned loop identity changed before cleanup")
            observe("detach-enter")
            fcntl.ioctl(loop, 0x4c01); attached = False
            observe("detach-return")
        except BaseException as error: errors.append(str(error))
    if loop is not None:
        observe("close-enter")
        os.close(loop)
        observe("close-return")
    if created and not attached:
        observe("remove-enter")
        try:
            if node_identity is None or entry_identity is None:
                owned_remove.remove_after_capture_failure(control, remove_receipt)
            else:
                owned_remove.remove_owned(control, DEVICE, node_identity, entry, entry_identity, remove_receipt)
            created = False
            observe("remove-return")
        except BaseException as error:
            errors.append(str(error))
            observe("remove-error", errno=getattr(error, "errno", None))
            remove_evidence(error)
    if control is not None: os.close(control)
    if image is not None: os.close(image)
    if not mounted and not attached and BACKING.exists(): BACKING.unlink()
    after_quota = pathlib.Path("/proc/sys/user/max_user_namespaces").read_text()
    record("parent-userns-quota", before=outer_quota, after=after_quota, unchanged=outer_quota == after_quota)
    if outer_quota != after_quota: errors.append("NATIVE_CONTAINER_USERNS_QUOTA_UNCHANGED")
    record("cleanup", mounted=mounted, attached=attached, loopCreated=created, backingExists=BACKING.exists(), errors=errors, removeReceipt=remove_receipt)
    if errors and failure is None: failure = RuntimeError("Native proof cleanup failed")
if failure is not None: raise failure
