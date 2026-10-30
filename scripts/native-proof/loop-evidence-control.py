"""File-only controls: a tracefs protocol double, never actual kernel probes."""
import ast, contextlib, errno, importlib.util, io, json, os, pathlib, signal, subprocess, sys, tempfile, time, unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

evidence, trace = module("loop-evidence"), module("loop-trace")

class Kernel:
    """Model the write protocol independently; record only when event AND stack filters match."""
    def __init__(self): self.events, self.writes = {}, []
    def write(self, path, value):
        self.writes.append((path, value))
        if path.name == "kprobe_events":
            if value.startswith("-:"): self.events.pop(value[2:]); return
            name, symbol, *fields = value.split()
            if fields != ["major=disk->major:u32", "minor=disk->first_minor:u32", "comm=$comm"]: raise OSError(errno.EINVAL, "BTF expression rejected")
            self.events[name[2:]] = {}; return
        if path.name in ("filter", "trigger", "enable"):
            event = self.events[path.parent.parent.name + "/" + path.parent.name]
            if path.name == "enable" and value == "1":
                assert "filter" in event and "trigger" in event, "LOOP_ADMIT_BEFORE_ENABLE"
            event[path.name] = value
    def emit(self, major, minor):
        def matches(predicate):
            # Deliberately independent of the collector's FILTER constant.
            values = {"major": major, "minor": minor}
            return all(values[key.strip()] == int(value) for key, value in (clause.split("==") for clause in predicate.split("&&")))
        return [(name.split("/")[1], matches(event["filter"]), matches(event["trigger"].removeprefix("stacktrace if ")))
                for name, event in self.events.items() if event.get("enable") == "1"]

class Controls(unittest.TestCase):
    def test_bounded_redacted_snapshot_and_realistic_mount_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); proc = root / "proc"; proc.mkdir()
            rows = [r"1 0 0:81 /secret /private rw - btrfs /dev/brain-native-proof-loop rw",
                    r"2 0 0:82 / /private rw - btrfs /dev/loop1790 rw",
                    r"3 0 0:83 / /private rw - btrfs /dev/loop17900 rw",
                    r"4 0 0:84 / /private rw - btrfs /dev/brain-native-proof-loop\040foreign rw",
                    r"5 0 0:85 / /private rw - overlay overlay rw",
                    r"6 0 0:86 / /private rw - btrfs /dev/brain-native-proof-\154oop rw"]
            for pid in range(130):
                base = proc / str(pid); base.mkdir(); (base / "ns").mkdir()
                (base / "status").write_text("Name:\tOdysseus\nUid:\t1000\nState:\tS\n")
                (base / "ns/mnt").symlink_to("mnt:[42]")
                (base / "mountinfo").write_text("\n".join(rows + rows * 3) + "\n")
            result = evidence.collect(proc, root / "sys", budget=10)
            self.assertTrue(result["truncated"], "LOOP_SAMPLE_PID_BOUND")
            mounts = result["processes"][0]["mounts"]
            self.assertTrue(mounts["truncated"], "LOOP_SAMPLE_MOUNT_BOUND")
            self.assertEqual([row["ownedDevice"] for row in mounts["facts"][:6]], [True, True, False, False, False, False], "LOOP_BTRFS_SOURCE_OWNERSHIP")
            for private in ("secret", "private", "/dev/", "foreign"):
                self.assertNotIn(private, json.dumps(result), "LOOP_SAMPLE_REDACTION")
            self.assertEqual(result["before"]["device"]["unknown"], "FileNotFoundError", "LOOP_SAMPLE_UNKNOWN")
            self.assertGreaterEqual(result["after"]["monoNs"], result["before"]["monoNs"])
            self.assertTrue(evidence.collect(proc, root / "sys", budget=0)["truncated"])

    def test_trace_protocol_filters_both_events_and_stacks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / "instances").mkdir()
            (root / "available_filter_functions").write_text("")
            kernel = Kernel()
            with patch.object(trace, "TRACE", root), patch.object(trace, "STATE", root / "state"), patch.object(trace, "write", kernel.write):
                trace.start(root / "receipt.json")
                receipt = json.loads((root / "receipt.json").read_text())
            self.assertEqual(len(kernel.events), 2, "LOOP_ONLY_TWO_DISK_PROBES")
            self.assertTrue(all(value.get("admitted") for value in receipt["availability"].values()))
            self.assertEqual(kernel.emit(7, 1790), [("lo_open", True, True), ("lo_release", True, True)], "LOOP_OWNED_EVENTS_AND_STACKS")
            for major, minor in ((7, 1791), (8, 1790), (7, 0)):
                self.assertTrue(all(not event and not stack for _, event, stack in kernel.emit(major, minor)), "LOOP_FOREIGN_EVENTS_AND_STACKS_REFUSED")

    def test_admission_failure_diagnostics_and_first_match(self):
        class Lines(io.StringIO):
            def readline(self, *args):
                result = super().readline(*args)
                if not result: raise AssertionError("read past first match")
                return result
        with patch.object(pathlib.Path, "open", return_value=Lines("lo_open [loop]\n")):
            self.assertTrue(trace.available("lo_open"), "LOOP_SYMBOL_FIRST_MATCH")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / "instances").mkdir()
            (root / "available_filter_functions").write_text("lo_open\n")
            (root / "error_log").write_text("")
            kernel = Kernel()
            def reject(path, value):
                if path.name == "kprobe_events":
                    (root / "error_log").write_text("[1] location: rejected\n  Command: " + value + "\n       ^\n")
                    raise OSError(errno.EINVAL, "rejected")
                kernel.write(path, value)
            with patch.object(trace, "TRACE", root), patch.object(trace, "STATE", root / "state"), patch.object(trace, "write", reject):
                trace.start(root / "receipt.json")
                result = json.loads((root / "receipt.json").read_text())["availability"]
            self.assertEqual(result["lo_open"]["phase"], "registration", "LOOP_FAILURE_PHASE")
            self.assertEqual(result["lo_open"]["classification"], "hint-only: rejected command", "LOOP_ERROR_CONTEXT_IS_HINT")
            self.assertTrue(result["lo_open"]["errorLog"], "LOOP_ERROR_LOG_RETAINED")
            self.assertFalse(result["lo_release"]["ftraceListingHint"])
            self.assertIn("^", result["lo_open"]["errorLog"][0], "LOOP_ERROR_CARET_RETAINED")
            self.assertFalse(kernel.events, "LOOP_NO_FAILED_ENABLE")

    def test_error_context_never_borrows_earlier_probe_or_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); group = "brainloop_owned"
            old = "[1] error: old\n Command: p:brainloop_owned/lo_open lo_open comm=$comm\n ^\n"
            (root / "error_log").write_text(old)
            with patch.object(trace, "TRACE", root):
                result = trace.failure(OSError(errno.EINVAL, "rejected"), "registration", group, "lo_release", "p:brainloop_owned/lo_release lo_release comm=$comm", "")
                self.assertEqual(result["errorLog"], [], "LOOP_NO_OTHER_PROBE_CONTEXT")
                result = trace.failure(OSError(errno.EINVAL, "rejected"), "enable", group, "lo_open", "1", old)
                self.assertEqual(result["errorLog"], [], "LOOP_NO_EARLIER_PHASE_CONTEXT")

    def test_salvage_precedes_failed_cleanup_and_missing_receipt(self):
        for mode in ("disable", "unregister", "receipt"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory); (root / "instances").mkdir(); kernel = Kernel()
                with patch.object(trace, "TRACE", root), patch.object(trace, "STATE", root / "state"), patch.object(trace, "write", kernel.write):
                    trace.start(root / "receipt.json")
                    state = json.loads((root / "state").read_text()); instance = root / "instances" / state["group"]
                    (instance / "trace").write_text("salvage before failure")
                    if mode == "receipt": (root / "receipt.json").unlink()
                    attempted = []; original_rmdir = pathlib.Path.rmdir
                    def broken(path, value):
                        if value.startswith("-:"): attempted.append(value)
                        if (mode == "disable" and path.name == "enable") or (mode == "unregister" and value.startswith("-:")):
                            raise PermissionError(errno.EACCES, "original cleanup failure")
                        kernel.write(path, value)
                    def remove(path): (path / "trace").unlink(); original_rmdir(path)
                    with patch.object(trace, "write", broken), patch.object(pathlib.Path, "rmdir", remove):
                        with self.assertRaises((PermissionError, FileNotFoundError)) as caught: trace.stop()
                    self.assertTrue((root / "receipt.trace.json").exists(), "LOOP_SALVAGE_SURVIVES_CLEANUP_FAILURE")
                    self.assertEqual(json.loads((root / "receipt.trace.json").read_text())["trace"], "salvage before failure", "LOOP_SALVAGE_SURVIVES_CLEANUP_FAILURE")
                    self.assertEqual(len(attempted), 2, "LOOP_CLEANUP_ATTEMPTS_BOTH_OWNED_PROBES")
                    self.assertTrue((root / "state").exists(), "LOOP_FAILURE_NOT_CLAIMED_CLEAN")
                    self.assertEqual(json.loads((root / "receipt.stop.json").read_text())["originalFailure"], type(caught.exception).__name__, "LOOP_ORIGINAL_STOP_FAILURE_RETAINED")

    def test_filter_or_trigger_rejection_never_enables_event(self):
        for failed in ("filter", "trigger", "enable"):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory); (root / "instances").mkdir()
                (root / "available_filter_functions").write_text("lo_open\nlo_release\n")
                kernel = Kernel()
                def reject(path, value):
                    if path.name == failed: raise OSError(errno.EINVAL, "rejected")
                    kernel.write(path, value)
                with patch.object(trace, "TRACE", root), patch.object(trace, "STATE", root / "state"), patch.object(trace, "write", reject):
                    trace.start(root / "receipt.json")
                receipt = json.loads((root / "receipt.json").read_text())
                self.assertTrue(all(event.get("enable") != "1" for event in kernel.events.values()), "LOOP_REJECTED_ADMISSION_DISABLED")
                self.assertTrue(all("admitted" not in value for value in receipt["availability"].values()))

    def test_stop_removes_only_owned_protocol_state_and_retains_trace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / "instances").mkdir()
            (root / "available_filter_functions").write_text("lo_open\nlo_release\n")
            kernel = Kernel(); original_rmdir = pathlib.Path.rmdir
            with patch.object(trace, "TRACE", root), patch.object(trace, "STATE", root / "state"), patch.object(trace, "write", kernel.write):
                trace.start(root / "receipt.json")
                state = json.loads((root / "state").read_text())
                instance = root / "instances" / state["group"]
                (instance / "trace").write_text("owned trace bytes")
                kernel.events["foreign/event"] = {"enable": "1"}
                def remove(path):
                    self.assertEqual(path, instance, "LOOP_ONLY_OWNED_INSTANCE_REMOVED")
                    (path / "trace").unlink(); original_rmdir(path)
                with patch.object(pathlib.Path, "rmdir", remove): trace.stop()
                self.assertFalse((root / "state").exists(), "LOOP_OWNED_STATE_RELEASED")
                self.assertEqual(kernel.events, {"foreign/event": {"enable": "1"}}, "LOOP_FOREIGN_PROBES_PRESERVED")
                self.assertTrue((root / "receipt.trace.json").exists(), "LOOP_SALVAGE_PRESENT")
                self.assertEqual(json.loads((root / "receipt.trace.json").read_text())["trace"], "owned trace bytes")
                self.assertIn("stoppedMonoNs", json.loads((root / "receipt.json").read_text()))

    def test_foreign_state_and_nonfatal_lifecycle_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); state = root / "state"; state.write_text("foreign-state")
            with patch.object(trace, "TRACE", root / "no-tracefs"), patch.object(trace, "STATE", state), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(trace.main(["start", str(root / "receipt.json")]), 1)
                self.assertTrue(state.exists(), "LOOP_TRACE_FOREIGN_STATE_EXISTS")
                self.assertEqual(state.read_text(), "foreign-state", "LOOP_TRACE_FOREIGN_STATE_PRESERVED")
                self.assertIn("owned-loop-availability-failure", output.getvalue())
            # An output PermissionError remains explicit, never a successful stop receipt.
            state.write_text(json.dumps(dict(group="owned", output=str(root / "receipt.json"), events=[])))
            with patch.object(trace, "TRACE", root / "no-tracefs"), patch.object(trace, "STATE", state), patch.object(trace, "stop", side_effect=PermissionError(errno.EACCES, "denied")), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(trace.main(["stop"]), 1)
                self.assertEqual(json.loads(output.getvalue())["failure"], "PermissionError")
            workflow = (HERE.parent.parent / ".github/workflows/ci.yml").read_text()
            for name in ("Start", "Stop"):
                step = workflow.split(f"- name: {name} optional owned-loop kernel trace\n")[1].split("      - name:")[0]
                self.assertIn("continue-on-error: true", step, "LOOP_DIAGNOSTIC_NONFATAL")

    def fixture_namespace(self, process):
        tree = ast.parse((HERE / "fixture.py").read_text())
        definitions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("observe", "remove_evidence")]
        records = []
        namespace = dict(errno=errno, subprocess=process, time=time, json=json, signal=signal, os=os,
                         record=lambda kind, **facts: records.append(facts))
        exec(compile(ast.Module(body=definitions, type_ignores=[]), "fixture-functions", "exec"), namespace)
        return tree, namespace, records

    def test_original_cleanup_failure_survives_broken_observer(self):
        class Broken:
            @staticmethod
            def Popen(*args, **kwargs): raise RuntimeError("observer failed")
            PIPE, DEVNULL = subprocess.PIPE, subprocess.DEVNULL
        tree, namespace, records = self.fixture_namespace(Broken)
        original = OSError(errno.EBUSY, "original busy")
        namespace["remove_evidence"](original)
        self.assertEqual(records[-1]["unknown"], "RuntimeError", "LOOP_OBSERVER_FAILURE_EXPLICIT")
        namespace["remove_evidence"](OSError(errno.EPERM, "denied"))
        self.assertEqual(len(records), 1, "LOOP_ONLY_EBUSY_SAMPLED")
        class Ioctl:
            calls = 0
            @classmethod
            def ioctl(cls, *args): cls.calls += 1; raise original
        class Missing:
            def exists(self): return False
        class Quota:
            def __truediv__(self, _): return self
            def read_text(self): return "quota"
        namespace.update(dict(mounted=False, attached=False, loop=None, created=True, control=None, image=None,
                              failure=None, BACKING=Missing(), outer_quota="quota", fcntl=Ioctl, MINOR=1790,
                              pathlib=type("Paths", (), {"Path": lambda _: Quota()})))
        cleanup = next(n for n in tree.body if isinstance(n, ast.Try)).finalbody
        exec(compile(ast.Module(body=cleanup, type_ignores=[]), "fixture-cleanup", "exec"), namespace)
        self.assertEqual(Ioctl.calls, 1, "LOOP_SINGLE_REMOVE")
        self.assertEqual(namespace["errors"], [str(original)], "LOOP_ORIGINAL_ERROR_RETAINED")
        self.assertEqual(str(namespace["failure"]), "Native proof cleanup failed", "LOOP_CLEANUP_STAYS_FAILED")

    def test_termination_error_is_unknown_without_replacing_busy(self):
        class Child:
            pid, stdout = 123, io.BytesIO()
            def poll(self): return None
            def communicate(self, timeout): raise ValueError("broken collector")
        process = type("Process", (), dict(Popen=lambda *a, **kw: Child(), PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL, TimeoutExpired=subprocess.TimeoutExpired))
        _, namespace, records = self.fixture_namespace(process)
        with patch.object(os, "killpg", side_effect=PermissionError(errno.EPERM, "denied")):
            namespace["remove_evidence"](OSError(errno.EBUSY, "busy"))
        self.assertEqual(records[-1]["childLifetime"], "unknown: PermissionError", "LOOP_TERMINATION_FAILURE_CANNOT_ESCAPE")

    def test_timeout_has_no_unbounded_reap(self):
        waits = []
        class Stuck:
            pid = 123
            stdout = io.BytesIO()
            @staticmethod
            def poll(): return None
            @staticmethod
            def communicate(timeout):
                assert timeout == 2
                raise subprocess.TimeoutExpired("collector", timeout)
            @staticmethod
            def wait(timeout=None):
                waits.append(timeout)
                raise subprocess.TimeoutExpired("collector", timeout)
        process = type("Process", (), dict(Popen=lambda *a, **kw: Stuck(), PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL, TimeoutExpired=subprocess.TimeoutExpired))
        _, namespace, records = self.fixture_namespace(process)
        with patch.object(os, "killpg") as kill:
            namespace["remove_evidence"](OSError(errno.EBUSY, "busy"))
            kill.assert_called_once_with(123, signal.SIGKILL)
        self.assertEqual(waits, [0.2], "LOOP_REAP_MUST_BE_BOUNDED")
        self.assertIn("uninterruptible", records[-1]["childLifetime"], "LOOP_CHILD_LIFETIME_UNKNOWN")

if __name__ == "__main__": unittest.main()
