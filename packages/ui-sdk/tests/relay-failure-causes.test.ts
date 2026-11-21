/** Controlled failures at the lowest fetch boundary; real Unix relay requests stay offline. */
import { expect,spyOn,test } from 'bun:test';
import { getEventListeners } from 'node:events';
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
 try{const op=kind==='managedReference'?proxy.managedReference(new URL('https://github.com/'),caller.signal):proxy[kind]('GET',new URL('http://ithaca.example.org/'),caller.signal);expect(getEventListeners(caller.signal,'abort')).toHaveLength(1);const admitted=await op.admit();if(terminal==='admit')expect(admitted).toBe(false);else{expect(admitted).toBe(true);if(terminal==='charge')op.charge(9);else if(terminal==='commit'){current=false;op.commit();}else if(terminal==='finish'){op.commit();op.finish('completed');}else if(terminal==='caller abort')caller.abort();else root.abort();}expect(rows).toHaveLength(1);expect(getEventListeners(caller.signal,'abort'),'ALL_TERMINAL_TRANSITIONS_RELEASE_THE_CALLER').toHaveLength(0);}finally{caller.abort();proxy.stop();}
});

for(const kind of ['inference','relayed','managedReference'] as const)test(`review19: commit observer cannot bypass final fence (${kind})`,async()=>{
 let current=true;const rows:EgressRecord[]=[];const proxy=await startEgressProxy({mode:'record',allow:[],deny:[],maxBytes:65536,outwardHosts:[],observe:r=>rows.push(r),committed:()=>{current=false;},admissionSafety:{read:()=>({evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,recordingAvailable:true,authorityCurrent:current}),subscribe:()=>()=>{}}});
 try{const op=kind==='managedReference'?proxy.managedReference(new URL('https://github.com/'),new AbortController().signal):proxy[kind]('POST',new URL(origin),new AbortController().signal);expect(await op.admit()).toBe(true);expect(op.commit(),'COMMIT_OBSERVER_MUST_NOT_BYPASS_FINAL_FENCE').toEqual({ok:false,reason:'safety_changed'});expect(rows.at(-1)).toMatchObject({outcome:'denied',failureReason:'safety_changed'});}finally{proxy.stop();}
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
