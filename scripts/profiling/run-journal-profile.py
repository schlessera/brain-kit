"""Reproduce the finite #1752 spike in its own offline native fixture.

Restore the archived scripts/profiling sources into measured main first.
Example: python3 scripts/profiling/run-journal-profile.py --source . --out /tmp/odysseus-profile --mode complete
"""
import argparse
import json
import pathlib
import subprocess
import uuid

p = argparse.ArgumentParser()
p.add_argument("--source", type=pathlib.Path, required=True)
p.add_argument("--out", type=pathlib.Path, required=True)
p.add_argument("--mode", choices=("pilot", "complete"), required=True)
args = p.parse_args()
source, out = args.source.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
security = json.loads(subprocess.check_output(["docker", "info", "--format", "{{json .SecurityOptions}}"], text=True))
apparmor = any(s.startswith("name=apparmor") for s in security)
(out / "native-environment.json").write_text(json.dumps({"apparmor": apparmor}))
fixture = (source / "scripts/native-proof/fixture.py").read_text()
fixture = fixture.replace("MINOR = 1790", "MINOR = 1752").replace("/sys/block/loop1790", "/sys/block/loop1752")
old = 'run(["/usr/local/bin/bun", "run", "test", str(pathlib.Path(__file__).with_name("hosted-app.test.ts"))], timeout=180)'
if old not in fixture:
    raise RuntimeError("Measured native fixture command moved; review rather than guessing ownership/cleanup")
tests = ["/repo/scripts/profiling/journal-capture.test.ts"] if args.mode == "pilot" else [
    "/repo/scripts/profiling/journal-capture-complete.test.ts", "/repo/scripts/profiling/journal-suspension.test.ts"]
replacement = 'os.environ["BRAIN_JOURNAL_PROFILE_OWNED"] = "1752"\n    run(' + repr(["/usr/local/bin/bun", "run", "test"] + tests) + ', timeout=1200)'
(out / "fixture.py").write_text(fixture.replace(old, replacement))
lease = source / "tmp/workspace-operation"
lease.mkdir(parents=True, exist_ok=True)
bun = pathlib.Path(subprocess.check_output(["which", "bun"], text=True).strip()).resolve()
argv = ["docker", "run", "--name", "brain-kit-profile1752-" + uuid.uuid4().hex[:12], "--rm", "--pull=never", "--network=none", "--cap-drop=ALL"]
argv += ["--cap-add=" + c for c in ("SYS_ADMIN", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID", "SETFCAP")]
argv += ["--security-opt=no-new-privileges", "--security-opt=seccomp=" + str(source / "scripts/native-proof/seccomp.json"), "--security-opt=systempaths=unconfined"]
if apparmor:
    argv += ["--security-opt=apparmor=brain-kit-native-proof"]
argv += ["--device=/dev/loop-control", "--device-cgroup-rule=b 7:1752 rwm"]
for host, guest, readonly in [(out, "/proof", False), (source, "/repo", True), (lease, "/repo/tmp/workspace-operation", False), (bun, "/usr/local/bin/bun", True)]:
    argv += ["--mount", "type=bind,source=" + str(host) + ",target=" + guest + (",readonly" if readonly else "")]
argv += ["--workdir=/repo", "brain-kit-native-runtime:1", "/proof/fixture.py", "claude", "0"]
with (out / "run.log").open("wb") as log:
    try:
        completed = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=1320)
    except BaseException:
        # Signal only this invocation's random named container. The native
        # fixture catches SIGTERM and attempts its identity-checked cleanup.
        subprocess.run(["docker", "stop", "--time", "30", argv[3]], stdout=log, stderr=subprocess.STDOUT, timeout=40)
        raise
raise SystemExit(completed.returncode)
