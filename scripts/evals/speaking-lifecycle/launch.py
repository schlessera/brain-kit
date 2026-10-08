"""Keyless native controls: isolated source read-only, no external network/auth."""
import os, pathlib, subprocess, sys

def main():
    source = pathlib.Path(__file__).resolve().parents[3]
    mode = sys.argv[1] if len(sys.argv) > 1 else 'read'
    if mode not in ['read', 'cli', 'write-denial', 'archive', 'review', 'cli-direct', 'current-cell', 'cli-escape']:
        raise RuntimeError('This launcher admits only bounded offline controls')
    bun = pathlib.Path(subprocess.run(['bun', '-e', 'console.log(process.execPath)'], capture_output=True, text=True, check=True).stdout.strip())
    args = ['bwrap', '--die-with-parent', '--new-session', '--unshare-all']
    for system in ['/usr', '/bin', '/lib', '/lib64']:
        args += ['--ro-bind', system, system]
    for system in ['/etc/ssl', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']:
        if pathlib.Path(system).exists():
            args += ['--ro-bind', system, system]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', str(source), str(source), '--ro-bind', str(bun), str(bun), '--chdir', str(source)]
    script = source / 'scripts/evals/speaking-lifecycle/offline-probe.ts'
    env = {'PATH': '/usr/bin:/bin:' + str(bun.parent), 'HOME': '/tmp/isolated-home', 'BRAIN_SPEAKING_OFFLINE': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    command = [str(script), mode]
    if len(sys.argv) > 2:
        destination = pathlib.Path(sys.argv[2]).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if destination.exists() or destination.parent in [pathlib.Path('/'), pathlib.Path('/tmp')]:
            raise RuntimeError('Fresh receipt in dedicated output parent required')
        args += ['--bind', str(destination.parent), str(destination.parent)]
        command += [str(destination)]
    args += ['--', str(bun)] + command
    return subprocess.run(args, env=env).returncode

if __name__ == '__main__':
    sys.exit(main())
