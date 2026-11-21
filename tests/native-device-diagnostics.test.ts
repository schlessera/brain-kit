import { expect,test } from "bun:test";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeDeviceMetadata,nativeDeviceMetadataCommand } from "../scripts/native-device-diagnostics";
test("device metadata is collected by the harmless payload inside its actual view",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-device-metadata-"));
 try{
  const log=join(root,"trace"),strace=Bun.which("strace");expect(strace,"strace required for device metadata proof").toBeTruthy();
  const child=Bun.spawn([strace!,"-f","-qq","-e","trace=newfstatat","-e","abbrev=!newfstatat,statx","-o",log,"--","bwrap","--unshare-user","--uid","21002","--gid","21002","--unshare-net","--ro-bind","/","/","--dev","/dev","--",...nativeDeviceMetadataCommand(["/usr/bin/python3","-I","-S","-c",'import os; fd=os.open("/dev/urandom",os.O_RDONLY);os.close(fd)'])],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(out).toBe("");
  const records=nativeDeviceMetadata(readFileSync(log,"utf8"));
  expect(records.map(value=>value.device),"ACTUAL_CHILD_DEVICE_METADATA").toEqual(["dev","urandom"]);
  expect(records.find(value=>value.device==="dev")?.uid).toBe(21002);
  for(const value of records){expect(value.mode).toBeGreaterThan(0);expect(Number.isSafeInteger(value.uid)).toBe(true);expect(Number.isSafeInteger(value.gid)).toBe(true);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("device metadata cannot retain host paths or arbitrary syscall content",()=>{
 const trace='1 newfstatat(AT_FDCWD, "/home/private-owner/secret", {st_mode=S_IFDIR|0700, st_uid=1000, st_gid=1000}, 0) = 0\n2 newfstatat(AT_FDCWD, "/dev/urandom", {st_mode=S_IFCHR|0666, st_uid=21002, st_gid=21002, private="TOKEN=secret"}, 0) = 0\n3 newfstatat(AT_FDCWD, "/dev", 0x1, 0) = -1 EACCES (Permission denied)';
 expect(nativeDeviceMetadata(trace),"DEVICE_METADATA_FIXED_FIELDS_ONLY").toEqual([{device:"urandom",mode:0o666,uid:21002,gid:21002},{device:"dev",error:"EACCES"}]);
});
