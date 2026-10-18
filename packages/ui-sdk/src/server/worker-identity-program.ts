/** Fixed host-side coordinator. Never imported or executed inside the worker. */
export const WORKER_IDENTITY_SUPERVISOR = String.raw`
import array, errno, json, os, select, signal, socket, stat, struct, subprocess, sys, time

MAX_PACKET = 65536
cfg = json.loads(sys.argv[1])
server_uid = os.getuid()
if server_uid == 0:
    raise RuntimeError("worker_identity_server_must_be_nonroot")
def identity(pid):
    text = open('/proc/%s/stat' % pid).read().rsplit(') ', 1)[1].split()
    return {'pid': pid, 'start': text[19]}
server = dict(cfg['server'], uid=server_uid)
if identity(server['pid'])['start'] != server['start']:
    raise RuntimeError('worker_identity_server_changed')
supervisor = identity(os.getpid())
base = {'version': 1, 'launch': cfg['launch'], 'server': server, 'supervisor': supervisor}
held = {}
pending = []
worker = None
failed = None
finished = False
released = False
cleaned = False

def packet(connection):
    data, ancillary, flags, address = connection.recvmsg(MAX_PACKET + 1, socket.CMSG_SPACE(16 * array.array('i').itemsize))
    received = []
    for level, kind, value in ancillary:
        if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
            for fd in received: os.close(fd)
            raise RuntimeError('worker_identity_unexpected_ancillary')
        descriptors = array.array('i'); descriptors.frombytes(value[:len(value) - len(value) % descriptors.itemsize])
        received.extend(descriptors)
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(data) > MAX_PACKET:
        for fd in received: os.close(fd)
        raise RuntimeError('worker_identity_packet_exceeds_bound')
    try:
        value = json.loads(data)
        if not isinstance(value, dict) or value.get('ok') is not True:
            raise RuntimeError(value.get('reason', 'worker_identity_helper_refused'))
        return value, received
    except BaseException:
        for fd in received: os.close(fd)
        raise

def helper(operation, extra=None, send_fds=(), inherited=()):
    local, remote = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    local.settimeout(5)
    process = subprocess.Popen([cfg['helper'], '--brain-worker-identity-v1', operation, str(remote.fileno())],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        pass_fds=(remote.fileno(),) + tuple(inherited), env={})
    remote.close()
    request = dict(base, **(extra or {}))
    ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', send_fds))] if send_fds else []
    received, transferred = [], False
    try:
        local.sendmsg([json.dumps(request).encode()], ancillary)
        try: answer, received = packet(local)
        except BaseException as error:
            if process.poll() is not None:
                detail = process.stderr.read(4096).decode(errors='replace')
                raise RuntimeError(operation + ': ' + str(error) + '; ' + detail) from error
            raise RuntimeError(operation + ': ' + str(error)) from error
        if process.wait(timeout=5) != 0:
            raise RuntimeError('worker_identity_helper_failed')
        transferred = True
        return answer, received
    finally:
        if not transferred:
            for fd in received: os.close(fd)
        local.close()
        if process.poll() is None:
            try: process.kill(); process.wait(timeout=1)
            except (PermissionError, subprocess.TimeoutExpired): pass

def control_tree(name):
    answer, fds = helper('signal', {'signal': name})
    for fd in fds: os.close(fd)
    if fds or answer.get('complete') is not True:
        raise RuntimeError('worker_identity_signal_unconfirmed')

def terminate():
    global finished
    if finished: return
    control_tree('KILL')
    child.wait(timeout=5)
    finished = True

def cleanup_owned():
    global cleaned
    if cleaned: return
    for fd in held.values(): os.close(fd)
    held.clear()
    receipt, unexpected = helper('cleanup')
    for fd in unexpected: os.close(fd)
    if unexpected or receipt.get('complete') is not True:
        raise RuntimeError('worker_identity_cleanup_unconfirmed')
    cleaned = True
    receipt = {'ok': True, 'complete': True, 'launch': cfg['launch'], 'supervisor': supervisor}
    with open(cfg['ready'] + '.cleanup.tmp', 'w') as output: json.dump(receipt, output)
    os.rename(cfg['ready'] + '.cleanup.tmp', cfg['ready'] + '.cleanup')

listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
listener.bind(cfg['socket']); os.chmod(cfg['socket'], 0o600); listener.listen(4)
status_read, status_write = os.pipe()
gate_read, gate_write = os.pipe()
launch_local, launch_remote = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
launch_local.settimeout(5)
argv = cfg['argv'][:]
bwrap = argv.index(cfg['bwrap'])
argv[bwrap + 1:bwrap + 1] = ['--json-status-fd', str(status_write), '--block-fd', str(gate_read)]
child = subprocess.Popen([cfg['helper'], '--brain-worker-identity-v1', 'launch', str(launch_remote.fileno())],
    pass_fds=(launch_remote.fileno(), status_write, gate_read), env={})
launch_remote.close()
stage_ticket = None
try:
    authority = []
    if cfg.get('stage', {}).get('ticketSource'):
        source = cfg['stage']['ticketSource']
        prefix = '/proc/%s/fd/' % server['pid']
        if not source.startswith(prefix) or not source[len(prefix):].isdigit():
            raise RuntimeError('worker_identity_invalid_stage_ticket_source')
        stage_ticket = os.open(source, os.O_RDONLY | os.O_CLOEXEC)
        authority = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [stage_ticket]))]
    launch_local.sendmsg([json.dumps(dict(base, argv=argv, statusFd=status_write, gateFd=gate_read,
        roots=cfg['roots'], keeper=cfg.get('stage', {}).get('keeper'), cgroup=cfg.get('cgroup'))).encode()], authority)
    ack, fds = packet(launch_local)
    for fd in fds: os.close(fd)
    if fds: raise RuntimeError('worker_identity_unexpected_launch_handles')
    if stage_ticket is not None: os.close(stage_ticket); stage_ticket = None
    os.close(status_write); os.close(gate_read)
    status = b''; deadline = time.monotonic() + 5
    while b'\n' not in status:
        if time.monotonic() >= deadline or child.poll() is not None:
            raise RuntimeError('worker_identity_missing_status')
        if select.select([status_read], [], [], .01)[0]:
            chunk = os.read(status_read, 4097 - len(status))
            if not chunk: raise RuntimeError('worker_identity_missing_status')
            status += chunk
        if len(status) > 4096: raise RuntimeError('worker_identity_malformed_status')
    reported = json.loads(status.split(b'\n', 1)[0]).get('child-pid')
    if type(reported) is not int or reported <= 1: raise RuntimeError('worker_identity_malformed_status')
    worker = identity(reported)
    answer, descriptors = helper('mounts', {'worker': worker, 'roots': cfg['roots']})
    pending = descriptors
    if len(descriptors) != len(cfg['roots']) or len(answer.get('roots', [])) != len(descriptors):
        raise RuntimeError('worker_identity_unexpected_mount_handles')
    if type(answer.get('workerUid')) is not int or not 0 < answer['workerUid'] < 0xffffffff or answer['workerUid'] == server_uid:
        raise RuntimeError('worker_identity_wrong_uid')
    verified = {}
    for requested, receipt, fd in zip(cfg['roots'], answer['roots'], descriptors):
        info = os.fstat(fd); space = os.fstatvfs(fd)
        if receipt.get('name') != requested['name'] or receipt.get('bytes') != requested['bytes'] or not stat.S_ISDIR(info.st_mode) or info.st_dev != receipt.get('dev') or info.st_ino != receipt.get('ino') or space.f_blocks * space.f_frsize != requested['bytes']:
            raise RuntimeError('worker_identity_substituted_mount')
        verified[requested['name']] = fd
    held.update(verified)
    pending = []
    ready = {'ok': True, 'pid': child.pid, 'worker': worker, 'workerUid': answer['workerUid'],
        'roots': {name: {'fd': fd, 'dev': os.fstat(fd).st_dev, 'ino': os.fstat(fd).st_ino} for name, fd in held.items()}}
    with open(cfg['ready'] + '.tmp', 'x') as output: json.dump(ready, output)
    os.rename(cfg['ready'] + '.tmp', cfg['ready'])
    parent = os.pidfd_open(server['pid'])
    if identity(server['pid'])['start'] != server['start']:
        os.close(parent)
        raise RuntimeError('worker_identity_server_changed_during_setup')
    try:
        while True:
            if child.poll() is not None and not finished:
                # Confirm all descendants are gone before any recovery or publication.
                control_tree('KILL'); finished = True
            readable = select.select([listener, parent], [], [], .01)[0]
            if parent in readable:
                terminate(); break
            if listener not in readable: continue
            connection, address = listener.accept()
            try:
                peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                request = connection.recv(MAX_PACKET + 1)
                if peer[1] != server_uid or len(request) > MAX_PACKET:
                    raise RuntimeError('worker_identity_unauthorized_control')
                request = json.loads(request)
                if request.pop('secret', None) != cfg['secret']:
                    raise RuntimeError('worker_identity_unauthorized_control')
                operation = request.get('operation')
                result = {'ok': True}
                if operation == 'release':
                    if released or finished: raise RuntimeError('worker_identity_start_gate_closed')
                    os.write(gate_write, b'g'); os.close(gate_write); gate_write = -1; released = True
                elif operation == 'status':
                    result.update(exited=finished, code=child.poll(), failure=failed)
                elif operation == 'signal':
                    if request.get('signal') not in ('TERM', 'KILL', 'INT', 'STOP', 'CONT'):
                        raise RuntimeError('worker_identity_invalid_signal')
                    control_tree(request['signal'])
                elif operation == 'read':
                    if not finished: raise RuntimeError('worker_identity_recovery_before_termination')
                    name = request.get('root')
                    if name not in held: raise RuntimeError('worker_identity_unauthorized_root')
                    result, fds = helper('reader', {'path': request.get('path'), 'maxBytes': request.get('maxBytes'), 'root': name,
                        'action': request.get('action', 'read'), 'offset': request.get('offset', 0), 'chunkBytes': request.get('chunkBytes', 32768)}, (held[name],))
                    for fd in fds: os.close(fd)
                    if fds: raise RuntimeError('worker_identity_unexpected_reader_handles')
                elif operation == 'close':
                    terminate(); cleanup_owned(); result['complete'] = True
                    connection.send(json.dumps(result).encode()); break
                else: raise RuntimeError('worker_identity_unknown_operation')
                connection.send(json.dumps(result).encode())
            except BaseException as error:
                failed = str(error)
                try: connection.send(json.dumps({'ok': False, 'reason': failed}).encode())
                except OSError: pass
                terminate()
            finally: connection.close()
    finally: os.close(parent)
except BaseException as error:
    for fd in pending: os.close(fd)
    pending = []
    failed = str(error)
    try: terminate()
    except BaseException as cleanup: failed += '; cleanup: ' + str(cleanup)
    if not os.path.exists(cfg['ready']):
        with open(cfg['ready'] + '.tmp', 'w') as output: json.dump({'ok': False, 'reason': failed}, output)
        os.rename(cfg['ready'] + '.tmp', cfg['ready'])
    sys.stderr.write('Worker identity supervision failed: ' + failed + '\n')
finally:
    if stage_ticket is not None: os.close(stage_ticket)
    try:
        if finished: cleanup_owned()
    except BaseException as cleanup:
        sys.stderr.write('Worker identity cleanup failed: ' + str(cleanup) + '\n')
    for fd in (status_read, gate_write):
        if fd >= 0:
            try: os.close(fd)
            except OSError: pass
    launch_local.close(); listener.close()
`;

/** Separate trusted client has no inherited provider environment or mount handles. */
export const WORKER_IDENTITY_CLIENT = String.raw`
import json, socket, sys
connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
connection.settimeout(6)
connection.connect(sys.argv[1])
connection.send(sys.argv[2].encode())
reply = connection.recv(65537)
if len(reply) > 65536: raise RuntimeError('worker_identity_reply_exceeds_bound')
sys.stdout.buffer.write(reply)
`;

/** Independent server-authorized cleanup remains available after coordinator death. */
export const WORKER_IDENTITY_FALLBACK = String.raw`
import array, json, os, socket, subprocess, sys
cfg = json.loads(sys.argv[1])
for operation in cfg.get('operations', ('signal', 'cleanup')):
    local, remote = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    local.settimeout(5)
    child = subprocess.Popen([cfg['helper'], '--brain-worker-identity-v1', operation, str(remote.fileno())],
        pass_fds=(remote.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env={})
    remote.close()
    request = dict(cfg['base'])
    if operation == 'signal': request['signal'] = 'KILL'
    local.send(json.dumps(request).encode())
    data, controls, flags, address = local.recvmsg(65537, socket.CMSG_SPACE(64))
    for level, kind, value in controls:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            fds = array.array('i'); fds.frombytes(value[:len(value) - len(value) % fds.itemsize])
            for fd in fds: os.close(fd)
    reply = json.loads(data)
    if flags or controls or reply.get('ok') is not True or reply.get('complete') is not True:
        raise RuntimeError('worker_identity_fallback_unconfirmed: ' + str(reply))
    if child.wait(timeout=5) != 0: raise RuntimeError('worker_identity_fallback_helper_failed')
    local.close()
`;

/** Bind cancellation to a kernel process handle, then check its original identity. */
export const WORKER_IDENTITY_STOP = String.raw`
import os, signal, sys
try: fd = os.pidfd_open(int(sys.argv[1]))
except ProcessLookupError: sys.exit(0)
try:
    try: start = open('/proc/%s/stat' % sys.argv[1]).read().rsplit(') ', 1)[1].split()[19]
    except FileNotFoundError: sys.exit(0)
    if start != sys.argv[2]: raise RuntimeError('worker_identity_supervisor_pid_reused')
    signal.pidfd_send_signal(fd, signal.SIGKILL)
finally: os.close(fd)
`;
