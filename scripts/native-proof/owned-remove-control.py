import importlib.util, pathlib, unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('remove', 'scripts/native-proof/owned-remove.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Controls(unittest.TestCase):
    def invoke(self, errors):
        receipt = {}; now = [0]
        def sleep(seconds): now[0] += round(seconds * 1e9)
        def ioctl(*args):
            error = next(errors)
            if error: raise OSError(error, 'control')
        with patch.object(m, 'validate'), patch.object(m.fcntl, 'ioctl', side_effect=ioctl) as call, patch.object(m.time, 'monotonic_ns', side_effect=lambda: now[0]), patch.object(m.time, 'sleep', side_effect=sleep):
            try: m.remove_owned(1, None, None, None, None, receipt)
            except OSError: pass
        return receipt, call.call_count
    def test_busy_success(self):
        receipt, count = self.invoke(iter([16, None])); self.assertEqual(count, 2); self.assertEqual(receipt['outcome'], 'removed'); self.assertEqual(receipt['attempts'][0]['errno'], 16)
    def test_cap(self):
        receipt, count = self.invoke(iter([16]*51)); self.assertEqual(count, 50); self.assertEqual(receipt['outcome'], 'failed'); self.assertIn('originalEBUSY', receipt)
    def test_other_error(self):
        for error in (1, 6, 19):
            receipt, count = self.invoke(iter([error, None])); self.assertEqual(count, 1); self.assertEqual(receipt['outcome'], 'failed')
class Guards(unittest.TestCase):
    def test_each_refusal(self):
        import os, stat, tempfile
        with tempfile.TemporaryDirectory() as folder:
            entry = pathlib.Path(folder)
            (entry/'dev').write_text('7:1790\n'); (entry/'size').write_text('0\n'); (entry/'holders').mkdir()
            mounts = entry/'mountinfo'; mounts.write_text('')
            node = (1, 2, 0, 0, stat.S_IFBLK | 0o600, os.makedev(7,1790))
            sysid = m.identity(entry)
            def check(): m.validate(pathlib.Path('/dev/brain-native-proof-loop'), node, entry, sysid, mounts)
            with patch.object(m, 'identity', side_effect=lambda p: node if str(p).startswith('/dev/') else sysid), patch.object(pathlib.Path, 'resolve', return_value=entry):
                check()
                for filename, text in [('dev','7:1791\n'), ('size','1\n'), ('mountinfo','1 0 0:42 / /else rw - btrfs /dev/loop1790 rw\n')]:
                    path = entry/filename; original = path.read_text(); path.write_text(text)
                    with self.assertRaises((RuntimeError, OSError)): check()
                    path.write_text(original)
                for path in [entry/'loop', entry/'holders'/'foreign']:
                    path.mkdir()
                    with self.assertRaises(RuntimeError): check()
                    path.rmdir()
            for index in range(6):
                changed = list(node); changed[index] += 1
                with patch.object(m, 'identity', return_value=tuple(changed)), self.assertRaises(RuntimeError): check()
            with patch.object(m, 'identity', side_effect=FileNotFoundError), self.assertRaises(FileNotFoundError): check()
unittest.main()
