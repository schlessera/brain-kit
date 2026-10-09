/** Root supplied exact-packet paid authority; diagnostics and invoices remain distinct. */
import { sha } from "./freeze";
import { openSync,writeFileSync,closeSync,fsyncSync,lstatSync,readFileSync,realpathSync } from "node:fs";
import { dirname,isAbsolute } from "node:path";
export interface RootPaidPolicy {
 version:1;issue:841;authorizationUrl:string;allowOverage:true;basis:"actual additional billed charges";
 grantNonce:string;consumedMarkerPath:string;
 perIssueCapUsd:15;aggregateCapUsd:150;remainingUpperUsd:number;issuedAt:string;expiresAt:string;
 freezeSha:string;proofSha:string;detectedSha:string;protocolSha:string;runtimeSha:string;promptSha:string;canonicalModel:"claude-sonnet-5-5";
 maxPhysicalRequests:24;contextWindowTokens:1000000;maxInputTokens:1000000;maxInputBytes:number;maxOutputTokens:number;inputUsdPerMillionUpper:8;outputUsdPerMillionUpper:20;invoiceUsd:null;
}
export function validPaidPolicy(p:RootPaidPolicy|undefined,expected?:{freezeSha:string;promptSha:string;runtime:unknown;proofSha?:string;detectedSha?:string;protocolSha?:string;dispatchedAt?:string},at?:string):p is RootPaidPolicy {
 return !!p && p.version===1 && p.issue===841 && p.allowOverage===true && p.basis==="actual additional billed charges" &&
 p.authorizationUrl==="https://github.com/schlessera/brain-kit/issues/838#issuecomment-6065882737" && p.perIssueCapUsd===15 && p.aggregateCapUsd===150 &&
 typeof p.grantNonce==="string" && /^[a-f0-9]{64}$/.test(p.grantNonce) && typeof p.consumedMarkerPath==="string" && isAbsolute(p.consumedMarkerPath) && p.consumedMarkerPath.endsWith("/"+p.grantNonce+".json") &&
 p.canonicalModel==="claude-sonnet-5-5" && p.invoiceUsd===null && p.maxPhysicalRequests===24 && p.contextWindowTokens===1_000_000 && p.maxInputTokens===1_000_000 &&
 p.inputUsdPerMillionUpper===8 && p.outputUsdPerMillionUpper===20 && Number.isFinite(p.remainingUpperUsd) && p.remainingUpperUsd>0 && p.remainingUpperUsd<=15 &&
 Number.isSafeInteger(p.maxInputBytes) && p.maxInputBytes>0 && Number.isSafeInteger(p.maxOutputTokens) && p.maxOutputTokens>0 && p.maxOutputTokens<=128_000 &&
 Number.isFinite(Date.parse(p.issuedAt)) && Date.parse(p.issuedAt)<=Date.parse(expected?.dispatchedAt??at??new Date().toISOString()) && Date.parse(p.expiresAt)>Date.parse(expected?.dispatchedAt??at??new Date().toISOString()) &&
 [p.freezeSha,p.proofSha,p.detectedSha,p.protocolSha,p.runtimeSha,p.promptSha].every(s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s)) &&
 (!expected || (p.freezeSha===expected.freezeSha && p.promptSha===expected.promptSha && p.runtimeSha===sha(JSON.stringify(expected.runtime)) && (!expected.proofSha || p.proofSha===expected.proofSha) && (!expected.detectedSha || p.detectedSha===expected.detectedSha) && (!expected.protocolSha || p.protocolSha===expected.protocolSha)));
}
export function rateAdmission(rates:any[],policy?:RootPaidPolicy,dispatchedAt?:string):boolean {
 return rates.length>0 && rates.every(r=>{const i=r.rate_limit_info;if(!i)return false;
 if(i.isUsingOverage===true||i.overageInUse===true)return ["allowed","allowed_warning","rejected"].includes(i.status) && ["allowed","allowed_warning"].includes(i.overageStatus) && validPaidPolicy(policy,undefined,dispatchedAt);
 return ["allowed","allowed_warning"].includes(i.status) && (i.isUsingOverage===false||i.overageInUse===false);});
}
export function paidReservation(policy:RootPaidPolicy|undefined){let held=0,debit=0,requests=0,active=false,failed=false,inputBound=0,outputBound=0;
 return {beforeForward(request:Record<string,any>,bytes:number,dispatchedAt?:string){
 if(!validPaidPolicy(policy,undefined,dispatchedAt)||active||failed)throw Error("Fresh root paid policy/single inflight/previous receipt required");
 if(!Number.isSafeInteger(request.max_tokens)||request.max_tokens<1||request.max_tokens>policy.maxOutputTokens||bytes>policy.maxInputBytes)throw Error("Unknown/excess input/output bound");
 if(request.model!==policy.canonicalModel || request.speed || ![undefined,"auto","standard_only"].includes(request.service_tier) || ![undefined,"global","us"].includes(request.inference_geo))throw Error("Uncovered model/cost modifier");
 // Serialized bytes enforce only the wire-size guard, not a tokenizer ceiling.
 // Reserve the entire validated native context before each physical request.
 const bound=(policy.maxInputTokens*8+request.max_tokens*20)/1e6;
 if(++requests>policy.maxPhysicalRequests||debit+bound>policy.remainingUpperUsd)throw Error("Root paid reservation exhausted");held=bound;active=true;inputBound=policy.maxInputTokens;outputBound=request.max_tokens;
 },afterPhysical(call:any){if(!active)return;const u=call.usage;
 const fields=[u?.input_tokens,u?.output_tokens,u?.cache_read_input_tokens,u?.cache_creation_input_tokens];
 if((u?.speed && u.speed!=="standard") || (u?.service_tier && u.service_tier!=="standard") || (u?.inference_geo && !["global","us","not_available"].includes(u.inference_geo))){failed=true;return;}
 if(call.outcome!=="completed"||!fields.every(n=>Number.isSafeInteger(n)&&n>=0)){failed=true;return;}
 const inputTotal=u.input_tokens+u.cache_read_input_tokens+u.cache_creation_input_tokens;
 if(inputTotal>inputBound || u.output_tokens>outputBound){failed=true;return;}
 const upper=(inputTotal*8+u.output_tokens*20)/1e6;
 if(upper>held){failed=true;return;}debit+=upper;held=0;active=false;
 },snapshot:()=>({reservedUpperUsd:held,knownUsageDebitUpperUsd:debit,physicalRequests:requests,unknown:failed,invoiceUsd:null})};
}

/** Atomic single-use root grant; failures never remove the marker or refund authority. */
export function claimPaidGrant(policy:RootPaidPolicy){
 if(!validPaidPolicy(policy))throw Error("Invalid root grant");
 const parent=dirname(policy.consumedMarkerPath),st=lstatSync(parent);
 if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(parent)!==parent||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw Error("Grant parent must be owned protected literal directory");
 const claim={version:1,grantNonce:policy.grantNonce,policySha:sha(JSON.stringify(policy)),freezeSha:policy.freezeSha,runtimeSha:policy.runtimeSha,proofSha:policy.proofSha,detectedSha:policy.detectedSha,protocolSha:policy.protocolSha,promptSha:policy.promptSha,claimedAtUtc:new Date().toISOString(),invoiceUsd:null};
 const bytes=JSON.stringify(claim,null,2),fd=openSync(policy.consumedMarkerPath,"wx",0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 return {bytes,sha:sha(bytes)};
}
/** Completed replay verifies the already-consumed literal claim, never consumes again. */
export function validGrantEvidence(policy:RootPaidPolicy,bytes:Buffer,claimSha:string,startedAt:string,firstPhysicalAt:string){
 try{const st=lstatSync(policy.consumedMarkerPath),claim=JSON.parse(bytes.toString("utf8"));
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o777)!==0o600||st.uid!==process.getuid?.()||sha(bytes)!==claimSha||!readFileSync(policy.consumedMarkerPath).equals(bytes))return false;
 const expected={version:1,grantNonce:policy.grantNonce,policySha:sha(JSON.stringify(policy)),freezeSha:policy.freezeSha,runtimeSha:policy.runtimeSha,proofSha:policy.proofSha,detectedSha:policy.detectedSha,protocolSha:policy.protocolSha,promptSha:policy.promptSha,claimedAtUtc:claim.claimedAtUtc,invoiceUsd:null};
 const at=Date.parse(claim.claimedAtUtc);
 return JSON.stringify(claim)===JSON.stringify(expected)&&Number.isFinite(at)&&at>=Date.parse(startedAt)&&at<=Date.parse(firstPhysicalAt)&&validPaidPolicy(policy,undefined,claim.claimedAtUtc);
 }catch{return false;}
}
