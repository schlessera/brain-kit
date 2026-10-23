/**
 * Fixed host-only Btrfs ioctl/sysfs helper for the reference pool (#2428).
 * The manager runs it with `python3 -I -S -c`; arguments are manager-chosen
 * paths and integers, never requester input. Structure offsets follow the
 * Linux UAPI headers `include/uapi/linux/btrfs.h` and `btrfs_tree.h` (v6.18).
 */
export const POOL_HELPER = String.raw`import os,sys,fcntl,struct,json,uuid,ctypes,errno,re
SYNC=0x9408; TREE_SEARCH=0xD0009411; SUBVOL_INFO=0x81f8943c; FS_INFO=0x8400941f
SUBVOL_CREATE=0x50009418; SNAP_CREATE=0x50009417; GETFLAGS=0x80089419; SETFLAGS=0x4008941a
QGROUP_CREATE=0x4010942a; QGROUP_LIMIT=0x8030942b
# BTRFS_SUBVOL_RDONLY for the ioctl flags; BTRFS_ROOT_SUBVOL_RDONLY in root item flags.
RDONLY=1<<1; ROOT_RDONLY=1<<0; INHERIT=1<<2; SET_LIMITS=1; MAX_RFER=1; MAX_EXCL=2
PROFILES=("single","dup","raid0","raid1","raid10","raid5","raid6","raid1c3","raid1c4")
QFIELDS=("referenced","exclusive","max_referenced","max_exclusive","limit_flags","rsv_data","rsv_meta_pertrans","rsv_meta_prealloc")
def opendir(path): return os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
def search(fd,tree,lo,hi,ltype,htype,limit):
 out=[]; key=[lo,ltype,0]
 while True:
  buf=bytearray(4096)
  struct.pack_into("<7Q4I4Q",buf,0,tree,key[0],hi,key[2],2**64-1,0,2**64-1,key[1],htype,4096,0,0,0,0,0)
  fcntl.ioctl(fd,TREE_SEARCH,buf,True)
  count=struct.unpack_from("<I",buf,64)[0]
  if count==0: return out
  offset=104; last=None
  for _ in range(count):
   _,objectid,keyoffset,kind,length=struct.unpack_from("<3Q2I",buf,offset); offset+=32
   if ltype<=kind<=htype: out.append((objectid,kind,keyoffset,bytes(buf[offset:offset+length])))
   offset+=length; last=(objectid,kind,keyoffset)
  if len(out)>limit: raise RuntimeError("tree search exceeded its fixed bound")
  if last[2]<2**64-1: key=[last[0],last[1],last[2]+1]
  elif last[1]<255: key=[last[0],last[1]+1,0]
  elif last[0]<hi: key=[last[0]+1,0,0]
  else: return out
def info(path):
 fd=opendir(path)
 try:
  s=os.fstat(fd)
  if s.st_ino!=256: raise RuntimeError("not a subvolume root")
  root=bytearray(504); fcntl.ioctl(fd,SUBVOL_INFO,root,True)
  fs=bytearray(1024); fcntl.ioctl(fd,FS_INFO,fs,True)
  q=lambda at: str(struct.unpack_from("<Q",root,at)[0])
  u=lambda at: bytes(root[at:at+16]).hex()
  return {"rootId":q(0),"parentId":q(264),"dirId":q(272),"uuid":u(296),"parentUuid":u(312),"receivedUuid":u(328),"ctransid":q(344),"otransid":q(352),
   "readOnly":bool(int(q(288))&ROOT_RDONLY),"fsid":str(uuid.UUID(bytes=bytes(fs[16:32]))),"devices":struct.unpack_from("<Q",fs,8)[0],"device":str(s.st_dev)}
 finally: os.close(fd)
def read(base,name):
 with open(base+"/"+name) as f: return f.read().strip()
def snapshot(fd,base,limit):
 spaces={}
 for kind in ("data","metadata","system"):
  directory=base+"/allocation/"+kind
  profiles=[name for name in os.listdir(directory) if name in PROFILES]
  spaces[kind]={"profiles":sorted(profiles),**{name:int(read(directory,name)) for name in ("disk_used","disk_total","bytes_used","bytes_reserved","bytes_may_use","bytes_pinned")}}
 qgroups={}
 for name in os.listdir(base+"/qgroups"):
  match=re.fullmatch(r"([0-9]+)_([0-9]+)",name)
  if not match: continue
  if len(qgroups)>limit: raise RuntimeError("qgroup census exceeded its fixed bound")
  qgroups[match[1]+"/"+match[2]]={field:int(read(base+"/qgroups/"+name,field)) for field in QFIELDS}
 status=search(fd,8,0,0,240,240,4)
 relations=[[objectid,keyoffset] for objectid,_,keyoffset,_ in search(fd,8,0,2**64-1,246,246,4*limit) if objectid<keyoffset]
 backrefs=[]
 for objectid,_,parent,data in search(fd,1,256,2**64-257,144,144,limit):
  dirid,_,length=struct.unpack_from("<QQH",data,0)
  backrefs.append({"rootId":str(objectid),"parentId":str(parent),"dirId":str(dirid),"name":data[18:18+length].decode("utf-8","surrogateescape")})
 dropping=[str(keyoffset) for _,_,keyoffset,_ in search(fd,1,2**64-5,2**64-5,48,48,limit)]
 if len(status)!=1 or len(status[0][3])<40: raise RuntimeError("simple quota status item is unavailable")
 version,generation,flags,_,enable=struct.unpack_from("<5Q",status[0][3],0)
 features=sorted(os.listdir(base+"/features"))
 return {"generation":read(base,"generation"),"mode":read(base+"/qgroups","mode"),"inconsistent":read(base+"/qgroups","inconsistent"),
  "override":read(base,"quota_override"),"nodesize":int(read(base,"nodesize")),"sectorsize":int(read(base,"sectorsize")),"features":features,
  "statusFlags":str(flags),"enableGeneration":str(enable),"spaces":spaces,"qgroups":qgroups,"relations":[[str(a),str(b)] for a,b in sorted(relations)],
  "subvolumes":sorted(backrefs,key=lambda item:int(item["rootId"])),"dropping":sorted(dropping,key=int)}
command=sys.argv[1]
if command=="observe":
 pool,fsid,limit=sys.argv[2],sys.argv[3],int(sys.argv[4])
 if not re.fullmatch(r"[0-9a-f-]{36}",fsid): raise RuntimeError("invalid pool fsid")
 fd=opendir(pool); base="/sys/fs/btrfs/"+fsid
 try:
  # A committed transaction runs delayed references, so the squota counters
  # and space_info totals describe one settled state unless writers race it.
  fcntl.ioctl(fd,SYNC)
  reads=0
  for _ in range(4):
   first=snapshot(fd,base,limit); second=snapshot(fd,base,limit); reads+=2
   if first==second: print(json.dumps({"stable":True,"reads":reads,**first})); break
  else: print(json.dumps({"stable":False,"reads":reads,**second}))
 finally: os.close(fd)
elif command=="inspect": print(json.dumps(info(sys.argv[2])))
elif command=="create":
 parent,name,limit,qgroup,source=sys.argv[2],sys.argv[3],int(sys.argv[4]),int(sys.argv[5]),sys.argv[6]
 # A worktree checkpoint (#2430) is born read-only inside the creating transaction.
 readonly=len(sys.argv)>7 and sys.argv[7]=="readonly"
 if readonly and source=="-": raise RuntimeError("a read-only pool root must be a snapshot")
 if not re.fullmatch(r"[0-9a-f-]{36}",name): raise RuntimeError("invalid pool root name")
 inherit=struct.pack("<4Q5QQ",SET_LIMITS,1,0,0,MAX_RFER|MAX_EXCL,limit,limit,0,0,qgroup)
 buffer=ctypes.create_string_buffer(inherit,len(inherit))
 parentfd=opendir(parent); sourcefd=opendir(source) if source!="-" else 0
 try:
  args=bytearray(4096)
  # btrfs_ioctl_vol_args_v2: fd, transid, flags, {size, qgroup_inherit}, name.
  struct.pack_into("<qQQQQ",args,0,sourcefd,0,INHERIT|(RDONLY if readonly else 0),len(inherit),ctypes.addressof(buffer))
  encoded=name.encode(); args[56:56+len(encoded)]=encoded
  try: fcntl.ioctl(parentfd,SNAP_CREATE if source!="-" else SUBVOL_CREATE,args)
  except OSError as error:
   if error.errno in (errno.EDQUOT,errno.ENOSPC,errno.EEXIST): print(json.dumps({"error":errno.errorcode[error.errno]})); sys.exit(3)
   raise
 finally:
  os.close(parentfd)
  if sourcefd: os.close(sourcefd)
 print(json.dumps(info(parent+"/"+name)))
elif command=="seal":
 fd=opendir(sys.argv[2])
 try:
  flags=bytearray(8); fcntl.ioctl(fd,GETFLAGS,flags,True)
  value=struct.unpack("<Q",flags)[0]
  if not value&RDONLY: fcntl.ioctl(fd,SETFLAGS,struct.pack("<Q",value|RDONLY))
 finally: os.close(fd)
 print(json.dumps(info(sys.argv[2])))
elif command=="unseal":
 # Publication (#2429) moves a sealed root between directories, which Btrfs
 # refuses while the root is read-only; the manager reseals it at once.
 fd=opendir(sys.argv[2])
 try:
  flags=bytearray(8); fcntl.ioctl(fd,GETFLAGS,flags,True)
  value=struct.unpack("<Q",flags)[0]
  if value&RDONLY: fcntl.ioctl(fd,SETFLAGS,struct.pack("<Q",value&~RDONLY))
 finally: os.close(fd)
 print(json.dumps(info(sys.argv[2])))
elif command=="qgroup":
 pool,qgroup,limit=sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
 fd=opendir(pool)
 try:
  try: fcntl.ioctl(fd,QGROUP_CREATE,struct.pack("<QQ",1,qgroup))
  except OSError as error:
   if error.errno!=errno.EEXIST: raise
  fcntl.ioctl(fd,QGROUP_LIMIT,bytearray(struct.pack("<6Q",qgroup,MAX_RFER|MAX_EXCL,limit,limit,0,0)))
 finally: os.close(fd)
 print(json.dumps({"qgroup":str(qgroup),"limit":limit}))
elif command=="qgroup-remove":
 fd=opendir(sys.argv[2])
 try: fcntl.ioctl(fd,QGROUP_CREATE,struct.pack("<QQ",0,int(sys.argv[3])))
 finally: os.close(fd)
 print(json.dumps({"removed":sys.argv[3]}))
elif command=="ledger":
 # One flock-serialized ledger per physical backing filesystem. Every
 # participating consumer records the unbacked bytes it may still draw.
 path,consumer,unbacked,floor,backing=sys.argv[2],sys.argv[3],int(sys.argv[4]),int(sys.argv[5]),sys.argv[6]
 directory=os.path.dirname(path); dirfd=opendir(directory)
 try:
  fcntl.flock(dirfd,fcntl.LOCK_EX)
  entries={}
  try: fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  except FileNotFoundError: fd=None
  if fd is not None:
   try:
    s=os.fstat(fd)
    if not (s.st_mode&0o170000==0o100000) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o077 or s.st_size>65536: raise RuntimeError("untrusted headroom ledger")
    value=json.loads(os.read(fd,65537) or b"{}")
   finally: os.close(fd)
   if value.get("version")!=1 or not isinstance(value.get("entries"),dict): raise RuntimeError("invalid headroom ledger")
   entries=value["entries"]
   for key,item in entries.items():
    if not re.fullmatch(r"[0-9a-z:-]{1,96}",key) or not isinstance(item,dict) or sorted(item)!=["floorBytes","unbackedBytes"] or any(type(item[k]) is not int or item[k]<0 for k in item): raise RuntimeError("invalid headroom ledger entry")
  if len(entries)>256: raise RuntimeError("headroom ledger exceeded its fixed bound")
  others=sum(item["unbackedBytes"] for key,item in entries.items() if key!=consumer)
  floors=max([floor]+[item["floorBytes"] for key,item in entries.items() if key!=consumer])
  entries[consumer]={"unbackedBytes":unbacked,"floorBytes":floor}
  temporary=path+".tmp"
  if os.path.lexists(temporary): os.unlink(temporary)
  fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
  try: os.write(fd,json.dumps({"version":1,"entries":entries},sort_keys=True).encode()); os.fsync(fd)
  finally: os.close(fd)
  os.rename(temporary,path); os.fsync(dirfd)
  space=os.statvfs(backing); available=space.f_bavail*space.f_frsize
  print(json.dumps({"device":str(os.stat(path).st_dev),"availableBytes":available,"otherBytes":others,"floorBytes":floors,"headroomBytes":available-floors-others-unbacked}))
 finally: os.close(dirfd)
else: raise RuntimeError("unknown pool helper command")
`;
