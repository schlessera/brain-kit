/** Real bubblewrap mount construction with /usr/bin/true only; never Claude. */
import { expect, test } from "bun:test";
import ts from "typescript";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeNamespacePolicy } from "../scripts/test-native-guard";
import { fixtureSources, namespaceLaunches } from "./helpers/native-launcher-inventory";
const root=join(import.meta.dir,"..");
for(const [file,source] of fixtureSources(root))for(const [index,plan] of namespaceLaunches(source).entries())test(`real bwrap policy mount survives read-only roots: ${file}:${index}`,()=>{
 const scratch=mkdtempSync(join(tmpdir(),"odysseus-policy-view-"));
 try {
  const policy=nativeNamespacePolicy(),argv:string[]=["bwrap"];let mounted=false;
  for(let i=1;i<plan.elements.length;i++){
   const item=plan.elements[i]!;
   if(item.getText(source)==="process.execPath")break;
   if(ts.isSpreadElement(item)){
    if(item.expression.getText(source)==="policy.mounts"){argv.push(...policy.mounts);mounted=true;}
    else expect(item.expression.getText(source)).toBe("nativeNamespaceEnvironment()");
    continue;
   }
   expect(ts.isStringLiteral(item),"known namespace option").toBe(true);
   if(!ts.isStringLiteral(item))throw Error("Unknown namespace shape");
   const flag=item.text;
   if(flag==="--setenv"){i+=2;continue;}
   if(["--ro-bind","--bind"].includes(flag)){
    const from=plan.elements[++i]!,to=plan.elements[++i]!;
    expect(ts.isStringLiteral(to)).toBe(true);
    argv.push(flag,ts.isStringLiteral(from)?from.text:scratch,(to as ts.StringLiteral).text);continue;
   }
   argv.push(flag);
   if(["--tmpfs","--proc","--dev","--dir"].includes(flag)){
    const value=plan.elements[++i]!;expect(ts.isStringLiteral(value)).toBe(true);argv.push((value as ts.StringLiteral).text);
   }
  }
  expect(mounted,"POLICY_MOUNT_PRESENT").toBe(true);
  const child=Bun.spawnSync([...argv,"/usr/bin/true"],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe",timeout:5000});
  expect(child.exitCode,child.stderr.toString()).toBe(0);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});
