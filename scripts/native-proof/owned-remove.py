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
MAX_ATTEMPTS = 50  # Includes the initial call, not 50 retries.


def identity(path):
    value = path.lstat()
    return tuple(getattr(value, key) for key in
                 ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_rdev'))


def validate(device, node_identity, entry, entry_identity, mountinfo):
    if identity(device) != node_identity or not stat.S_ISBLK(node_identity[4]) or node_identity[5] != os.makedev(7, 1790):
        raise RuntimeError('Owned remove device identity lost')
    if identity(entry) != entry_identity or not stat.S_ISDIR(entry_identity[4]):
        raise RuntimeError('Owned remove sysfs identity lost')
    if pathlib.Path('/sys/dev/block/7:1790').resolve(strict=True) != entry:
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
    receipt.update(attempts=[], outcome='failed')
    try:
        for number in range(MAX_ATTEMPTS):
            if first_busy is not None and time.monotonic_ns() - first_busy >= LIMIT_NS:
                raise original
            validate(device, node_identity, entry, entry_identity, pathlib.Path('/proc/self/mountinfo'))
            began = time.monotonic_ns()
            if first_busy is not None and began - first_busy >= LIMIT_NS:
                raise original
            attempt = dict(startNs=began)
            receipt['attempts'].append(attempt)
            try:
                fcntl.ioctl(control, 0x4c81, 1790)
            except OSError as error:
                ended = time.monotonic_ns()
                attempt.update(endNs=ended, errno=error.errno, error=str(error))
                if error.errno != errno.EBUSY:
                    raise
                if original is None:
                    original, first_busy = error, ended
                if number + 1 == MAX_ATTEMPTS or ended - first_busy >= LIMIT_NS:
                    raise original
                time.sleep(SPACING_NS / 1_000_000_000)
            else:
                attempt.update(endNs=time.monotonic_ns(), errno=None)
                receipt['outcome'] = 'removed'
                return
        raise original
    except BaseException as error:
        receipt['failure'] = str(error)
        if original is not None:
            receipt['originalEBUSY'] = str(original)
        raise
