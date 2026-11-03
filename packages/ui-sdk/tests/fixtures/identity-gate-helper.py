#!/usr/bin/python3 -I
"""Same-UID stand-in for the identity helper, for identity-gate-holder-crash.test.ts (#3402).

It speaks the --brain-worker-identity-v1 operations the real coordinator
(WORKER_IDENTITY_SUPERVISOR) uses for a launch, so that coordinator and the
real launcher run unchanged on a host without root. Like the qualified helper
it refuses a launch without --json-status-fd/--block-fd pipes, --die-with-parent
or --unshare-pid, arms its parent-death signal and execs bubblewrap with only
stdio and those two descriptors. It drops no identity: the separate UID is
proven by the disposable-container qualification, not here.
"""
import array, ctypes, json, os, signal, socket, stat, sys

MAX_PACKET = 65536
libc = ctypes.CDLL(None, use_errno=True)


def receive(connection):
    data, controls, flags, _ = connection.recvmsg(MAX_PACKET + 1, socket.CMSG_SPACE(16 * 4))
    fds = []
    for level, kind, value in controls:
        values = array.array("i")
        values.frombytes(value[:len(value) - len(value) % values.itemsize])
        fds.extend(values)
    if controls and any(level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS for level, kind, _ in controls):
        raise RuntimeError("unexpected_control")
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
        raise RuntimeError("packet_bound")
    return json.loads(data), fds


def send(connection, payload, fds=()):
    control = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else []
    connection.sendmsg([json.dumps(dict(ok=True, **payload)).encode()], control)


def children(pid):
    found = []
    try:
        for task in os.listdir("/proc/%d/task" % pid):
            with open("/proc/%d/task/%s/children" % (pid, task)) as stream:
                found.extend(int(value) for value in stream.read().split())
    except (FileNotFoundError, ProcessLookupError):
        pass
    return found


def tree(pid):
    return [pid] + [each for child in children(pid) for each in tree(child)]


operation, connection = sys.argv[2], socket.socket(fileno=int(sys.argv[3]))
request, fds = receive(connection)
supervisor = request["supervisor"]["pid"]
if operation == "launch":
    argv = request["argv"]
    options = argv[:argv.index("--")]
    for key, flag in (("statusFd", "--json-status-fd"), ("gateFd", "--block-fd")):
        fd = request[key]
        if options.count(flag) != 1 or options[options.index(flag) + 1] != str(fd) or not stat.S_ISFIFO(os.fstat(fd).st_mode):
            raise RuntimeError("status_gate")
    if "--die-with-parent" not in options or "--unshare-pid" not in options:
        raise RuntimeError("missing_lifecycle_boundary")
    send(connection, {})
    connection.close()
    parent = os.getppid()
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent:
        raise RuntimeError("supervisor_lost_at_launch")
    allowed = {0, 1, 2, request["statusFd"], request["gateFd"]}
    for name in os.listdir("/proc/self/fd"):
        if int(name) not in allowed:
            try: os.close(int(name))
            except OSError: pass
    os.execve("/usr/bin/env", ["env", "--default-signal", *argv], {})
elif operation == "mounts":
    worker = request["worker"]["pid"]
    receipts, handles = [], []
    for root in request["roots"]:
        fd = os.open("/proc/%d/root%s" % (worker, root["path"]), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(fd)
        receipts.append({"name": root["name"], "bytes": root["bytes"], "dev": info.st_dev, "ino": info.st_ino})
        handles.append(fd)
    # Any UID but the server's: this stand-in does not change identity.
    send(connection, {"workerUid": os.getuid() + 1, "roots": receipts}, handles)
elif operation == "signal":
    number = getattr(signal, "SIG" + request["signal"])
    for pid in tree(supervisor):
        if pid not in (supervisor, os.getpid()):
            try: os.kill(pid, number)
            except ProcessLookupError: pass
    send(connection, {"complete": True})
elif operation == "cleanup":
    send(connection, {"complete": True})
else:
    raise RuntimeError("unsupported_operation")
