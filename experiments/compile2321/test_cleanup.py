"""Real process controls for the branch-only measurement driver."""
import pathlib
import json
import os
import select
import signal
import subprocess
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import measure


class CompilerCleanup(unittest.TestCase):
    def test_completed_compiler_is_not_signalled_after_reaping(self):
        children = []
        native_popen = subprocess.Popen

        def start(*args, **kwargs):
            child = native_popen(*args, **kwargs)
            children.append(child)
            return child

        def signal_group(pid, sig):
            child = next(child for child in children if child.pid == pid)
            self.assertIsNone(child.returncode, "REAPED_COMPILER_GROUP_MUST_NOT_BE_SIGNALED")
            raise AssertionError("Successful compiler cleanup must send no signal")

        with tempfile.TemporaryDirectory(prefix="odysseus-compile-cleanup-") as temporary:
            root = pathlib.Path(temporary)
            worker = root / "worker"
            (worker / "scripts").mkdir(parents=True)
            (worker / "packages").mkdir()
            report = root / "report"
            report.mkdir()
            with patch.object(measure.subprocess, "Popen", start), patch.object(measure.os, "killpg", signal_group):
                receipt, _ = measure.run_arm([worker], "completed", "serial", "process.exit(0);\n", report, False, True)
            self.assertEqual(receipt["exitCodes"], [0])
            self.assertEqual(len(children), 1)
            self.assertEqual(children[0].returncode, 0)

    def test_timed_out_compiler_descendant_is_terminated_before_parent_reaping(self):
        with tempfile.TemporaryDirectory(prefix="odysseus-compile-descendant-") as temporary:
            ready = pathlib.Path(temporary) / "ready"
            grandchild = "import os,pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
            parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]]); time.sleep(30)"
            child = subprocess.Popen([sys.executable, "-c", parent, grandchild, str(ready)],
                                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            descendant = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(ready.exists(), "OWNED_COMPILER_DESCENDANT_READY")
                descendant = os.pidfd_open(int(ready.read_text()))
                with self.assertRaises(subprocess.TimeoutExpired):
                    child.wait(timeout=.01)
                measure.stop_owned_children([child])
                self.assertEqual(child.returncode, -signal.SIGTERM)
                poll = select.poll()
                poll.register(descendant, select.POLLIN)
                self.assertTrue(poll.poll(2000), "TIMED_OUT_COMPILER_DESCENDANT_TERMINATED")
            finally:
                try:
                    # pidfd keeps cleanup bound to this exact descendant even
                    # when the tested helper omitted its final kill round.
                    if descendant is not None:
                        try:
                            signal.pidfd_send_signal(descendant, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        final_poll = select.poll()
                        final_poll.register(descendant, select.POLLIN)
                        self.assertTrue(final_poll.poll(2000), "OWNED_DESCENDANT_FINAL_CLEANUP_CONFIRMED")
                    if child.returncode is None:
                        child.kill()
                    child.wait(timeout=5)
                finally:
                    if descendant is not None:
                        os.close(descendant)

    def test_parallel_compile_failure_drains_live_peer_and_preserves_exit(self):
        with tempfile.TemporaryDirectory(prefix="odysseus-compile-peer-") as temporary:
            root = pathlib.Path(temporary)
            scripts = root / "scripts"
            scripts.mkdir()
            for name in ["publishable-packages.ts", "bin-modes.ts", "workspace-lease.mjs"]:
                shutil.copyfile(measure.ROOT / "scripts" / name, scripts / name)
            for name, source in [("alpha", 'export const port: string = 1;\n'), ("beta", 'export const port: string = "Ithaca";\n')]:
                package = root / "packages" / name
                (package / "src").mkdir(parents=True)
                (package / "package.json").write_text(json.dumps({"name": "@odysseus/" + name, "version": "0.0.0"}))
                (package / "src/index.ts").write_text(source)
                (package / "tsconfig.build.json").write_text(json.dumps({"compilerOptions": {
                    "target": "ESNext", "module": "ESNext", "types": [], "strict": True,
                    "rootDir": "src", "outDir": "dist"}, "include": ["src/**/*.ts"]}))
            binary = root / "bin"
            binary.mkdir()
            wrapper = binary / "bunx"
            # The actual installed compiler runs in both children. A private
            # barrier holds beta after compilation, so alpha's real type error
            # must not finish the parent until that already-started peer exits.
            wrapper.write_text("#!/usr/bin/env python3\n" + f'''
import os,pathlib,subprocess,sys,time
root=pathlib.Path({str(root)!r})
config=pathlib.Path(sys.argv[sys.argv.index('-p')+1])
name=config.parent.name
def wait(path):
 deadline=time.monotonic()+10
 while not path.exists():
  if time.monotonic()>deadline: raise RuntimeError('Compiler peer barrier timed out')
  time.sleep(.01)
if name=='beta': (root/'beta-ready').write_text(str(os.getpid()))
else: wait(root/'beta-ready')
child=subprocess.run([{shutil.which('node')!r},{str(measure.ROOT / 'node_modules/typescript/lib/tsc.js')!r},*sys.argv[2:]])
if name=='beta':
 (root/'beta-compiled').touch()
 wait(root/'beta-release')
 (root/'beta-finished').touch()
else: (root/'alpha-failed').write_text(str(child.returncode))
sys.exit(child.returncode)
''')
            wrapper.chmod(0o755)
            entry = scripts / "compile2321-build.ts"
            entry.write_text(measure.candidate((measure.ROOT / "scripts/build.ts").read_text(), "parallel2", False))
            log = (root / "build.log").open("wb")
            child = subprocess.Popen([shutil.which("bun"), str(entry)], cwd=root,
                env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]},
                start_new_session=True, stdout=log, stderr=subprocess.STDOUT)
            peer = None
            try:
                deadline = time.monotonic() + 10
                while not (root / "beta-ready").exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue((root / "beta-ready").exists(), "ACTUAL_COMPILER_PEER_STARTED")
                peer = os.pidfd_open(int((root / "beta-ready").read_text()))
                while not all((root / name).exists() for name in ["alpha-failed", "beta-compiled"]) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual((root / "alpha-failed").read_text(), "2", "ACTUAL_TYPESCRIPT_ERROR_EXIT")
                with self.assertRaises(subprocess.TimeoutExpired, msg="PARALLEL_BUILD_WAITS_LIVE_COMPILER_PEER_AFTER_ERROR"):
                    child.wait(timeout=.3)
                (root / "beta-release").touch()
                self.assertEqual(child.wait(timeout=5), 2, "PARALLEL_BUILD_PRESERVES_COMPILER_EXIT")
                self.assertTrue((root / "beta-finished").exists(), "PARALLEL_BUILD_DRAINS_STARTED_PEER")
                self.assertIn("packages/alpha", (root / "build.log").read_text())
            finally:
                (root / "beta-release").touch()
                try:
                    if child.returncode is None:
                        measure.stop_owned_children([child])
                    if peer is not None:
                        poll = select.poll()
                        poll.register(peer, select.POLLIN)
                        if not poll.poll(2000):
                            signal.pidfd_send_signal(peer, signal.SIGKILL)
                        self.assertTrue(poll.poll(2000), "COMPILER_PEER_FINAL_CLEANUP_CONFIRMED")
                finally:
                    log.close()
                    if peer is not None:
                        os.close(peer)


if __name__ == "__main__":
    unittest.main()
