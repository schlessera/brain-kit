"""Branch-only compilation comparison; not product proof or a build-result cache."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import tempfile
import threading
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


def worker_resolution(worker):
    manifests = [(path.parent, json.loads(path.read_text())) for path in (worker / "packages").glob("*/package.json")]
    known = {manifest["name"]: manifest for _, manifest in manifests}
    requests = []
    for directory, manifest in manifests:
        dependencies = {**manifest.get("dependencies", {}), **manifest.get("devDependencies", {}),
                        **manifest.get("optionalDependencies", {}), **manifest.get("peerDependencies", {})}
        for name in sorted({manifest["name"], *[name for name in dependencies if name in known]}):
            source_exports = [key for key, value in known[name].get("exports", {}).items()
                              if isinstance(value, dict) and isinstance(value.get("bun"), str)
                              and value["bun"].startswith("./src/") and "*" not in key]
            assert source_exports, "Workspace package has no explicit Bun source export"
            for key in sorted(source_exports):
                requests.append({"specifier": name + (key[1:] if key != "." else ""), "importer": str(directory / "src")})
    script = 'console.log(JSON.stringify(JSON.parse(process.argv.at(-1)).map(item => ({...item, resolved:Bun.resolveSync(item.specifier,item.importer)}))));'
    resolved = json.loads(command(["bun", "-e", script, json.dumps(requests)], worker))
    sources = []
    for item in resolved:
        path = pathlib.Path(item["resolved"]).resolve(strict=True)
        relative = path.relative_to(worker)
        assert relative.parts[0] == "packages", "Workspace dependency resolved outside private sources"
        assert sha(path) == sha(ROOT / relative), "Private resolved source differs"
        sources.append({"specifier": item["specifier"], "importer": str(pathlib.Path(item["importer"]).relative_to(worker)),
                        "resolved": str(relative), "sha256": sha(path)})
    compiler = (worker / "node_modules/.bin/tsc").resolve(strict=True)
    compiler.relative_to(worker)
    implementation = worker / "node_modules/typescript/lib/_tsc.js"
    parent = ROOT / "node_modules/typescript/lib/_tsc.js"
    child_stat, parent_stat = implementation.stat(), parent.stat()
    assert (child_stat.st_dev, child_stat.st_ino) != (parent_stat.st_dev, parent_stat.st_ino), "Compiler inode is shared with parent"
    return {"workspaceSources": sources, "compilerBin": str(compiler.relative_to(worker)),
            "compilerBinSha256": sha(compiler), "compilerImplementationSha256": sha(implementation),
            "compilerPrivateInode": {"dev": child_stat.st_dev, "ino": child_stat.st_ino}}


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
        # A package failure must not exit Bun while sibling compilers still run.
        # Keep preflight exits outside the package function unchanged.
        method = text.index("async function buildPackage(")
        body, replaced = re.subn(r"process\.exit\((\w+)\)", lambda match:
            'throw Object.assign(new Error("Compilation failed for packages/" + packageName + " (exit " + '
            + match.group(1) + ' + ")"), { compileExitCode: ' + match.group(1) + ' })', text[method:])
        assert replaced == 5, "Unexpected package exit structure"
        text = text[:method] + body
        width = int(variant.removeprefix("parallel"))
        text += f'''
const known = new Set(packages.map(pkg => pkg.name));
const placed = new Set<string>();
async function compileLevels() {{
while (placed.size < packages.length) {{
  const ready = packages.filter(pkg => !placed.has(pkg.name) &&
    Object.keys({{ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies }})
      .filter(name => known.has(name) && name !== pkg.name).every(name => placed.has(name)));
  if (!ready.length) throw new Error("Compilation measurement dependency cycle");
  let cursor = 0;
  const results = await Promise.allSettled(Array.from({{length: Math.min({width}, ready.length)}}, async () => {{
    while (cursor < ready.length) await buildPackage(ready[cursor++]!);
  }}));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Bounded compilation failed");
  for (const pkg of ready) placed.add(pkg.name);
}}
}}
try {{ await compileLevels(); }}
catch (error) {{
  console.error(error);
  const first = error instanceof AggregateError ? error.errors[0] : error;
  process.exitCode = typeof first?.compileExitCode === "number" ? first.compileExitCode : 1;
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


def stop_owned_children(children):
    # Popen.wait() records and reaps completed children. Never signal those
    # numeric group IDs: their leader's PID can already have been reused.
    # Pending parents remain unreaped throughout BOTH signal rounds, retaining
    # their PID identity even if TERM exits the leader before its descendants.
    pending = [child for child in children if child.returncode is None]
    failures = []
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for child in pending:
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                pass
            except OSError as error:
                failures.append(error)
        if pending and sig == signal.SIGTERM:
            time.sleep(.25)
    for child in pending:
        try:
            child.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(error)
    if failures:
        raise ExceptionGroup("Owned compiler cleanup failed", failures)


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
    peak_memory = [None]
    stop_sampling = threading.Event()
    def sample_memory():
        while not stop_sampling.is_set():
            raw = cgroup_value("memory.current")
            if raw and raw.isdecimal():
                peak_memory[0] = max(peak_memory[0] or 0, int(raw))
            stop_sampling.wait(.1)
    sampler = threading.Thread(target=sample_memory, daemon=True)
    children = []
    streams = []
    try:
        for index, worker in enumerate(workers):
            stream = (report / f"{name}-worker{index + 1}.log").open("wb")
            streams.append(stream)
            children.append(subprocess.Popen(["/usr/bin/time", "-v", "-o", str(report / f"{name}-worker{index + 1}-resources.txt"),
                "bun", "scripts/compile2321-build.ts"], cwd=worker, stdout=stream, stderr=subprocess.STDOUT,
                start_new_session=True))
        sampler.start()
        exits = [child.wait(timeout=max(.001, 600 - (time.monotonic() - started))) for child in children]
        wall_seconds = time.monotonic() - started
        cpu_after = cgroup_value("cpu.stat")
    finally:
        stop_sampling.set()
        if sampler.ident is not None:
            sampler.join(timeout=1)
        try:
            stop_owned_children(children)
        finally:
            for stream in streams:
                stream.close()
    outputs = [inventory([package / "dist" for package in (worker / "packages").iterdir()
                          if package.is_dir()], worker) for worker in workers]
    for index, output in enumerate(outputs):
        (report / f"{name}-worker{index + 1}-outputs.json").write_text(json.dumps(output, indent=2))
        assert not any(path.endswith(".tsbuildinfo") for path in output), "Incremental metadata entered dist"
    receipt = {"name": name, "variant": variant, "wallSeconds": wall_seconds,
               "exitCodes": exits, "outputDigests": [digest(output) for output in outputs],
               "variantSourceSha256": sha(workers[0] / "scripts/compile2321-build.ts"),
               "argv": ["bun", "scripts/compile2321-build.ts"],
               "cpuBefore": cpu_before, "cpuAfter": cpu_after, "jobCgroupPeakMemoryObserved": peak_memory[0]}
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
    parser.add_argument("--require-offline", action="store_true")
    args = parser.parse_args()
    report = args.report.resolve()
    report.mkdir(parents=True, exist_ok=False)
    network_interfaces = [line.split(":")[0].strip() for line in pathlib.Path("/proc/net/dev").read_text().splitlines()[2:]]
    if args.require_offline:
        assert network_interfaces == ["lo"], "Benchmark must own an offline network namespace"
        routes = pathlib.Path("/proc/net/route").read_text().splitlines()
        assert not routes or (len(routes) == 1 and routes[0].split()[:2] == ["Iface", "Destination"]), "Benchmark has an IPv4 route"
    head = command(["git", "rev-parse", "HEAD"])
    original = (ROOT / "scripts/build.ts").read_text()
    dependency_paths = [ROOT / "node_modules", *[package / "node_modules" for package in (ROOT / "packages").iterdir() if package.is_dir()]]
    install = inventory(dependency_paths, ROOT)
    (report / "installation.json").write_text(json.dumps(install, indent=2))
    identity = {"head": head, "tree": command(["git", "rev-parse", "HEAD^{tree}"]),
        "sourceDirty": command(["git", "status", "--porcelain", "--untracked-files=no"]),
        "buildSha256": sha(ROOT / "scripts/build.ts"), "driverSha256": sha(pathlib.Path(__file__)), "lockSha256": sha(ROOT / "bun.lock"),
        "bun": command(["bun", "--version"]), "node": command(["node", "--version"]),
        "bunExecutableSha256": sha(pathlib.Path(shutil.which("bun")).resolve()),
        "nodeExecutableSha256": sha(pathlib.Path(shutil.which("node")).resolve()),
        "typescript": json.loads((ROOT / "node_modules/typescript/package.json").read_text())["version"],
        "installationDigest": digest(install), "workers": args.workers, "smoke": args.smoke,
        "offlineNamespaceRequired": args.require_offline,
        "networkInterfaces": network_interfaces if args.require_offline else "not-qualified-local-smoke",
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
            (report / f"worker{index + 1}-resolution.json").write_text(json.dumps(worker_resolution(worker), indent=2))
        baseline, expected = run_arm(workers, "serial-before", "serial", original, report, args.smoke, True)
        arms = [("parallel2", "parallel2", True)]
        if args.workers == 1:
            arms.append(("parallel4", "parallel4", True))
        arms += [("incremental-cold", "incremental", True), ("incremental-warm", "incremental", False)]
        for name, variant, clean in arms:
            _, outputs = run_arm(workers, name, variant, original, report, args.smoke, clean)
            assert outputs == expected, f"{name}: emitted paths/modes/bytes differ from serial"
        deleted_output = next(path for path in expected[0]
                              if path.startswith("packages/common/dist/") and path.endswith(".js"))
        for worker in workers:
            (worker / deleted_output).unlink()
        _, outputs = run_arm(workers, "incremental-missing-output", "incremental", original, report, args.smoke, False)
        missing = outputs != expected
        final, outputs = run_arm(workers, "serial-after", "serial", original, report, args.smoke, True)
        assert outputs == expected, "Final serial output drifted"
        assert inventory(dependency_paths, ROOT) == install, "Parent install changed during measurement"
        summary = {"identity": identity, "serialBeforeSeconds": baseline["wallSeconds"],
                   "serialAfterSeconds": final["wallSeconds"], "incrementalMissingOutputRejected": missing,
                   "coldAndUnchangedWarmOutputEquality": True, "deletedOutput": deleted_output,
                   "incrementalEligibleForAdoption": not missing,
                   "result": "measurement-complete-not-product-proof"}
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
