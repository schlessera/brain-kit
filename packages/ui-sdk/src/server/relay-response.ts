import { chargeReceivedBytes } from "./egress-accounting.js";
import type { EgressChargeFailure } from './egress-proxy.js';

/** Counts every peer-supplied pair before any forwarding policy removes fields. */
function receivedHeadBytes(first:string,rawHeaders:readonly string[],allowance:number):number {
 let bytes=Buffer.byteLength(first+"\r\n")+2+allowance;
 for(let i=0;i<rawHeaders.length;i+=2)bytes+=Buffer.byteLength(`${rawHeaders[i]}: ${rawHeaders[i+1]??""}\r\n`);
 return bytes;
}
/** Parsed fetch headers retain all observable fields; reserve runtime framing too. */
export function relayHeaderBytes(first:string,headers:Headers):number {
 return receivedHeadBytes(first,[...headers].flat(),1024);
}
/** Node supplies raw pairs (including duplicate and hop-by-hop fields); fetch supplies its unfiltered observable pairs. */
export function readReceivedHead(first:string,rawHeaders:readonly string[],options:Parameters<typeof chargeReceivedBytes>[1],allowance=64) {
 return chargeReceivedBytes(receivedHeadBytes(first,rawHeaders,allowance),options);
}
export class RelayResponseRefused extends Error {
 constructor(readonly failure:EgressChargeFailure){super('Relay response refused');}
}
/** Owns header-first accounting, charge-before-size ordering and the EOF fence. */
export function readRelayResponse(response:Response,options:{charge(count:number):EgressChargeFailure|undefined;remaining():number;maxBytes?:number}) {
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,size=0;
 const received=(count:number)=>chargeReceivedBytes(count,options);
 const headerFailure=readReceivedHead(`HTTP/1.1 ${response.status} ${response.statusText}`,[...response.headers].flat(),options,1024);
 const fence=()=>options.charge(0);
 const deliver=(send:()=>void)=>{const failure=fence();if(failure)return failure;send();return undefined;};
 return {
  headerFailure,fence,deliver,
  async read():Promise<ReadableStreamReadResult<Uint8Array>&{deliver:typeof deliver}> {
   if(headerFailure)throw new RelayResponseRefused(headerFailure);
   reader??=response.body?.getReader();
   const next=reader?await reader.read():{done:true as const,value:undefined};
   const failure=next.done?fence():received(next.value.byteLength+16);
   if(failure)throw new RelayResponseRefused(failure);
   if(!next.done){size+=next.value.byteLength;if(options.maxBytes!==undefined&&size>options.maxBytes)throw new Error('Relay response too large');}
   return next.done?{done:true,value:undefined,deliver}:{done:false,value:next.value,deliver};
  },
  async cancel(){try{if(reader)await reader.cancel();else await response.body?.cancel();}finally{reader?.releaseLock();reader=undefined;}},
  release(){reader?.releaseLock();reader=undefined;},
 };
}
