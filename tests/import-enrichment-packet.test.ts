import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {freeze} from "../scripts/evals/import-enrichment/freeze";
import {packets} from "../scripts/evals/import-enrichment/review-packet";
test("complete import-enrichment source and18 case packets preserve the original400000-byte bound",()=>{
 const f=freeze(),proof={freezeSha:f.freezeSha,testsExitCode:0,typecheckExitCode:0,lintExitCode:0,nativeExitCodes:{read:0,generation:0,hybrid:0,"custom-inbox":0,"write-denial":0,review:0}};
 let rows:ReturnType<typeof packets>=[];expect(()=>{rows=packets(proof);}).not.toThrow();
 expect(f.inputs).toHaveLength(18);expect(rows.length).toBeGreaterThan(6);
 const root=new URL("../",import.meta.url).pathname,seen=new Set<string>(),cases:any[]=[];
 for(const row of rows){
  expect(Buffer.byteLength(row.text)).toBe(row.bytes);expect(row.bytes).toBeLessThanOrEqual(400000);
  for(const path of row.sourceFiles){expect(row.text).toContain("\n\nCOMPLETE SOURCE FILE "+path+"\n"+readFileSync(join(root,path),"utf8"));seen.add(path);}
  const marker="\n\nCOMPLETE CASES AND AUTHOR-PROVISIONAL GOLDENS\n";
  if(row.text.includes(marker))cases.push(...JSON.parse(row.text.split(marker)[1]!));
 }
 expect(seen.has("packages/core/src/lib/jev.ts")).toBe(true);expect(seen.has("scripts/evals/native-paid-policy.ts")).toBe(true);
 expect(cases).toEqual(f.inputs);expect(cases[0].arms[0].files).not.toEqual({});
});
