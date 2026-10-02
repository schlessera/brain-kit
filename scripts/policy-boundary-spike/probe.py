"""Bounded offline Linux experiment; never opens a real brain or provider key."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
GOLDEN = b"Odysseus: only the server owns policy writes.\n"
PAYLOAD = b"Odysseus: agent changed the policy.\n"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sandbox(brain, scratch, profile, bun, operation, target):
    command = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session",
               "--cap-drop", "ALL", "--ro-bind", "/", "/", "--proc", "/proc",
               "--dev", "/dev", "--tmpfs", "/tmp"]
    # /tmp is deliberately hidden. Re-expose only the checkout (read-only)
    # and this probe's owned fixture directories.
    checkout = HERE.parents[1]
    command += ["--ro-bind", str(checkout), str(checkout),
                "--ro-bind", str(brain), str(brain)]
    if profile == "host-scratch":
        command += ["--bind", str(scratch), str(scratch)]
    else:
        # A separate empty filesystem cannot carry writable policy hardlinks.
        command += ["--tmpfs", str(scratch)]
    if profile in ("path-only", "mutation"):
        command += ["--bind", str(brain), str(brain)]
    if profile == "path-only":
        command += ["--ro-bind", str(brain / "context/policies"), str(brain / "context/policies")]
    command += ["--clearenv", "--setenv", "PATH", os.environ["PATH"],
                "--setenv", "PI_CODING_AGENT_DIR", str(scratch / "pi"),
                "--chdir", str(brain), "--", bun, str(HERE / "worker.ts"),
                operation, str(brain), str(scratch), str(target)]
    return command


def landlock_child():
    """Separate native-thread experiment: open descriptor precedes restriction."""
    brain, scratch = map(Path, sys.argv[2:4])
    target = brain / "context/policies/rule.md"
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # x86_64 Linux syscall IDs. Probe the ABI; unsupported is a refusal.
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 3:
        raise RuntimeError(f"Landlock ABI >=3 required; got {abi}, errno {ctypes.get_errno()}")
    fd = os.open(target, os.O_WRONLY)
    handled = (1 << 1) | (1 << 4) | (1 << 5) | sum(1 << i for i in range(6, 15))
    attr = ctypes.c_uint64(handled)
    ruleset = libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    require(ruleset >= 0, f"create ruleset errno {ctypes.get_errno()}")
    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]
    directory = os.open(scratch, os.O_PATH | os.O_CLOEXEC)
    rule = PathRule(handled, directory)
    require(libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0) == 0, "add rule failed")
    require(libc.prctl(38, 1, 0, 0, 0) == 0, "no_new_privs failed")
    require(libc.syscall(446, ruleset, 0) == 0, "restrict_self failed")
    os.close(ruleset)
    os.close(directory)
    denied = False
    try:
        target.write_bytes(PAYLOAD)
    except PermissionError:
        denied = True
    require(denied, "Landlock did not deny new policy open")
    (scratch / "allowed.md").write_bytes(PAYLOAD)
    require(target.read_bytes() == GOLDEN, "policy changed before descriptor attack")
    os.write(fd, PAYLOAD)
    os.close(fd)
    require(target.read_bytes() != GOLDEN, "expected preopened descriptor escape absent")
    print(json.dumps({"probe": "Landlock post-open", "abi": abi, "new_open_denied": denied,
                      "preopened_descriptor_changed_policy": True, "scratch_write": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutation", action="store_true", help="remove brain read-only mount; MUST fail safety assertion")
    args = parser.parse_args()
    require(platform.system() == "Linux" and platform.machine() == "x86_64", "experiment requires Linux x86_64")
    bun = shutil.which("bun")
    require(bun and shutil.which("bwrap"), "bun and bubblewrap required; no unsandboxed fallback")
    # The launcher accepts only pipes for its own protocol descriptors.
    # The stdio escape probe below deliberately bypasses this admission rule.
    def protocol_fd(fd):
        mode = os.fstat(fd).st_mode
        return stat.S_ISFIFO(mode)
    require(protocol_fd(1) and protocol_fd(2), "run with piped stdout/stderr (e.g. 2>&1 | tee receipt)")
    print(json.dumps({"kernel": platform.release(), "machine": platform.machine(),
                      "bun": subprocess.check_output([bun, "--version"], text=True).strip(),
                      "bubblewrap": subprocess.check_output(["bwrap", "--version"], text=True).strip()}), flush=True)
    with tempfile.TemporaryDirectory(prefix="policy-boundary-") as directory:
        root = Path(directory)
        brain, scratch = root / "brain", root / "scratch"
        policies = brain / "context/policies"
        policies.mkdir(parents=True)
        notes = brain / "notes"
        notes.mkdir()
        scratch.mkdir()
        policy = policies / "rule.md"
        policy.write_bytes(GOLDEN)
        alias = notes / "hardlink.md"
        alias.hardlink_to(policy)
        symlink = notes / "symlink.md"
        symlink.symlink_to(policy)
        require(alias.stat().st_ino == policy.stat().st_ino, "hardlink fixture is not an alias")
        require(len(GOLDEN) > 0, "empty safety target")
        # Python's close_fds removes >2. Bubblewrap does NOT promise to close
        # caller-supplied descriptors: the retained-fd probe proves this.
        # Native fd 3 is used only in the explicit adversarial probes.
        receipts = []
        def run(profile, operation, target=policy, fd_mode=None):
            policy.write_bytes(GOLDEN)
            stdout = subprocess.PIPE
            passed = ()
            owned = None
            if fd_mode in ("closed", "preserved"):
                owned = os.open(policy, os.O_WRONLY)
                require(owned == 3, "fixture must own descriptor 3")
                passed = (owned,) if fd_mode == "preserved" else ()
            elif fd_mode == "stdout":
                owned = os.open(policy, os.O_WRONLY)
                require(not protocol_fd(owned), "regular-file descriptor admission should reject")
                stdout = owned
            command = sandbox(brain, scratch, profile, bun, operation, target)
            try:
                result = subprocess.run(command, stdout=stdout, stderr=subprocess.PIPE,
                                        stdin=subprocess.DEVNULL, close_fds=True, pass_fds=passed, timeout=30)
            finally:
                if owned is not None:
                    os.close(owned)
            require(result.returncode == 0, f"worker unavailable for {operation}: {result.stderr.decode()}")
            receipt = json.loads(result.stderr.decode().splitlines()[-1])
            receipts.append(receipt)
            require(receipt["results"], f"no writer executed: {operation}")
            require(receipt["allowedBytes"] == "Odysseus: permitted scratch write.\n", "scratch positive control failed")
            changed = not policy.exists() or policy.read_bytes() != GOLDEN
            require(policies.is_dir() and sorted(p.name for p in policies.iterdir()) == ["rule.md"],
                    f"POLICY_DIRECTORY_UNCHANGED failed: {operation} under {profile}")
            print(json.dumps({"profile": profile, "operation": operation,
                              "policy_changed": changed, "scratch_write": True, "writer": receipt["results"]}), flush=True)
            return changed

        profile = "mutation" if args.mutation else "whole-worker"
        for operation, target in [("write", policy), ("edit", policy), ("notebook-fixture", policy),
                                  ("bash-script", policy), ("subagent-fixture", policy), ("claude-wrapper", policy),
                                  ("write", Path("notes/../context/policies/rule.md")),
                                  ("write", symlink), ("write", alias), ("hardlink-scratch", policy),
                                  ("create-policy", policy), ("remove-policy", policy), ("rename-policies", policy),
                                  ("extension-init", policy), ("extension-tool", policy)]:
            changed = run(profile, operation, target)
            require(not changed, f"POLICY_BYTES_UNCHANGED failed: {operation} under {profile}")
        require(not run(profile, "fd", fd_mode="closed"), "closed inherited fd changed policy")
        # Use the SAME installed executors in the permitted filesystem, rather
        # than a different writer as the only positive control.
        for operation in ("write", "bash-script", "subagent-fixture", "claude-wrapper", "extension-init", "extension-tool"):
            require(not run(profile, operation, scratch / "permitted.md"), "permitted writer changed policy")
            # Each operation must have written the payload, independently of
            # its return/error value. Parse the worker's actual readback below.
            require(receipts[-1]["targetBytes"] == PAYLOAD.decode(), f"permitted {operation} did not write")
        # Deliberately wrong configurations MUST demonstrate actual escapes.
        require(run("path-only", "write", alias), "expected writable-hardlink escape absent")
        scratch_alias = scratch / "preexisting-alias.md"
        scratch_alias.hardlink_to(policy)
        require(run("host-scratch", "write", scratch_alias), "expected scratch-hardlink escape absent")
        require(run("whole-worker", "fd", fd_mode="preserved"), "expected preserved-fd escape absent")
        require(run("whole-worker", "stdio", fd_mode="stdout"), "expected stdio escape absent")
        # Child-only confinement cannot restrict a pi extension in its parent.
        policy.write_bytes(GOLDEN)
        parent = subprocess.run([bun, str(HERE / "worker.ts"), "extension-init", str(brain), str(scratch), str(policy)],
                                env={"PATH": os.environ["PATH"], "PI_CODING_AGENT_DIR": str(scratch / "pi")},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        require(parent.returncode == 0, parent.stderr.decode())
        receipt = json.loads(parent.stderr.decode().splitlines()[-1])
        require(receipt["results"][0]["writer"] == "installed pi extension initialization", "parent extension not observed")
        require(policy.read_bytes() != GOLDEN, "expected in-process extension escape absent")
        print(json.dumps({"probe": "unsandboxed parent pi extension", "policy_changed": True}), flush=True)
        policy.write_bytes(GOLDEN)
        landlock = subprocess.run([sys.executable, str(HERE / "probe.py"), "--landlock-child", str(brain), str(scratch)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        require(landlock.returncode == 0, landlock.stderr.decode())
        print(landlock.stdout.decode().strip(), flush=True)
        print("PASS: bounded worker proof and six rejected-boundary escape cases", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--landlock-child":
        landlock_child()
    else:
        main()
