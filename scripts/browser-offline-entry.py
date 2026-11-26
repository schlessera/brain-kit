"""Give the network-none browser container a route-free online indicator, then drop setup authority."""
import os
from pathlib import Path
import socket
import struct
import sys


def attribute(kind, data):
    length = len(data) + 4
    return struct.pack('HH', length, kind) + data + b'\0' * (-length % 4)


def request(kind, payload, create=False):
    # Linux rtnetlink.h/if_link.h: REQUEST|ACK, optionally CREATE|EXCL.
    flags = 1 | 4 | (1024 | 512 if create else 0)
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE) as channel:
        channel.bind((0, 0))
        channel.send(struct.pack('IHHII', len(payload) + 16, kind, flags, 1, 0) + payload)
        reply = channel.recv(65536)
        error = struct.unpack_from('i', reply, 16)[0]
        if error:
            raise OSError(-error, 'browser indicator netlink setup')


def main():
    uid, gid = int(sys.argv[1]), int(sys.argv[2])
    # IFLA_IFNAME=3, LINKINFO=18, INFO_KIND=1.
    info = struct.pack('BBHiII', 0, 0, 0, 0, 0, 0)
    request(16, info + attribute(3, b'offline0\0') + attribute(18, attribute(1, b'dummy\0')), create=True)
    index = socket.if_nametoindex('offline0')
    # IFA_ADDRESS=1, LOCAL=2, FLAGS=8; IFA_F_NOPREFIXROUTE=0x200.
    address = socket.inet_aton('198.18.0.1')
    request(20, struct.pack('BBBBI', socket.AF_INET, 32, 0, 0, index) +
            attribute(1, address) + attribute(2, address) + attribute(8, struct.pack('I', 0x200)), create=True)
    request(16, struct.pack('BBHiII', 0, 0, 0, index, 1, 1))
    for line in Path('/proc/net/route').read_text().splitlines()[1:]:
        if line.split()[0] != 'lo':
            raise RuntimeError('BROWSER_INDICATOR_MUST_NOT_ADD_A_ROUTE')
    for line in Path('/proc/net/ipv6_route').read_text().splitlines():
        if line.split()[-1] != 'lo':
            raise RuntimeError('BROWSER_INDICATOR_MUST_NOT_ADD_A_ROUTE')
    os.execvp('setpriv', ['setpriv', f'--reuid={uid}', f'--regid={gid}', '--clear-groups',
                         '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all',
                         '--no-new-privs', *sys.argv[3:]])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('OFFLINE_SETUP_REFUSAL browser container: ' + str(error), file=sys.stderr)
        sys.exit(125)
