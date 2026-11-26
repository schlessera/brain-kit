#!/usr/bin/env python3
"""Command-scoped Linux test isolation; descendants inherit the namespaces."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def refuse(error):
    # Never include command arguments or environment values in a setup diagnostic.
    print('OFFLINE_SETUP_REFUSAL ' + json.dumps({
        'cause': str(error), 'errorClass': type(error).__name__}), file=sys.stderr)
    return 125


def clean_env(env):
    names = json.loads(Path(__file__).with_name('test-credential-names.json').read_text())
    return {key: value for key, value in env.items() if not (
        key.startswith(tuple(names['prefixes'])) or key.endswith(tuple(names['suffixes'])))}


def already_inside(browser=False):
    try:
        ip = shutil.which('ip')
        def query(*args):
            return json.loads(subprocess.check_output([ip, '-j', *args], stderr=subprocess.DEVNULL))
        allowed = {'lo', 'offline0', 'offline1'} if browser else {'lo'}
        links = query('link', 'show')
        managed = Path('/etc/claude-code')
        hidden = not managed.exists() or any(
            row.split()[4] == str(managed) and row.split(' - ', 1)[1].startswith('tmpfs ')
            for row in Path('/proc/self/mountinfo').read_text().splitlines())
        return hidden and (not browser or any(row['ifname'] == 'offline0' and 'UP' in row['flags'] for row in links)) and any(row['ifname'] == 'lo' and 'UP' in row['flags'] for row in links) and all(
            row['ifname'] in allowed for row in links) and all(not query(family, 'route', 'show', 'table', 'main') for family in ('-4', '-6'))
    except (OSError, ValueError, subprocess.CalledProcessError, TypeError):
        return False


def setup(data):
    # sudo closes extra descriptors. Restore main's existing workspace lease
    # from the waiting launcher before dropping setup authority.
    if data.get('lease_fd') is not None:
        fd = data['lease_fd']
        try:
            os.fstat(fd)  # The unprivileged path already preserves it.
        except OSError:
            restored = os.open(f"/proc/{data['launcher_pid']}/fd/{fd}", os.O_RDONLY)
            if restored != fd:
                os.dup2(restored, fd)
                os.close(restored)
        os.set_inheritable(fd, True)
    libc = ctypes.CDLL(None, use_errno=True)
    def mount(source, target, kind, flags=0, options=None):
        args = [part.encode() if isinstance(part, str) else part
                for part in (source, target, kind, flags, options)]
        if libc.mount(*args) != 0:
            raise OSError(ctypes.get_errno(), 'mount ' + target)
    # No mount changes may propagate back to the invoking host.
    mount(None, '/', None, 1 << 14 | 1 << 18)
    managed = '/etc/claude-code'
    if os.path.exists(managed):
        mount('tmpfs', managed, 'tmpfs', 0, 'mode=000,size=4096')
    ip = shutil.which('ip')
    if not ip:
        raise RuntimeError('ip executable unavailable')
    subprocess.run([ip, 'link', 'set', 'lo', 'up'], check=True, capture_output=True)
    if data.get('browser'):
        # A route-free link gives Chrome its online indicator without an egress route.
        dummy = subprocess.run([ip, 'link', 'add', 'offline0', 'type', 'dummy'], capture_output=True) if Path('/sys/module/dummy').exists() else None
        if dummy is None or dummy.returncode:
            subprocess.run([ip, 'link', 'add', 'offline0', 'type', 'veth', 'peer', 'name', 'offline1'],
                           check=True, capture_output=True)
            subprocess.run([ip, 'link', 'set', 'offline1', 'addrgenmode', 'none'], check=True, capture_output=True)
            subprocess.run([ip, 'link', 'set', 'offline1', 'up'], check=True, capture_output=True)
        subprocess.run([ip, 'link', 'set', 'offline0', 'addrgenmode', 'none'], check=True, capture_output=True)
        subprocess.run([ip, '-4', 'address', 'add', '198.18.0.1/32', 'dev', 'offline0', 'noprefixroute'], check=True, capture_output=True)
        subprocess.run([ip, 'link', 'set', 'offline0', 'up'], check=True, capture_output=True)
    if os.geteuid() == 0:
        os.setgroups(data['groups'])
        os.setgid(data['gid'])
        os.setuid(data['uid'])
    if (os.getuid(), os.getgid()) != (data['uid'], data['gid']) or (
            not data.get('unprivileged') and sorted(os.getgroups()) != sorted(data['groups'])):
        raise RuntimeError('caller identity could not be restored')
    os.chdir(data['cwd'])
    Path(data['started']).touch()
    setpriv = shutil.which('setpriv')
    if not setpriv:
        raise RuntimeError('setpriv executable unavailable')
    os.execvpe(setpriv, [setpriv, '--inh-caps=-all', '--ambient-caps=-all',
                       *data['argv']], data['env'])


def main(argv):
    if argv[:1] == ['--inside']:
        try:
            setup(json.loads(Path(argv[1]).read_text()))
        except Exception as error:
            return refuse(error)
    browser = argv[:1] == ['--browser-online']
    if browser:
        argv = argv[1:]
    if argv == ['--check']:
        return 0 if already_inside(browser) else 1
    if not argv:
        return refuse(RuntimeError('no command supplied'))
    if sys.platform != 'linux':
        return refuse(RuntimeError('Linux namespaces required'))
    try:
        unshare = shutil.which('unshare')
        if not unshare:
            raise RuntimeError('unshare executable unavailable')
        # Supplementary groups may display as overflow IDs in a user namespace.
        # The kernel still uses the caller's real groups for permission checks.
        probe = subprocess.run([unshare, '--user', '--map-current-user', '--net', '--mount',
            sys.executable, '-I', '-S', '-c',
            'import os,json; print(json.dumps([os.getuid(),os.getgid(),sorted(os.getgroups())]))'],
            capture_output=True)
        expected = [os.getuid(), os.getgid()]
        unprivileged = probe.returncode == 0 and json.loads(probe.stdout)[:2] == expected
        prefix = [unshare, '--net', '--mount']
        if unprivileged:
            prefix += ['--user', '--map-current-user', '--keep-caps']
        elif os.geteuid() != 0:
            sudo = shutil.which('sudo')
            if not sudo:
                raise RuntimeError('unprivileged namespaces unavailable and sudo unavailable')
            prefix = [sudo, '-n', '--'] + prefix
        with tempfile.TemporaryDirectory(prefix='brain-offline-command-') as scratch:
            home, config = Path(scratch, 'home'), Path(scratch, 'config')
            home.mkdir(mode=0o700)
            config.mkdir(mode=0o700)
            env = clean_env(dict(os.environ))
            env.update(HOME=str(home), CLAUDE_CONFIG_DIR=str(config))
            lease_fd = None
            try:
                candidate = json.loads(env.get('BRAIN_WORKSPACE_LEASE', '{}')).get('fd')
                if isinstance(candidate, int) and candidate >= 3:
                    os.fstat(candidate)
                    lease_fd = candidate
            except (ValueError, OSError):
                pass
            data = dict(unprivileged=unprivileged, lease_fd=lease_fd, launcher_pid=os.getpid(), uid=os.getuid(), gid=os.getgid(), groups=os.getgroups(),
                        cwd=os.getcwd(), argv=argv, browser=browser, env=env, started=str(Path(scratch, 'started')))
            record = Path(scratch, 'command.json')
            record.write_text(json.dumps(data))
            record.chmod(0o600)
            result = subprocess.run(prefix + [sys.executable, '-I', '-S',
                                    str(Path(__file__).resolve()), '--inside', str(record)],
                                    pass_fds=() if lease_fd is None else (lease_fd,))
            if result.returncode != 0 and not Path(data['started']).exists() and result.returncode != 125:
                # unshare/sudo report their own setup cause on stderr.
                return refuse(RuntimeError('namespace setup or command failed; see preceding stderr'))
            return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except Exception as error:
        return refuse(error)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
