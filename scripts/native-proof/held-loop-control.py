"""Diagnostic-only pipe-held descriptor control, never a product cleanup repair.
Executed in the canonical fixture namespace; no device allocation of its own.
"""
import ctypes, select

held_pid = held_release = held_status = None
held_inode = None
held_comm = "OdH" + os.urandom(6).hex()

def control_record(kind, **facts): record("held-control", phase=kind, monoNs=time.monotonic_ns(), **facts)

def pipe_read(fd, size, timeout=5):
    if not select.select([fd], [], [], timeout)[0]: raise RuntimeError("Held control pipe deadline")
    value = os.read(fd, size)
    if not value: raise RuntimeError("Held control pipe closed")
    return value

def held_begin():
    global held_pid, held_release, held_status, held_inode
    held_inode = pathlib.Path("/sys/block/loop1790").stat().st_ino
    status_read, status_write = os.pipe(); release_read, release_write = os.pipe()
    held_pid = os.fork()
    if held_pid == 0:
        try:
            os.close(status_read); os.close(release_write)
            if ctypes.CDLL(None).prctl(15, held_comm.encode(), 0, 0, 0): os._exit(91)
            descriptor = os.open(DEVICE, os.O_RDONLY | os.O_CLOEXEC)
            for inherited in (loop, image, control): os.close(inherited)
            start = pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19]
            info = dict(pid=os.getpid(), start=start, comm=held_comm, openedMonoNs=time.monotonic_ns())
            os.write(status_write, json.dumps(info).encode())
            if pipe_read(release_read, 1, 30) != b"R": os._exit(92)
            os.close(descriptor)
            os.write(status_write, b"C"); os._exit(0)
        except BaseException: os._exit(93)
    os.close(status_write); os.close(release_read)
    held_release, held_status = release_write, status_read
    witness = json.loads(pipe_read(held_status, 4096))
    if witness["pid"] != held_pid or witness["comm"] != held_comm: raise RuntimeError("Held pipe identity mismatch")
    control_record("holder-ready", **witness)
    # Host validates ONLY this owned container's PID/start/namespace before ACK.
    if not select.select([sys.stdin], [], [], 10)[0]: raise RuntimeError("Host witness deadline")
    ack = json.loads(sys.stdin.readline(4096))
    if ack.get("start") != witness["start"] or ack.get("comm") != held_comm or ack.get("containerPid") != held_pid:
        raise RuntimeError("Host witness identity mismatch")
    control_record("host-witness", **ack)

def held_close():
    global held_pid
    if held_pid is None: return
    os.write(held_release, b"R")
    if pipe_read(held_status, 1) != b"C": raise RuntimeError("Held descriptor close not acknowledged")
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        pid, status = os.waitpid(held_pid, os.WNOHANG)
        if pid:
            held_pid = None
            if status: raise RuntimeError("Held child exit failed")
            control_record("holder-reaped", pid=pid)
            os.close(held_release); os.close(held_status); return
        time.sleep(0.01)
    raise RuntimeError("Held child lifetime unknown")

def held_busy(error):
    if not isinstance(error, OSError) or error.errno != errno.EBUSY: raise RuntimeError("Control did not reproduce EBUSY")
    control_record("expected-remove-ebusy", errno=error.errno)
    held_close()
    base = pathlib.Path("/sys/block/loop1790")
    # The single original remove stays failed. This is separate post-release recovery.
    if base.stat().st_ino != held_inode or (base / "dev").read_text().strip() != "7:1790" or (base / "size").read_text().strip() != "0" or (base / "loop").exists():
        raise RuntimeError("Owned entry not unchanged, empty and unbound after release")
    control_record("post-release-unbound", inode=held_inode)
    fcntl.ioctl(control, 0x4c81, MINOR)
    if base.exists(): raise RuntimeError("Owned control entry cleanup not confirmed")
    control_record("owned-entry-removed")

def held_abort():
    global held_pid
    if held_pid is None: return
    try: os.kill(held_pid, signal.SIGKILL)
    except ProcessLookupError: pass
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if os.waitpid(held_pid, os.WNOHANG)[0]: held_pid = None; return
        time.sleep(0.01)
    control_record("abort-child-lifetime-unknown", pid=held_pid)
