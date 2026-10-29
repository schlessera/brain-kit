"""Derived fixture prerequisites only; no raw host/process/environment dumps."""
mi = pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
def mounted_at(path):
    rows = [row for row in mi if row.split()[4] == path]
    assert len(rows) == 1, 'DIAGNOSTIC_MOUNT_IDENTITY'
    left, right = rows[0].split(' - ')
    assert right.split()[0] == 'btrfs', 'DIAGNOSTIC_NOT_BTRFS'
    assert {'nosuid', 'nodev'}.issubset(set(left.split()[5].split(','))), 'DIAGNOSTIC_MOUNT_FLAGS'
    return right.split()[2].split(',')
assert os.uname().release == '7.0.0-1017-azure', 'DIAGNOSTIC_ACTUAL_KERNEL'
assert os.getuid() == 0 and os.getgid() == 0, 'DIAGNOSTIC_FIXTURE_UID'
pool_options, store_options = mounted_at('/reference-pool'), mounted_at('/brain-fixture')
assert 'discard=async' in pool_options, 'DIAGNOSTIC_POOL_DISCARD'
assert not any(value.startswith('discard') for value in store_options), 'DIAGNOSTIC_STORE_DISCARD'
status = pathlib.Path('/proc/self/status').read_text()
derived = {key: value.strip() for key, value in (row.split(':',1) for row in status.splitlines() if ':' in row)}
cap = int(derived['CapEff'],16)
expected = sum(1 << bit for bit in [21, 27, 1, 3, 0, 5, 7, 6, 31])
assert all(int(derived[key],16)==expected for key in ['CapEff','CapPrm','CapBnd']), 'DIAGNOSTIC_CAPS'
assert int(derived['CapInh'],16)==int(derived['CapAmb'],16)==0, 'DIAGNOSTIC_AMBIENT_CAPS'
assert derived['NoNewPrivs']=='1' and derived['Seccomp']=='2', 'DIAGNOSTIC_RESTRICTIONS'
profile = pathlib.Path('/proc/self/attr/current').read_text().strip()
assert profile == 'brain-kit-native-proof (enforce)', 'DIAGNOSTIC_APPARMOR'
interfaces = [row.split(':')[0].strip() for row in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]]
assert interfaces == ['lo'], 'DIAGNOSTIC_NETWORK'
fsid = subprocess.check_output(['btrfs', 'filesystem', 'show', '--raw', str(POOL)]).decode().split('uuid: ')[1].split()[0]
sysbase = pathlib.Path('/sys/fs/btrfs') / fsid
assert (sysbase/'qgroups/mode').read_text().strip() == 'squota', 'DIAGNOSTIC_SQUOTA'
assert (sysbase/'qgroups/inconsistent').read_text().strip() == '0', 'DIAGNOSTIC_QUOTA_INCONSISTENT'
assert (sysbase/'quota_override').read_text().strip() == '0', 'DIAGNOSTIC_QUOTA_OVERRIDE'
features = sorted(item.name for item in (sysbase/'features').iterdir())
assert 'simple_quota' in features, 'DIAGNOSTIC_SIMPLE_QUOTA'
record('diagnostic-admitted', kernel=os.uname().release, disposition='SAME_KERNEL_MEASUREMENT',
       uid=os.getuid(), gid=os.getgid(), capEff=hex(cap), apparmor=profile, networkLoopbackOnly=True,
       restrictions={key:derived[key] for key in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp']},
       poolOptions=pool_options, storeOptions=store_options, features=features, tracefs='TRACEFS_NOT_REQUESTED')
