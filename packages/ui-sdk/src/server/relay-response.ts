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
 const received=(count:number)=>{
  // Received bytes consume the available allowance even if the rest is refused.
  const available=options.remaining();
  if(count>available&&available>0){const failure=options.charge(available);if(failure)return failure;count-=available;}
  return options.charge(count);
 };
 const headerFailure=received(relayHeaderBytes(`HTTP/1.1 ${response.status} ${response.statusText}`,response.headers));
 const fence=()=>options.charge(0);
 return {
  headerFailure,fence,
  async read():Promise<ReadableStreamReadResult<Uint8Array>> {
   if(headerFailure)throw new RelayResponseRefused(headerFailure);
   reader??=response.body?.getReader();
   const next=reader?await reader.read():{done:true as const,value:undefined};
   const failure=next.done?fence():received(next.value.byteLength+16);
   if(failure)throw new RelayResponseRefused(failure);
   if(!next.done){size+=next.value.byteLength;if(options.maxBytes!==undefined&&size>options.maxBytes)throw new Error('Relay response too large');}
   return next.done?{done:true,value:undefined}:{done:false,value:next.value};
  },
  async cancel(){try{if(reader)await reader.cancel();else await response.body?.cancel();}finally{reader?.releaseLock();reader=undefined;}},
  release(){reader?.releaseLock();reader=undefined;},
 };
}
