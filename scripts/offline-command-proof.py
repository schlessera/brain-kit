#!/usr/bin/env python3
"""Small runtime proof; run outside the test namespace on a disposable Linux runner."""
import argparse
import os
from pathlib import Path
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--uid', type=int, required=True)
    parser.add_argument('--gid', type=int, required=True)
    parser.add_argument('--groups', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0, 'Proof setup needs root on a disposable runner'
    groups = [int(value) for value in args.groups.split(',')]
    def caller():
        os.setgroups(groups)
        os.setgid(args.gid)
        os.setuid(args.uid)
    original = Path(__file__).with_name('offline-command.py').read_text()
    managed = Path('/etc/claude-code')
    created = not managed.exists()
    if created:
        managed.mkdir()
    sentinel = managed / ('odysseus-offline-proof-' + uuid.uuid4().hex)
    sentinel.write_text('Ithaca')
    ip = shutil.which('ip')
    assert ip and subprocess.run([ip, 'link', 'show', 'offline0'], capture_output=True).returncode != 0, 'Proof needs an unused offline0 name'
    server = socket.socket()
    server.bind(('0.0.0.0', 0))
    server.listen()
    route = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    route.connect(('192.0.2.1', 9))  # Address selection only; no packet is sent.
    address = route.getsockname()[0]
    route.close()
    try:
        with tempfile.TemporaryDirectory(prefix='brain-offline-proof-') as directory:
            root = Path(directory)
            root.chmod(0o755)
            launcher = root / 'launcher.py'
            def run(source, code, env=None):
                launcher.write_text(source)
                launcher.chmod(0o644)
                return subprocess.run([sys.executable, '-I', '-S', str(launcher),
                    sys.executable, '-I', '-S', '-c', code], preexec_fn=caller,
                    env={'PATH':'/usr/local/bin:/usr/bin:/bin', 'ANTHROPIC_API_KEY':'odysseus-fixture-key', **(env or {})},
                    text=True, capture_output=True, timeout=30, cwd=Path(__file__).resolve().parent.parent)
            network = f'''import socket
try:
 s=socket.create_connection(({address!r},{server.getsockname()[1]}),timeout=2)
except OSError: pass
else: raise AssertionError('NETWORK_MUST_BE_LOOPBACK_ONLY')
'''
            settings = f'''from pathlib import Path
try: Path({str(sentinel)!r}).read_bytes()
except (FileNotFoundError,PermissionError): pass
else: raise AssertionError('MANAGED_SETTINGS_MUST_BE_HIDDEN')
'''
            credentials = "import os; assert 'ANTHROPIC_API_KEY' not in os.environ, 'PROVIDER_CREDENTIAL_MUST_BE_ABSENT'"
            cases = [
                ('NETWORK_MUST_BE_LOOPBACK_ONLY', network, original.replace("prefix = [unshare, '--net', '--mount']", "prefix = [unshare, '--mount']")),
                ('MANAGED_SETTINGS_MUST_BE_HIDDEN', settings, original.replace("mount('tmpfs', managed, 'tmpfs', 0, 'mode=000,size=4096')", 'pass')),
                ('PROVIDER_CREDENTIAL_MUST_BE_ABSENT', credentials, original.replace('env = clean_env(dict(os.environ))', 'env = dict(os.environ)')),
            ]
            for name, code, mutant in cases:
                assert mutant != original
                green = run(original, code)
                assert green.returncode == 0, (name, green.stderr)
                try:
                    red = run(mutant, code)
                finally:
                    # Removing --net lets the one network mutation create its indicator here.
                    if name == 'NETWORK_MUST_BE_LOOPBACK_ONLY':
                        subprocess.run([ip, 'link', 'del', 'offline0'], check=True, capture_output=True)
                assert red.returncode != 0 and name in red.stderr, (name, red.stderr)
                restored = run(original, code)
                assert restored.returncode == 0, (name, restored.stderr)
                print(name + ': baseline PASS; mutation FAIL on named assertion; restored PASS', flush=True)
            refused = run(original, "raise AssertionError('PAYLOAD_MUST_NOT_START')", {'PATH': '/nonexistent'})
            assert refused.returncode == 125 and 'OFFLINE_SETUP_REFUSAL' in refused.stderr and 'unshare executable unavailable' in refused.stderr
            assert 'PAYLOAD_MUST_NOT_START' not in refused.stderr
            print('SETUP_FAILURE_REFUSES_COMMAND_AND_LOGS_CAUSE: PASS', flush=True)
            samples = []
            for _ in range(5):
                start = time.monotonic()
                result = run(original, 'pass')
                assert result.returncode == 0, result.stderr
                samples.append((time.monotonic() - start) * 1000)
            print('NEXT_COMMAND_RETRIES_SETUP: PASS', flush=True)
            print('COMMAND_STARTUP_MS: ' + str(dict(samples=samples, median=statistics.median(samples))), flush=True)
    finally:
        server.close()
        sentinel.unlink()
        if created:
            managed.rmdir()


if __name__ == '__main__':
    main()
