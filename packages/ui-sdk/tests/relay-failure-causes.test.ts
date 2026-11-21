/** Controlled failures at the lowest fetch boundary; real Unix relay requests stay offline. */
import { expect,spyOn,test } from 'bun:test';
import { getEventListeners } from 'node:events';
import {createServer} from 'node:net';
import { request,type IncomingHttpHeaders } from 'node:http';
import { startEgressProxy,type EgressRecord } from '../src/server/egress-proxy';
import { startInferenceRelay,type InferenceRelayEvent } from '../src/server/inference-relay';
import { startProviderRelay,type ProviderRelayRefusal,type ProviderRelayReceipt } from '../src/server/provider-relay';
const origin='http://127.0.0.1:43107';
const causes=['upstream','cancelled','safety_changed','policy_denied','unavailable','budget'] as const;
const paths=['credentials','credentials return','inference fetch','inference stream','provider fetch','Files response','provider stream','cleanup'] as const;
function send(socketPath:string,path:string,body:string,headers:Record<string,string>,onData:()=>void=()=>{}) {
 return new Promise<{status:number;interrupted:boolean;headers:IncomingHttpHeaders;body:string}>((resolve,reject)=>{
  const req=request({socketPath,path,method:'POST',headers:{'content-type':'application/json',...headers}},res=>{
   const chunks:Buffer[]=[];const done=(interrupted:boolean)=>resolve({status:res.statusCode!,interrupted,headers:res.headers,body:Buffer.concat(chunks).toString()});res.on('data',chunk=>{chunks.push(chunk);onData();});res.once('end',()=>done(false));res.once('aborted',()=>done(true));res.once('error',()=>done(true));
  });req.once('error',reject);req.end(body);
 });
}
for(const path of paths)for(const cause of causes)test(`failure cause: ${cause} × ${path}`,async()=>{
 const root=new AbortController();let authority=true,recording=true,armed=path!=='cleanup',recovering=false;let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});const audits:EgressRecord[]=[],receipts:ProviderRelayReceipt[]=[],inference:InferenceRelayEvent[]=[],refusals:ProviderRelayRefusal[]=[];
 const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],signal:root.signal,observe:r=>audits.push(r),admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:recording,authorityCurrent:authority}),subscribe:()=>()=>{}}});
 const operations:Array<{op:ReturnType<typeof proxy.inference>;signal:AbortSignal;owned:Function[]}>=[];
 const capture=(kind:'inference'|'relayed',method:string,target:URL,signal:AbortSignal)=>{const before=getEventListeners(signal,'abort');const op=proxy[kind](method,target,signal);const owned=getEventListeners(signal,'abort').filter(f=>!before.includes(f));expect(owned).toHaveLength(1);operations.push({op,signal,owned});return op;};
 const egress={...proxy,inference:(method:string,target:URL,signal:AbortSignal)=>capture('inference',method,target,signal),relayed:(method:string,target:URL,signal:AbortSignal)=>capture('relayed',method,target,signal)};
 const trigger=()=>{const op=operations.at(-1)!.op;if(cause==='cancelled')root.abort();else if(cause==='policy_denied')op.finish('denied','destination_not_allowed');else if(cause==='budget')op.charge(proxy.remainingBytes()+1);else if(cause==='safety_changed'){authority=false;op.charge(0);}else if(cause==='unavailable'){recording=false;op.charge(0);}};
 const failureBody=()=>{let first=true;const streaming=path.endsWith('stream');return new ReadableStream<Uint8Array>({async pull(controller){if(streaming&&first){first=false;controller.enqueue(new TextEncoder().encode('Ithaca '.repeat(16)));return;}if(streaming)await gate;trigger();controller.error(new Error('Odysseus upstream interrupted'));}},{highWaterMark:0});};
 const original=globalThis.fetch;
 const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(recovering)return Response.json({});
  if(path==='cleanup'&&!armed){if(!url.search)return Response.json({},{headers:{'x-goog-upload-url':`${origin}/upload/v1beta/files?upload_id=ithaca&upload_protocol=resumable`}});return Response.json({file:{name:'files/ithaca',uri:`${origin}/v1beta/files/ithaca`,mimeType:'video/mp4',state:'ACTIVE'}},{headers:{'x-goog-upload-status':'final'}});}
  expect(url.origin).toBe(origin);expect(init?.signal).toBeInstanceOf(AbortSignal);
  if(path.endsWith('stream')||path==='Files response')return new Response(failureBody(),{headers:{'content-type':'application/octet-stream'}});
  trigger();throw new Error('Odysseus upstream unavailable');
 },{preconnect:original.preconnect}));
 const isInference=path.startsWith('inference')||path.startsWith('credentials');
 const relay=isInference?startInferenceRelay({upstream:origin,routes:['/v1/messages'],egress,credentials:async()=>{if(path.startsWith('credentials')){trigger();if(path==='credentials')throw new Error('Odysseus credential resolver unavailable');}return {'x-api-key':'odysseus-key'};},observe:r=>inference.push(r)}):startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]],['GEMINI_API_KEY',[origin]]]),credential:()=> 'odysseus-key',get egress(){return path==='cleanup'&&!armed?undefined:egress;},observe:r=>receipts.push(r),refused:r=>refusals.push(r)});
 const gemini={'x-brain-provider':'gemini','x-brain-provider-key':'GEMINI_API_KEY','x-brain-provider-origin':origin};
 try{
  let result:{status:number;interrupted:boolean;body:string}|undefined;
  if(path==='cleanup'){
   const started=await send(relay.socketPath,'/upload/v1beta/files',JSON.stringify({file:{mimeType:'video/mp4'}}),{...gemini,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'});
   expect(started.status).toBe(200);const upload=new URL(String(started.headers['x-goog-upload-url']));
   expect((await send(relay.socketPath,upload.pathname+upload.search,'troy!',{...gemini,'x-goog-upload-command':'upload, finalize','x-goog-upload-offset':'0'})).status).toBe(200);
   receipts.length=0;armed=true;await relay.stop();
  }else{
   const files=path==='Files response';const headers:Record<string,string>=isInference?{}:files?{...gemini,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'}:{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin};
   result=await send(relay.socketPath,files?'/upload/v1beta/files':'/v1/messages',JSON.stringify({model:'odysseus-model',messages:[]}),headers,release);
  }
  const streaming=path.endsWith('stream'),typed=cause!=='upstream',status=cause==='cancelled'?499:cause==='unavailable'?503:typed?403:502;
  if(result){expect(result.status,'FAILURE_SITE_CAUSE_DETERMINES_STATUS').toBe(streaming?200:status);if(streaming)expect(result.interrupted).toBe(true);}
  if(!isInference){
   if(!streaming&&path!=='cleanup'){
    const expected=cause==='cancelled'?'cancelled':cause==='upstream'?'upstream_unreachable':'egress_refused';
    expect(refusals.at(-1),'CALLER_REFUSAL_CALLBACK_PRESERVES_REASON').toMatchObject({reason:expected,status});
    const wireReason=cause==='policy_denied'?'not_allowlisted':cause==='budget'?'byte_cap':cause==='unavailable'?'egress_unavailable':cause==='safety_changed'?'safety_changed':expected;
    expect(JSON.parse(result!.body).error.reason,'CALLER_ERROR_BODY_PRESERVES_REASON').toBe(wireReason);
   }else expect(refusals,'NO_NEW_ERROR_ENVELOPE_AFTER_STREAM_OR_INTERNAL_CLEANUP').toEqual([]);
  }
  if(isInference&&!streaming){
   const detail=cause==='cancelled'?'Inference request cancelled':cause==='safety_changed'?'Inference safety or authority changed':cause==='policy_denied'?'Inference network policy refused the request':cause==='unavailable'?'Inference egress unavailable':cause==='budget'?'Inference egress limit exceeded':path==='credentials'?'Inference credentials unavailable':'Inference upstream unreachable';
   expect(JSON.parse(result!.body).error).toMatchObject({type:'brain_inference_refused',message:detail});
   expect(JSON.parse(result!.body).error.reason).toBeUndefined();
   expect(inference.at(-1)).toMatchObject({outcome:'refused',status,reason:detail});
  }
  const outcome=typed?'cancelled':'failed';
  // HTTP contract: docs/integration-contract/http.md:1412-1413 — status is upstream evidence, never the local refusal.
  if(!isInference)expect(receipts.at(-1),'FINISH_ABORT_CANNOT_RECLASSIFY_THE_PROVIDER_RECEIPT').toMatchObject({outcome,status:streaming||path==='Files response'?200:0});
  else expect(inference.at(-1)).toMatchObject({outcome:streaming?'forwarded':'refused',status:streaming?200:status});
  expect(audits.at(-1)?.dispatched,'FETCH_START_IS_THE_DISPATCH_FACT').toBe(!path.startsWith('credentials')||path==='credentials return'&&cause==='upstream');
  expect(audits.at(-1),'TERMINAL_AUDIT_PRESERVES_THE_ACTUAL_CAUSE').toMatchObject({outcome:cause==='upstream'?'failed':cause==='cancelled'?'cancelled':'denied',failureReason:typed?cause:'unavailable'});
  if(cause==='upstream'){
   expect(root.signal.aborted,'ONE_TRANSPORT_FAILURE_NEVER_ABORTS_THE_TURN').toBe(false);recovering=true;
   const recovery=startInferenceRelay({upstream:origin,routes:['/v1/messages'],egress,credentials:{'x-api-key':'odysseus-key'}});
   try{expect((await send(recovery.socketPath,'/v1/messages','{}',{})).status,'ANOTHER_OPERATION_IN_THE_SAME_TURN_STAYS_USABLE').toBe(200);}finally{await recovery.stop();}
  }
  for(const {signal,owned} of operations)expect(getEventListeners(signal,'abort').filter(f=>owned.includes(f)),'TERMINAL_OPERATION_RELEASES_CALLER_LISTENERS').toHaveLength(0);
 }finally{release();await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

for(const kind of ['inference','relayed','managedReference'] as const)for(const terminal of ['admit','charge','commit','finish','caller abort','turn abort'])test(`listener owner: ${terminal} × ${kind}`,async()=>{
 const caller=new AbortController(),root=new AbortController();let current=true;const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:terminal==='admit'?['ithaca.example.org','github.com']:[],maxBytes:8,outwardHosts:[],signal:root.signal,observe:r=>rows.push(r),admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:true,authorityCurrent:current}),subscribe:()=>()=>{}}});
 try{const op=kind==='managedReference'?proxy.managedReference(new URL('https://github.com/'),caller.signal):proxy[kind]('GET',new URL('http://ithaca.example.org/'),caller.signal);expect(getEventListeners(caller.signal,'abort')).toHaveLength(1);const admitted=await op.admit();if(terminal==='admit')expect(admitted).toBe(false);else{expect(admitted).toBe(true);if(terminal==='charge')op.charge(9);else if(terminal==='commit'){current=false;op.dispatch(()=>{});}else if(terminal==='finish'){op.dispatch(()=>{});op.finish('completed');}else if(terminal==='caller abort')caller.abort();else root.abort();}expect(rows).toHaveLength(1);expect(getEventListeners(caller.signal,'abort'),'ALL_TERMINAL_TRANSITIONS_RELEASE_THE_CALLER').toHaveLength(0);}finally{caller.abort();proxy.stop();}
});

for(const kind of ['inference','relayed','managedReference'] as const)test(`review19: commit observer cannot bypass final fence (${kind})`,async()=>{
 let current=true;const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r),preparing:()=>{current=false;},admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:true,authorityCurrent:current}),subscribe:()=>()=>{}}});
 try{const op=kind==='managedReference'?proxy.managedReference(new URL('https://github.com/'),new AbortController().signal):proxy[kind]('POST',new URL(origin),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.dispatch(()=>{}),'COMMIT_OBSERVER_MUST_NOT_BYPASS_FINAL_FENCE').toEqual({ok:false,reason:'safety_changed'});expect(rows.at(-1)).toMatchObject({outcome:'denied',failureReason:'safety_changed'});}finally{proxy.stop();}
});

for(const files of [false,true])for(const unavailable of [false,true])test(`review20: EOF fences held bytes and handles (Files ${files}, unavailable ${unavailable})`,async()=>{
 let current=true,reads=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const receipts:ProviderRelayReceipt[]=[],rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r),admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:unavailable?current:true,authorityCurrent:unavailable?true:current}),subscribe:()=>()=>{}}});
 const original=globalThis.fetch;const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>new Response(new ReadableStream<Uint8Array>({async pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode(files?'{}':'Ithaca '.repeat(16)+'Troy'));else{if(!files)await gate;current=false;controller.close();}}},{highWaterMark:0}),{headers:files?{'x-goog-upload-url':`${origin}/upload/v1beta/files?upload_id=ithaca`}:{}}),{preconnect:original.preconnect}));
 const relay=startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]],['GEMINI_API_KEY',[origin]]]),credential:()=> 'odysseus-key',egress:proxy,observe:r=>receipts.push(r)});
 try{const answer=await send(relay.socketPath,files?'/upload/v1beta/files':'/v1/messages','{}',files?{'x-brain-provider':'gemini','x-brain-provider-key':'GEMINI_API_KEY','x-brain-provider-origin':origin,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'}:{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin},release);
  expect(answer.status,'EOF_MUST_REVALIDATE_BEFORE_RELEASING_HELD_BYTES').toBe(files?(unavailable?503:403):200);if(files)expect(answer.headers['x-goog-upload-url'],'REVOKED_RESPONSE_CANNOT_REGISTER_UPLOAD').toBeUndefined();else{expect(answer.interrupted).toBe(true);expect(answer.body,'SCRUBBER_TAIL_NEVER_ESCAPES_REVOKED_AUTHORITY').toBe(('Ithaca '.repeat(16)+'Troy').slice(0,-11));}
  expect(receipts.at(-1)).toMatchObject({outcome:'cancelled',status:200});expect(rows.at(-1)).toMatchObject({outcome:'denied',failureReason:unavailable?'unavailable':'safety_changed'});
 }finally{release();await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

for(const provider of [false,true])for(const scenario of ['redirect','EOF authority','EOF recording'] as const)test(`review21: ${scenario} × ${provider?'provider':'inference'}`,async()=>{
 let current=true,reads=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r),admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:scenario==='EOF recording'?current:true,authorityCurrent:scenario==='EOF recording'?true:current}),subscribe:()=>()=>{}}});
 const original=globalThis.fetch;const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>scenario==='redirect'?new Response(null,{status:302,headers:{location:'http://ithaca.example.org/','x-ithaca-receipt':'x'.repeat(8192)}}):new Response(new ReadableStream<Uint8Array>({async pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('Ithaca '.repeat(16)));else{await gate;current=false;controller.close();}}},{highWaterMark:0})),{preconnect:original.preconnect}));
 const relay=provider?startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]]]),credential:()=> 'odysseus-key',egress:proxy}):startInferenceRelay({upstream:origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress:proxy});
 try{const answer=await send(relay.socketPath,'/v1/messages','{}',provider?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin}:{},release);if(scenario==='redirect'){expect(answer.status).toBe(502);expect(rows.at(-1)!.bytes,'REDIRECT_HEADERS_DEBIT_SHARED_ALLOWANCE').toBeGreaterThan(8192);}else{expect(answer.interrupted,'EOF_CANNOT_COMPLETE_REVOKED_ADMISSION').toBe(true);expect(rows.at(-1)).toMatchObject({failureReason:scenario==='EOF recording'?'unavailable':'safety_changed',outcome:'denied'});}}finally{release();await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

test('review21: overflowing Files chunk consumes remaining allowance before size refusal',async()=>{
 const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r)});const original=globalThis.fetch;const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>new Response(new Uint8Array(1024*1024+1)),{preconnect:original.preconnect}));const relay=startProviderRelay({origins:new Map([['GEMINI_API_KEY',[origin]]]),credential:()=> 'odysseus-key',egress:proxy});
 try{const answer=await send(relay.socketPath,'/upload/v1beta/files','{}',{'x-brain-provider':'gemini','x-brain-provider-key':'GEMINI_API_KEY','x-brain-provider-origin':origin,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'});expect(answer.status,'RECEIVED_BYTES_PRECEDE_FILES_SIZE_BRANCH').toBe(403);expect(proxy.remainingBytes(),'RECEIVED_OVERFLOW_CANNOT_RESTORE_ALLOWANCE').toBe(0);expect(rows.at(-1)).toMatchObject({failureReason:'budget',outcome:'denied'});}finally{await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

for(const kind of ['inference','relayed','managedReference'] as const)for(const stage of ['prepare','fence','started failure'])test(`review22: dispatch fact ${stage} × ${kind}`,async()=>{
 let current=true,sends=0,grants=0;const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r),preparing:()=>{if(stage==='prepare')current=false;},committed:()=>{grants++;},admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:true,authorityCurrent:current}),subscribe:()=>()=>{}}});
 try{const op=kind==='managedReference'?proxy.managedReference(new URL('https://github.com/'),new AbortController().signal):proxy[kind]('POST',new URL(origin),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.charge(8).ok).toBe(true);expect(op.prepare().ok).toBe(true);if(stage==='fence')current=false;const result=op.dispatch(()=>{sends++;op.finish('failed','upstream_unreachable');});expect(result.ok).toBe(stage==='started failure');expect(sends).toBe(stage==='started failure'?1:0);expect(grants,'ONLY_STARTED_SENDS_PUBLISH_CONTACT_PERMISSION').toBe(sends);expect(rows.at(-1),'DISPATCH_AUDIT_MATCHES_THE_ACTUAL_SEND').toMatchObject({dispatched:stage==='started failure',outcome:stage==='started failure'?'failed':'denied'});}finally{proxy.stop();}
});

for(const provider of [false,true])for(const eof of [false,true])for(const unavailable of [false,true])test(`review22: queued delivery revocation (provider ${provider}, EOF ${eof}, unavailable ${unavailable})`,async()=>{
 let current=true,queued=false,armed=false,reads=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const rows:EgressRecord[]=[];
 const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r),admissionSafety:{read:()=>{const snapshot={evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:unavailable?current:true,authorityCurrent:unavailable?true:current};if(armed&&!queued){queued=true;queueMicrotask(()=>{current=false;});}return snapshot;},subscribe:()=>()=>{}}});
 const original=globalThis.fetch;const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>new Response(new ReadableStream<Uint8Array>({async pull(controller){if(reads++===0){controller.enqueue(new TextEncoder().encode('Ithaca '.repeat(16)));return;}await gate;armed=true;if(eof)controller.close();else controller.enqueue(new TextEncoder().encode('Troy'));}},{highWaterMark:0})),{preconnect:original.preconnect}));
 const relay=provider?startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]]]),credential:()=> 'odysseus-key',egress:proxy}):startInferenceRelay({upstream:origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress:proxy});
 try{const answer=await send(relay.socketPath,'/v1/messages','{}',provider?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin}:{},release);expect(queued).toBe(true);expect(answer.interrupted,'NO_AWAIT_BETWEEN_FINAL_FENCE_AND_CLIENT_DELIVERY').toBe(true);expect(answer.body).not.toContain('Troy');expect(answer.body.length).toBe(provider?101:112);expect(rows.at(-1)).toMatchObject({outcome:'denied',failureReason:unavailable?'unavailable':'safety_changed'});}finally{release();await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

for(const provider of [false,true])test(`review24: received normal ${provider?'provider':'inference'} response exhausts allowance`,async()=>{
 const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:16384,outwardHosts:[],observe:r=>rows.push(r)});const original=globalThis.fetch;const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>new Response(new Uint8Array(65536)),{preconnect:original.preconnect}));const relay=provider?startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]]]),credential:()=> 'odysseus-key',egress:proxy}):startInferenceRelay({upstream:origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress:proxy});
 try{const result=await send(relay.socketPath,'/v1/messages','{}',provider?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin}:{}).catch(()=>({interrupted:true}));expect(result.interrupted).toBe(true);expect(proxy.remainingBytes(),'RECEIVED_RELAY_BYTES_CANNOT_LEAVE_LATER_ALLOWANCE').toBe(0);expect(rows.at(-1)).toMatchObject({outcome:'denied',failureReason:'budget',bytes:16384});}finally{await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

for(const provider of [false,true])test(`review24: received ${provider?'provider':'inference'} upload exhausts allowance`,async()=>{
 let hits=0;const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:16384,outwardHosts:[],observe:r=>rows.push(r)});const original=globalThis.fetch;const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>{hits++;return Response.json({});},{preconnect:original.preconnect}));const relay=provider?startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]]]),credential:()=> 'odysseus-key',egress:proxy}):startInferenceRelay({upstream:origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress:proxy});
 try{const answer=await send(relay.socketPath,'/v1/messages',JSON.stringify({model:'odysseus-model',messages:[{role:'user',content:'Ithaca '.repeat(16384)}]}),provider?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin}:{});expect(answer.status).toBe(403);expect(proxy.remainingBytes(),'RECEIVED_UPLOAD_BYTES_CANNOT_LEAVE_LATER_ALLOWANCE').toBe(0);expect(hits).toBe(0);expect(rows.at(-1)).toMatchObject({outcome:'denied',failureReason:'budget',bytes:16384,dispatched:false});}finally{await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});

for(const path of ['inference','provider','cleanup'] as const)for(const synchronous of [false,true])test(`review25: ${synchronous?'sync throw':'promise rejection'} × ${path}`,async()=>{
 const rows:EgressRecord[]=[],receipts:ProviderRelayReceipt[]=[];let armed=path!=='cleanup';const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r)});const original=globalThis.fetch;
 const fetchSpy=spyOn(globalThis,'fetch').mockImplementation(Object.assign((input:Parameters<typeof fetch>[0])=>{
  const url=new URL(String(input));if(!armed)return Promise.resolve(!url.search?Response.json({},{headers:{'x-goog-upload-url':`${origin}/upload/v1beta/files?upload_id=ithaca`}}):Response.json({file:{name:'files/ithaca',uri:`${origin}/v1beta/files/ithaca`,mimeType:'video/mp4',state:'ACTIVE'}},{headers:{'x-goog-upload-status':'final'}}));
  if(synchronous)throw new Error('Odysseus transport unavailable');return Promise.reject(new Error('Odysseus transport unavailable'));
 },{preconnect:original.preconnect}));
 const relay=path==='inference'?startInferenceRelay({upstream:origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress:proxy}):startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]],['GEMINI_API_KEY',[origin]]]),credential:()=> 'odysseus-key',get egress(){return armed?proxy:undefined;},observe:r=>receipts.push(r)});
 try{if(path==='cleanup'){const headers={'x-brain-provider':'gemini','x-brain-provider-key':'GEMINI_API_KEY','x-brain-provider-origin':origin};const started=await send(relay.socketPath,'/upload/v1beta/files','{}',{...headers,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'});const url=new URL(String(started.headers['x-goog-upload-url']));expect((await send(relay.socketPath,url.pathname+url.search,'troy!',{...headers,'x-goog-upload-command':'upload, finalize','x-goog-upload-offset':'0'})).status).toBe(200);receipts.length=0;armed=true;await relay.stop();}
  else{const answer=await send(relay.socketPath,'/v1/messages','{}',path==='provider'?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':origin}:{});expect(answer.status,'SYNC_AND_ASYNC_UPSTREAM_FAILURE_ARE_502').toBe(502);}
  if(path!=='inference')expect(receipts.at(-1),'UPSTREAM_FAILURE_IS_FAILED_WITH_NO_OBSERVED_HTTP_STATUS').toMatchObject({outcome:'failed',status:0});expect(rows.at(-1),'ATTEMPTED_HANDOFF_RETAINS_UPSTREAM_FAILURE_EVIDENCE').toMatchObject({outcome:'failed',reason:'upstream_unreachable',dispatched:!synchronous});
 }finally{await relay.stop();proxy.stop();fetchSpy.mockRestore();}
});


for(const path of ['proxy','proxy request','inference','provider','Files','cleanup'] as const)test(`review26: oversized Connection-nominated response header × ${path}`,async()=>{
 let contacts=0;const server=createServer(socket=>{contacts++;socket.on('error',()=>{});socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nConnection: x-ithaca-hidden, close\r\nX-Ithaca-Hidden: '+'x'.repeat(path==='proxy request'?0:8192)+'\r\nContent-Length: 2\r\n\r\n{}'));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const upstream=`http://127.0.0.1:${(server.address() as {port:number}).port}`;const rows:EgressRecord[]=[],receipts:ProviderRelayReceipt[]=[];let armed=path!=='cleanup';const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:4096,outwardHosts:[],observe:r=>rows.push(r)});const original=globalThis.fetch;
 const fetchSpy=path==='cleanup'?spyOn(globalThis,'fetch').mockImplementation(Object.assign((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{if(armed)return original(input,init);const url=new URL(String(input));return Promise.resolve(!url.search?Response.json({},{headers:{'x-goog-upload-url':`${upstream}/upload/v1beta/files?upload_id=ithaca`}}):Response.json({file:{name:'files/ithaca',uri:`${upstream}/v1beta/files/ithaca`,mimeType:'video/mp4',state:'ACTIVE'}},{headers:{'x-goog-upload-status':'final'}}));},{preconnect:original.preconnect})):undefined;
 const relay=path.startsWith('proxy')?undefined:path==='inference'?startInferenceRelay({upstream,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress:proxy}):startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[upstream]],['GEMINI_API_KEY',[upstream]]]),credential:()=> 'odysseus-key',get egress(){return armed?proxy:undefined;},observe:r=>receipts.push(r)});
 const gemini={'x-brain-provider':'gemini','x-brain-provider-key':'GEMINI_API_KEY','x-brain-provider-origin':upstream},startHeaders={...gemini,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'};
 try{if(path==='cleanup'){const started=await send(relay!.socketPath,'/upload/v1beta/files','{}',startHeaders);const url=new URL(String(started.headers['x-goog-upload-url']));expect((await send(relay!.socketPath,url.pathname+url.search,'troy!',{...gemini,'x-goog-upload-command':'upload, finalize','x-goog-upload-offset':'0'})).status).toBe(200);receipts.length=0;armed=true;await relay!.stop();}else{const result=await send(relay?.socketPath??proxy.socketPath,path.startsWith('proxy')?upstream+'/':path==='Files'?'/upload/v1beta/files':'/v1/messages','{}',path==='provider'?{'x-brain-provider':'anthropic','x-brain-provider-key':'ANTHROPIC_API_KEY','x-brain-provider-origin':upstream}:path==='Files'?startHeaders:path==='proxy request'?{'connection':'x-ithaca-inbound','x-ithaca-inbound':'x'.repeat(8192)}:{});expect(result.status,'RECEIVED_HOP_BY_HOP_BYTES_PRECEDE_FORWARD_FILTER').toBe(403);}
  expect(proxy.remainingBytes(),'RECEIVED_HOP_BY_HOP_HEADERS_EXHAUST_ALLOWANCE').toBe(0);expect(rows.at(-1)).toMatchObject({outcome:'denied',reason:'max_bytes_per_turn',bytes:4096,dispatched:path!=='proxy request'});if(path==='proxy request')expect(contacts,'FILTERED_REQUEST_HEADERS_ARE_METERED_BEFORE_CONTACT').toBe(0);if(path==='provider'||path==='Files'||path==='cleanup')expect(receipts.at(-1)).toMatchObject({outcome:'cancelled',status:200});
 }finally{await relay?.stop();proxy.stop();fetchSpy?.mockRestore();await new Promise<void>(r=>server.close(()=>r()));}
});
