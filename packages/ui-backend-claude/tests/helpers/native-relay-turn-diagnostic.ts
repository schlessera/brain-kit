/** Fixture-only numeric progress; no messages, credentials or provider addresses. */
import { nativeReceipt } from "../../../../scripts/native-test-receipts";
import { nativeTestHead } from "../../../../scripts/test-native-guard";
const outcomes=new Set(["success","error","cancelled"]);
const classes=new Set(["unknown","auth_failure","authentication_failed","subscription_required","rate_limit","overloaded","server_error","timeout","invalid_request","process_exited_nonzero","worker_host_unsupported"]);
const count=(value:number)=>Number.isFinite(value)?Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.round(value))):0;
export function recordNativeRelayTurn(input:{elapsedMs:number;aborted:boolean;requestDelta:number;refreshDelta:number;outcome?:unknown;errorClass?:unknown}):void {
 try { nativeReceipt({kind:"native-fixture-relay-turn",head:nativeTestHead(),elapsedMs:count(input.elapsedMs),aborted:input.aborted===true,
  requestDelta:count(input.requestDelta),refreshDelta:count(input.refreshDelta),
  outcome:typeof input.outcome==="string"&&outcomes.has(input.outcome)?input.outcome:null,
  errorClass:typeof input.errorClass==="string"?(classes.has(input.errorClass)?input.errorClass:"unknown"):null});
 }catch{/* Diagnostics cannot prevent fixture cleanup or replace its failure. */}
}
