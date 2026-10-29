"""Temporary fixed #3129 measurement packet. Never ordinary CI proof or a release gate."""
import argparse, hashlib, json, os, re, selectors, signal, stat, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'tmp/diag-3129'
POOL = ROOT/'tmp/reference-pool-proof'
KERNEL = '7.0.0-1017-azure'
TREE = '4436e086c921557b22f5e92b15834e7b62be3036'
JOB_BYTES = 128 * 1024 * 1024
LOG_BYTES = 16 * 1024 * 1024
TRACE_BYTES = 8 * 1024 * 1024

class SetupMismatch(Exception):
    pass

def sha(data): return hashlib.sha256(data).hexdigest()
def command(args): return subprocess.check_output(args, cwd=ROOT, text=True).strip()
def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        stream.write(json.dumps(value, sort_keys=True)+'\n'); stream.flush(); os.fsync(stream.fileno())
def append(path, value):
    fd = os.open(path, os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW, 0o600)
    try: os.write(fd, (json.dumps(value, sort_keys=True)+'\n').encode()); os.fsync(fd)
    finally: os.close(fd)
def marker(reason):
    OUT.mkdir(parents=True, exist_ok=True)
    append(OUT/'events.jsonl', {'kind':'SETUP_MISMATCH','reason':reason,'wall':time.time()})
    (OUT/'SETUP_MISMATCH').write_text(reason+'\n')
def kernel_admission(kernel, os_id, version):
    if kernel != KERNEL: raise SetupMismatch('kernel')
    if (os_id, version) != ('ubuntu','24.04'): raise SetupMismatch('os')

def reserve_metadata():
    path=OUT/'.metadata-reserve'
    if path.exists(): return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try: os.posix_fallocate(fd,0,1024*1024); os.fsync(fd)
    finally: os.close(fd)
def release_metadata():
    path=OUT/'.metadata-reserve'
    if path.exists(): path.unlink()

def initialize():
    tmp = ROOT/'tmp'; tmp.mkdir(exist_ok=True)
    if any(tmp.iterdir()): raise SetupMismatch('artifact_directory_not_empty')
    subprocess.run(['sudo','mount','-t','tmpfs','-o','size=128m,mode=0755,nosuid,nodev','diag-3129-artifacts',str(tmp)],check=True)
    subprocess.run(['sudo','chown',f'{os.getuid()}:{os.getgid()}',str(tmp)],check=True)
    OUT.mkdir(); POOL.mkdir(); reserve_metadata()
    write(OUT/'job.json', {'shard':os.environ.get('DIAG_SHARD'),'monoStarted':time.monotonic(),
                         'maxInvocations':4,'traceBytesPerInvocation':TRACE_BYTES,
                         'stdoutStderrBytesPerInvocation':LOG_BYTES,'artifactPayloadBytesPerJob':JOB_BYTES,
                         'tracefs':'TRACEFS_NOT_REQUESTED','rateEstimate':False})

def source_admission():
    inventory = json.loads((ROOT/'.diagnostic/source-inventory.json').read_text())
    overlay = json.loads((ROOT/'.diagnostic/overlay.json').read_text())['files']
    parent = command(['git','rev-parse','HEAD^'])
    parent_tree = command(['git','rev-parse',parent+'^{tree}'])
    if parent != inventory['c0'] or parent_tree != TREE: raise SetupMismatch('c0_identity')
    changed = command(['git','diff','--name-only','HEAD^','HEAD']).splitlines()
    if sorted(changed) != sorted(overlay): raise SetupMismatch('overlay_file_list')
    checksums = {}
    for line in (ROOT/'.diagnostic/SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ',1); checksums[name] = digest
    if set(checksums) != set(overlay)-{'.diagnostic/SHA256SUMS'}: raise SetupMismatch('overlay_hash_coverage')
    for name, digest in checksums.items():
        if sha((ROOT/name).read_bytes()) != digest: raise SetupMismatch('overlay_hash')
    if command(['git','diff','--name-only','HEAD']): raise SetupMismatch('destination_worktree_diff')
    expected = set(inventory['files']) | set(overlay)
    actual = set(command(['git','ls-files']).splitlines())
    if actual != expected: raise SetupMismatch('tracked_inventory')
    for name, row in inventory['files'].items():
        if name in overlay: continue
        path = ROOT/name
        data = os.readlink(path).encode() if row['mode']=='120000' else path.read_bytes()
        if sha(data) != row['sha256']: raise SetupMismatch('baseline_bytes')
    # Reject source shadows; only dependency installation and the bounded artifact area may be untracked.
    for base, dirs, files in os.walk(ROOT, followlinks=False):
        dirs[:] = [name for name in dirs if name not in ['.git','node_modules'] and Path(base)/name != ROOT/'tmp']
        for name in files:
            rel = str((Path(base)/name).relative_to(ROOT))
            if rel not in expected: raise SetupMismatch('untracked_source')
    return {'c0':parent,'c0Tree':parent_tree,'head':command(['git','rev-parse','HEAD']),
            'sourceFiles':len(inventory['files']),'overlay':sorted(overlay),
            'sourceInventorySHA256':sha((ROOT/'.diagnostic/source-inventory.json').read_bytes()),
            'overlayChecksumsSHA256':sha((ROOT/'.diagnostic/SHA256SUMS').read_bytes())}

def admit():
    release = dict(line.split('=',1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    kernel = os.uname().release
    kernel_admission(kernel,release['ID'].strip('"'),release['VERSION_ID'].strip('"'))
    if os.environ.get('GITHUB_RUN_ATTEMPT') != '1': raise SetupMismatch('rerun_forbidden')
    if os.environ.get('DIAG_SHARD') not in ['1','2','3','4']: raise SetupMismatch('shard')
    if os.environ.get('DIAG_SAMPLES') != '4': raise SetupMismatch('sample_bound')
    facts = source_admission()
    write(OUT/'admission.json', {'kernel':kernel,'os':'ubuntu24.04','source':facts,
                               'disposition':'SAME_KERNEL_MEASUREMENT_ONLY','tracefs':'TRACEFS_NOT_REQUESTED'})

# Mirrors installed SDK core.mjs: createRequire(import.meta.url).resolve(platformPackage + '/claude').
# Only resolve/read metadata here; never import the SDK or execute either binary.
SDK_RESOLVER = r'''import {createRequire} from "node:module"; import {readFileSync,realpathSync} from "node:fs"; import {dirname,join} from "node:path";
const root=process.cwd(); const product=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(root,"packages/ui-sdk"));
const rootEntry=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",root); const result={};
for(const [label,entry] of [["root",rootEntry],["product",product]]) { const binary=realpathSync(label==="root" ? Bun.resolveSync("@anthropic-ai/claude-agent-sdk-linux-x64/claude",root) : createRequire(entry).resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")); result[label]={entry,binaryVersion:JSON.parse(readFileSync(join(dirname(binary),"package.json"),"utf8")).version,version:JSON.parse(readFileSync(join(dirname(entry),"package.json"),"utf8")).version,binary}; }
console.log(JSON.stringify(result));'''

def environment():
    source_admission()
    if command(['bun','--version']) != '1.4.2': raise SetupMismatch('bun_version')
    bun = Path(command(['sh','-c','command -v bun'])).resolve()
    if sha(bun.read_bytes()) != 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c': raise SetupMismatch('bun_hash')
    identities = json.loads(command(['bun','-e',SDK_RESOLVER]))
    for label, expected in [('root','a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3'),
                            ('product','8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978')]:
        identity = identities[label]
        if identity['version'] != '0.3.293': raise SetupMismatch(label+'_sdk_version')
        if identity['binaryVersion'] != ('0.3.293' if label=='product' else '0.3.292'): raise SetupMismatch(label+'_native_version')
        binary = Path(identity['binary'])
        if not binary.is_relative_to(ROOT.resolve()): raise SetupMismatch(label+'_sdk_outside_destination')
        identity.update(sha256=sha(binary.read_bytes()),bytes=binary.stat().st_size,nlink=binary.stat().st_nlink)
        if identity['nlink'] != 1 or identity['sha256'] != expected or identity['bytes'] != (252755128 if label=='product' else 251456696): raise SetupMismatch(label+'_sdk_binary')
        identity['entry'] = str(Path(identity['entry']).relative_to(ROOT.resolve()))
        identity['binary'] = str(binary.relative_to(ROOT.resolve()))
    count = 0
    for base, dirs, files in os.walk(ROOT/'node_modules'):
        for name in files:
            path = Path(base)/name
            if path.is_file() and not path.is_symlink():
                count += 1
                if path.stat().st_nlink != 1: raise SetupMismatch('dependency_hardlink')
    lock = sha((ROOT/'bun.lock').read_bytes())
    if lock != '5bbd5f6651f111db3fcfabeda512d44a21163cba54c58993f8878012d548cc14': raise SetupMismatch('lock')
    image = command(['docker','image','inspect','brain-kit-native-runtime:1','--format','{{.Id}}'])
    tools = command(['docker','run','--rm','--network=none','--cap-drop=ALL','--entrypoint','/bin/sh',image,'-c',
                     'dpkg-query -W btrfs-progs python3 util-linux bubblewrap libseccomp2 git iproute2; sha256sum /usr/bin/bwrap'])
    if 'btrfs-progs\t6.6.3' not in tools or 'bubblewrap\t0.9.0' not in tools or 'e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71' not in tools:
        raise SetupMismatch('image_tools')
    security = json.loads(command(['docker','info','--format','{{json .SecurityOptions}}']))
    if not any(value.startswith('name=apparmor') for value in security): raise SetupMismatch('apparmor_runtime')
    # Resolve the exact script imports without importing product code.
    resolver = r'''import {readFileSync} from "node:fs"; let count=0; for(const file of ["scripts/native-proof/reference-pool.native.ts","packages/ui-sdk/src/server/native-reference-pool.ts"]){const s=readFileSync(file,"utf8");for(const x of s.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)){if(!x[2].startsWith("bun:")){Bun.resolveSync(x[2],process.cwd()+"/"+file.slice(0,file.lastIndexOf("/")));count++;}}} console.log(count);'''
    resolved = int(command(['bun','-e',resolver]))
    if resolved < 8: raise SetupMismatch('imports')
    write(OUT/'environment.json', {'bunSHA256':sha(bun.read_bytes()),'sdkVersion':'0.3.293',
                                 'sdkIdentities':identities,'historicalExecutableEquivalence':False,'dependencyFiles':count,
                                 'lockSHA256':lock,'image':image,'tools':tools,'resolvedImports':resolved,
                                 'tracefs':'TRACEFS_NOT_REQUESTED'})

def trace_summary(path):
    if path.stat().st_size > TRACE_BYTES: raise ValueError('DIAGNOSTIC_TRACE_BUDGET')
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    ids = set(); unequal = []; armed = []
    for row in rows:
        if row['observation_id'] in ids: raise ValueError('DIAGNOSTIC_DUPLICATE_OBSERVATION')
        ids.add(row['observation_id'])
        if row['exception'] is not None or row['reads'] not in [2,4,6,8]: raise ValueError('DIAGNOSTIC_TRACE_INCOMPLETE')
        if row['sync_start_ns'] > row['sync_done_ns'] or row['sync_done_ns'] > row['finished_mono_ns']: raise ValueError('DIAGNOSTIC_TIME_ORDER')
        if row['armed']:
            if row['arm']['worktreeId'] != row['operation'].get('from'): raise ValueError('DIAGNOSTIC_ARM_IDENTITY')
            armed.append(row)
        if not row['armed'] and row['stable'] and row['reads']==2:
            if 'pairs' in row: raise ValueError('DIAGNOSTIC_COMPACT_SHAPE')
            continue
        pairs = row['pairs']
        if len(pairs)*2 != row['reads'] or bool(pairs[-1]['equal']) != row['stable']: raise ValueError('DIAGNOSTIC_PAIR_SHAPE')
        if not row['stable'] and row['reads']!=8: raise ValueError('DIAGNOSTIC_READ_BOUND')
        ended=row['sync_done_ns']
        for index,pair in enumerate(pairs,1):
            stamps=[pair[key]['mono_ns'] for key in ['first_began','first_ended','second_began','second_ended']]
            if pair['index']!=index or stamps!=sorted(stamps) or ended>stamps[0]: raise ValueError('DIAGNOSTIC_PAIR_TIME_ORDER')
            ended=stamps[-1]
            if pair['equal'] and index!=len(pairs): raise ValueError('DIAGNOSTIC_READS_AFTER_EQUAL_PAIR')
            paths = [value['path'] for value in pair['differences']]
            if paths != sorted(paths) or pair['equal'] != (not paths): raise ValueError('DIAGNOSTIC_DIFF_SHAPE')
            if not pair['equal']: unequal.append({'operation':row['operation'],'armed':row['armed'],
                                                  'observation':row['observation_id'],'pair':pair})
    return {'observations':len(rows),'nearMisses':sum(row['stable'] and row['reads']>2 for row in rows),
            'changing':sum(not row['stable'] for row in rows),'armed':armed,'unequalPairs':unequal}

def loops_absent():
    return not any(Path('/sys/dev/block/7:'+str(minor)).exists() for minor in [2428,2429])
def wait_loops(seconds):
    deadline = time.monotonic()+seconds
    while not loops_absent() and time.monotonic()<deadline: time.sleep(min(.2,max(0,deadline-time.monotonic())))
    return loops_absent()
def classify(row, *, output_bound=False, wall_bound=False, text=''):
    """Keep product outcome and trace validity independent; called by invoke itself."""
    trace = row.get('trace')
    valid = (not row.get('traceError') and isinstance(trace,dict)
             and isinstance(trace.get('armed'),list) and len(trace['armed'])==1
             and type(trace.get('unequalPairCount')) is int and trace['unequalPairCount']>=0)
    row['measurementValid'] = bool(valid)
    row['productFailure'] = row['exit'] != 0 and bool(row.get('assertion'))
    if not valid: row['measurementError'] = row.get('traceError') or 'MISSING_OR_MALFORMED_TRACE'
    if output_bound: label='HARNESS_OUTPUT_LIMIT'
    elif wall_bound or row['exit'] in [124,137,-9,-15]: label='HARNESS_TIMEOUT'
    elif 'DIAGNOSTIC_' in text or not row['scriptStarted']: label='SETUP_OR_RECORDER_ERROR'
    elif not row['cleanupVerified']: label='CLEANUP_UNCERTAIN'
    elif row['exit']!=0: label='PRODUCT_FAILURE' if row['productFailure'] else 'NATIVE_FAILURE'
    elif not valid: label='RECORDER_ERROR'
    else: label='NEAR_MISS' if row['trace']['unequalPairCount'] else 'CLEAN'
    row['classification'] = label
    return row

def should_stop(row):
    return row['exit'] != 0 or row['classification'] not in ['CLEAN','NEAR_MISS'] or not row['cleanupVerified']

def invoke(index):
    if index not in [1,2,3,4]: raise SetupMismatch('invocation_bound')
    previous = [json.loads(line) for line in (OUT/'results.jsonl').read_text().splitlines()] if (OUT/'results.jsonl').exists() else []
    if len(previous)!=index-1 or any(should_stop(row) for row in previous): raise SetupMismatch('sample_already_stopped')
    source_admission()
    job = json.loads((OUT/'job.json').read_text())
    if time.monotonic()-job['monoStarted'] > 1500-245: raise SetupMismatch('job_collection_budget')
    if not wait_loops(10): raise SetupMismatch('owned_loop_persist_before_start')
    reserve_metadata()
    before = set(POOL.glob('run-pool-*')); began = time.monotonic()
    start = {'kind':'STARTED','index':index,'wall':time.time()}; append(OUT/'started.jsonl',start)
    row = {'index':index,'exit':125,'classification':'RECORDER_OR_HARNESS_ERROR','cleanupVerified':False,
           'artifact':None,'scriptStarted':None,'trace':None,'assertion':None}
    try:
        env = dict(os.environ, GEMINI_API_KEY='',ANTHROPIC_API_KEY='',TYPESAFE_API_KEY='',GH_TOKEN='',GITHUB_TOKEN='')
        args = ['timeout','--signal=TERM','--kill-after=5s','120s','bun','scripts/prove-reference-pool.ts']
        child = subprocess.Popen(args,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
        sel = selectors.DefaultSelector(); sel.register(child.stdout,selectors.EVENT_READ); total = 0; bound = False
        log = OUT/f'invocation-{index}.log'; wall_bound=False
        with log.open('xb') as output:
            while sel.get_map():
                if time.monotonic()-began >= 125:
                    wall_bound=True; os.killpg(child.pid,signal.SIGKILL); break
                for key,_ in sel.select(.2):
                    data = os.read(key.fileobj.fileno(),65536)
                    if not data: sel.unregister(key.fileobj); continue
                    if total+len(data)>LOG_BYTES:
                        bound=True; os.killpg(child.pid,signal.SIGTERM); break
                    output.write(data); total+=len(data)
                if bound: break
            output.flush(); os.fsync(output.fileno())
        try: code=child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGKILL); code=child.wait()
        row['exit']=code; row['stdoutBytes']=total
        new = set(POOL.glob('run-pool-*'))-before
        if len(new)!=1: raise ValueError('DIAGNOSTIC_ARTIFACT_IDENTITY')
        artifact = new.pop(); row['artifact']=artifact.name
        fixture = json.loads((artifact/'reference-pool-fixture.json').read_text())
        row['scriptStarted']=True if any(event.get('kind')=='command' and any('reference-pool.native.ts' in str(arg) for arg in event.get('argv',[])) for event in fixture) or (artifact/'reference-pool-receipts.json').exists() or (artifact/'diagnostic-trace/observations.jsonl').exists() else None
        last=fixture[-1]; row['cleanupVerified']=last.get('kind')=='cleanup' and last['mounted']==[] and last['loops']=={'store':False,'pool':False} and not last['errors'] and wait_loops(min(35,max(0,began+155-time.monotonic())))
        text=log.read_text(errors='replace'); matches=re.findall(r'error: (REFERENCE_[A-Z0-9_]+)',text)
        row['assertion']=matches[-1] if matches else None
        trace=artifact/'diagnostic-trace/observations.jsonl'
        if trace.exists():
            try:
                measured=trace_summary(trace)
                keys=sorted({value['path'] for item in measured['unequalPairs'] for value in item['pair']['differences']})
                row['trace']={key:measured[key] for key in ['observations','nearMisses','changing']}
                row['trace'].update(armed=[{'operation':item['operation'],'reads':item['reads'],'stable':item['stable']} for item in measured['armed']],
                                    unequalPairCount=len(measured['unequalPairs']),keys=[key[:256] for key in keys[:64]],
                                    summaryTruncated=len(keys)>64 or any(len(key)>256 for key in keys),raw='diagnostic-trace/observations.jsonl')
            except Exception as error: row['traceError']=str(error)
        classify(row, output_bound=bound, wall_bound=wall_bound, text=text)
    except BaseException as error:
        row['error']=str(error)
    finally:
        release_metadata()
        row['ms']=round((time.monotonic()-began)*1000); append(OUT/'results.jsonl',row)
    print(json.dumps(row,sort_keys=True))
    return 1 if should_stop(row) else 0

def finalize():
    OUT.mkdir(parents=True,exist_ok=True); release_metadata()
    results = [json.loads(line) for line in (OUT/'results.jsonl').read_text().splitlines()] if (OUT/'results.jsonl').exists() else []
    started = [json.loads(line) for line in (OUT/'started.jsonl').read_text().splitlines()] if (OUT/'started.jsonl').exists() else []
    summary = {'purpose':'unstable-pair measurement only','maxStarted':4,'started':len(started),'completed':len(results),
               'uncompleted':[row['index'] for row in started if row['index'] not in [value['index'] for value in results]],
               'results':results,'setupMismatch':(OUT/'SETUP_MISMATCH').exists(),'rateEstimate':False,
               'cleanDoesNotQualifyPR':True,'tracefs':'TRACEFS_NOT_REQUESTED'}
    write(OUT/'summary.json',summary)
    files={}; total=0
    for directory in [OUT,POOL]:
        if not directory.exists(): continue
        for path in sorted(directory.rglob('*')):
            if path.is_symlink(): raise ValueError('DIAGNOSTIC_ARTIFACT_SYMLINK')
            if not path.is_file(): continue
            data=path.read_bytes(); total+=len(data)
            if total>JOB_BYTES: raise ValueError('DIAGNOSTIC_ARTIFACT_BUDGET')
            files[str(path.relative_to(ROOT/'tmp'))]={'sha256':sha(data),'bytes':len(data)}
            os.chmod(path,0o644)
        for path in directory.rglob('*'):
            if path.is_dir(): os.chmod(path,0o755)
        os.chmod(directory,0o755)
    write(OUT/'artifact-manifest.json',{'version':1,'payloadBytes':total,'rawPayloadCapBytes':JOB_BYTES,
                                       'excludes':['diag-3129/artifact-manifest.json'],'files':files})
    os.chmod(OUT/'artifact-manifest.json',0o644)
    target=os.environ.get('GITHUB_STEP_SUMMARY')
    if target:
        with open(target,'a') as stream:
            stream.write('Temporary diagnostic only; no rate estimate or PR qualification.\n\n')
            stream.write('| Started | Original exit | Classification |\n|---|---|---|\n')
            for row in results: stream.write(f"| {row['index']} | {row['exit']} | {row['classification']} |\n")
    return 1 if summary['uncompleted'] else 0

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('action',choices=['init','admit','environment','invoke','finalize']); parser.add_argument('index',nargs='?',type=int)
    args=parser.parse_args()
    try:
        if args.action=='init': initialize()
        elif args.action=='admit': admit()
        elif args.action=='environment': environment()
        elif args.action=='invoke': return invoke(args.index)
        else: return finalize()
        return 0
    except BaseException as error:
        marker(str(error)); print('SETUP_MISMATCH '+str(error),file=sys.stderr); return 1
if __name__=='__main__': sys.exit(main())
