"""Isolate a scoped #839 harness. Credentials remain memory-only, never arguments/files."""
import json, os, pathlib, subprocess, sys

def main():
    source = pathlib.Path(__file__).resolve().parents[3]
    mode = sys.argv[1]
    if mode not in ['offline', 'offline-review', 'offline-paid-review', 'review', 'live']:
        raise RuntimeError('Explicit harness mode required')
    bun = pathlib.Path(subprocess.run(['bun', '-e', 'console.log(process.execPath)'], capture_output=True, text=True, check=True).stdout.strip())
    args = ['bwrap', '--die-with-parent', '--new-session', '--unshare-all']
    env = {'PATH': '/usr/bin:/bin:' + str(bun.parent), 'HOME': '/tmp/isolated-home', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    if mode in ['review', 'live']:
        out = pathlib.Path(sys.argv[2]).resolve()
        if out.parent in [pathlib.Path('/tmp'), pathlib.Path('/')]:
            raise RuntimeError('Use a dedicated issue output parent, not the entire temporary filesystem')
        if out.exists():
            raise RuntimeError('Fresh protected output directory required')
        out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        args += ['--share-net']
        ledger = pathlib.Path(os.environ['BRAIN_SMART_CAP_LEDGER']).resolve()
        proof = pathlib.Path(sys.argv[3]).resolve()
        token = os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')
        if not token:
            login = json.loads((pathlib.Path.home() / '.claude/.credentials.json').read_text())
            token = login['claudeAiOauth']['accessToken']
        if not token:
            raise RuntimeError('Protected subscription token missing')
        policy = pathlib.Path(os.environ['BRAIN_SMART_PAID_POLICY']).resolve() if os.environ.get('BRAIN_SMART_PAID_POLICY') else None
        policy_dir = pathlib.Path(os.environ['BRAIN_SMART_PAID_POLICY_DIR']).resolve() if os.environ.get('BRAIN_SMART_PAID_POLICY_DIR') else None
        if not policy and not policy_dir:
            raise RuntimeError('Explicit root paid policy required, no automatic route fallback')
        if policy:
            env['BRAIN_SMART_PAID_POLICY'] = str(policy)
            grant_parent = pathlib.Path(json.loads(policy.read_text())['consumedMarkerPath']).parent.resolve()
        else:
            raise RuntimeError('Coordinator supplies one exact per-turn policy, never a prebuilt policy directory')
        if policy_dir:
            env['BRAIN_SMART_PAID_POLICY_DIR'] = str(policy_dir)
        env.update(CLAUDE_CODE_OAUTH_TOKEN=token, BRAIN_SMART_CAP_LEDGER=str(ledger), TMPDIR=str(out.parent))
        if mode == 'live':
            key = os.environ.get('TYPESAFE_API_KEY')
            if not key:
                raise RuntimeError('Protected Jev key missing')
            env.update(TYPESAFE_API_KEY=key, BRAIN_LIVE_EVAL='839')
        else:
            env['BRAIN_LIVE_REVIEW'] = '839'
        script = source / 'scripts/evals/smart-capture' / ('live.ts' if mode == 'live' else 'review.ts')
        command = [str(script), str(out), str(proof)]
    else:
        env['BRAIN_SMART_OFFLINE'] = '1'
        if mode == 'offline-review':
            env['BRAIN_SMART_READONLY_REVIEW'] = '1'
        if mode == 'offline-paid-review':
            out = pathlib.Path(sys.argv[2]).resolve()
            if out.exists() or out.parent in [pathlib.Path('/tmp'), pathlib.Path('/')]:
                raise RuntimeError('Fresh dedicated protected offline output required')
            out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            command = [str(source / 'scripts/evals/smart-capture/offline-paid-probe.ts'), str(out), sys.argv[3] if len(sys.argv) > 3 else 'paid-allowed']
        else:
            command = [str(source / 'scripts/evals/smart-capture/offline-probe.ts')]
    for system in ['/usr', '/bin', '/lib', '/lib64']:
        args += ['--ro-bind', system, system]
    for system in ['/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']:
        if pathlib.Path(system).exists():
            args += ['--ro-bind', system, system]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', str(source), str(source), '--ro-bind', str(bun), str(bun), '--chdir', str(source)]
    # Writable destinations must be mounted after /tmp is created.
    if mode in ['review', 'live']:
        if policy: args += ['--ro-bind', str(policy), str(policy), '--bind', str(grant_parent), str(grant_parent)]
        if policy_dir: args += ['--ro-bind', str(policy_dir), str(policy_dir)]
        args += ['--bind', str(out.parent), str(out.parent), '--ro-bind', str(ledger), str(ledger), '--ro-bind', str(proof), str(proof)]
    if mode == 'offline-paid-review':
        args += ['--bind', str(out.parent), str(out.parent)]
    args += ['--', str(bun)]
    if mode in ['offline', 'offline-review']:
        args += ['--preload', str(source / 'scripts/captures/clock.ts')]
    args += command
    return subprocess.run(args, env=env).returncode

if __name__ == '__main__':
    sys.exit(main())
