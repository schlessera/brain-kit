"""Test-only host helper for the real second-UID broker qualification.

Install only inside the disposable, network-disabled native test fixture.
The production hosting template owns production helper authorization/packaging.
No repository configuration, provider environment or worker code runs here.
"""
import array
import base64
import ctypes
import fcntl
import json
import os
import re
import signal
import socket
import stat
import struct
import sys
import time
import traceback

SERVER_UID, WORKER_UID, SHARED_GID = 21001, 21002, 21001
RECORDS = "/run/brain-identity-fixture"
FILTER = "/usr/local/lib/brain-identity-fixture/filesystem-filter.py"
MAX_PACKET = 65536
ROOTS = {"state": "/tmp/brain-worker-state", "temp": "/tmp"}
MOUNTS = "/run/brain-identity-mounts"
libc = ctypes.CDLL(None, use_errno=True)


def refuse(reason):
    raise RuntimeError(reason)


def process(pid):
    if type(pid) is not int or pid <= 0:
        refuse("invalid_pid")
    with open("/proc/%s/stat" % pid) as stream:
        fields = stream.read().rsplit(") ", 1)[1].split()
    with open("/proc/%s/status" % pid) as stream:
        status = stream.read()
    ids = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)", status, re.M)
    return {"pid": pid, "start": fields[19], "parent": int(fields[1]),
            "uid": int(ids[1]), "state": fields[0]}


def same(expected):
    actual = process(expected["pid"])
    if actual["start"] != str(expected["start"]):
        refuse("reused_pid")
    return actual


def descendant(pid, ancestor):
    seen = set()
    while pid > 0 and pid not in seen:
        if pid == ancestor:
            return True
        if pid == 1:
            return False
        seen.add(pid)
        pid = process(pid)["parent"]
    return False


def receive(connection):
    data, controls, flags, _ = connection.recvmsg(MAX_PACKET + 1, socket.CMSG_SPACE(16 * 4))
    fds = []
    for level, kind, value in controls:
        if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
            refuse("unexpected_control")
        values = array.array("i")
        values.frombytes(value[:len(value) - len(value) % values.itemsize])
        fds.extend(values)
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(data) > MAX_PACKET:
        refuse("packet_bound")
    request = json.loads(data)
    if not isinstance(request, dict) or type(request.get("version")) is not int or request.get("version") != 1:
        refuse("version")
    return request, fds


def send(connection, payload, fds=()):
    encoded = json.dumps(dict(ok=True, **payload), separators=(",", ":")).encode()
    if len(encoded) > MAX_PACKET:
        refuse("reply_bound")
    control = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else []
    connection.sendmsg([encoded], control)


def save(name, record, create=False):
    # Once storage exists, preserve the last complete cleanup record if this
    # short-lived helper is killed during a subsequent metadata write.
    target = RECORDS + "/" + name
    pending = target if create else target + ".next"
    fd = os.open(pending, os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", closefd=False) as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(fd)
        if not create:
            os.replace(pending, target)
    finally:
        os.close(fd)
        if not create:
            try:
                os.unlink(pending)
            except FileNotFoundError:
                pass


def authenticate(connection, request, operation):
    peer_pid, peer_uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if peer_uid != SERVER_UID:
        refuse("unauthorized_peer")
    token = request.get("launch")
    if not isinstance(token, str) or not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", token):
        refuse("invalid_launch")
    info = os.stat(RECORDS, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        refuse("unsafe_records")
    if operation == "launch":
        supervisor, server = same(request["supervisor"]), same(request["server"])
        if peer_pid != supervisor["pid"] or supervisor["uid"] != SERVER_UID:
            refuse("unauthorized_supervisor")
        if server["uid"] != SERVER_UID or request["server"].get("uid") != SERVER_UID or not descendant(peer_pid, server["pid"]):
            refuse("unauthorized_server")
        return token, {"server": request["server"], "supervisor": request["supervisor"], "launcher": process(os.getpid())}
    fd = os.open(RECORDS + "/" + token, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            refuse("unsafe_record")
        with os.fdopen(fd, closefd=False) as stream:
            record = json.load(stream)
    finally:
        os.close(fd)
    for key in ("server", "supervisor"):
        if request[key] != record[key]:
            refuse("wrong_launch_owner")
    if peer_pid == record["supervisor"]["pid"]:
        if same(record["supervisor"])["uid"] != SERVER_UID:
            refuse("changed_supervisor_owner")
        try:
            server_alive = same(record["server"])["uid"] == SERVER_UID
        except (FileNotFoundError, ProcessLookupError, RuntimeError):
            server_alive = False
        termination = operation == "signal" and request.get("signal") in ("KILL", "TERM", "INT")
        if not server_alive and not (termination or operation == "cleanup"):
            refuse("server_lost")
    elif descendant(peer_pid, record["server"]["pid"]):
        if same(record["server"])["uid"] != SERVER_UID:
            refuse("changed_server_owner")
        try:
            supervisor = same(record["supervisor"])
        except (FileNotFoundError, ProcessLookupError, RuntimeError):
            pass
        else:
            # A killed child may remain unreaped while its server performs this
            # synchronous fallback. A zombie cannot control or signal a worker.
            if supervisor["state"] not in ("Z", "X"):
                refuse("server_fallback_supervisor_still_live")
        if operation != "cleanup" and not (operation == "signal" and request.get("signal") == "KILL"):
            refuse("server_fallback_not_termination")
    else:
        refuse("unauthorized_retained_owner")
    return token, record


def drop():
    parent = os.getppid()
    os.setgroups([SHARED_GID])
    os.setresgid(SHARED_GID, SHARED_GID, SHARED_GID)
    os.setresuid(WORKER_UID, WORKER_UID, WORKER_UID)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent:
        refuse("parent_lost_during_uid_drop")


def private_mounts(argv, roots, token, record):
    if not isinstance(roots, list) or len(roots) > 2:
        refuse("launch_roots")
    if libc.unshare(0x00020000):
        refuse("private_mount_namespace")
    if libc.mount(None, b"/", None, 0x4000 | 0x40000, None):
        refuse("private_mount_propagation")
    os.makedirs(MOUNTS, mode=0o755, exist_ok=True)
    parent = os.stat(MOUNTS, follow_symlinks=False)
    if parent.st_uid != 0 or not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o022:
        refuse("unsafe_mount_parent")
    launch_dir = MOUNTS + "/" + token
    os.mkdir(launch_dir, 0o755)
    result, seen = [], set()
    for root in roots:
        name, path, size = root.get("name"), root.get("path"), root.get("bytes")
        if name not in ROOTS or name in seen or path != ROOTS[name] or type(size) is not int or not 0 < size <= 64 * 1024**3 or size % 4096:
            refuse("launch_root_authority")
        seen.add(name)
        source = launch_dir + "/" + name
        # Persist cleanup authority before creating any per-root storage. A
        # failed/killed setup can remove only these exact launch-owned names.
        result.append({"name": name, "bytes": size})
        record["roots"] = result
        save(token, record)
        os.mkdir(source, 0o755)
        # Initial-userns superblock represents both real outside UIDs. A tmpfs
        # first created in worker-only userns cannot represent server-created files.
        options = ("size=%s,mode=2770,uid=%s,gid=%s" % (size, SERVER_UID, SHARED_GID)).encode()
        if libc.mount(b"tmpfs", source.encode(), b"tmpfs", 2 | 4, options):
            refuse("bounded_mount_setup")
        info = os.stat(source)
        pair = ["--size", str(size), "--tmpfs", path]
        matches = [index for index in range(len(argv) - 3) if argv[index:index + 4] == pair]
        if len(matches) != 1:
            refuse("root_mount_argv")
        index = matches[0]
        argv[index:index + 4] = ["--bind", source, path]
        result[-1].update(dev=info.st_dev, ino=info.st_ino)
        save(token, record)
    # Sources are traversable by trusted bwrap before entering its new sandbox;
    # the executed payload receives no path back to the helper namespace sources.
    boundary = argv.index("--")
    masked_run = any(argv[index:index + 2] == ["--tmpfs", "/run"] for index in range(boundary - 1))
    if not masked_run:
        argv[boundary:boundary] = ["--tmpfs", MOUNTS, "--remount-ro", MOUNTS]
    return result


def stage_ticket(fd):
    info = os.fstat(fd)
    required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or not 0 < info.st_size <= 16384 or fcntl.fcntl(fd, fcntl.F_GET_SEALS) & required != required:
        refuse("untrusted_stage_ticket")
    ticket = json.loads(os.pread(fd, info.st_size + 1, 0))
    if not isinstance(ticket, dict) or ticket.get("version") != 1 or ticket.get("kind") != "brain-worker-stage" or ticket.get("appUid") != SERVER_UID or ticket.get("appGid") != SHARED_GID:
        refuse("stage_ticket_schema")
    if not isinstance(ticket.get("id"), str) or not re.fullmatch(r"[0-9a-f-]{36}", ticket["id"]):
        refuse("stage_ticket_id")
    if type(ticket.get("allowanceBytes")) is not int or ticket["allowanceBytes"] <= 0:
        refuse("stage_ticket_allowance")
    return ticket


def stage_aliases(argv, ticket, token, record):
    if ticket is None:
        return
    stage = ticket["root"]
    checkpoint = ticket["checkpoint"]
    roots = []
    try:
        for name, receipt in (("stage", stage), ("checkpoint", checkpoint)):
            path = receipt.get("path")
            if not isinstance(path, str) or not path.startswith("/") or "\0" in path or any(v in ("", ".", "..") for v in path.split("/")[1:]):
                refuse("stage_ticket_path")
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            roots.append(fd)
            info = os.fstat(fd)
            if str(info.st_dev) != str(receipt.get("dev")) or str(info.st_ino) != str(receipt.get("ino")):
                refuse("stage_ticket_root_changed")
            if name == "stage":
                filesystem = os.fstatvfs(fd)
                if filesystem.f_blocks * filesystem.f_frsize != ticket["allowanceBytes"]:
                    refuse("stage_ticket_allowance_changed")
                source, original = fd, path
            else:
                source, original = fd, path
            alias = MOUNTS + "/" + token + "/" + name
            record.setdefault("sources", []).append(name)
            save(token, record)
            os.mkdir(alias, 0o755)
            if libc.mount(("/proc/self/fd/%s" % source).encode(), alias.encode(), None, 4096, None):
                refuse("stage_alias_mount")
            for index in range(len(argv) - 2):
                if argv[index] in ("--bind", "--ro-bind") and (argv[index + 1] == original or argv[index + 1].startswith(original + "/")):
                    argv[index + 1] = alias + argv[index + 1][len(original):]
        same(ticket["keeper"])
    finally:
        for fd in roots:
            os.close(fd)


def launch(connection, request, token, record, fds):
    record["roots"] = []
    save(token, record, create=True)
    argv = request.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) and "\0" not in v for v in argv):
        refuse("argv")
    prefix = []
    if len(argv) > 5 and argv[1:4] == ["-I", "-S", "-c"]:
        info = os.stat(FILTER)
        if info.st_uid != 0 or info.st_mode & 0o022:
            refuse("untrusted_filter")
        with open(FILTER) as stream:
            if stream.read() != argv[4]:
                refuse("untrusted_filter")
        if os.path.realpath(argv[0]) != os.path.realpath("/usr/bin/python3"):
            refuse("untrusted_interpreter")
        prefix, argv = argv[:5], argv[5:]
    ticket = None
    if argv and os.path.basename(argv[0]) == "nsenter":
        if argv[1:5] != ["--user", "--mount", "--preserve-credentials", "--target"] or len(argv) < 8 or argv[6] != "--":
            refuse("namespace_argv")
        expected = request.get("keeper")
        if not isinstance(expected, dict) or expected.get("pid") != int(argv[5]):
            refuse("missing_keeper_identity")
        keeper = same(expected)
        if fds:
            if len(fds) != 1:
                refuse("stage_ticket_descriptor_count")
            ticket = stage_ticket(fds[0])
            if ticket.get("keeper", {}).get("pid") != keeper["pid"] or ticket["keeper"].get("start") != keeper["start"]:
                refuse("stage_ticket_keeper_changed")
        elif not descendant(keeper["pid"], record["server"]["pid"]):
            refuse("unauthorized_keeper")
        if keeper["uid"] != SERVER_UID:
            refuse("unauthorized_keeper")
        os.seteuid(SERVER_UID)
        try:
            same(keeper)
            fd = os.open("/proc/%s/ns/mnt" % keeper["pid"], os.O_RDONLY)
            if ticket is not None and str(os.fstat(fd).st_ino) != str(ticket["keeper"].get("mountNamespaceInode")):
                os.close(fd)
                refuse("stage_ticket_namespace_changed")
        finally:
            os.seteuid(0)
        try:
            # Remain in the initial user namespace: the keeper maps only serverUID.
            # Its owned mount namespace is entered before dropping the outside UID.
            if libc.setns(fd, 0x00020000):
                refuse("mount_namespace_errno_" + str(ctypes.get_errno()))
        finally:
            os.close(fd)
        argv = argv[7:]
    elif fds:
        refuse("unexpected_stage_ticket")
    if not argv or os.path.realpath(argv[0]) != os.path.realpath("/usr/bin/bwrap"):
        refuse("untrusted_launcher")
    if "--" not in argv:
        refuse("missing_payload_separator")
    options = argv[1:argv.index("--")]
    if "--die-with-parent" not in options or "--unshare-pid" not in options:
        refuse("missing_lifecycle_boundary")
    for key, flag in (("statusFd", "--json-status-fd"), ("gateFd", "--block-fd")):
        fd = request.get(key)
        if type(fd) is not int or fd < 3 or options.count(flag) != 1 or options[options.index(flag) + 1] != str(fd):
            refuse("status_gate")
        if not stat.S_ISFIFO(os.fstat(fd).st_mode):
            refuse("status_gate_not_pipe")
    record["roots"] = private_mounts(argv, request.get("roots"), token, record)
    stage_aliases(argv, ticket, token, record)
    # Root authority is restricted to namespace entry and the recorded launch;
    # the fixed seccomp interpreter and all worker execution run as the worker.
    save(token, record)
    cgroup = request.get("cgroup")
    if cgroup is not None:
        if not isinstance(cgroup, str) or not cgroup.startswith("/sys/fs/cgroup/") or ".." in cgroup.split("/"):
            refuse("unauthorized_cgroup")
        info = os.stat(cgroup)
        if info.st_uid != SERVER_UID:
            refuse("unauthorized_cgroup")
        fd = os.open(cgroup + "/cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW)
        try:
            os.write(fd, str(os.getpid()).encode())
        finally:
            os.close(fd)
    send(connection, {})
    connection.close()
    parent = os.getppid()
    drop()
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent:
        refuse("supervisor_lost_at_launch")
    # Ensure temporary privileged control handles never enter the payload.
    allowed = {0, 1, 2, request["statusFd"], request["gateFd"]}
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd not in allowed:
            try:
                os.close(fd)
            except OSError:
                pass
    # Python itself ignores SIGPIPE/SIGXFSZ after the outer worker-entry reset.
    # Restore every catchable disposition at the final trusted exec boundary.
    os.execve("/usr/bin/env", ["env", "--default-signal", *(prefix + argv)], {})


def worker(record, request=None):
    root = same(record["launcher"])
    if request is not None:
        value = same(request["worker"])
    else:
        value = same(record["worker"])
    if value["uid"] != WORKER_UID or not descendant(value["pid"], root["pid"]):
        refuse("wrong_worker_identity")
    return value


def mounts(connection, request, token, record):
    value = worker(record, request)
    # Preserve authenticated termination authority before any inspector IO.
    # Namespace/root validation below still gates descriptor publication.
    record["worker"] = {"pid": value["pid"], "start": value["start"]}
    save(token, record)
    roots = request.get("roots")
    if not isinstance(roots, list) or len(roots) > 2 or len(roots) != len(record.get("roots", [])):
        refuse("substituted_root_count")
    initial_pid_namespace = os.stat("/proc/self/ns/pid").st_ino
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    inspector = os.fork()
    if inspector == 0:
        parent.close()
        connection.close()
        fds, receipts, seen = [], [], set()
        try:
            drop()
            same(value)
            if os.stat("/proc/%s/ns/pid" % value["pid"]).st_ino == initial_pid_namespace:
                refuse("wrong_pid_namespace")
            for root in roots:
                name, path, size = root.get("name"), root.get("path"), root.get("bytes")
                if name not in ROOTS or name in seen or path != ROOTS[name] or type(size) is not int or size <= 0:
                    refuse("unauthorized_root")
                seen.add(name)
                fd = os.open("/proc/%s/root%s" % (value["pid"], path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                fds.append(fd)
                info, space = os.fstat(fd), os.fstatvfs(fd)
                filesystem = ctypes.create_string_buffer(256)
                if libc.fstatfs(fd, filesystem) or struct.unpack_from("l", filesystem.raw)[0] != 0x01021994:
                    refuse("not_tmpfs")
                expected = next((item for item in record.get("roots", []) if item["name"] == name), None)
                if not expected or (info.st_dev, info.st_ino, size) != (expected["dev"], expected["ino"], expected["bytes"]):
                    refuse("substituted_mount")
                if space.f_blocks * space.f_frsize != size:
                    refuse("wrong_allowance")
                receipts.append({"name": name, "bytes": size, "dev": info.st_dev, "ino": info.st_ino})
            send(child, {"workerUid": WORKER_UID, "roots": receipts}, fds)
            os._exit(0)
        except BaseException as error:
            traceback.print_exc(file=sys.stderr)
            child.send(json.dumps({"ok": False, "reason": "inspector: " + str(error)}).encode())
            os._exit(125)
    child.close()
    fds = []
    try:
        data, ancillary, flags, _ = parent.recvmsg(MAX_PACKET + 1, socket.CMSG_SPACE(16 * 4))
        for level, kind, raw in ancillary:
            if (level, kind) != (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                refuse("inspector_control")
            values = array.array("i")
            values.frombytes(raw[:len(raw) - len(raw) % values.itemsize])
            fds.extend(values)
        _, status = os.waitpid(inspector, 0)
        result = json.loads(data)
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(data) > MAX_PACKET or status or result.get("ok") is not True:
            refuse(result.get("reason", "inspector_failed"))
        if len(fds) != len(roots) or len(result.get("roots", [])) != len(roots):
            refuse("inspector_handles")
        for receipt, fd in zip(result["roots"], fds):
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != (receipt["dev"], receipt["ino"]):
                refuse("inspector_substituted_handle")
        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)
    finally:
        parent.close()
        for fd in fds:
            os.close(fd)


def collect(record):
    # The launcher may die before its namespace leader is reaped. Retain both
    # authenticated identities so reparenting cannot erase termination authority.
    anchors = []
    for expected in (record["launcher"], record.get("worker")):
        if expected is None:
            continue
        try:
            anchors.append(same(expected)["pid"])
        except (FileNotFoundError, ProcessLookupError):
            pass
    # A live reused anchor is a refusal, never authority over its new tree.
    nodes = {}
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        try:
            value = process(int(name))
            nodes[value["pid"]] = value
        except (FileNotFoundError, ProcessLookupError):
            pass
    selected = set(anchors)
    while True:
        added = {pid for pid, value in nodes.items() if value["parent"] in selected} - selected
        if not added:
            break
        selected |= added
    return [nodes[pid] for pid in selected if pid in nodes and nodes[pid]["state"] != "Z"]


def signal_tree(connection, request, record):
    names = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL, "INT": signal.SIGINT,
             "STOP": signal.SIGSTOP, "CONT": signal.SIGCONT}
    name = request.get("signal")
    if name not in names:
        refuse("invalid_signal")
    deadline, previous = time.monotonic() + 2, None
    while time.monotonic() < deadline:
        nodes = collect(record)
        identities = {(v["pid"], v["start"]) for v in nodes}
        for value in reversed(nodes):
            try:
                descriptor = os.pidfd_open(value["pid"])
                try:
                    same(value)
                    signal.pidfd_send_signal(descriptor, names[name])
                finally:
                    os.close(descriptor)
            except (FileNotFoundError, ProcessLookupError):
                pass
        if name in ("KILL", "TERM", "INT"):
            if not collect(record):
                send(connection, {"complete": True})
                return
        elif identities == previous:
            current = collect(record)
            if name == "STOP" and any(v["state"] not in ("T", "t") for v in current):
                previous = None
            elif name == "CONT" and any(v["state"] in ("T", "t") for v in current):
                previous = None
            else:
                send(connection, {"complete": True})
                return
        previous = identities
        time.sleep(0.005)
    refuse("signal_incomplete")


def cleanup(connection, token, record):
    if collect(record):
        refuse("cleanup_writer_survives")
    for reader in record.get("readers", []):
        try:
            current = process(reader["pid"])
        except FileNotFoundError:
            continue
        if current["start"] == reader["start"] and current["state"] not in ("Z", "X", "x"):
            refuse("cleanup_owned_reader_survives")
    # These are empty source mountpoint directories in the original namespace.
    # The private mount namespace is gone; retained external FDs remain outside
    # this helper's physical-reclamation guarantee, as documented by ruling E.
    for path in [MOUNTS + "/" + token + "/" + name for name in [root["name"] for root in record.get("roots", [])] + record.get("sources", [])] + [MOUNTS + "/" + token]:
        try:
            os.rmdir(path)
        except FileNotFoundError:
            pass
    try:
        os.unlink(RECORDS + "/" + token + ".next")
    except FileNotFoundError:
        pass
    os.unlink(RECORDS + "/" + token)
    send(connection, {"complete": True})


def beneath(root, path, directory=False):
    if not isinstance(path, str) or path.startswith("/") or "\0" in path:
        refuse("relative_path")
    path.encode("utf-8", errors="strict")
    parts = path.split("/") if path else []
    if any(v in ("", ".", "..") for v in parts):
        refuse("relative_path")
    fd, device = os.dup(root), os.fstat(root).st_dev
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1 or directory:
                flags |= os.O_DIRECTORY
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            if os.fstat(fd).st_dev != device:
                refuse("unexpected_mount")
        return fd
    except BaseException:
        os.close(fd)
        raise


def reader(connection, request, record, fds, token):
    if collect(record):
        refuse("writer_survives")
    if len(fds) != 1:
        refuse("reader_descriptor_count")
    root = fds[0]
    expected = next((v for v in record.get("roots", []) if v["name"] == request.get("root")), None)
    info = os.fstat(root)
    if not expected or not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != (expected["dev"], expected["ino"]):
        refuse("reader_root_identity")
    maximum = request.get("maxBytes")
    if type(maximum) is not int or maximum < 0 or maximum > expected["bytes"]:
        refuse("reader_bound")
    # Persist known retained-I/O ownership before losing root authority. A
    # killed coordinator cannot mistake a still-running reader for reclaimed storage.
    prior = []
    for item in record.get("readers", []):
        try:
            current = process(item["pid"])
            if current["start"] == item["start"] and current["state"] not in ("Z", "X", "x"):
                prior.append(item)
        except FileNotFoundError:
            pass
    if len(prior) >= 16:
        refuse("reader_operation_bound")
    prior.append({"pid": os.getpid(), "start": process(os.getpid())["start"]})
    record["readers"] = prior
    save(token, record)
    drop()
    action = request.get("action", "read")
    fd = beneath(root, request.get("path"), action == "list")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
            refuse("reader_type")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            refuse("reader_aliased_file")
        if action == "stat":
            send(connection, {"type": "file" if stat.S_ISREG(info.st_mode) else "directory", "size": info.st_size, "mode": stat.S_IMODE(info.st_mode)})
        elif action == "list":
            entries = []
            for name in sorted(os.listdir(fd)):
                name.encode("utf-8", errors="strict")
                entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
                kind = "file" if stat.S_ISREG(entry.st_mode) and entry.st_nlink == 1 else "directory" if stat.S_ISDIR(entry.st_mode) else "unsupported"
                entries.append({"name": name, "type": kind, "size": entry.st_size, "mode": stat.S_IMODE(entry.st_mode)})
                if len(entries) > 256:
                    refuse("reader_listing_bound")
            send(connection, {"entries": entries})
        elif action == "read":
            offset, chunk = request.get("offset", 0), request.get("chunkBytes", 32768)
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or type(offset) is not int or offset < 0 or offset > info.st_size or type(chunk) is not int or not 0 < chunk <= 32768:
                refuse("reader_file_bound")
            data = os.pread(fd, min(chunk, info.st_size - offset), offset)
            send(connection, {"data": base64.b64encode(data).decode(), "size": info.st_size})
        else:
            refuse("reader_action")
    finally:
        os.close(fd)


def main():
    if os.getuid() != 0 or len(sys.argv) != 3:
        refuse("bootstrap")
    operation = sys.argv[1]
    connection = socket.socket(fileno=int(sys.argv[2]))
    fds = []
    try:
        request, fds = receive(connection)
        if fds and operation not in ("reader", "launch"):
            refuse("unexpected_descriptors")
        token, record = authenticate(connection, request, operation)
        if operation == "launch":
            launch(connection, request, token, record, fds)
        elif operation == "mounts":
            mounts(connection, request, token, record)
        elif operation == "signal":
            signal_tree(connection, request, record)
        elif operation == "reader":
            reader(connection, request, record, fds, token)
        elif operation == "cleanup":
            cleanup(connection, token, record)
        else:
            refuse("operation")
    except BaseException as error:
        traceback.print_exc(file=sys.stderr)
        try:
            connection.send(json.dumps({"ok": False, "reason": operation + ": " + str(error)}).encode())
        except OSError:
            pass
        return 125
    finally:
        for fd in fds:
            os.close(fd)
        connection.close()
    return 0


sys.exit(main())
