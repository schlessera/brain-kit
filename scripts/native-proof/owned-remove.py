"""Finite removal of this fixture's exclusively created empty loop entry.

Reads only: validation must never open the block device. Kernel removal still
refuses bound/open devices; userspace cannot close the free-allocator TOCTOU.
"""
import errno
import fcntl
import os
import pathlib
import re
import stat
import time

LIMIT_NS = 1_000_000_000
SPACING_NS = 20_000_000
SYSFS_LINK = pathlib.Path('/sys/dev/block/7:1790')
MOUNTINFO = pathlib.Path('/proc/self/mountinfo')
MAX_ATTEMPTS = 50  # Includes the initial call, not 50 retries.


def identity(path):
    value = path.lstat()
    return tuple(getattr(value, key) for key in
                 ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_rdev'))


def validate(device, node_identity, entry, entry_identity, mountinfo):
    try: current_node = identity(device)
    except FileNotFoundError: raise RuntimeError('Owned remove device vanished')
    if current_node != node_identity or not stat.S_ISBLK(node_identity[4]) or node_identity[5] != os.makedev(7, 1790):
        raise RuntimeError('Owned remove device identity lost')
    try: current_entry = identity(entry)
    except FileNotFoundError: raise RuntimeError('Owned remove sysfs vanished')
    if current_entry != entry_identity or not stat.S_ISDIR(entry_identity[4]):
        raise RuntimeError('Owned remove sysfs identity lost')
    if SYSFS_LINK.resolve(strict=True) != entry:
        raise RuntimeError('Owned remove sysfs mapping changed')
    if (entry / 'dev').read_text() != '7:1790\n' or (entry / 'size').read_text().strip() != '0':
        raise RuntimeError('Owned remove entry changed or nonempty')
    if os.path.lexists(entry / 'loop') or list((entry / 'holders').iterdir()):
        raise RuntimeError('Owned remove entry rebound or held')
    for line in mountinfo.read_text().splitlines():
        fields = line.split()
        separator = fields.index('-')
        decode = lambda text: re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), text)
        # Btrfs uses anonymous 0:NN, so device numbers alone are insufficient.
        if fields[2] == '7:1790' or decode(fields[4]) == '/brain-fixture' or decode(fields[separator + 2]) in (str(device), '/dev/loop1790'):
            raise RuntimeError('Owned remove entry still mounted')


def remove_owned(control, device, node_identity, entry, entry_identity, receipt):
    first_busy = None
    original = None
    t0 = time.monotonic_ns()
    receipt.update(attempts=[], outcome='failed', identityCaptured=True)
    try:
        for number in range(MAX_ATTEMPTS):
            validate(device, node_identity, entry, entry_identity, MOUNTINFO)
            began = time.monotonic_ns()
            if first_busy is not None and began - first_busy >= LIMIT_NS:
                raise original
            attempt = dict(startNs=began - t0)
            receipt['attempts'].append(attempt)
            try:
                fcntl.ioctl(control, 0x4c81, 1790)
            except OSError as error:
                ended = time.monotonic_ns()
                attempt.update(endNs=ended - t0, errno=error.errno, error=str(error))
                if error.errno != errno.EBUSY:
                    raise
                if original is None:
                    original, first_busy = error, ended
                if ended - first_busy >= LIMIT_NS:
                    raise original
                time.sleep(SPACING_NS / 1_000_000_000)
            else:
                attempt.update(endNs=time.monotonic_ns() - t0, errno=None)
                receipt['outcome'] = 'removed'
                return
        raise original
    except BaseException as error:
        receipt['failure'] = str(error)
        if original is not None:
            receipt['originalEBUSY'] = str(original)
        raise


def remove_after_capture_failure(control, receipt):
    """Preserve main's one-shot cleanup if exclusive ADD preceded failed capture.

    This is never retry authority: the fixture already failed and must stay failed.
    """
    t0 = time.monotonic_ns()
    receipt.update(attempts=[], outcome='failed', identityCaptured=False,
                   reason='exclusive ADD succeeded but initial identity capture failed', retry=False)
    attempt = dict(startNs=0)
    receipt['attempts'].append(attempt)
    try:
        fcntl.ioctl(control, 0x4c81, 1790)
    except OSError as error:
        attempt.update(endNs=time.monotonic_ns() - t0, errno=error.errno, error=str(error))
        receipt['failure'] = str(error)
        raise
    else:
        attempt.update(endNs=time.monotonic_ns() - t0, errno=None)
        receipt['outcome'] = 'removed'
