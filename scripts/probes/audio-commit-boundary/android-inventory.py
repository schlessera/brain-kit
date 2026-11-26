#!/usr/bin/env python3
"""Verify SDK revision pins. This is inventory, not a doctor/boot receipt."""
import json
import pathlib
import sys


def inventory(sdk):
    pins = json.loads(pathlib.Path(__file__).with_name('android-pins.json').read_text())
    checks = []
    for relative, expected in [
        ('cmdline-tools/latest', pins['commandLineTools']),
        ('emulator', pins['emulator']),
        ('platform-tools', pins['platformTools']),
        ('system-images/android-35/google_apis/x86_64', pins['systemImageRevision']),
    ]:
        props = pathlib.Path(sdk, relative, 'source.properties')
        values = dict(line.split('=', 1) for line in props.read_text().splitlines()
                      if '=' in line) if props.exists() else {}
        actual = values.get('Pkg.Revision')
        checks.append({'component': relative, 'expected': expected, 'actual': actual,
                       'pass': actual == expected})
    return {'kind': 'sdk-inventory-only', 'checks': checks,
            'pass': all(c['pass'] for c in checks)}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: python3 android-inventory.py <sdk-root>')
    result = inventory(sys.argv[1])
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['pass'] else 1)
