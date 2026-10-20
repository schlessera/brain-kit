import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {assertNativeExportArguments,assertNativeExportInput,assertNativeExportChild} from "../packages/module-diagrams/tests/fixtures/export-native-boundary.ts";
import {originGroup} from "../packages/module-diagrams/tests/fixtures/origin-group.ts";
// These invoke the actual preload checks before dispatch. Positive CLI/browser
// execution remains a separate native proof; this unit control does not launch it.
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const invocation=(filename:string,format:string)=>["diagram","export",filename,"--theme","print","--format",format,"--json"];
test("native preload admits only the six closed filename and format combinations",()=>{
 for(const filename of ["release.diagram.yaml","origin.diagram.yaml"])for(const format of ["svg","png","pdf"]){
  expect(assertNativeExportArguments(invocation(filename,format))).toEqual({filename,format});
  expect(()=>assertNativeExportChild(["bun",resolve(import.meta.dir,"../packages/core/src/cli/brain.ts"),...invocation(filename,format)])).not.toThrow();
 }
});
test("native origin input requires the exact serialized source-owned fixture",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-export-boundary-"));roots.push(root);
 const file=join(root,"origin.diagram.yaml");writeFileSync(file,JSON.stringify(originGroup));
 expect(()=>assertNativeExportInput(root,"origin.diagram.yaml")).not.toThrow();
 for(const bytes of [JSON.stringify({...originGroup,title:"A different voyage"}),JSON.stringify(originGroup)+"\n","{}"]){
  writeFileSync(file,bytes);expect(()=>assertNativeExportInput(root,"origin.diagram.yaml")).toThrow("NATIVE_EXPORT_LITERAL_ORIGIN");
 }
 expect(()=>assertNativeExportInput(root,"../origin.diagram.yaml")).toThrow("NATIVE_EXPORT_FIXED_FILENAME");
});
test("native preload refuses arbitrary filenames, formats, themes, argument order and extras",()=>{
 const exact=invocation("origin.diagram.yaml","svg");
 for(const args of [invocation("other.diagram.yaml","svg"),invocation("../origin.diagram.yaml","svg"),invocation("origin.diagram.yaml","jpeg"),[...exact,"--help"],[...exact,"--config","other.ts"],[...exact.slice(0,-1)],["diagram","export","origin.diagram.yaml","--format","svg","--theme","print","--json"],invocation("origin.diagram.yaml","svg").map(arg=>arg==="print"?"dark":arg)]){
  expect(()=>assertNativeExportArguments(args)).toThrow();
 }
});
test("native preload refuses alternate commands, command aliases and early dispatch arguments",()=>{
 for(const args of [[],["--version"],["-v"],["--help"],["help"],["storage","status","--json"],["storage","pack","--json"],["policy","list","--json"],["init"],["mcp"],["render","origin.diagram.yaml","--json"],["diagrams","export","origin.diagram.yaml","--theme","print","--format","svg","--json"],["diagram","render","origin.diagram.yaml","--theme","print","--format","svg","--json"],["--version",...invocation("origin.diagram.yaml","svg")]]){
  expect(()=>assertNativeExportArguments(args)).toThrow();
 }
});
test("native child guard refuses executable aliases, alternate entries and early dispatch before spawn",()=>{
 const entry=resolve(import.meta.dir,"../packages/core/src/cli/brain.ts");
 for(const cmd of ["bun",["bunx",entry,...invocation("origin.diagram.yaml","svg")],["bun",entry+".alias",...invocation("origin.diagram.yaml","svg")],["bun",entry,"--version"],["bun",entry,"policy","list"],["bun","-e","process.exit(0)"]]){
  expect(()=>assertNativeExportChild(cmd)).toThrow();
 }
});
test("native origin input refuses a symlink even when its target bytes match",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-export-boundary-"));roots.push(root);
 writeFileSync(join(root,"other.diagram.yaml"),JSON.stringify(originGroup));symlinkSync("other.diagram.yaml",join(root,"origin.diagram.yaml"));
 expect(()=>assertNativeExportInput(root,"origin.diagram.yaml")).toThrow("NATIVE_EXPORT_OWNED_ORIGIN_FILE");
});
