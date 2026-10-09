/** Actual pinned292 paid controls; only loopback responses, never semantic approval. */
import assert from "node:assert/strict";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fixtures,prepare} from "./fixture";
import {installNativeSurface} from "./native-surface";
import {runNativePhase} from "./native-driver";
import {assertNativeEvidence} from "./collector";
import {response} from "./offline-native";
import {literalNativeFrames,digest} from "../native-paid-policy";

export const paidModes=["paid","inactive","paid-rejected","http402","http429","missing-usage","wrong-model","partial"] as const;
async function main(){
  const [mode,out]=process.argv.slice(2);if(!paidModes.includes(mode as any)||!out)throw Error("Require known mode and fresh output");
  mkdirSync(out,{mode:0o700});const source=new URL("../../../",import.meta.url).pathname,env=prepare(fixtures[0],19);
  installNativeSurface(env.root,source,fixtures[0]);let physical=0;
  try{
    const receipt=await runNativePhase({root:env.root,source,destination:join(out,"native"),phase:"dry-run",offline:true,
      purpose:"complementary-review",prompt:"Frozen keyless paid transport control for Odysseus; no semantic approval.",
      token:`sk-ant-oat01-${"o".repeat(95)}AA`,deadlineMs:20000,...mode==="partial"?{offlineDeadlineAfterDispatchMs:200}: {},
      async physicalFetch(_url,init){
        physical++;assert.equal(physical,1,"Failed request must stop later physical forwarding");
        const request=JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
        assert.equal(request.model,"claude-sonnet-5-5");assert.equal(request.tools?.length??0,0);assert.equal(request.output_config.effort,"low");
        const original=response(physical),headers=new Headers(original.headers);
        headers.delete("anthropic-ratelimit-unified-overage-disabled-reason");
        headers.set("anthropic-ratelimit-unified-status",mode==="inactive"?"allowed":"rejected");
        headers.set("anthropic-ratelimit-unified-overage-status",mode==="paid-rejected"?"rejected":"allowed");
        if(mode==="http402"||mode==="http429")return Response.json({error:{type:"rate_limit_error",message:"Authored offline refusal"}},{status:mode==="http402"?402:429,headers});
        let text=await original.text();
        if(mode==="missing-usage")text=text.replace(/,"cache_read_input_tokens":0/g,"");
        if(mode==="wrong-model")text=text.replaceAll("claude-sonnet-5-5","unexpected-model");
        if(mode==="partial")return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from(text.slice(0,80)));},cancel(){}}),{headers});
        return new Response(text,{headers});
      }});
    assert.equal(receipt.runtimePair.sdk,"0.3.292");assert.equal(receipt.runtimePair.cli,"2.1.292");
    assert.equal(receipt.native.ownedChildDrained,true);assert.equal(receipt.stdoutComplete,true);assert.equal(physical,1);
    const successful=mode==="paid"||mode==="inactive";
    if(successful){
      assert.equal(receipt.native.failure,null);assertNativeEvidence(receipt.native);literalNativeFrames(receipt);
      assert.equal(receipt.paid!.entries[0].status,"complete");assert.equal(receipt.paid!.entries[0].inputBound,1_000_000);
      assert.equal(receipt.native.overage,mode==="paid"?"active":"reported inactive");
      const relabelled=structuredClone(receipt.native);relabelled.paid!.policy.control="live";
      assert.throws(()=>assertNativeEvidence(relabelled),/grant evidence differs/,"Relabelling a consumed synthetic grant cannot supply live provenance");
      const edited=structuredClone(receipt);edited.result.result="APPROVED altered metadata";
      assert.throws(()=>literalNativeFrames(edited),/result differ/,"Preserved native result must independently reject altered metadata");
      const physicalEdited=structuredClone(receipt.native);(physicalEdited.calls[0].literal as any).usage.output_tokens++;
      assert.throws(()=>assertNativeEvidence(physicalEdited),/Literal terminal usage differs/,"Retained upstream counters must independently reject altered summary");
    }else{assert.ok(receipt.native.failure);assert.notEqual(receipt.paid!.entries[0].status,"reserved");if(mode!=="paid-rejected")assert.equal(receipt.paid!.entries[0].status,"unknown");}
    const marker=readFileSync(receipt.paid!.policy.consumedMarkerPath);
    assert.equal(marker.toString(),readFileSync(join(out,"native/paid-grant.json"),"utf8"));
    assert.equal(receipt.paid!.policy.control,"offline");assert.equal(receipt.executionKind,"offline-scripted-control");
    if(mode==="paid"){
      const base={root:env.root,source,phase:"dry-run" as const,offline:true,purpose:"complementary-review" as const,
        prompt:"Frozen keyless paid transport control for Odysseus; no semantic approval.",token:`sk-ant-oat01-${"o".repeat(95)}AA`,physicalFetch:async()=>{physical++;return response(physical);}};
      const policy=receipt.paid!.policy;
      await assert.rejects(runNativePhase({...base,destination:join(out,"reuse"),offlinePaidPolicy:policy}),/EEXIST/);
      for(const [kind,change] of Object.entries({expired:{expiresAt:new Date(0).toISOString()},future:{issuedAt:new Date(Date.now()+10000).toISOString()},source:{freezeSha:"0".repeat(64)},scope:{issue:843},budget:{remainingUpperUsd:.01}})){
        const grantNonce=digest(`${out}:${kind}`),negative={...policy,...change,grantNonce,consumedMarkerPath:join(out,`${grantNonce}.json`)};
        await assert.rejects(runNativePhase({...base,destination:join(out,kind),offlinePaidPolicy:negative as any}),kind==="budget"?/insufficient before prompt release/:/Missing, stale or mismatched root native paid allocation/);
        assert.equal(physical,1,"Invalid allocation/grant must refuse before native prompt/upstream forwarding");
      }
    }
    const control={passed:true,mode,sdk:receipt.runtimePair.sdk,cli:receipt.runtimePair.cli,physical,overage:receipt.native.overage,
      budget:receipt.paid!.entries,ownedChildDrained:true,externalRequests:0,semanticApproval:false,invoiceUsd:null};
    writeFileSync(join(out,"control.json"),JSON.stringify(control,null,2),{mode:0o600});console.log(JSON.stringify(control));
  }finally{env.close();}
}
if(import.meta.main)await main();
