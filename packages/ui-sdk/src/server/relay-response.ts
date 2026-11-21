import { chargeReceivedBytes } from "./egress-accounting.js";
import type { EgressChargeFailure } from './egress-proxy.js';

/** Observable HTTP framing shared by both concrete host relays. */
export function relayHeaderBytes(first:string,headers:Headers):number {
 let bytes=Buffer.byteLength(first)+1028;
 for(const [name,value] of headers)bytes+=Buffer.byteLength(name)+Buffer.byteLength(value)+4;
 return bytes;
}
export class RelayResponseRefused extends Error {
 constructor(readonly failure:EgressChargeFailure){super('Relay response refused');}
}
/** Owns header-first accounting, charge-before-size ordering and the EOF fence. */
export function readRelayResponse(response:Response,options:{charge(count:number):EgressChargeFailure|undefined;remaining():number;maxBytes?:number}) {
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,size=0;
 const received=(count:number)=>chargeReceivedBytes(count,options);
 const headerFailure=received(relayHeaderBytes(`HTTP/1.1 ${response.status} ${response.statusText}`,response.headers));
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
