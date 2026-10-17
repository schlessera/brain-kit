"""Branch-only compilation comparison; not product proof or a build-result cache."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]


def command(argv, cwd=ROOT):
    return subprocess.check_output(argv, cwd=cwd, text=True).strip()


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inventory(paths, base):
    result = {}
    for top in paths:
        if not top.exists():
            continue
        for directory, dirs, files in os.walk(top, followlinks=False):
            for name in list(dirs):
                path = pathlib.Path(directory) / name
                if path.is_symlink():
                    files.append(name)
                    dirs.remove(name)
            for name in files:
                path = pathlib.Path(directory) / name
                key = path.relative_to(base).as_posix()
                result[key] = {"mode": path.lstat().st_mode & 0o7777,
                               "link": os.readlink(path)} if path.is_symlink() else {
                    "mode": path.stat().st_mode & 0o7777, "sha256": sha(path)}
    return dict(sorted(result.items()))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def candidate(original, variant, smoke):
    text = original
    if smoke:
        text = text.replace("listPublishablePackages(root)",
                            'listPublishablePackages(root).filter(pkg => pkg.dir === "common")')
    if variant == "incremental":
        removal = "  rmSync(distDir, { recursive: true, force: true });"
        assert text.count(removal) == 1
        text = text.replace(removal, "  // Measurement warm arm retains existing emitted output.")
        compiler = '[bunx, "tsc", "-p", resolve(packageDir, "tsconfig.build.json")]'
        assert text.count(compiler) == 1
        text = text.replace(compiler,
            '[bunx, "tsc", "-p", resolve(packageDir, "tsconfig.build.json"), "--incremental", '
            '"--tsBuildInfoFile", resolve(root, "node_modules/.cache/compile2321", packageName + ".tsbuildinfo")]')
    elif variant.startswith("parallel"):
        start = "for (const { dir: packageName, manifest } of listPublishablePackages(root)"
        if smoke:
            start += '.filter(pkg => pkg.dir === "common")'
        start += ") {"
        assert text.count(start) == 1
        text = text.replace(start, 'const packages = listPublishablePackages(root)' +
                            ('.filter(pkg => pkg.dir === "common")' if smoke else '') + ';\n'
                            'async function buildPackage({ dir: packageName, manifest }: typeof packages[number]) {')
        width = int(variant.removeprefix("parallel"))
        text += f'''
const known = new Set(packages.map(pkg => pkg.name));
const placed = new Set<string>();
while (placed.size < packages.length) {{
  const ready = packages.filter(pkg => !placed.has(pkg.name) &&
    Object.keys({{ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies }})
      .filter(name => known.has(name) && name !== pkg.name).every(name => placed.has(name)));
  if (!ready.length) throw new Error("Compilation measurement dependency cycle");
  let cursor = 0;
  await Promise.all(Array.from({{length: Math.min({width}, ready.length)}}, async () => {{
    while (cursor < ready.length) await buildPackage(ready[cursor++]!);
  }}));
  for (const pkg of ready) placed.add(pkg.name);
}}
'''
    elif variant != "serial":
        raise ValueError(variant)
    return text


def cgroup_value(name):
    try:
        return pathlib.Path("/sys/fs/cgroup", name).read_text().strip()
    except OSError:
        return None


def run_arm(workers, name, variant, original, report, smoke, clean):
    for worker in workers:
        if clean:
            for package in (worker / "packages").iterdir():
                if package.is_dir():
                    shutil.rmtree(package / "dist", ignore_errors=True)
            shutil.rmtree(worker / "node_modules/.cache/compile2321", ignore_errors=True)
        (worker / "scripts/compile2321-build.ts").write_text(candidate(original, variant, smoke))
    started = time.monotonic()
    cpu_before = cgroup_value("cpu.stat")
    peak_memory = 0
    children = []
    streams = []
    try:
        for index, worker in enumerate(workers):
            stream = (report / f"{name}-worker{index + 1}.log").open("wb")
            streams.append(stream)
            children.append(subprocess.Popen(["/usr/bin/time", "-v", "-o", str(report / f"{name}-worker{index + 1}-resources.txt"),
                "bun", "scripts/compile2321-build.ts"], cwd=worker, stdout=stream, stderr=subprocess.STDOUT,
                start_new_session=True))
        while any(child.poll() is None for child in children):
            if time.monotonic() - started > 600:
                raise TimeoutError(f"Compilation arm {name} exceeded its bounded capacity")
            raw = cgroup_value("memory.current")
            if raw and raw.isdecimal():
                peak_memory = max(peak_memory, int(raw))
            time.sleep(.1)
        exits = [child.wait() for child in children]
        wall_seconds = time.monotonic() - started
        cpu_after = cgroup_value("cpu.stat")
    finally:
        # Include compiler grandchildren if a build entry exits on failure.
        for child in children:
            try:
                os.killpg(child.pid, 15)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
        for stream in streams:
            stream.close()
    outputs = [inventory([package / "dist" for package in (worker / "packages").iterdir()
                          if package.is_dir()], worker) for worker in workers]
    for index, output in enumerate(outputs):
        (report / f"{name}-worker{index + 1}-outputs.json").write_text(json.dumps(output, indent=2))
        assert not any(path.endswith(".tsbuildinfo") for path in output), "Incremental metadata entered dist"
    receipt = {"name": name, "variant": variant, "wallSeconds": wall_seconds,
               "exitCodes": exits, "outputDigests": [digest(output) for output in outputs],
               "cpuBefore": cpu_before, "cpuAfter": cpu_after, "jobCgroupPeakMemoryObserved": peak_memory}
    (report / f"{name}.json").write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt), flush=True)
    if any(exits):
        raise RuntimeError(f"Compilation arm {name} failed; logs retained")
    return receipt, outputs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", choices=(1, 2), type=int, required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    parser.add_argument("--smoke", action="store_true", help="common-only local driver check, never a timing qualification")
    args = parser.parse_args()
    report = args.report.resolve()
    report.mkdir(parents=True, exist_ok=False)
    head = command(["git", "rev-parse", "HEAD"])
    original = (ROOT / "scripts/build.ts").read_text()
    dependency_paths = [ROOT / "node_modules", *[package / "node_modules" for package in (ROOT / "packages").iterdir() if package.is_dir()]]
    install = inventory(dependency_paths, ROOT)
    (report / "installation.json").write_text(json.dumps(install, indent=2))
    identity = {"head": head, "tree": command(["git", "rev-parse", "HEAD^{tree}"]),
        "sourceDirty": command(["git", "status", "--porcelain", "--untracked-files=no"]),
        "buildSha256": sha(ROOT / "scripts/build.ts"), "driverSha256": sha(pathlib.Path(__file__)), "lockSha256": sha(ROOT / "bun.lock"),
        "bun": command(["bun", "--version"]), "node": command(["node", "--version"]),
        "typescript": json.loads((ROOT / "node_modules/typescript/package.json").read_text())["version"],
        "installationDigest": digest(install), "workers": args.workers, "smoke": args.smoke,
        "cpuCount": os.cpu_count(), "affinity": sorted(os.sched_getaffinity(0)),
        "cpuMax": cgroup_value("cpu.max"), "memoryMax": cgroup_value("memory.max"),
        "uid": os.getuid(), "gid": os.getgid(), "groups": os.getgroups(),
        "uname": {"system": os.uname().sysname, "release": os.uname().release, "machine": os.uname().machine},
        "runner": os.environ.get("ImageOS"), "imageVersion": os.environ.get("ImageVersion")}
    (report / "identity.json").write_text(json.dumps(identity, indent=2))
    container = pathlib.Path(tempfile.mkdtemp(prefix=".compile2321-", dir=ROOT.parent))
    workers = []
    try:
        for index in range(args.workers):
            worker = container / str(index + 1)
            command(["git", "worktree", "add", "--quiet", "--detach", str(worker), head])
            workers.append(worker)
            for dependency in dependency_paths:
                if dependency.exists():
                    target = worker / dependency.relative_to(ROOT)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    command(["cp", "--archive", "--reflink=auto", str(dependency), str(target)])
            copied = inventory([worker / path.relative_to(ROOT) for path in dependency_paths], worker)
            assert copied == install, "Private worker install differs before measurement"
        baseline, expected = run_arm(workers, "serial-before", "serial", original, report, args.smoke, True)
        arms = [("parallel2", "parallel2", True)]
        if args.workers == 1:
            arms.append(("parallel4", "parallel4", True))
        arms += [("incremental-cold", "incremental", True), ("incremental-warm", "incremental", False)]
        for name, variant, clean in arms:
            _, outputs = run_arm(workers, name, variant, original, report, args.smoke, clean)
            assert outputs == expected, f"{name}: emitted paths/modes/bytes differ from serial"
        for worker in workers:
            (worker / "packages/common/dist/index.js").unlink()
        _, outputs = run_arm(workers, "incremental-missing-output", "incremental", original, report, args.smoke, False)
        missing = outputs != expected
        final, outputs = run_arm(workers, "serial-after", "serial", original, report, args.smoke, True)
        assert outputs == expected, "Final serial output drifted"
        assert inventory(dependency_paths, ROOT) == install, "Parent install changed during measurement"
        summary = {"identity": identity, "serialBeforeSeconds": baseline["wallSeconds"],
                   "serialAfterSeconds": final["wallSeconds"], "incrementalMissingOutputRejected": missing,
                   "candidateOutputEquality": True, "result": "measurement-complete-not-product-proof"}
        (report / "summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary), flush=True)
    finally:
        for worker in workers:
            (worker / "scripts/compile2321-build.ts").unlink(missing_ok=True)
            command(["git", "worktree", "remove", str(worker)])
        container.rmdir()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt("Measurement interrupted")))
    main()
