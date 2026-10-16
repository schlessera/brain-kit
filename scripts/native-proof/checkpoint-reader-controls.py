#!/usr/bin/python3
"""Offline disposable-container controls for the fixed checkpoint reader.

Run as initial-namespace container root with SYS_ADMIN for the foreign-mount
negative control. No SYS_PTRACE is needed. Uses only a fixture-owned temporary
root; the real Btrfs manager proof is a separate cell.
"""
import os,json,subprocess,uuid,tempfile,shutil,fcntl,stat,time
base=tempfile.mkdtemp(prefix='reader-');os.chmod(base,0o755);root=base+'/checkpoint';os.mkdir(root,0o700);os.chown(root,21002,21001)
rootfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);assert rootfd==3
import pathlib,re
source=(pathlib.Path(__file__).resolve().parents[2]/'packages/ui-sdk/src/server/native-checkpoint-reader.ts').read_text()
programs=dict(re.findall(r'(?:export )?const ([A-Z_]+) = String.raw`(.*?)`;',source,re.S))
program=programs['NATIVE_CHECKPOINT_READER_PROGRAM'];client=programs['NATIVE_CHECKPOINT_CLIENT_PROGRAM'];authority_client=programs['STAGE_AUTHORITY_CLIENT']
def drop():os.setgroups([]);os.setgid(21001);os.setuid(21001)
results=[]
def start(request):
 os.lseek(rootfd,0,os.SEEK_SET)
 channel=base+'/'+str(uuid.uuid4());token=str(uuid.uuid4())
 helper=subprocess.Popen(['/usr/bin/python3','-I','-S','-c',program,channel,token,'21001','21002','21001','5',json.dumps(request)],pass_fds=(3,),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert helper.stdout.readline()==b'{"ready": true}\n'
 return helper,channel,token
def run(name,action,path='',maximum=4096,ok=True,expected=b'Ithaca',uid=21002):
 helper,channel,token=start({'action':action,'path':path,'maximum':maximum})
 result=subprocess.run(['/usr/bin/python3','-I','-S','-c',client,channel,token,str(uid),str(maximum)],preexec_fn=drop,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
 code=helper.wait(timeout=8);errors=helper.stderr.read()
 assert (result.returncode==0)==ok,(name,result.returncode,result.stdout,result.stderr,code,errors)
 if ok:
  assert code==0,(name,errors)
  if action=='file':assert result.stdout==expected
  else:json.loads(result.stdout)
 else:assert not result.stdout,(name,'failed read leaked bytes',result.stdout)
 assert not os.path.exists(channel)
 results.append(name)
try:
 p=root+'/private';open(p,'wb').write(b'Ithaca');os.chown(p,21002,21001);os.chmod(p,0o600)
 run('worker0600-file','file','private')
 run('uid-mismatch-zero-bytes','file','private',ok=False,uid=21003)
 run('file-bound','file','private',maximum=5,ok=False)
 os.mkdir(root+'/secret',0o700);os.chown(root+'/secret',21002,21001);shutil.copy(p,root+'/secret/note');os.chown(root+'/secret/note',21002,21001)
 run('worker0700-directory','file','secret/note')
 os.symlink('private',root+'/link');run('leaf-link','file','link',ok=False)
 os.symlink('secret',root+'/parent-link');run('parent-link','file','parent-link/note',ok=False)
 os.link(p,root+'/alias');run('hard-link','file','private',ok=False);os.unlink(root+'/alias')
 run('incremental-metadata-bound','list',maximum=1,ok=False)
 os.chmod(p,0);run('chmod000-file','file','private',ok=False);run('chmod000-file-name-size','stat','private');os.chmod(p,0o600)
 os.chmod(root+'/secret',0);run('chmod000-directory','list','secret',ok=False);run('chmod000-directory-known-name','stat','secret');os.chmod(root+'/secret',0o700)
 os.mkdir(root+'/foreign');subprocess.run(['/usr/bin/mount','-t','tmpfs','tmpfs',root+'/foreign'],check=True)
 try:
  open(root+'/foreign/note','wb').write(b'Ithaca');os.chmod(root+'/foreign',0o755)
  run('foreign-mount-directory','list','foreign',ok=False);run('foreign-mount-file','file','foreign/note',ok=False)
 finally:subprocess.run(['/usr/bin/umount',root+'/foreign'],check=True)
 same=base+'/same-device';os.mkdir(same,0o755);open(same+'/note','wb').write(b'Ithaca');os.mkdir(root+'/same-mount-alias')
 subprocess.run(['/usr/bin/mount','--bind',same,root+'/same-mount-alias'],check=True)
 try:
  run('same-device-bind-mount-directory','list','same-mount-alias',ok=False)
  run('same-device-bind-mount-file','file','same-mount-alias/note',ok=False)
 finally:subprocess.run(['/usr/bin/umount',root+'/same-mount-alias'],check=True)
 raw=os.fsencode(root)+b'/\xff';fd=os.open(raw,os.O_CREAT|os.O_WRONLY,0o600);os.close(fd)
 run('invalid-utf8-name','list',ok=False);os.unlink(raw)
 authority={'version':1,'kind':'brain-worker-stage','id':str(uuid.uuid4())}
 helper,channel,token=start({'action':'authority','authority':authority})
 # The app must duplicate its own same-UID bridge, without SYS_PTRACE.
 app_program="""import subprocess,json,os,fcntl,stat,sys
bridge=subprocess.Popen(['/usr/bin/python3','-I','-S','-c',sys.argv[1],sys.argv[2],sys.argv[3]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
 receipt=json.loads(bridge.stdout.readline());fd=os.open('/proc/'+str(bridge.pid)+'/fd/'+str(receipt['fd']),os.O_RDONLY);info=os.fstat(fd)
 assert info.st_uid==0 and info.st_nlink==0 and stat.S_IMODE(info.st_mode)==0o444 and fcntl.fcntl(fd,fcntl.F_GET_SEALS)&15==15
 assert json.loads(os.read(fd,65536))==json.loads(sys.argv[4]);os.close(fd)
finally:bridge.stdin.close();assert bridge.wait()==0
"""
 app=subprocess.run(['/usr/bin/python3','-I','-S','-c',app_program,authority_client,channel,token,json.dumps(authority)],preexec_fn=drop,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
 assert app.returncode==0,app.stderr;assert helper.wait()==0;results.append('sealed-root-metadata-scm')
 # Cancellation must reap the fixed UID child even while its bounded pipe is full.
 large=root+'/large';open(large,'wb').write(b'x'*1048576);os.chown(large,21002,21001);os.chmod(large,0o600)
 helper,channel,token=start({'action':'file','path':'large','maximum':1048576})
 hold_program="import socket,array,sys; s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.sendall(sys.argv[2].encode());data,anc,flags,addr=s.recvmsg(1,socket.CMSG_SPACE(16));print('held',flush=True);sys.stdin.buffer.read()"
 hold=subprocess.Popen(['/usr/bin/python3','-I','-S','-c',hold_program,channel,token],preexec_fn=drop,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert hold.stdout.readline()==b'held\n'
 deadline=time.monotonic()+2;children=[]
 while time.monotonic()<deadline:
  children=open('/proc/'+str(helper.pid)+'/task/'+str(helper.pid)+'/children').read().split()
  if children:break
  time.sleep(.01)
 assert len(children)==1,children
 helper.terminate();assert helper.wait(timeout=8)!=0;assert not os.path.exists('/proc/'+children[0]);assert not os.path.exists(channel)
 hold.stdin.close();assert hold.wait(timeout=8)==0;results.append('cancel-reaps-blocked-reader')
 # Exercise the same fixed reader launched inside the real trusted stage helper's private mount namespace.
 stage_source=(pathlib.Path(__file__).resolve().parents[2]/'packages/ui-sdk/src/server/native-brain-stage.ts').read_text()
 stage_program=re.search(r'const STAGE_PROGRAM = String.raw`(.*?)`;',stage_source,re.S).group(1)
 mount=base+'/stage';os.mkdir(mount,0o700)
 stage=subprocess.Popen(['/usr/bin/unshare','--mount','/usr/bin/python3','-I','-S','-c',stage_program,mount,root,'21001','21001','16777216','21002',program,'5'],env={},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  line=stage.stdout.readline();assert line,stage.stderr.read();identity=json.loads(line);assert identity['mountNamespaceInode']
  channel=base+'/'+str(uuid.uuid4());token=str(uuid.uuid4());key=str(uuid.uuid4())
  request={'id':key,'socketPath':channel,'token':token,'request':{'action':'file','path':'private','maximum':4096}}
  stage.stdin.write(b'reader '+json.dumps(request).encode()+b'\n');stage.stdin.flush();assert json.loads(stage.stdout.readline())=={'reader':key}
  copied=subprocess.run(['/usr/bin/python3','-I','-S','-c',client,channel,token,'21002','4096'],preexec_fn=drop,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
  assert copied.returncode==0 and copied.stdout==b'Ithaca',(copied.returncode,copied.stdout,copied.stderr)
  stage.stdin.write(('cancel-reader '+key+'\n').encode());stage.stdin.flush();assert json.loads(stage.stdout.readline())=={'closed':key}
  results.append('private-file-through-owned-stage-root')
 finally:
  if stage.poll() is None:stage.stdin.write(b'release\n');stage.stdin.close()
  assert stage.wait(timeout=8)==0,stage.stderr.read()
 print(json.dumps({'passed':results,'count':len(results)}))
finally:os.close(rootfd);shutil.rmtree(base)
