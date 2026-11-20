import { expect,test } from 'bun:test';
import { request } from 'node:http';
import { startEgressProxy } from '../src/server/egress-proxy';
import { startInferenceRelay } from '../src/server/inference-relay';
import { startProviderRelay } from '../src/server/provider-relay';
for(const provider of [false,true])for(const recording of [false,true])for(const response of [false,true])test(`review10: ${provider?'provider':'inference'} ${response?'response':'upload'} reports ${recording?'recording loss':'authority change'} separately from bytes`,async()=>{
 let current=true,hits=0,entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;});const authority=()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:recording?current:true,authorityCurrent:recording?true:current});
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){hits++;if(response)current=false;return new Response('Ithaca');}});
 const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe(){},admissionSafety:{read:authority,subscribe:()=>()=>{}},committed:()=>entered()});
 const relay=provider?startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[upstream.url.origin]]]),credential:()=> 'odysseus-host-key',egress:proxy}):startInferenceRelay({upstream:upstream.url.origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-host-key'},egress:proxy});
 let outgoing:ReturnType<typeof request>|undefined;
 try{const body=JSON.stringify({model:'odysseus-model',messages:[]});const result=new Promise<{status:number;body:string}>((resolve,reject)=>{outgoing=request({socketPath:relay.socketPath,method:'POST',path:'/v1/messages',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(provider?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':upstream.url.origin}:{})}},res=>{let data='';res.on('data',b=>{data+=b;});res.once('end',()=>resolve({status:res.statusCode!,body:data}));res.once('error',reject);});outgoing.once('error',reject);outgoing.flushHeaders();});
 await reached;if(!response)current=false;outgoing!.end(body);const got=await result;expect(got.status).toBe(recording?503:403);expect(got.body,'SAFETY_OR_UNAVAILABLE_NEVER_REPORTS_BYTE_EXHAUSTION').toContain(recording?'unavailable':'safety');expect(got.body).not.toContain('egress limit exceeded');expect(hits).toBe(response?1:0);expect(proxy.remainingBytes()).toBeGreaterThan(0);
 }finally{outgoing?.destroy();await relay.stop();proxy.stop();upstream.stop(true);}
});

for(const reason of ['budget','safety','unavailable'] as const)test(`review10: charge distinguishes ${reason}`,async()=>{
 let current=true;const snapshot=()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:reason==='unavailable'?current:true,authorityCurrent:reason==='safety'?current:true});
 const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:8,outwardHosts:[],observe(){},admissionSafety:{read:snapshot,subscribe:()=>()=>{}}});
 try{const op=proxy.inference('POST',new URL('http://127.0.0.1/'),new AbortController().signal);expect(await op.admit()).toBe(true);current=false;expect(op.charge(reason==='budget'?9:1),'CHARGE_FAILURE_HAS_A_TYPED_REASON').toEqual({ok:false,reason});}finally{proxy.stop();}
});

for(const recording of [false,true])test(`review10: raw HTTP proxy reports ${recording?'unavailable recording':'changed safety'} before delayed bytes`,async()=>{
 let current=true,hits=0,entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;});const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){hits++;return new Response('Ithaca');}});
 const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe(){},committed:()=>entered(),admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:recording?current:true,authorityCurrent:recording?true:current}),subscribe:()=>()=>{}}});let outgoing:ReturnType<typeof request>|undefined;
 try{const result=new Promise<{status:number;body:string}>((resolve,reject)=>{outgoing=request({socketPath:proxy.socketPath,path:upstream.url.href,method:'POST',headers:{'content-length':'6'}},res=>{let body='';res.on('data',b=>{body+=b;});res.once('end',()=>resolve({status:res.statusCode!,body}));res.once('error',reject);});outgoing.once('error',reject);outgoing.flushHeaders();});await reached;current=false;outgoing!.end('Ithaca');const got=await result;expect(got.status).toBe(recording?503:403);expect(got.body,'RAW_PROXY_REPORTS_CHARGE_FAILURE_CLASS').toContain(recording?'unavailable':'safety');expect(hits).toBe(0);
 }finally{outgoing?.destroy();proxy.stop();upstream.stop(true);}
});
