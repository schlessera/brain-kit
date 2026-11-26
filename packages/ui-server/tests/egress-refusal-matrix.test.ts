/** Every operation refusal enters the same stored decision before any caller observes abort. */
import { expect, test } from 'bun:test';
import { request } from 'node:http';
import { connect } from 'node:net';
import { startEgressProxy, EgressAdmissionRefused, type EgressProxyOptions, type EgressRecord, type EgressFailureReason } from '../../ui-sdk/src/server/egress-proxy';
import { startInferenceRelay } from '../../ui-sdk/src/server/inference-relay';
import { startProviderRelay, type ProviderRelayOptions, type ProviderRelayReceipt } from '../../ui-sdk/src/server/provider-relay';
import { createGitHubReferenceWire } from '../src/brain/github-reference-wire';

const callers=['HTTP','CONNECT','inference','provider','cleanup','reference'] as const;
const sources=[
 {name:'budget',category:'budget',detail:'max_bytes_per_turn'},
 {name:'deny',category:'policy_denied',detail:'destination_not_allowed'},
 {name:'allowlist',category:'policy_denied',detail:'destination_not_allowed'},
 {name:'port',category:'policy_denied',detail:'destination_port'},
 {name:'dns',category:'policy_denied',detail:'unresolved_destination'},
 {name:'private',category:'policy_denied',detail:'private_destination'},
 {name:'metadata',category:'policy_denied',detail:'metadata_destination'},
 {name:'late taint',category:'policy_denied',detail:'taint_not_allowed',g6:true},
 {name:'taint',category:'policy_denied',detail:'taint_not_allowed',g6:true},
 {name:'declined Network',category:'policy_denied',detail:'taint_not_approved',g6:true},
 {name:'stale Network',category:'safety_changed',detail:'safety_changed',g6:true},
 {name:'declined outward',category:'policy_denied',detail:'outward_not_approved'},
 {name:'stale outward',category:'safety_changed',detail:'safety_changed'},
 {name:'card recording',category:'unavailable',detail:'egress_unavailable'},
 {name:'card authority',category:'safety_changed',detail:'safety_changed'},
 {name:'card read error',category:'unavailable',detail:'egress_unavailable'},
 {name:'initial authority',category:'safety_changed',detail:'safety_changed'},
 {name:'late authority',category:'safety_changed',detail:'safety_changed'},
 {name:'initial recording',category:'unavailable',detail:'egress_unavailable'},
 {name:'late recording',category:'unavailable',detail:'egress_unavailable'},
 {name:'initial read error',category:'unavailable',detail:'egress_unavailable'},
 {name:'late read error',category:'unavailable',detail:'egress_unavailable'},
 {name:'host refusal',category:'policy_denied',detail:'call_not_admitted'},
 {name:'recording abort',category:'unavailable',detail:'egress_unavailable'},
 {name:'host error',category:'unavailable',detail:'proxy_error'},
 {name:'source removal',category:'safety_changed',detail:'source_trust_changed'},
 {name:'turn cancellation',category:'cancelled',detail:'turn_cancelled'},
] satisfies {name:string;category:EgressFailureReason;detail:string;g6?:boolean}[];

function http(socketPath:string,path:string,headers:Record<string,string>={},body?:string,method=body?'POST':'GET') {
 return new Promise<{status:number;body:string;headers:Record<string,unknown>}>((resolve,reject)=>{
  const req=request({socketPath,path,method,headers},res=>{let text='';res.on('data',b=>{text+=b;});res.on('end',()=>resolve({status:res.statusCode!,body:text,headers:res.headers}));res.on('error',reject);});req.on('error',reject);req.end(body);
 });
}
function tunnel(socketPath:string,target:string) {
 return new Promise<number>((resolve,reject)=>{const s=connect(socketPath);let text='';s.on('error',reject);s.on('connect',()=>s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));s.on('data',b=>{text+=b;s.end();});s.on('close',()=>resolve(Number(/^HTTP\/1.1 (\d+)/.exec(text)?.[1]??0)));});
}

for(const source of sources)for(const caller of callers)test(`refusal matrix: ${source.name} × ${caller}`,async()=>{
 let phase=false,revision='1',hits=0,armed=false,origin='';
 const records:EgressRecord[]=[],receipts:ProviderRelayReceipt[]=[];
 const root=new AbortController();
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  hits++;await req.arrayBuffer();const u=new URL(req.url);
  if(u.pathname==='/upload/v1beta/files'&&!u.search)return Response.json({},{headers:{'x-goog-upload-url':`${origin}/upload/v1beta/files?upload_id=ithaca&upload_protocol=resumable`}});
  if(u.pathname==='/upload/v1beta/files')return Response.json({file:{name:'files/ithaca',uri:`${origin}/v1beta/files/ithaca`,mimeType:'video/mp4',state:'ACTIVE'}},{headers:{'x-goog-upload-status':'final'}});
  return Response.json({});
 }});
 const host=caller==='reference'?'github.com':['dns','private','metadata'].includes(source.name)?'localhost':'127.0.0.1';
 origin=`http://${host}:${upstream.port}`;
 const options:EgressProxyOptions={mode:source.name==='allowlist'?'allowlist':'record',allow:[],deny:source.name==='deny'?[host]:[],maxBytes:source.name==='budget'?0:65536,
  signal:root.signal,outwardHosts:source.name.includes('outward')||source.name.startsWith('card ')?[host]:[],
  approveOutward:async()=>{if(source.name.startsWith('card '))phase=true;if(source.name==='stale outward')revision='2';return source.name!=='declined outward';},
  observe:r=>records.push(r),inputCurrent:()=>source.name!=='source removal',
  admissionSafety:{read:()=>{
   if(source.name==='initial read error'||(source.name==='late read error'||source.name==='card read error')&&phase)throw new Error('Athena cannot verify recording');
   return {evidenceRevision:'1',trustRevision:'1',authorityEpoch:'1',scope:'ithaca',policyHash:null,restricted:false,
    recordingAvailable:!(source.name==='initial recording'||(source.name==='late recording'||source.name==='card recording')&&phase),
    authorityCurrent:!(source.name==='initial authority'||(source.name==='late authority'||source.name==='card authority')&&phase)};
  },subscribe:()=>()=>{}},
  taint:{allow:[],tainted:()=>!!('g6' in source&&source.g6)&&(source.name!=='late taint'||phase),contacted:()=>false,approvalRevision:()=>source.name.startsWith('card ')?JSON.stringify([revision,phase]):revision,
   ...(source.name==='declined Network'||source.name==='stale Network'?{approve:async()=>{if(source.name==='stale Network')revision='2';return source.name!=='declined Network';}}:{})},
  admitted:async()=>{phase=true;if(source.name==='host refusal')throw new EgressAdmissionRefused();if(source.name==='host error')throw new Error('Athena cannot record');if(source.name==='turn cancellation')root.abort();if(source.name==='recording abort')root.abort(new EgressAdmissionRefused('Recording failed','egress_unavailable'));},
  ...(['port','dns','private','metadata'].includes(source.name)?{destinations:{ports:source.name==='port'?[]:[upstream.port!,443],allowRanges:['127.0.0.0/8'],lookup:async()=>{if(source.name==='dns')throw new Error('No DNS');return [{address:source.name==='private'?'10.0.0.1':source.name==='metadata'?'169.254.169.254':'127.0.0.1',family:4}];}}}:{}),
 };
 const egress=await startEgressProxy(options);
 let relay:ReturnType<typeof startInferenceRelay>|ReturnType<typeof startProviderRelay>|undefined;
 let wire:Awaited<ReturnType<typeof createGitHubReferenceWire>>|undefined;
 const exemption='g6' in source&&source.g6&&['inference','provider','cleanup'].includes(caller);
 let status=0;
 try{
  if(caller==='HTTP')status=(await http(egress.socketPath,origin+'/').catch(()=>({status:0}))).status;
  else if(caller==='CONNECT')status=await tunnel(egress.socketPath,`${host}:${upstream.port}`).catch(()=>0);
  else if(caller==='inference'){
   relay=startInferenceRelay({upstream:origin,routes:['/v1/messages'],credentials:{'x-api-key':'odysseus-key'},egress});
   status=(await http(relay.socketPath,'/v1/messages',{'content-type':'application/json'},JSON.stringify({model:'odysseus-model',messages:[]})).catch(()=>({status:0}))).status;
  }else if(caller==='provider'||caller==='cleanup'){
   const family=caller==='cleanup'?'gemini':'anthropic',key=caller==='cleanup'?'GEMINI_API_KEY':'ANTHROPIC_API_KEY';
   const relayOptions:ProviderRelayOptions={origins:new Map([[key,[origin]]]),credential:()=> 'odysseus-key',observe:r=>receipts.push(r),get egress(){return caller==='cleanup'&&!armed?undefined:egress;}};
   relay=startProviderRelay(relayOptions);
   const headers={'x-brain-provider':family,'x-brain-provider-key':key,'x-brain-provider-origin':origin,'content-type':'application/json'};
   if(caller==='provider')status=(await http(relay.socketPath,'/v1/messages',headers,JSON.stringify({model:'odysseus-model',messages:[]})).catch(()=>({status:0}))).status;
   else{
    const start=await http(relay.socketPath,'/upload/v1beta/files',{...headers,'x-goog-upload-protocol':'resumable','x-goog-upload-command':'start','x-goog-upload-header-content-length':'5','x-goog-upload-header-content-type':'video/mp4'},JSON.stringify({file:{mimeType:'video/mp4'}}));
    expect(start.status,'CLEANUP_MATRIX_HAS_A_REAL_OWNED_FILE').toBe(200);
    const url=new URL(String(start.headers['x-goog-upload-url']));
    const upload=await http(relay.socketPath,url.pathname+url.search,{...headers,'x-goog-upload-command':'upload, finalize','x-goog-upload-offset':'0'},'troy!');expect(upload.status).toBe(200);
    hits=0;receipts.length=0;armed=true;await relay.stop();status=receipts.at(-1)?.status??0;
   }
  }else{
   wire=await createGitHubReferenceWire({repository:'odysseus/ithaca',egress,maxBytes:65536,authorize(){},lookup:async()=>[{address:'93.184.216.34',family:4}],connect:()=>connect({host:'127.0.0.1',port:upstream.port!})});
   const url=new URL(wire.gitProxyUrl(false));await new Promise<void>((resolve,reject)=>{const s=connect({host:url.hostname,port:Number(url.port)});s.on('error',reject);s.on('connect',()=>s.write(`CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}\r\n\r\n`));s.on('data',()=>{});s.on('close',resolve);});
   const reason=(wire.failure() as {reason?:string}|null)?.reason;
   expect(reason,'REFERENCE_PRESERVES_STORED_REFUSAL').toBe(source.category==='budget'?'capacity':source.category==='unavailable'||source.category==='cancelled'?'unavailable':'denied');
  }
  for(let i=0;!records.length&&i<100;i++)await Bun.sleep(1);
  const record=records.at(-1);
  if(exemption){expect(status,'HOST_RELAYS_RETAIN_G5_EXEMPTION').toBe(200);expect(record?.failureReason).toBeUndefined();}
  else{
   if(caller==='cleanup')expect(status,'RECEIPT_HAS_NO_UPSTREAM_STATUS_BEFORE_RESPONSE').toBe(0);
   else if(caller!=='reference')expect(status,'CALLER_PRESERVES_REFUSAL_STATUS').toBe((source.category==='cancelled'||source.name==='recording abort')&&['HTTP','CONNECT'].includes(caller)?0:source.category==='unavailable'?503:source.category==='cancelled'?499:403);
   expect(record,'CALLER_PRESERVES_TERMINAL_AUDIT').toMatchObject({reason:source.detail,failureReason:source.category,outcome:source.category==='cancelled'||source.name==='source removal'?'cancelled':source.name==='host error'?'failed':'denied'});
   expect(hits,'REFUSED_OPERATION_NEVER_DISPATCHES').toBe(0);
  }
 }finally{await wire?.close();await relay?.stop();egress.stop();upstream.stop(true);}
});
