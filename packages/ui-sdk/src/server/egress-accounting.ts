import type { EgressChargeFailure, EgressChargeResult } from './egress-proxy.js';

/** Bytes already received consume the available allowance before excess is refused. */
export function chargeReceivedBytes(count:number,options:{remaining():number;charge(count:number):EgressChargeFailure|undefined}):EgressChargeFailure|undefined {
 if(!Number.isSafeInteger(count)||count<0)throw new RangeError('Received byte count must be a nonnegative safe integer');
 const available=options.remaining();
 if(count>available&&available>0){const failure=options.charge(available);if(failure)return failure;count-=available;}
 return options.charge(count);
}

/** Legacy operation-only routes retain a bounded per-request allowance. */
export function relayAllowance(operation:{charge(count:number):EgressChargeResult;finish(outcome:"denied",reason:string):void}|undefined,reader:(()=>number)|undefined,limit:number) {
 let charged=0;
 const remaining=()=>operation ? reader?.() ?? Math.max(0,limit-charged) : Infinity;
 const charge=(count:number):EgressChargeFailure|undefined=>{
  if(!Number.isSafeInteger(count)||count<0)throw new RangeError("Relay charge bytes must be a nonnegative safe integer");
  if(operation&&!reader&&count>remaining()){const live=operation.charge(0);if(!live.ok)return live;operation.finish("denied","max_bytes_per_turn");return {ok:false,reason:"budget"};}
  const result=operation?.charge(count);
  if(result&&!result.ok)return result;
  charged+=count;return undefined;
 };
 return {charge,remaining};
}
