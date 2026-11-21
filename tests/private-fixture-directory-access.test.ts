import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRIVATE_FIXTURE_DIRECTORY_ACCESS } from "../packages/ui-sdk/tests/fixtures/private-fixture-directory-access";

test("private fixture metadata ACL names one different UID and preserves worker-only file bytes", () => {
  const root=mkdtempSync(join(tmpdir(),"odysseus-private-fixture-")),privateRoot=join(root,"private"),file=join(privateRoot,"voyage.md");
  mkdirSync(privateRoot,{mode:0o700});writeFileSync(file,"Odysseus charts Ithaca.\n",{mode:0o600});
  const outside=join(root,"outside");mkdirSync(outside,{mode:0o700});mkdirSync(join(outside,"nested"),{mode:0o700});symlinkSync(outside,join(privateRoot,"alias"));
  const owner=process.getuid!(),reader=owner===21001?21002:21001;
  try {
    const result=Bun.spawnSync(["/usr/bin/python3","-I","-S","-c",PRIVATE_FIXTURE_DIRECTORY_ACCESS,privateRoot,String(owner),String(reader)],{stdout:"pipe",stderr:"pipe"});
    expect(result.exitCode,result.stderr.toString()).toBe(0);
    const inspect=Bun.spawnSync(["/usr/bin/python3","-I","-S","-c",`import json,os,struct,sys
try:
 b=os.getxattr(sys.argv[1],'system.posix_acl_access')
 rows=[list(struct.unpack('<HHI',b[i:i+8])) for i in range(4,len(b),8)]
except OSError:
 rows=[]
print(json.dumps(rows))`,privateRoot],{stdout:"pipe",stderr:"pipe"});
    expect(inspect.exitCode,inspect.stderr.toString()).toBe(0);
    expect(JSON.parse(inspect.stdout.toString()),"EXACT_UID_READ_TRAVERSE_ACL").toEqual([[1,7,4294967295],[2,5,reader],[4,0,4294967295],[16,5,4294967295],[32,0,4294967295]]);
    expect(lstatSync(privateRoot).uid).toBe(owner);
    expect(lstatSync(privateRoot).mode & 0o007).toBe(0);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file,"utf8")).toBe("Odysseus charts Ithaca.\n");
    expect(lstatSync(outside).mode & 0o777,"SYMLINK_TARGET_IS_NOT_SHARED").toBe(0o700);
    expect(lstatSync(join(outside,"nested")).mode & 0o777,"SYMLINK_DESCENDANTS_ARE_NOT_SHARED").toBe(0o700);
  } finally {chmodSync(privateRoot,0o700);rmSync(root,{recursive:true,force:true});}
});
