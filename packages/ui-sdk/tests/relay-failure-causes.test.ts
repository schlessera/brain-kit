/** Controlled failures at the lowest fetch boundary; real Unix relay requests stay offline. */
import { expect,spyOn,test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { request,type IncomingHttpHeaders } from 'node:http';
import { startEgressProxy,type EgressRecord } from '../src/server/egress-proxy';
import { startInferenceRelay,type InferenceRelayEvent } from '../src/server/inference-relay';
import { startProviderRelay,type ProviderRelayReceipt } from '../src/server/provider-relay';
const origin='http://127.0.0.1:43107';
const causes=['upstream','cancelled','safety_changed','policy_denied','unavailable','budget'] as const;
const paths=['credentials','credentials return','inference fetch','inference stream','provider fetch','Files response','provider stream','cleanup'] as const;
function send(socketPath:string,path:string,body:string,headers:Record<string,string>,onData:()=>void=()=>{}) {
 return new Promise<{status:number;interrupted:boolean;headers:IncomingHttpHeaders}>((resolve,reject)=>{
  const req=request({socketPath,path,method:'POST',headers:{'content-type':'application/json',...headers}},res=>{
   const done=(interrupted:boolean)=>resolve({status:res.statusCode!,interrupted,headers:res.headers});res.on('data',()=>onData());res.once('end',()=>done(false));res.once('aborted',()=>done(true));res.once('error',()=>done(true));
  });req.once('error',reject);req.end(body);
 });
}
for(const path of paths)for(const cause of causes)test(`failure cause: ${cause} × ${path}`,async()=>{
 const root=new AbortController();let authority=true,recording=true,armed=path!=='cleanup',recovering=false;let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});const audits:EgressRecord[]=[],receipts:ProviderRelayReceipt[]=[],inference:InferenceRelayEvent[]=[];
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
 const relay=isInference?startInferenceRelay({upstream:origin,routes:['/v1/messages'],egress,credentials:async()=>{if(path.startsWith('credentials')){trigger();if(path==='credentials')throw new Error('Odysseus credential resolver unavailable');}return {'x-api-key':'odysseus-key'};},observe:r=>inference.push(r)}):startProviderRelay({origins:new Map([['ANTHROPIC_API_KEY',[origin]],['GEMINI_API_KEY',[origin]]]),credential:()=> 'odysseus-key',get egress(){return path==='cleanup'&&!armed?undefined:egress;},observe:r=>receipts.push(r)});
 const gemini={'x-brain-provider':'gemini','x-brain-provider-key':'GEMINI_API_KEY','x-brain-provider-origin':origin};
 try{
  let result:{status:number;interrupted:boolean}|undefined;
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
  const outcome=typed?'cancelled':'failed';
  if(!isInference)expect(receipts.at(-1),'FINISH_ABORT_CANNOT_RECLASSIFY_THE_PROVIDER_RECEIPT').toMatchObject({outcome,status:streaming||path==='Files response'?200:typed?status:0});
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
