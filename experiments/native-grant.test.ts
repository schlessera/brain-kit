import {test,expect} from "bun:test";
import {mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync,symlinkSync,unlinkSync,existsSync} from "node:fs";
import {join} from "node:path";
import {consumeGrant,validGrantEvidence} from "../scripts/evals/native-grant";
import {digest} from "../scripts/evals/native-paid-policy";
const binding={freezeSha:digest("source"),inputSha:digest("Odysseus"),protocolSha:digest("protocol"),runtimeSha:digest("runtime"),proofSha:digest("proof"),promptSha:digest("prompt")};
function policy(root:string){const grantNonce=digest(root);return{grantNonce,consumedMarkerPath:join(root,`${grantNonce}.json`),issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};}
test("original private grant marker is single-use and copied evidence cannot replace its authority",()=>{
  const root=mkdtempSync("/tmp/native-grant-control-");
  try{
    const p=policy(root),start=new Date().toISOString(),claim=consumeGrant(p,binding),copy=readFileSync(p.consumedMarkerPath);
    expect(validGrantEvidence(p,binding,copy,claim.sha,start,Date.now())).toBe(true);
    expect(()=>consumeGrant(p,binding)).toThrow("EEXIST");expect(readFileSync(p.consumedMarkerPath)).toEqual(copy);
    expect(validGrantEvidence(p,{...binding,inputSha:digest("Penelope")},copy,claim.sha,start,Date.now())).toBe(false);
    expect(validGrantEvidence(p,binding,copy,claim.sha,start,Date.parse(p.expiresAt))).toBe(false);
    writeFileSync(p.consumedMarkerPath,JSON.stringify({...claim.marker,bindingSha:digest("replacement")}));
    expect(validGrantEvidence(p,binding,copy,claim.sha,start,Date.now())).toBe(false);
    unlinkSync(p.consumedMarkerPath);const target=join(root,"marker-copy.json");writeFileSync(target,copy);symlinkSync(target,p.consumedMarkerPath);
    expect(validGrantEvidence(p,binding,copy,claim.sha,start,Date.now())).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("an unprotected coordinator parent refuses the original claim before writing a marker",()=>{
  const root=mkdtempSync("/tmp/native-grant-parent-");
  try{const p=policy(root);chmodSync(root,0o755);expect(()=>consumeGrant(p,binding)).toThrow("Protected coordinator grant parent required");expect(existsSync(p.consumedMarkerPath)).toBe(false);}
  finally{rmSync(root,{recursive:true,force:true});}
});
