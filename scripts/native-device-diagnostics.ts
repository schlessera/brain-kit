/** Temporary identity-only metadata probe: fixed paths, no permissions changed. */
export function nativeDeviceMetadataCommand(command:readonly string[]):string[] {
 return ["/usr/bin/python3","-I","-S","-c",'import os,sys\nfor path in ["/dev","/dev/urandom"]:\n try: os.stat(path)\n except OSError: pass\nos.execvp(sys.argv[1],sys.argv[1:])',...command];
}
export function nativeDeviceMetadata(trace:string):Array<Record<string,string|number>> {
 const records=new Map<string,Record<string,string|number>>();
 for(const line of trace.split("\n")){
  const match=/^\s*(?:[0-9]+\s+)?newfstatat\(AT_FDCWD, "(\/dev(?:\/urandom)?)", (.*)\) = (.*)$/.exec(line);
  if(!match)continue;
  const device=match[1]==="/dev"?"dev":"urandom",body=match[2]!,result=match[3]!;
  const mode=/\bst_mode=S_IF(?:DIR|CHR)\|([0-7]+)/.exec(body),uid=/\bst_uid=([0-9]+)/.exec(body),gid=/\bst_gid=([0-9]+)/.exec(body);
  if(result==="0"&&mode&&uid&&gid)records.set(device,{device,mode:parseInt(mode[1]!,8),uid:Number(uid[1]),gid:Number(gid[1])});
  else {const error=/^-1 (EACCES|EPERM|ENOENT|ENOTDIR)\b/.exec(result);if(error)records.set(device,{device,error:error[1]!});}
 }
 return [...records.values()];
}
