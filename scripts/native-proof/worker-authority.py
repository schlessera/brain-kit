"""Fixed offline authority witness executed by actual native workers."""
import errno
import fcntl
import json
import os
import socket
import tempfile
import sys

expected_host_uid = int(sys.argv[1])

os.chdir(os.environ.get("BRAIN_WORKER_DATA_ROOT", "."))
status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
caps = {key: int(status[key].strip(), 16) for key in ("CapInh", "CapPrm", "CapEff", "CapAmb")}
assert all(value == 0 for value in caps.values()), "NATIVE_WORKER_NO_CAPABILITIES"
assert int(status["NoNewPrivs"].strip()) == 1, "NATIVE_WORKER_NO_NEW_PRIVILEGES"
requests = (0x50009401, 0x5000940e, 0x5000940f, 0x50009417, 0x50009418, 0x4008941a, 0x5000943f)
fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
denied = []
try:
    for request in requests:
        try:
            fcntl.ioctl(fd, request, bytearray(4096))
        except OSError as error:
            assert error.errno == errno.EPERM, "NATIVE_WORKER_IOCTL_FILTER_DENIED"
            denied.append(request)
        else:
            raise AssertionError("NATIVE_WORKER_IOCTL_FILTER_DENIED")
finally:
    os.close(fd)
with tempfile.TemporaryFile(dir=".") as temporary:
    try:
        os.setxattr(temporary.fileno(), "trusted.overlay.whiteout", b"y")
    except OSError as error:
        assert error.errno == errno.EPERM, "NATIVE_WORKER_CANNOT_SPOOF_TRUSTED_OVERLAY"
    else:
        raise AssertionError("NATIVE_WORKER_CANNOT_SPOOF_TRUSTED_OVERLAY")
assert not os.path.exists("/brain-fixture/.brain-native/state"), "NATIVE_WORKER_PRIVATE_STATE_MASKED"
client = socket.socket(socket.AF_UNIX)
client.settimeout(0.5)
try:
    client.connect("/native-runtime/manager.sock")
except OSError as error:
    assert error.errno in (errno.ENOENT, errno.ECONNREFUSED), "NATIVE_WORKER_CONTROL_SOCKET_MASKED"
else:
    raise AssertionError("NATIVE_WORKER_CONTROL_SOCKET_MASKED")
finally:
    client.close()
proc_readonly = None
if expected_host_uid == 0:
    try:
        fd = os.open("/proc/sys/kernel/hostname", os.O_WRONLY)
    except OSError as error:
        assert error.errno == errno.EROFS, "NATIVE_ROOT_WORKER_PROC_READONLY"
        proc_readonly = True
    else:
        os.close(fd)
        raise AssertionError("NATIVE_ROOT_WORKER_PROC_READONLY")
print(json.dumps({"namespaceUid": os.getuid(), "namespaceGid": os.getgid(), "caps": caps, "ioctlsDenied": denied,
                  "trustedOverlayDenied": True, "privateStateMasked": True, "controlSocketMasked": True,
                  "procReadonly": proc_readonly}))
