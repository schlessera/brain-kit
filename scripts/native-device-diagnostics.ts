import {readFileSync} from "node:fs";
/** Temporary identity-only metadata probe: fixed paths, no permissions changed. */
export function nativeDeviceMetadataCommand(command:readonly string[]):string[] {
 return ["/usr/bin/python3","-I","-S","-c",'import os,sys\nfor path in ["/dev","/dev/urandom"]:\n try: os.stat(path); os.statvfs(path)\n except OSError: pass\nos.execvp(sys.argv[1],sys.argv[1:])',...command];
}
export function nativeDeviceMetadata(trace:string):Array<Record<string,string|number|boolean>> {
 const records=new Map<string,Record<string,string|number|boolean>>();
 for(const line of trace.split("\n")){
  const mount=/^\s*(?:[0-9]+\s+)?statfs\("(\/dev(?:\/urandom)?)", .*\bf_flags=([^,}]+).*\) = 0$/.exec(line);
  if(mount){const device=mount[1]==="/dev"?"dev":"urandom",flags=mount[2]!;records.set(device,{...records.get(device),device,nodev:/\bST_NODEV\b/.test(flags),nosuid:/\bST_NOSUID\b/.test(flags),ro:/\bST_RDONLY\b/.test(flags)});continue;}

  const match=/^\s*(?:[0-9]+\s+)?newfstatat\(AT_FDCWD, "(\/dev(?:\/urandom)?)", (.*)\) = (.*)$/.exec(line);
  if(!match)continue;
  const device=match[1]==="/dev"?"dev":"urandom",body=match[2]!,result=match[3]!;
  const mode=/\bst_mode=S_IF(?:DIR|CHR)\|([0-7]+)/.exec(body),uid=/\bst_uid=([0-9]+)/.exec(body),gid=/\bst_gid=([0-9]+)/.exec(body);
  if(result==="0"&&mode&&uid&&gid)records.set(device,{...records.get(device),device,mode:parseInt(mode[1]!,8),uid:Number(uid[1]),gid:Number(gid[1])});
  else {const error=/^-1 (EACCES|EPERM|ENOENT|ENOTDIR)\b/.exec(result);if(error)records.set(device,{device,error:error[1]!});}
 }
 return [...records.values()];
}

/** Exec positions and /dev basenames only; never retain executable or host paths. */
export function nativeStartupOpenStages(trace:string,expected:readonly string[],wrapper:string):Array<{stage:string;execPosition:number;device:string;error:string}> {
 const pendingExec=new Map<number,string>();
 const states=new Map<number,{stage:string;execPosition:number}>();const records:Array<{stage:string;execPosition:number;device:string;error:string}>=[];
 for(const line of trace.split("\n")){
  const exec=/^\s*(\d+)\s+execve\(("(?:\\.|[^"\\])*"),/.exec(line);
  if(exec){try{pendingExec.set(Number(exec[1]),JSON.parse(exec[2]!));}catch{continue;}}
  const resumed=/^\s*(\d+)\s+<\.\.\. execve resumed>/.exec(line),pid=exec?Number(exec[1]):resumed?Number(resumed[1]):undefined;
  if(pid!==undefined&&line.endsWith("= 0")){const path=pendingExec.get(pid);if(path){const previous=states.get(pid);states.set(pid,{stage:expected.includes(path)?"payload":path===wrapper?"wrapper":"bootstrap",execPosition:(previous?.execPosition??0)+1});}pendingExec.delete(pid);}
  const fork=/^\s*(\d+)\s+(?:clone3?|fork|vfork)\(.*\)\s+= (\d+)$/.exec(line);
  if(fork){const state=states.get(Number(fork[1]));if(state)states.set(Number(fork[2]),{...state});}
  const failed=/^\s*(\d+)\s+open(?:at2?)?\(.*?"(\/dev\/(?:stdin|stdout|stderr|null|urandom|tty|fd\/\d+|pts\/\d+|shm\/[^"/]+))".*= -1 (EACCES|EPERM)\b/.exec(line);
  if(failed){const state=states.get(Number(failed[1]))??{stage:"bootstrap",execPosition:0};const device=failed[2]!.startsWith("/dev/shm/")?"shm":failed[2]!.slice(5);records.push({...state,device,error:failed[3]!});}
 }
 return records.slice(-32);
}

/** Derive device restoration from the production keeper; never maintain a second device list. */
export function nativeProductDeviceMounts():string[] {
 const source=readFileSync(new URL("../packages/ui-sdk/src/server/worker-launcher.ts",import.meta.url),"utf8");
 const keeper=source.slice(source.indexOf("const keeperCommand ="),source.indexOf("child = Bun.spawn(keeperCommand"));
 const matches=[...keeper.matchAll(/\.\.\.(\[[^\]]+\])\.flatMap\(name => \["--dev-bind",/g)];
 if(matches.length!==1)throw Error("production keeper device policy is unavailable");
 const names:unknown=JSON.parse(matches[0]![1]!);
 if(!Array.isArray(names)||names.length!==6||new Set(names).size!==names.length||names.some(name=>typeof name!=="string"||!/^[_a-z]+$/.test(name)))throw Error("production keeper device policy is invalid");
 return names.flatMap(name=>["--dev-bind",`/dev/${name}`,`/dev/${name}`]);
}
export function nativeSeparateUidAuditCommand(bwrap:string,payload:readonly string[],auditStorage:string):string[] {
 return [bwrap,"--die-with-parent","--unshare-user","--unshare-pid","--unshare-net","--cap-drop","ALL","--bind","/","/","--proc","/proc",...nativeProductDeviceMounts(),"--tmpfs",auditStorage,"--",...payload];
}
