"""File-only controls at sysfs/read/remove boundary; no real device is opened."""
import builtins, importlib.util, io, os, pathlib, stat, tempfile, unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('remove', pathlib.Path(__file__).with_name('owned-remove.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Controls(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        root = pathlib.Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.device = pathlib.Path('/dev/brain-native-proof-loop'); self.node_exists = True
        self.entry = root/'entry'; self.entry.mkdir(); (self.entry/'holders').mkdir()
        (self.entry/'dev').write_text('7:1790\n'); (self.entry/'size').write_text('0\n')
        self.link = root/'link'; self.link.symlink_to(self.entry)
        self.mounts = root/'mountinfo'; self.mounts.write_text('')
        self.stack.enter_context(patch.object(m, 'SYSFS_LINK', self.link))
        self.stack.enter_context(patch.object(m, 'MOUNTINFO', self.mounts))
        # Only the fake device's stat metadata is synthetic; all other paths use
        # real per-path filesystem identities and symlink resolution.
        def missing(): raise FileNotFoundError('fake owned node vanished')
        lstat = pathlib.Path.lstat
        self.node = dict(st_dev=1, st_ino=2, st_uid=0, st_gid=0, st_mode=stat.S_IFBLK|0o600, st_rdev=os.makedev(7,1790))
        self.stack.enter_context(patch.object(pathlib.Path, 'lstat', lambda p: (SimpleNamespace(**self.node) if self.node_exists else missing()) if p == self.device else lstat(p)))
        self.nid = m.identity(self.device); self.eid = m.identity(self.entry)
        self.opens = []
        for owner, name in [(builtins,'open'),(io,'open'),(os,'open')]:
            original = getattr(owner,name)
            def opened(path, *args, _original=original, **kwargs):
                self.opens.append(path)
                if not isinstance(path,int) and pathlib.Path(path) == self.device:
                    raise AssertionError('DEVICE_OPEN_FORBIDDEN')
                return _original(path,*args,**kwargs)
            self.stack.enter_context(patch.object(owner,name,opened))
    def invoke(self, errors, change=lambda: None, advance=0, sleep_advance=True):
        self.receipt = {}; self.now = 10**18; self.starts = []; self.sleeps = []; self.raised = None
        errors = iter(errors)
        def ioctl(*args):
            self.assertEqual(args, (123,0x4c81,1790)); self.starts.append(self.now)
            self.now += advance
            code = next(errors)
            if len(self.starts)==1: change()
            if code: raise OSError(code,'control')
        def sleep(seconds):
            self.sleeps.append(seconds)
            if sleep_advance: self.now += round(seconds*1e9)
        with patch.object(m.fcntl,'ioctl',side_effect=ioctl), patch.object(m.time,'monotonic_ns',side_effect=lambda:self.now), patch.object(m.time,'sleep',side_effect=sleep):
            try: m.remove_owned(123,self.device,self.nid,self.entry,self.eid,self.receipt)
            except Exception as error: self.raised = error
        self.assertFalse(any(not isinstance(p,int) and pathlib.Path(p)==self.device for p in self.opens), 'NO_DEVICE_OPEN')
    def test_busy_success(self):
        self.invoke([16,None]); self.assertIsNone(self.raised,'RETRY_REQUIRED'); self.assertEqual(len(self.starts),2)
        self.assertEqual(self.receipt['outcome'],'removed'); self.assertEqual(self.receipt['attempts'][0]['errno'],16)
        self.assertEqual(self.receipt['attempts'][0]['startNs'],0,'OFFSETS_NOT_HOST_UPTIME')
    def test_cap(self):
        self.invoke([16]*60,sleep_advance=False)
        self.assertEqual(len(self.starts),50,'CAP_REQUIRED'); self.assertIsInstance(self.raised,OSError)
        self.assertEqual(self.raised.errno,16); self.assertEqual(self.receipt['outcome'],'failed')
    def test_deadline(self):
        self.invoke([16]*60,advance=30_000_000)
        self.assertLess(len(self.starts),50,'DEADLINE_REQUIRED')
        self.assertTrue(all(t-self.starts[0]-30_000_000 < m.LIMIT_NS for t in self.starts),'NO_LATE_IOCTL')
        self.assertIsInstance(self.raised,OSError); self.assertEqual(self.raised.errno,16)
        self.assertIn('originalEBUSY',self.receipt)
    def test_nonbusy(self):
        for errors, count in [([1,None],1),([6,None],1),([19,None],1),([16,19,None],2)]:
            self.invoke(errors); self.assertEqual(len(self.starts),count,'ONLY_EBUSY_RETRIED')
            self.assertEqual(self.raised.errno,errors[count-1]); self.assertEqual(self.receipt['outcome'],'failed')
            if count==2: self.assertIn('originalEBUSY',self.receipt)
    def refuse(self, change, message):
        self.invoke([16,None],change)
        self.assertEqual(len(self.starts),1,'NO_IOCTL_AFTER_GUARD_CHANGE')
        self.assertEqual(str(self.raised),message,'EXACT_GUARD_BARRIER')
        self.assertEqual(self.receipt['outcome'],'failed'); self.assertIn('originalEBUSY',self.receipt)
    def test_node_identity(self):
        self.refuse(lambda:self.node.update(st_ino=3),'Owned remove device identity lost')
    def test_node_rdev(self):
        self.refuse(lambda:self.node.update(st_rdev=os.makedev(7,1791)),'Owned remove device identity lost')
    def test_sysfs_identity(self):
        self.refuse(lambda:self.entry.chmod(0o700 if self.entry.stat().st_mode&0o777!=0o700 else 0o755),'Owned remove sysfs identity lost')
    def test_mapping(self):
        other=self.entry.parent/'other'; other.mkdir()
        def change(): self.link.unlink(); self.link.symlink_to(other)
        self.refuse(change,'Owned remove sysfs mapping changed')
    def test_dev(self): self.refuse(lambda:(self.entry/'dev').write_text('7:1791\n'),'Owned remove entry changed or nonempty')
    def test_size(self): self.refuse(lambda:(self.entry/'size').write_text('1\n'),'Owned remove entry changed or nonempty')
    def test_loop(self): self.refuse(lambda:(self.entry/'loop').mkdir(),'Owned remove entry rebound or held')
    def test_holder(self): self.refuse(lambda:(self.entry/'holders'/'owned').touch(),'Owned remove entry rebound or held')
    def test_node_vanished(self): self.refuse(lambda:setattr(self,'node_exists',False),'Owned remove device vanished')
    def test_sysfs_vanished(self): self.refuse(lambda:self.entry.rename(self.entry.parent/'gone'),'Owned remove sysfs vanished')
    def test_mount_major(self): self.mount('7:1790','/else','/dev/other')
    def test_mount_target(self): self.mount('0:42','/brain-fixture','/dev/other')
    def test_mount_device(self): self.mount('0:42','/else',str(self.device))
    def test_mount_loop(self): self.mount('0:42','/else','/dev/loop1790')
    def mount(self, number, target, source):
        self.refuse(lambda:self.mounts.write_text(f'1 0 {number} / {target} rw - btrfs {source} rw\n'),'Owned remove entry still mounted')
    def test_no_device_open(self):
        self.invoke([16,None]); self.assertIsNone(self.raised,'NO_DEVICE_OPEN')
    def test_capture_failure(self):
        for code in (None,16,19):
            receipt={}
            with patch.object(m,'validate',side_effect=AssertionError('NO_PARTIAL_VALIDATION')), patch.object(m.fcntl,'ioctl',side_effect=OSError(code,'control') if code else None) as call:
                try: m.remove_after_capture_failure(123,receipt)
                except OSError: pass
                self.assertEqual(call.call_count,1,'BASELINE_ONE_SHOT_REQUIRED')
                self.assertFalse(receipt['identityCaptured']); self.assertFalse(receipt['retry'])

class CaptureControls(unittest.TestCase):
    def test_fixture_early_capture_failure_preserves_main_one_shot(self):
        import ast
        source = pathlib.Path(__file__).with_name('fixture.py').read_text()
        tree = ast.parse(source)
        outer = next(node for node in tree.body if isinstance(node,ast.Try) and node.finalbody)
        first = next(i for i,node in enumerate(outer.body) if '0x4c80' in ast.unparse(node))
        last = next(i for i,node in enumerate(outer.body) if ast.unparse(node).startswith('loop = os.open'))
        setup = compile(ast.Module(body=outer.body[first:last],type_ignores=[]),'fixture-capture','exec')
        cleanup_node = next(node for node in outer.finalbody if isinstance(node,ast.If) and ast.unparse(node.test)=='created and (not attached)')
        cleanup = compile(ast.Module(body=[cleanup_node],type_ignores=[]),'fixture-cleanup','exec')
        for failure in ('resolve','mknod','entry-lstat','node-lstat','entry-mode','node-mode'):
            with self.subTest(failure=failure):
                calls=[]; receipt={}; errors=[]
                entry = pathlib.Path('/fake-owned-entry'); device=pathlib.Path('/dev/brain-native-proof-loop')
                def identify(path):
                    if (path==entry and failure=='entry-lstat') or (path==device and failure=='node-lstat'): raise OSError('capture failure')
                    mode = stat.S_IFDIR if path==entry else stat.S_IFBLK
                    if failure==('entry-mode' if path==entry else 'node-mode'): mode=stat.S_IFREG
                    return (1,2,0,0,mode,os.makedev(7,1790))
                env=dict(fcntl=m.fcntl,os=os,pathlib=pathlib,stat=stat,owned_remove=m,MINOR=1790,DEVICE=device,control=123,
                         created=False,attached=False,entry=None,entry_identity=None,node_identity=None,remove_receipt=receipt,errors=errors)
                with patch.object(pathlib.Path,'resolve',side_effect=OSError('capture failure') if failure=='resolve' else None,return_value=entry), patch.object(os,'mknod',side_effect=OSError('capture failure') if failure=='mknod' else None), patch.object(m,'identity',side_effect=identify), patch.object(m.fcntl,'ioctl',side_effect=lambda *args:calls.append(args)):
                    caught=None
                    try: exec(setup,env)
                    except (OSError,RuntimeError) as error: caught=error
                    self.assertIsNotNone(caught,'CAPTURE_FAILURE_REQUIRED')
                    self.assertTrue(env['created'])
                    exec(cleanup,env)
                self.assertEqual(calls,[(123,0x4c80,1790),(123,0x4c81,1790)],'BASELINE_ONE_SHOT_REQUIRED')
                self.assertFalse(env['created']); self.assertEqual(errors,[])
                self.assertEqual(receipt['identityCaptured'],False)
                self.assertEqual(receipt['retry'],False)

if __name__ == '__main__': unittest.main()
