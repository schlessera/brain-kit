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

for(const notified of [false,true])test(`review11: source revocation has one safety reason (notification first ${notified})`,async()=>{
 let current=true;const records:import('../src/server/egress-proxy').EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:32,outwardHosts:[],observe:r=>records.push(r),inputCurrent:()=>current});
 try{const op=proxy.managedReference(new URL('https://github.com/'),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.charge(3)).toEqual({ok:true});current=false;if(notified)proxy.invalidateInputs();expect(op.charge(1),'REVOCATION_IS_SAFETY_REGARDLESS_OF_FIRST_FENCE').toEqual({ok:false,reason:'safety'});expect(records[0]).toMatchObject({outcome:'cancelled',reason:'source_trust_changed',bytes:3});expect(records).toHaveLength(1);expect(proxy.remainingBytes()).toBe(29);}finally{proxy.stop();}
});
for(const count of [-1,-0.5,0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,'1' as unknown as number])test(`review11: invalid charge ${String(count)} leaves both counters intact`,async()=>{
 const records:Array<{bytes:number}>=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:32,outwardHosts:[],observe:r=>{records.push(r);}});
 try{const op=proxy.inference('POST',new URL('http://127.0.0.1/'),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.charge(8)).toEqual({ok:true});expect(()=>op.charge(count),'INVALID_CHARGE_NEVER_MUTATES_NETWORK_BUDGET').toThrow('nonnegative safe integer');expect(proxy.usedBytes()).toBe(8);expect(proxy.remainingBytes()).toBe(24);expect(op.charge(0)).toEqual({ok:true});expect(op.charge(24)).toEqual({ok:true});expect(proxy.usedBytes()).toBe(32);op.finish('completed');expect(records[0]?.bytes,'INVALID_CHARGE_NEVER_MUTATES_CONNECTION_BYTES').toBe(32);}finally{proxy.stop();}
});

for (const failure of ['safety','unavailable','source'] as const) test(`review13: zero-byte completion at the cap still checks ${failure}`, async () => {
 let current=true;
 const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:8,outwardHosts:[],observe(){},
  inputCurrent:()=>failure!=='source'||current,
  admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:failure!=='unavailable'||current,authorityCurrent:failure!=='safety'||current}),subscribe:()=>()=>{}}});
 try{const op=proxy.inference('POST',new URL('http://127.0.0.1/'),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.charge(8)).toEqual({ok:true});expect(op.charge(0),'ZERO_BYTE_TERMINAL_AT_CAP_IS_ALLOWED').toEqual({ok:true});current=false;expect(op.charge(0),'ZERO_BYTE_TERMINAL_REVALIDATES_SAFETY').toEqual({ok:false,reason:failure==='unavailable'?'unavailable':'safety'});}finally{proxy.stop();}
});
