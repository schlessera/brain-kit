"""Offline duperemove cost/benefit on generated Odysseus Git workloads (#3514).

Runs unprivileged on a real Btrfs directory the caller owns. Each scenario
lives in its own subvolume under BENCH (argv[1]) and is removed afterwards.
Unique allocation is read from `btrfs filesystem du` (exclusive/shared
extents), never from logical sizes. Content safety: every regular file's
SHA-256 and `git fsck --full` are compared before and after each dedupe.

    python3 -I scripts/dedupe-bench.py <bench-dir> <report.json> [<state-dir>]
"""
import hashlib, json, os, pathlib, random, resource, shutil, subprocess, sys, time

BENCH, REPORT = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve()
# Hash databases live outside the measured tree, so their own allocation never reads as lost savings.
STATE = pathlib.Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else REPORT.parent / "dedupe-bench-state"
MIB = 1024 ** 2
WORKLOAD = {"books": 40, "lines": 50, "charts": 8, "chartBytes": 4 * MIB, "changedLines": 50}
GIT = ["git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", "-c", "init.defaultBranch=main", "-c", "gc.auto=0"]
report = {"schema": 1, "workload": WORKLOAD, "environment": {}, "scenarios": []}

def sh(argv, cwd=None, check=True):
    r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode: raise RuntimeError(f"{argv}: {r.stderr[-800:]}")
    return r

def save(): REPORT.write_text(json.dumps(report, indent=2))

def subvolume(name, compression="none"):
    path = BENCH / name
    sh(["btrfs", "subvolume", "create", str(path)])
    sh(["btrfs", "property", "set", str(path), "compression", compression])
    return path

def remove(path):
    # Unprivileged removal: writable, emptied, then rmdir of the empty subvolume.
    sh(["btrfs", "property", "set", str(path), "ro", "false"], check=False)
    for child in sorted(path.iterdir()):
        if child.is_dir() and not child.is_symlink() and os.stat(child).st_ino == 256: remove(child)
        elif child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
        else: child.unlink()
    os.rmdir(path)

def flush():
    sh(["btrfs", "filesystem", "sync", str(BENCH)])

def census(paths):
    flush()
    out = sh(["btrfs", "filesystem", "du", "-s", "--raw", *map(str, paths)]).stdout.strip().splitlines()[1:]
    rows = {}
    for line in out:
        total, exclusive, shared, name = line.split(None, 3)
        rows[name] = {"total": int(total), "exclusive": int(exclusive), "shared": int(shared)}
    return rows

def unique(_paths):
    flush()
    """Unique allocation of the whole bench: extents referenced once plus extents shared within it, each counted once."""
    total, exclusive, shared, _ = sh(["btrfs", "filesystem", "du", "-s", "--raw", str(BENCH)]).stdout.strip().splitlines()[1].split(None, 3)
    return {"exclusive": int(exclusive) + int(shared), "total": int(total)}

def fingerprint(root):
    """SHA-256 of every regular file, Git internals included: dedupe must never change a byte."""
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file() and not path.is_symlink()}

def fsck(repo):
    return sh(["git", "-C", str(repo), "fsck", "--full", "--no-progress"], check=False).returncode

def measured(argv):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    began = time.monotonic()
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    io = {}
    while child.poll() is None:
        try:
            io = dict(line.split(": ") for line in pathlib.Path(f"/proc/{child.pid}/io").read_text().splitlines())
        except (OSError, ValueError): pass
        time.sleep(0.05)
    output = child.stdout.read()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"code": child.returncode, "ms": round((time.monotonic() - began) * 1000),
            "cpuMs": round((after.ru_utime - before.ru_utime + after.ru_stime - before.ru_stime) * 1000),
            "maxRssKiB": after.ru_maxrss, "readBytes": int(io.get("read_bytes", 0)), "writeBytes": int(io.get("write_bytes", 0)),
            "tail": output[-1500:]}

def generate(root, seed):
    rng = random.Random(seed)
    sh([*GIT, "init", "-q", str(root)])
    for book in range(WORKLOAD["books"]):
        (root / "odyssey" / f"book-{book}").mkdir(parents=True)
        for line in range(WORKLOAD["lines"]):
            (root / "odyssey" / f"book-{book}" / f"line-{line}.md").write_text(f"Ithaca log: book {book}, line {line}.\n")
    (root / "charts").mkdir()
    for chart in range(WORKLOAD["charts"]):
        (root / "charts" / f"aegean-{chart}.bin").write_bytes(rng.randbytes(WORKLOAD["chartBytes"]))
    (root / "notes").mkdir()
    # Compressible larger text: the Odysseus voyage log, repeated.
    (root / "notes" / "voyage.md").write_text("Sing to me of the man, Muse, the man of twists and turns.\n" * 80_000)
    sh([*GIT, "-C", str(root), "add", "."]); sh([*GIT, "-C", str(root), "commit", "-q", "-m", "Odysseus charts the Aegean"])
    sh([*GIT, "-C", str(root), "repack", "-q", "-a", "-d"])

def dedupe_rounds(name, roots, repos, hashfile, notes=None, mutate=None):
    """First run, unchanged rerun, then a rerun after `mutate` changes files."""
    scenario = {"name": name, "roots": [str(r.relative_to(BENCH)) for r in roots], "notes": notes, "rounds": []}
    report["scenarios"].append(scenario)
    prints = {str(r): fingerprint(r) for r in roots}
    base = {"census": census(roots), "unique": unique(roots)}
    scenario["before"] = base
    flush()
    argv = ["duperemove", "-dr", "-q", f"--hashfile={hashfile}", *map(str, roots)]
    for label in ["first", "unchanged-rerun", "changed-rerun"]:
        if label == "changed-rerun":
            if not mutate: break
            mutate(); prints = {str(r): fingerprint(r) for r in roots}
            base = {"census": census(roots), "unique": unique(roots)}
        run = measured(argv)
        after = {"census": census(roots), "unique": unique(roots)}
        same = all(fingerprint(r) == prints[str(r)] for r in roots)
        checks = {str(r): fsck(r) for r in repos}
        scenario["rounds"].append({"round": label, **run, "hashfileBytes": hashfile.stat().st_size if hashfile.exists() else 0,
            "exclusiveBefore": base["unique"]["exclusive"], "exclusiveAfter": after["unique"]["exclusive"],
            "savedExclusiveBytes": base["unique"]["exclusive"] - after["unique"]["exclusive"], "census": after["census"],
            "contentUnchanged": same, "fsck": checks})
        if not same or any(checks.values()): raise RuntimeError(f"{name}/{label}: content or Git integrity changed")
        save()
        base = after
    return scenario

def main():
    BENCH.mkdir(parents=True, exist_ok=True); STATE.mkdir(parents=True, exist_ok=True)
    kernel = os.uname().release
    report["environment"] = {"kernel": kernel, "btrfsProgs": sh(["btrfs", "--version"]).stdout.splitlines()[0],
        "duperemove": sh(["duperemove", "--version"]).stdout.strip() or sh(["duperemove", "--version"]).stderr.strip(),
        "git": sh(["git", "--version"]).stdout.strip(), "mount": sh(["findmnt", "-no", "FSTYPE,OPTIONS", "-T", str(BENCH)]).stdout.strip()}
    made = []
    try:
        source = subvolume("source"); made.append(source); generate(source, 3514)
        sh(["btrfs", "property", "set", str(source), "ro", "true"])

        # 1. Independent acquisitions of one repository (two domains): full duplicates of objects and checkout.
        a, b = subvolume("domain-a"), subvolume("domain-b"); made += [a, b]
        for root in (a, b): sh([*GIT, "clone", "-q", "--no-local", str(source), str(root / "aegean")])
        def edit_b():
            for line in range(WORKLOAD["changedLines"]):
                (b / "aegean" / "odyssey" / "book-1" / f"line-{line}.md").write_text(f"Ithaca log: book 1, line {line}, revised.\n")
        dedupe_rounds("independent-acquisitions", [a, b], [a / "aegean", b / "aegean"], STATE / "independent.hash",
            "two separate clones, as two private domains would hold", edit_b)

        # 2. Snapshot worktrees: already shared, so dedupe should save nothing and only cost the scan.
        w1, w2 = BENCH / "worktree-1", BENCH / "worktree-2"
        for w in (w1, w2): sh(["btrfs", "subvolume", "snapshot", str(source), str(w)]); made.append(w)
        dedupe_rounds("snapshot-worktrees", [source, w1, w2], [w1, w2], STATE / "snapshots.hash", "writable snapshots of one read-only source")

        # 3. Repack and a linked Git worktree inside a snapshot worktree: the sharing lost after #3513's case 19.
        sh(["git", "-C", str(w1), "repack", "-q", "-a", "-d", "-f"])
        sh(["git", "-C", str(w1), "worktree", "add", "-q", "--detach", str(w1 / "linked"), "HEAD"])
        dedupe_rounds("repack-and-linked-worktree", [source, w1], [w1], STATE / "loss.hash", "repacked objects and a linked checkout in one worktree")

        # 4. Compressed independent copies.
        c1, c2 = subvolume("compressed-1", "zstd"), subvolume("compressed-2", "zstd"); made += [c1, c2]
        # shutil/copy_file_range would reflink on Btrfs; these must be independent writes.
        for root in (c1, c2): sh(["cp", "-a", "--reflink=never", str(source / "notes"), str(source / "odyssey"), str(source / "charts"), str(root)])
        dedupe_rounds("compressed-copies", [c1, c2], [], STATE / "compressed.hash", "zstd-compressed notes and small files copied twice")

        # 5. A read-only destination: an independent copy sealed read-only next to a writable one.
        r1, r2 = subvolume("sealed-1"), subvolume("writable-2"); made += [r1, r2]
        for root in (r1, r2): sh(["cp", "-a", "--reflink=never", str(source / "charts"), str(root)])
        sh(["btrfs", "property", "set", str(r1), "ro", "true"])
        dedupe_rounds("read-only-root", [r1, r2], [], STATE / "readonly.hash", "one sealed (read-only) and one writable copy")
    finally:
        for path in reversed(made):
            try: remove(path)
            except Exception as error: report.setdefault("cleanupErrors", []).append(f"{path}: {error}")
        for hashfile in STATE.glob("*.hash"): hashfile.unlink()
        save()

main()
