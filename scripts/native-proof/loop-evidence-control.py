"""File-only controls; no device access or trace registration."""
import ast, errno, importlib.util, json, pathlib, sys, tempfile, unittest
sys.dont_write_bytecode = True

HERE = pathlib.Path(__file__).parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

evidence, trace = module("loop-evidence"), module("loop-trace")

class Controls(unittest.TestCase):
    def test_bounded_redacted_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); proc = root / "proc"; proc.mkdir()
            for pid in range(130):
                base = proc / str(pid); base.mkdir(); (base / "ns").mkdir()
                (base / "status").write_text("Name:\tOdysseus\nUid:\t1000\nState:\tS\n")
                (base / "ns/mnt").symlink_to("mnt:[42]")
                (base / "mountinfo").write_text("1 0 7:1790 /secret /private rw - btrfs /hidden rw\n" * 20)
            result = evidence.collect(proc, root / "sys", budget=10)
            self.assertTrue(result["truncated"], "LOOP_SAMPLE_PID_BOUND")
            self.assertEqual(len(result["processes"]), 128)
            self.assertTrue(result["processes"][0]["mounts"]["truncated"], "LOOP_SAMPLE_MOUNT_BOUND")
            self.assertNotIn("secret", json.dumps(result), "LOOP_SAMPLE_REDACTION")
            self.assertNotIn("private", json.dumps(result))
            self.assertEqual(result["before"]["device"]["unknown"], "FileNotFoundError", "LOOP_SAMPLE_UNKNOWN")
            self.assertGreaterEqual(result["after"]["monoNs"], result["before"]["monoNs"])
            self.assertTrue(evidence.collect(proc, root / "sys", budget=0)["truncated"])

    def test_live_layout_required_and_owned_filter(self):
        types = [{"id": 1, "kind": "FUNC", "name": "lo_release", "type_id": 2},
                 {"id": 2, "kind": "FUNC_PROTO", "params": [{"type_id": 3}]},
                 {"id": 3, "kind": "PTR", "type_id": 4},
                 {"id": 4, "kind": "STRUCT", "name": "gendisk", "members": [
                     {"name": "major", "type_id": 5, "bits_offset": 32},
                     {"name": "first_minor", "type_id": 5, "bits_offset": 64}]},
                 {"id": 5, "kind": "INT", "size": 4}]
        self.assertIn("major=+4($arg1):u32 minor=+8($arg1):u32", trace.definitions(types, "lo_release", "owned"), "LOOP_TRACE_LIVE_OFFSETS")
        with self.assertRaises(ValueError, msg="LOOP_TRACE_NO_UNKNOWN_LAYOUT"): trace.definitions([], "lo_release", "owned")
        source = (HERE / "loop-trace.py").read_text()
        self.assertIn('predicate = "major == 7 && minor == 1790"', source, "LOOP_TRACE_OWNED_DEVICE_FILTER")
        self.assertIn('predicate = "cmd == 19585 && arg == 1790"', source, "LOOP_TRACE_OWNED_IOCTL_FILTER")
        # Unsupported registration must remain disabled; every enable follows filter admission.
        self.assertLess(source.index('(base / "filter").write_text(predicate)'), source.index('(base / "enable").write_text("1")'))

    def test_unavailable_trace_is_explicit_without_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            old_trace, old_state, old_run = trace.TRACE, trace.STATE, trace.subprocess.run
            trace.TRACE, trace.STATE = root / "no-tracefs", root / "state.json"
            def unavailable(*args, **kwargs): raise FileNotFoundError(errno.ENOENT, "missing BTF tool")
            trace.subprocess.run = unavailable
            try:
                output = root / "receipt.json"
                trace.start(output)
                result = json.loads(output.read_text())
                self.assertIn("unavailable", result, "LOOP_TRACE_UNAVAILABLE_EXPLICIT")
                self.assertTrue(all("unavailable" in value for value in result["availability"].values()))
                self.assertFalse(trace.STATE.exists(), "LOOP_TRACE_NO_REGISTRATION_WITHOUT_BTF")
            finally: trace.TRACE, trace.STATE, trace.subprocess.run = old_trace, old_state, old_run

    def test_trace_reservation_race_preserves_foreign_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            old_trace, old_state, old_run = trace.TRACE, trace.STATE, trace.subprocess.run
            trace.TRACE, trace.STATE = root / "tracefs", root / "state.json"
            def race(*args, **kwargs):
                trace.STATE.write_text("foreign-state")
                return type("Result", (), {"returncode": 0, "stdout": b'{"types":[]}'})()
            trace.subprocess.run = race
            try:
                trace.start(root / "receipt.json")
                self.assertEqual(trace.STATE.read_text(), "foreign-state", "LOOP_TRACE_FOREIGN_STATE_PRESERVED")
            finally: trace.TRACE, trace.STATE, trace.subprocess.run = old_trace, old_state, old_run

    def test_original_cleanup_failure_survives_collector_failure(self):
        tree = ast.parse((HERE / "fixture.py").read_text())
        definitions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("observe", "remove_evidence")]
        records = []
        class Broken:
            @staticmethod
            def run(*args, **kwargs): raise RuntimeError("observer failed")
        import time
        namespace = {"errno": errno, "subprocess": Broken, "time": time, "json": json, "record": lambda kind, **facts: records.append(facts)}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), "fixture-functions", "exec"), namespace)
        original = OSError(errno.EBUSY, "original busy")
        namespace["remove_evidence"](original)
        self.assertEqual(records[-1]["unknown"], "RuntimeError", "LOOP_OBSERVER_FAILURE_EXPLICIT")
        namespace["remove_evidence"](OSError(errno.EPERM, "denied"))
        self.assertEqual(len(records), 1, "LOOP_ONLY_EBUSY_SAMPLED")
        cleanup = next(n for n in tree.body if isinstance(n, ast.Try)).finalbody
        # Execute the actual cleanup block with its original remove failing and observer broken.
        class Ioctl:
            calls = 0
            @classmethod
            def ioctl(cls, *args):
                cls.calls += 1
                raise original
        class Missing:
            @staticmethod
            def exists(): return False
        class Quota:
            def __truediv__(self, _): return self
            def read_text(self): return "quota"
        namespace.update({"mounted": False, "attached": False, "loop": None, "created": True, "control": None, "image": None,
                          "failure": None, "BACKING": Missing(), "outer_quota": "quota", "fcntl": Ioctl,
                          "MINOR": 1790, "pathlib": type("Paths", (), {"Path": lambda _: Quota()}), "os": __import__("os")})
        exec(compile(ast.Module(body=cleanup, type_ignores=[]), "fixture-cleanup", "exec"), namespace)
        self.assertEqual(Ioctl.calls, 1, "LOOP_SINGLE_REMOVE")
        self.assertEqual(namespace["errors"], [str(original)], "LOOP_ORIGINAL_ERROR_RETAINED")
        self.assertEqual(str(namespace["failure"]), "Native proof cleanup failed", "LOOP_CLEANUP_STAYS_FAILED")

if __name__ == "__main__": unittest.main()
