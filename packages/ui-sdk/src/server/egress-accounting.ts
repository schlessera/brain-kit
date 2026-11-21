import type { EgressChargeFailure } from './egress-proxy.js';

/** Bytes already received consume the available allowance before excess is refused. */
export function chargeReceivedBytes(count:number,options:{remaining():number;charge(count:number):EgressChargeFailure|undefined}):EgressChargeFailure|undefined {
 if(!Number.isSafeInteger(count)||count<0)throw new RangeError('Received byte count must be a nonnegative safe integer');
 const available=options.remaining();
 if(count>available&&available>0){const failure=options.charge(available);if(failure)return failure;count-=available;}
 return options.charge(count);
}
