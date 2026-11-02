"""Fixture-only storage experiment for #1780; accepts no external scan roots.

Run with python3 -B docs/plans/storage-accounting-experiment.py. All writes,
including Git setup/packing and permission changes, stay in fresh temporary
Odysseus trees. Measurement reads metadata, not attachment contents. This
single-process prototype does not establish race-safe production traversal.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time


def command(args, env=None):
    return subprocess.run(args, env=env, check=True, text=True,
                          capture_output=True, timeout=10).stdout.strip()


def inventory(roots, limit=10000, seconds=2, cancelled=lambda: False):
    started = time.monotonic()
    objects, errors, visited = {}, [], 0
    stack = list(reversed(roots))
    while stack:
        if cancelled() or visited >= limit or time.monotonic() - started >= seconds:
            errors.append("budget_or_cancel")
            break
        path = stack.pop()
        visited += 1
        try:
            info = path.lstat()
            key = (info.st_dev, info.st_ino)
            if key in objects:
                continue
            objects[key] = (info.st_size, info.st_blocks * 512, info.st_mode,
                            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)
            if stat.S_ISDIR(info.st_mode):
                with os.scandir(path) as entries:
                    # Incremental read avoids materializing an unbounded directory.
                    for entry in entries:
                        if len(stack) + visited >= limit:
                            errors.append("entry_budget")
                            break
                        stack.append(Path(entry.path))
        except OSError as error:
            errors.append(error.__class__.__name__)
    return {"logical": sum(v[0] for v in objects.values() if not stat.S_ISDIR(v[2])),
            "directory_stat_bytes": sum(v[0] for v in objects.values() if stat.S_ISDIR(v[2])),
            "allocated": sum(v[1] for v in objects.values()),
            "entries": len(objects), "errors": errors,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3)}, objects


def capacity(path):
    fs = os.statvfs(path)
    return {"identity": path.stat().st_dev,
            "total": fs.f_blocks * fs.f_frsize,
            "used": (fs.f_blocks - fs.f_bfree) * fs.f_frsize,
            "available": fs.f_bavail * fs.f_frsize}


def run():
    with tempfile.TemporaryDirectory(prefix="odysseus-storage-") as temporary:
        root = Path(temporary)
        home, brain, state = (root / name for name in ("home", "brain", "state"))
        for path in (home, brain, state):
            path.mkdir()
        env = {"PATH": os.environ["PATH"], "HOME": str(home),
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
               "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
        git = lambda *args: command(["git", "-C", str(brain), *args], env)
        git("init", "-q", "-b", "main")
        git("config", "user.name", "Odysseus")
        git("config", "user.email", "odysseus@example.invalid")
        (brain / "voyage.md").write_text("# Voyage\nSail from Ithaca.\n")
        (brain / ".gitignore").write_text("ignored.pdf\nworkspaces/\n.brain/\n")
        git("add", "voyage.md", ".gitignore")
        git("commit", "-qm", "Voyage")
        (brain / "voyage.md").write_text("# Voyage\nConsult Athena.\n")
        git("commit", "-qam", "Consult Athena")
        loose = git("count-objects", "-v")
        git("repack", "-ad")  # Setup only: never part of the observation pass.
        packed = git("count-objects", "-v")
        worktree = root / "worktree"
        git("worktree", "add", "-q", "-b", "athena", str(worktree))
        common = command(["git", "-C", str(worktree), "rev-parse",
                          "--path-format=absolute", "--git-common-dir"], env)
        assert Path(common) == brain / ".git", "worktree shares Git common directory"
        separate = root / "separate"
        separate.mkdir()
        command(["git", "init", "-q", "--separate-git-dir", str(root / "git-store"),
                 str(separate)], env)
        assert (separate / ".git").is_file(), "alternate Git directory is a gitfile"
        for name, size in (("map.pdf", 6000000), ("boundary.pdf", 5000000),
                           ("binary-boundary.PDF", 5242880), ("ignored.pdf", 7000000)):
            with (brain / name).open("wb") as file:
                file.truncate(size)
                file.seek(0)
                file.write(b"%PDF-Odysseus\n")
        workspace = brain / "workspaces"
        workspace.mkdir()
        (workspace / "raft.txt").write_text("Raft plans\n")
        (brain / ".brain").mkdir()
        (brain / ".brain" / "scratch").mkdir()
        (state / "brain-ui.db").write_bytes(b"synthetic operational bytes")
        os.link(brain / "map.pdf", state / "map-alias.pdf")
        (brain / "loop").symlink_to(brain, target_is_directory=True)
        (brain / "external").symlink_to(state, target_is_directory=True)
        many = brain / "crew"
        many.mkdir()
        for index in range(2000):
            (many / f"oar-{index}.txt").write_text("row\n")

        before, baseline = inventory([root])
        overlap, _ = inventory([root, brain, workspace, state, worktree])
        assert overlap["allocated"] == before["allocated"], "overlapping roots counted once"
        assert overlap["logical"] == before["logical"], "hard links counted once"
        du_alloc = int(command(["du", "-s", "-B1", str(root)]).split()[0])
        du_logical = int(command(["du", "-s", "--apparent-size", "-B1", str(root)]).split()[0])
        assert before["allocated"] == du_alloc, "allocated aggregate agrees with du"
        assert before["logical"] == du_logical, f"logical aggregate agrees with du: metadata={before['logical']} du={du_logical}; directory bytes={sum(v[0] for v in baseline.values() if stat.S_ISDIR(v[2]))}"
        sparse = (brain / "map.pdf").stat()
        assert sparse.st_blocks * 512 < sparse.st_size, "sparse logical differs from allocation"
        pdfs = [p for p in brain.iterdir() if p.suffix.lower() == ".pdf"
                and p.lstat().st_size > 5000000]
        assert len(pdfs) == 3, "PDF > 5 MB includes ignored and uppercase, excludes exact boundary"
        assert sum(p.stat().st_size for p in pdfs) == 18242880, "PDF logical total"
        assert git("check-ignore", "ignored.pdf", "workspaces/raft.txt").splitlines() == [
            "ignored.pdf", "workspaces/raft.txt"], "ignored files remain inventory candidates"
        short, _ = inventory([root], limit=10)
        assert short["errors"], "entry budget reports partial"
        cancelled, _ = inventory([root], cancelled=lambda: True)
        assert cancelled["errors"] and cancelled["entries"] == 0, "cancellation is visible"
        timed, _ = inventory([root], seconds=0)
        assert timed["errors"], "time budget reports partial"
        denied = root / "denied"
        denied.mkdir()
        (denied / "secret.txt").write_text("Odysseus fixture\n")
        denied.chmod(0)
        try:
            refused, _ = inventory([denied])
            # A root run cannot demonstrate ordinary permission denial.
            assert "PermissionError" in refused["errors"], "real EACCES must be visible (run unprivileged)"
        finally:
            denied.chmod(0o700)
        (denied / "secret.txt").unlink()
        denied.rmdir()
        # Root directory timestamps changed during the separate denial probe;
        # every descendant measured in the observation pass must be unchanged.
        after, observed = inventory([root])
        root_key = (root.stat().st_dev, root.stat().st_ino)
        assert {k: v for k, v in baseline.items() if k != root_key} == {
            k: v for k, v in observed.items() if k != root_key}, "measurement did not mutate fixture"
        changing = state / "changing.txt"
        changing.write_text("Athena\n")
        first = changing.stat()
        changing.write_text("Consult Athena before sailing.\n")
        last = changing.stat()
        assert (first.st_size, first.st_mtime_ns, first.st_ctime_ns) != (
            last.st_size, last.st_mtime_ns, last.st_ctime_ns), "changing metadata invalidates a stable observation"
        changing.unlink()
        filesystem = capacity(brain)
        df_values = command(["df", "-B1", "--output=size,used,avail", str(brain)]).splitlines()[-1].split()
        df_capacity = dict(zip(("total", "used", "available"), map(int, df_values)))
        assert df_capacity["total"] == filesystem["total"], "capacity total agrees with df"
        df_delta = {k: df_capacity[k] - filesystem[k] for k in df_capacity}
        assert capacity(state)["identity"] == filesystem["identity"], "colocated capacity deduplicates"
        second = None
        if Path("/dev/shm").is_dir():
            with tempfile.TemporaryDirectory(prefix="odysseus-storage-", dir="/dev/shm") as other:
                other_root = Path(other)
                (other_root / "raft.txt").write_text("Raft\n")
                second = capacity(other_root)
                assert second["identity"] != filesystem["identity"], "two real capacity identities"
                (brain / "other-volume").symlink_to(other_root, target_is_directory=True)
                local, _ = inventory([brain])
                combined, _ = inventory([brain, other_root])
                assert combined["logical"] > local["logical"], "cross-volume symlink not traversed"
                (brain / "other-volume").unlink()
        packs = list((brain / ".git" / "objects" / "pack").glob("*.pack"))
        pack_logical = sum(p.stat().st_size for p in packs)
        packed_fields = dict(line.split(": ", 1) for line in packed.splitlines())
        pack_disk = sum(p.stat().st_blocks * 512 for p in (brain / ".git" / "objects" / "pack").iterdir()
                        if p.suffix in (".pack", ".idx"))
        pack_git_bytes = int(packed_fields["size-pack"]) * 1024
        print(json.dumps({"versions": {"python": command(["python3", "--version"]),
                         "git": command(["git", "--version"]),
                         "du": command(["du", "--version"]).splitlines()[0]},
                         "inventory": before, "overlap": overlap, "du_allocated": du_alloc,
                         "du_logical": du_logical, "sparse": {"logical": sparse.st_size,
                         "allocated": sparse.st_blocks * 512}, "pdf_count": len(pdfs),
                         "pdf_logical": 18242880, "loose_git": loose, "packed_git": packed,
                         "pack_logical": pack_logical, "pack_and_index_allocated": pack_disk, "git_pack_report_bytes": pack_git_bytes,
                         "capacity": filesystem, "df_delta_bytes": df_delta, "second_capacity": second,
                         "denied": refused, "budget": short, "cancelled": cancelled,
                         "timed": timed, "readonly_descendants": True}, indent=2))


if __name__ == "__main__":
    run()
