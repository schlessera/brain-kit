import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
import { nativeNamespaceEnvironment } from "../scripts/test-native-guard";

const root=join(import.meta.dir,"..");
test("relay turn records admit only bounded numeric state and scrub free-form outcomes",async()=>{
 const input={elapsedMs:12.7,aborted:true,requestDelta:1,refreshDelta:0,outcome:"MY_PASSWORD=odysseus-private",errorClass:"https://ithaca.invalid/private-token",env:{TOKEN:"odysseus-private"},message:"/home/circe/private.json"};
 const child=spawnGuardFixture([process.execPath,"-e",`import {recordNativeRelayTurn} from ${JSON.stringify(join(root,"packages/ui-backend-claude/tests/helpers/native-relay-turn-diagnostic.ts"))};recordNativeRelayTurn(${JSON.stringify(input)});recordNativeRelayTurn({elapsedMs:Infinity,aborted:false,requestDelta:-1,refreshDelta:2,outcome:"cancelled",errorClass:"timeout"});`],{env:{PATH:"/usr/bin:/bin"}});
 const [code,out]=await Promise.all([child.exited,child.guardOutput()]);expect(code,out).toBe(0);
 const records=out.split("\n").filter(line=>line.startsWith('{"kind":"native-fixture-relay-turn"')).map(line=>JSON.parse(line));
 expect(records).toHaveLength(2);
 expect(Object.keys(records[0]).sort(),"ONLY_APPROVED_RELAY_DIAGNOSTIC_FIELDS").toEqual(["kind","head","elapsedMs","aborted","requestDelta","refreshDelta","outcome","errorClass"].sort());
 expect(records[0],"UNSAFE_RELAY_DIAGNOSTIC_VALUES_DROPPED").toMatchObject({elapsedMs:13,aborted:true,requestDelta:1,refreshDelta:0,outcome:null,errorClass:"unknown"});
 expect(records[1]).toMatchObject({elapsedMs:0,aborted:false,requestDelta:0,refreshDelta:2,outcome:"cancelled",errorClass:"timeout"});
 for(const secret of ["odysseus-private","ithaca.invalid","circe","private.json"])expect(out,"RELAY_DIAGNOSTICS_CONTAIN_NO_FREE_FORM_SECRETS").not.toContain(secret);
});

test("every touched relay fixture hang timer scales and the namespace retains its factor",()=>{
 let count=0;
 for(const name of ["server-host-relay-probe","sdk-host-relay-probe","ordinary-host-relay-probe","host-relay-probe","relayed-runtime-traffic-probe"]){
  const file=join(root,"packages/ui-backend-claude/tests/fixtures",name+".ts"),source=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="setTimeout"){
   count++;const duration=node.arguments[1];expect(duration&&ts.isCallExpression(duration)&&duration.expression.getText(source)==="watchdogMs","RELAY_HANG_GUARD_SCALED "+name).toBe(true);
  }ts.forEachChild(node,visit);};visit(source);
 }
 expect(count).toBe(8);
 const before=process.env.BRAIN_TEST_DEADLINE_FACTOR;try{process.env.BRAIN_TEST_DEADLINE_FACTOR="3";const args=nativeNamespaceEnvironment();const i=args.indexOf("BRAIN_TEST_DEADLINE_FACTOR");expect(args[i+1],"NAMESPACE_PRESERVES_WATCHDOG_FACTOR").toBe("3");}finally{if(before===undefined)delete process.env.BRAIN_TEST_DEADLINE_FACTOR;else process.env.BRAIN_TEST_DEADLINE_FACTOR=before;}
});
