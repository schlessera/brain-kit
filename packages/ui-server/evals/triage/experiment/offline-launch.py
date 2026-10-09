"""Owned native fixture launcher. No credential inheritance or host network namespace.

Execute with a verified Bun >=1.4.0 and an explicit fresh output directory.
CAP_NET_ADMIN exists only in the disposable user/network namespace to raise loopback.
Timeout cleanup is recorded from observed waits; a timeout is never a success receipt.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not (0 < args.timeout <= 60):
        raise ValueError("finite bounded timeout required")
    root = Path(__file__).resolve().parents[5]
    runtime = Path(args.bun).resolve()
    destination = Path(args.output)
    destination.mkdir(parents=True, exist_ok=False)
    commands = ["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--cap-add", "CAP_NET_ADMIN",
                "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr",
                "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--ro-bind", "/lib", "/lib",
                "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                "--ro-bind", str(root), str(root), "--ro-bind", str(runtime.parent), str(runtime.parent),
                "--chdir", str(root), "/bin/sh", "-c", 'ip link set lo up && exec "$@"', "sh",
                str(runtime), str(root / "packages/ui-server/evals/triage/experiment/native-offline.ts")]
    environment = {"PATH": "/usr/sbin:/usr/bin:/bin", "HOME": "/tmp", "CLAUDE_CONFIG_DIR": "/tmp",
                   "BRAIN_TRIAGE_OFFLINE": "1", "BRAIN_TRIAGE_PARENT_NET": os.readlink("/proc/self/ns/net")}
    start = time.monotonic()
    timed_out = False
    with (destination / "stdout.json").open("wb") as output, (destination / "stderr.txt").open("wb") as errors:
        child = subprocess.Popen(commands, cwd=root, env=environment, stdout=output, stderr=errors, start_new_session=True)
        try:
            code = child.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try:
                code = child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                code = child.wait(timeout=3)
    receipt = {"mode": "offline fixture only", "pid": child.pid, "observedExit": code, "timeout": timed_out,
               "bwrapWaitCompleted": child.poll() is not None, "durationSeconds": time.monotonic() - start,
               "containment": "distinct network/user/PID namespace; read-only source/runtime; empty scratch home; loopback only",
               "stdoutSHA256": hashlib.sha256((destination / "stdout.json").read_bytes()).hexdigest(),
               "stderrSHA256": hashlib.sha256((destination / "stderr.txt").read_bytes()).hexdigest()}
    (destination / "lifecycle.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if timed_out or code != 0:
        raise RuntimeError("native fixture launcher failed; retained raw output and lifecycle receipt")
    result = json.loads((destination / "stdout.json").read_text())
    assert result["failure"] is None and result["drained"], "real SDK/native triage execution failed"
    assert len(result["physical"]) == 1, "exact scripted physical request missing"
    assert len(result["parsedRows"]) == 8, "real parsed triage rows missing"
    assert result["accounting"]["complete"], "native final usage receipt is incomplete"
    assert result["accounting"]["rows"][0]["output"] == 23, "provisional output replaced terminal usage"
    assert all(p["closed"] and p["stdoutFinished"] and not p["forcedKill"] for p in result["processes"]), "native child closure/drain missing"
    receipt["assertionsPassed"] = True
    (destination / "lifecycle.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
