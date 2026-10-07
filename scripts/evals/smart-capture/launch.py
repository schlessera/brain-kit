"""Isolate a scoped #839 harness. Credentials remain memory-only, never arguments/files."""
import json, os, pathlib, subprocess, sys

def main():
    source = pathlib.Path(__file__).resolve().parents[3]
    mode = sys.argv[1]
    if mode not in ['offline', 'offline-review', 'review', 'live']:
        raise RuntimeError('Explicit harness mode required')
    bun = pathlib.Path(subprocess.run(['bun', '-e', 'console.log(process.execPath)'], capture_output=True, text=True, check=True).stdout.strip())
    args = ['bwrap', '--die-with-parent', '--new-session', '--unshare-all']
    env = {'PATH': '/usr/bin:/bin:' + str(bun.parent), 'HOME': '/tmp/isolated-home', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    if mode in ['review', 'live']:
        out = pathlib.Path(sys.argv[2]).resolve()
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
        command = [str(source / 'scripts/evals/smart-capture/offline-probe.ts')]
    for system in ['/usr', '/bin', '/lib', '/lib64', '/etc']:
        args += ['--ro-bind', system, system]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', str(source), str(source), '--ro-bind', str(bun), str(bun), '--chdir', str(source)]
    # Writable destinations must be mounted after /tmp is created.
    if mode in ['review', 'live']:
        args += ['--bind', str(out.parent), str(out.parent), '--ro-bind', str(ledger), str(ledger), '--ro-bind', str(proof), str(proof)]
    args += ['--', str(bun)]
    if mode.startswith('offline'):
        args += ['--preload', str(source / 'scripts/captures/clock.ts')]
    args += command
    return subprocess.run(args, env=env).returncode

if __name__ == '__main__':
    sys.exit(main())
