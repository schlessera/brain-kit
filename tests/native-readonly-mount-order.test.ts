import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferNativeReadOnlyRemounts, labelNativeMountErrors } from "../scripts/test-native-guard";

function plan(file:string,ordered:boolean,payload:string[]) {
 const argv=["bwrap","--unshare-user","--unshare-pid","--unshare-net","--die-with-parent","--ro-bind","/usr","/usr","--symlink","usr/bin","/bin","--symlink","usr/lib","/lib","--symlink","usr/lib64","/lib64","--proc","/proc","--dev","/dev","--tmpfs","/tmp","--tmpfs","/etc","--tmpfs","/run","--dir","/run/odysseus","--symlink","../run/odysseus/resolve.conf","/etc/resolv.conf","--remount-ro","/run","--remount-ro","/etc","--",...payload];
 const remounts=ordered?deferNativeReadOnlyRemounts(argv,0):[];
 argv.splice(argv.indexOf("--"),0,"--ro-bind",file,"/etc/resolv.conf","--ro-bind",file,"/etc/odysseus-extra.conf",...remounts);
 return argv;
}

test("real bwrap creates guarded file and symlink-alias targets before readonly parents",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-remount-order-")),file=join(root,"resolver");writeFileSync(file,"nameserver 127.0.0.1\n");
 try{
  const old=Bun.spawnSync(plan(file,false,["/usr/bin/true"]),{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(old.exitCode).not.toBe(0);expect(old.stderr.toString()).toContain("Read-only file system");
  const child=Bun.spawnSync(plan(file,true,["/usr/bin/true"]),{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(child.exitCode,"GUARD_MOUNTS_PRECEDE_READONLY_REMOUNTS "+child.stderr.toString()).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("final namespace mount table retains exactly the declared readonly masks",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-remount-table-")),file=join(root,"resolver");writeFileSync(file,"nameserver 127.0.0.1\n");
 try{
  const inspect='import json\nrows={}\nfor line in open("/proc/self/mountinfo"):\n p=line.split();\n if p[4] in ["/usr","/etc","/run","/tmp","/run/odysseus/resolve.conf","/etc/odysseus-extra.conf"]: rows[p[4]]="ro" in p[5].split(",")\nprint(json.dumps({"mounts":rows,"resolver":open("/etc/resolv.conf").read(),"extra":open("/etc/odysseus-extra.conf").read()}))';
  const child=Bun.spawnSync(plan(file,true,["/usr/bin/python3","-I","-S","-c",inspect]),{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
  expect(child.exitCode,child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString()),"FINAL_READONLY_POLICY_UNCHANGED").toEqual({mounts:{"/usr":true,"/etc":true,"/run":true,"/tmp":false,"/run/odysseus/resolve.conf":true,"/etc/odysseus-extra.conf":true},resolver:"nameserver 127.0.0.1\n",extra:"nameserver 127.0.0.1\n"});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("bwrap mount errors expose fixed target categories instead of host path segments",()=>{
 const text=labelNativeMountErrors("bwrap: Can't create file at /etc/odysseus.conf: Read-only file system\nbwrap: Can't create file at /home/circe/private.config: Permission denied");
 expect(text).toContain("[mount-target etc]");expect(text).toContain("[mount-target home-outside-fixture]");
 expect(text).not.toContain("circe");expect(text).not.toContain("odysseus.conf");expect(text).not.toContain("private.config");
});
