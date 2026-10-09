/** Root-issued single-use grant. Failures never remove a consumed marker. */
import { openSync, writeFileSync, readFileSync, closeSync, fsyncSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
const sha=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
import { type ReviewBinding } from "./native-pricing";
export interface GrantPolicy { grantNonce:string;consumedMarkerPath:string;issuedAt:string;expiresAt:string }
export interface GrantMarker { version:1;grantNonce:string;policySha:string;bindingSha:string;claimedAtUtc:string;invoiceUsd:null }
export interface GrantClaim { marker:GrantMarker;sha:string }
export function assertGrantPath(policy:GrantPolicy){
  if(!policy || !/^[a-f0-9]{64}$/.test(policy.grantNonce) || !isAbsolute(policy.consumedMarkerPath??"") || basename(policy.consumedMarkerPath)!==`${policy.grantNonce}.json`)throw Error("Root one-use nonce/path required");
}
export function validGrantTime(policy:GrantPolicy,now:number){
  const issued=Date.parse(policy.issuedAt),expires=Date.parse(policy.expiresAt);
  return Number.isFinite(now)&&Number.isFinite(issued)&&Number.isFinite(expires)&&issued<=now&&expires>issued&&now<expires;
}
/** Mechanical marker shape matches1294; no live grant is minted by this helper. */
export function consumeGrant(policy:GrantPolicy,binding:ReviewBinding,now=Date.now()):GrantClaim{
  assertGrantPath(policy);
  if(!validGrantTime(policy,now))throw Error("Root grant expired");
  const parent=dirname(policy.consumedMarkerPath),stat=lstatSync(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(parent)!==parent||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error("Protected coordinator grant parent required");
  const marker:GrantMarker={version:1,grantNonce:policy.grantNonce,policySha:sha(JSON.stringify(policy)),bindingSha:sha(JSON.stringify(binding)),claimedAtUtc:new Date(now).toISOString(),invoiceUsd:null};
  const fd=openSync(policy.consumedMarkerPath,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(marker,null,2));fsyncSync(fd);}finally{closeSync(fd);}
  return{marker,sha:sha(readFileSync(policy.consumedMarkerPath))};
}
/** Reparse original consumed marker and copied literal bytes; never attempt another claim. */
export function validGrantEvidence(policy:GrantPolicy,binding:ReviewBinding,copy:Buffer,claimedSha:string,startedAtUtc:string,firstPhysicalAt:number):boolean{
  try{
    assertGrantPath(policy);const stat=lstatSync(policy.consumedMarkerPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)return false;
    const original=readFileSync(policy.consumedMarkerPath);if(!original.equals(copy)||sha(original)!==claimedSha)return false;
    const marker:GrantMarker=JSON.parse(copy.toString("utf8")),at=Date.parse(marker.claimedAtUtc),start=Date.parse(startedAtUtc),expires=Date.parse(policy.expiresAt);
    return marker.version===1&&marker.grantNonce===policy.grantNonce&&marker.policySha===sha(JSON.stringify(policy))&&marker.bindingSha===sha(JSON.stringify(binding))&&marker.invoiceUsd===null&&
      Number.isFinite(at)&&Number.isFinite(start)&&Number.isFinite(expires)&&Number.isFinite(firstPhysicalAt)&&validGrantTime(policy,start)&&validGrantTime(policy,at)&&validGrantTime(policy,firstPhysicalAt)&&at>=start&&at<=firstPhysicalAt&&at<=Date.now();
  }catch{return false;}
}
