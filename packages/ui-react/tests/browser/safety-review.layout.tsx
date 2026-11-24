/// <reference types="@vitest/browser-playwright" />
import {afterAll,afterEach,beforeAll,expect,test} from 'vitest';
import {watchdogMs} from '../../../../scripts/test-deadlines.js';
import {commands,page,userEvent} from 'vitest/browser';
import {createRoot,type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {createBrainUiRoot,type BrainUiRoot} from '../../src/root.js';
import {BrainUiProvider} from '../../src/root-context.js';
import {MessageBubble} from '../../src/components/chat/message-bubble.js';
import {createSafetyClient} from '../../src/lib/safety-client.js';
import {SessionSafety} from '../../src/components/chat/safety-indicator.js';
import {parseServerMessage} from '@schlessera/brain-ui-sdk/schemas';
import type {ChatMessage} from '../../src/stores/chat-store.js';
import type {ClientMessage,SafetyPage,SafetyRecord} from '@schlessera/brain-ui-sdk/protocol';
let fixture:{id:string;url:string}|undefined,ui:BrainUiRoot|undefined,socket:WebSocket|undefined,renderer:Root|undefined,host:HTMLDivElement|undefined;
let safetyClient:ReturnType<typeof createSafetyClient>|undefined;
let styles:HTMLStyleElement;const oldTheme=document.documentElement.dataset.theme,viewport={width:innerWidth,height:innerHeight};
beforeAll(async()=>{styles=document.createElement('style');styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(async()=>{styles.remove();await page.viewport(viewport.width,viewport.height);});
async function disposeView(){safetyClient?.dispose();safetyClient=undefined;if(renderer)flushSync(()=>renderer!.unmount());renderer=undefined;ui?.dispose();ui=undefined;socket?.close();socket=undefined;host?.remove();host=undefined;}
afterEach(async()=>{statusBarrier=undefined;commitBarrier=undefined;await disposeView();if(fixture)await commands.safetyServer({op:'stop',id:fixture.id});fixture=undefined;if(oldTheme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=oldTheme;});
const patch=(patch:Record<string,unknown>={})=>commands.safetyServer({op:'set',id:fixture!.id,patch}) as Promise<{page:SafetyPage;commits:number;prepares:number;decisions:Array<{occurrence_id:string}>}>;
const noop=()=>{};
const message:ChatMessage={id:'odysseus-answer',turnId:'voyage',role:'assistant',content:'Voyage notes retained.',isStreaming:false,timestamp:Date.UTC(2026,6,12,10),
 toolCalls:[{id:'tool_a',name:'WebFetch',inputJson:'{}',input:{url:'https://example.com/odyssey'},output:'Odysseus voyage notes',status:'complete'},{id:'tool_c',name:'Grep',inputJson:'{}',input:{path:'workspaces/ithaca/voyage.md'},output:'Penelope voyage notes',status:'complete'}],
 parts:[{kind:'tool',toolIndex:0},{kind:'tool',toolIndex:1},{kind:'text',text:'Voyage notes retained.'}]};
let commitBarrier:((result:{status:number;body:unknown})=>Promise<void>)|undefined;
let statusBarrier:((body:Record<string,unknown>,result:{status:number;body:unknown})=>Promise<void>)|undefined;
async function view(independentSocket=false){
 const f=fixture!;
 ui=createBrainUiRoot({storage:null,config:{backendUrl:f.url},request:async(url,init)=>{
  if(!String(url).includes('/safety/reviews/'))return Response.json({providers:[]});
  const result=await patch({action:'request',path:new URL(url).pathname,body:init?.body}) as unknown as {status:number;body:unknown};
  if(String(url).endsWith('/future/status')&&statusBarrier)await statusBarrier(JSON.parse(String(init?.body)),result);
  if(String(url).endsWith('/commit')&&commitBarrier)await commitBarrier(result);
  if(init?.signal?.aborted)throw new DOMException('Aborted','AbortError');return Response.json(result.body,{status:result.status});
 }});
 const frames:unknown[]=[],sent:unknown[]=[];const current=ui;current.stores.chat.setState({activeSessionId:'ithaca',buffers:{ithaca:{messages:[message],isStreaming:false,askUser:null,lastTouched:message.timestamp}}});
 current.stores.connection.getState().setWsStatus('connected');
 socket=new WebSocket(f.url.replace('http:','ws:')+'/ws');const ws=socket;
 current.connection.send=(m:ClientMessage)=>{sent.push(m);if(ws.readyState!==WebSocket.OPEN)return false;ws.send(JSON.stringify(m));return true;};
 const client=safetyClient=createSafetyClient(current,m=>{sent.push(m);const target=independentSocket?ws:socket;if(target?.readyState!==WebSocket.OPEN)return false;target.send(JSON.stringify(m));return true;});
 ws.onopen=()=>ws.send(JSON.stringify({type:'client_hello',protocolRev:5,capabilities:{sessionSafetyHistory:true,chatDeletion:true}}));
 ws.onmessage=e=>{frames.push(JSON.parse(String(e.data)));const parsed=parseServerMessage(String(e.data));if(!parsed.ok)throw new Error(parsed.error);client.frame(parsed.message);};
 host=document.createElement('div');host.style.maxWidth='100%';document.body.append(host);renderer=createRoot(host);
 flushSync(()=>renderer!.render(<BrainUiProvider root={current}><button type="button">Outside safety details</button><SessionSafety/><MessageBubble message={message} journalVisible={false} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>));
 try{await expect.poll(()=>current.stores.safety.getState().status,{timeout:5000}).toBe('ready');}catch(error){throw new Error(`${String(error)} Frames:${JSON.stringify(frames)} Sent:${JSON.stringify(sent)} Safety:${JSON.stringify(current.stores.safety.getState())} Session:${current.stores.chat.getState().activeSessionId}`);}
}
async function scene(width:number,theme:string,independentSocket=false){await page.viewport(width,900);document.documentElement.dataset.theme=theme;fixture=await commands.safetyServer({op:'start'}) as typeof fixture;await view(independentSocket);}
function buttonForTool(){const all=[...host!.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')];return all.find(b=>b.getAttribute('aria-label')?.includes('2 unresolved'))!;}

for(const width of [320,1280])for(const theme of ['light','dark'])test(`${width} ${theme}: collapsed counts, native touch, exact scope, A/B/C and reload`,async()=>{
 await scene(width,theme);
 expect(host!.textContent,'OPAQUE_TRAFFIC_HAS_OWN_NAMED_TURN_EVENT').toContain('The proxy could not identify the tool');
 const indicator=buttonForTool();expect(indicator,'COLLAPSED_RUN_RETAINS_BOTH_TRIGGERS').toBeTruthy();
 const box=indicator.getBoundingClientRect();expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
 indicator.focus();await expect.poll(()=>getComputedStyle(indicator.parentElement!.querySelector('[role=tooltip]')!).opacity).toBe('1');
 const tooltipLayer=getComputedStyle(indicator.parentElement!.querySelector('[role=tooltip]')!).zIndex;
 await commands.rankTap({x:box.x+box.width/2,y:box.y+box.height/2});
 const panel=page.getByRole('dialog',{name:'Safety input details'});await expect.element(panel).toBeVisible();
 const popoverLayer=getComputedStyle(document.documentElement).getPropertyValue('--bk-z-popover').trim();expect(popoverLayer).not.toBe('');
 expect({tooltip:tooltipLayer,details:getComputedStyle(document.querySelector('[data-safety-details]')!).zIndex},'SAFETY_SURFACES_USE_NAMED_POPOVER_LAYER').toEqual({tooltip:popoverLayer,details:popoverLayer});
 expect(document.querySelector('[data-safety-details]')!.textContent,'REVIEW_NAMES_LINKED_SEARCH').toContain('Local search (Grep)');
 expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Whole chat · 3 unresolved inputs, including this one');
 expect(indicator.getAttribute('aria-expanded')).toBe('true');expect(document.querySelector('[data-safety-details]')!.textContent).toContain('The host did not record a verified origin');
 await userEvent.click(page.getByRole('button',{name:'Mark as safe',exact:true}).first());
 expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Only this input');
 expect(document.querySelector('[data-safety-details]')!.textContent).not.toMatch(/trust this origin|future repositories|Verified safe/i);
 await userEvent.click(page.getByRole('button',{name:'Mark this input as safe',exact:true}));
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount,{timeout:5000}).toBe(2);
 const state=await patch();expect(state.commits,'ONE_EXPLICIT_VERDICT').toBe(1);expect(state.decisions).toHaveLength(1);
 expect(host!.textContent).not.toContain('Normal policy restored');
 const reopener=indicator;
 await expect.element(panel).toBeVisible();
 await expect.element(page.getByText('Marked safe by you',{exact:true}).first()).toBeVisible();
 await page.screenshot({element:document.querySelector('[data-safety-details]') as HTMLElement,path:`../../.vitest-attachments/safety-review/${theme}-${width}.png`});
 const bounds=document.querySelector('[data-safety-details]')!.getBoundingClientRect();expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(innerWidth);
 await userEvent.keyboard('{Escape}');expect(document.querySelector('[data-safety-details]')).toBeNull();expect(document.activeElement).toBe(reopener);
 await userEvent.keyboard('{Enter}');await expect.element(panel).toBeVisible();await userEvent.click(page.getByRole('button',{name:'Outside safety details'}));expect(document.querySelector('[data-safety-details]')).toBeNull();
 await disposeView();await view();expect((await patch()).commits,'RELOAD_NEVER_REPLAYS_A_VERDICT').toBe(1);expect(ui!.stores.safety.getState().projection?.unresolvedCount).toBe(2);
});

test('open delivery, pruning, recorder loss and explicit unavailable evidence remain restrictive',async()=>{
 await scene(320,'dark');await patch({action:'add',id:'tool_open',finalized:false});
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount,{timeout:5000}).toBe(4);
 const fallback=host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!;await userEvent.click(fallback);
 expect(document.querySelector('[data-safety-details]')!.textContent,'OPEN_DELIVERY_EXPLAINS_REFUSAL').toContain('Input is still arriving');
 const section=[...document.querySelectorAll('[data-safety-trigger]')].find(e=>e.textContent?.includes('Input is still arriving'))!;
 expect(section.querySelector('[role=button]'),'OPEN_DELIVERY_OFFERS_NO_GRANT').toBeNull();
 await userEvent.keyboard('{Escape}');await patch({action:'prune'});ui!.stores.safety.getState().refresh();await expect.poll(()=>ui!.stores.safety.getState().status).toBe('ready');
 expect(host!.querySelectorAll('[data-safety-indicator]').length).toBeGreaterThan(0);
 await patch({action:'loss'});await expect.poll(()=>ui!.stores.safety.getState().projection?.reasons,{timeout:5000}).toContain('recording_failed');
 expect(host!.textContent).toContain('Recording is unavailable');expect(host!.textContent).not.toContain('Normal policy restored');expect((await patch()).commits).toBe(0);
});

test('only a complete healthy zero-trigger read restores normal; partial state never does',async()=>{
 await scene(320,'light');
 for(let remaining=3;remaining>0;remaining--){
  const button=[...host!.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')].find(b=>b.getClientRects().length>0&&b.getAttribute('aria-label')?.startsWith('Safety restrictions'))!;
  await userEvent.click(button);await userEvent.click(page.getByRole('button',{name:'Mark as safe',exact:true}).first());
  await userEvent.click(page.getByRole('button',{name:'Mark this input as safe',exact:true}));
  await expect.poll(()=>ui!.stores.safety.getState().status==='ready'&&ui!.stores.safety.getState().projection?.unresolvedCount===remaining-1,{timeout:5000}).toBe(true);
  await userEvent.keyboard('{Escape}');
 }
 expect(host!.textContent,'COMPLETE_ZERO_UNRESOLVED_RESTORES_NORMAL').toContain('Normal policy restored');
 expect((await patch()).commits).toBe(3);
 flushSync(()=>ui!.stores.safety.setState({status:'partial',normal:true}));
 expect(host!.textContent,'PARTIAL_STATE_CANNOT_PRINT_NORMAL').not.toContain('Normal policy restored');
});

test('read-only clients keep evidence without grant controls and retirement purges an open panel',async()=>{
 await scene(320,'dark');flushSync(()=>ui!.stores.safety.setState({capabilities:{...ui!.stores.safety.getState().capabilities!,review:false}}));
 await userEvent.click(buttonForTool());const panel=page.getByRole('dialog',{name:'Safety input details'});await expect.element(panel).toBeVisible();
 expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Only the authenticated owner');
 expect([...document.querySelectorAll('[data-safety-details] [role=button]')].some(e=>e.textContent==='Mark as safe'),'READ_ONLY_VIEW_OFFERS_NO_GRANT').toBe(false);
 await patch({action:'retire'});await expect.poll(()=>ui!.stores.safety.getState().reason,{timeout:5000}).toBe('retired');
 expect(document.querySelector('[data-safety-details]'),'RETIRED_HISTORY_PURGES_OPEN_DETAILS').toBeNull();
 expect(host!.querySelectorAll('[data-safety-indicator]').length).toBe(0);expect(Object.keys(ui!.stores.safety.getState().records)).toEqual([]);
});

test('same-owner disconnect and replay keep read-only evidence geometry without resuming a decision',async()=>{
 await scene(320,'dark');const indicator=buttonForTool(),notice=host!.querySelector<HTMLElement>('[data-session-safety]')!;
 await userEvent.click(indicator);await userEvent.click(page.getByRole('button',{name:'Mark as safe',exact:true}).first());
 const before=notice.getBoundingClientRect(),buttons=host!.querySelectorAll('[data-safety-indicator]').length;
 const client=safetyClient!,current=ui!;socket!.close();flushSync(()=>client.disconnected());
 expect(host!.querySelectorAll('[data-safety-indicator]').length,'DISCONNECT_RETAINS_READ_ONLY_INDICATORS').toBe(buttons);
 expect(notice.getBoundingClientRect().height,'DISCONNECT_RETAINS_NOTICE_HEIGHT').toBe(before.height);
 expect(current.stores.safety.getState().normal,'DISCONNECTED_EVIDENCE_CANNOT_RESTORE_NORMAL').toBe(false);
 expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Current evidence is unavailable');
 expect(document.querySelector('[data-safety-details]')!.textContent).not.toContain('Mark this input as safe');
 socket=new WebSocket(fixture!.url.replace('http:','ws:')+'/ws');const next=socket;
 next.onopen=()=>next.send(JSON.stringify({type:'client_hello',protocolRev:5,capabilities:{sessionSafetyHistory:true,chatDeletion:true}}));
 next.onmessage=e=>{const parsed=parseServerMessage(String(e.data));if(!parsed.ok)throw new Error(parsed.error);client.frame(parsed.message);};
 await expect.poll(()=>current.stores.safety.getState().status,{timeout:5000}).toBe('ready');
 expect(notice.getBoundingClientRect().height,'REPLAY_RETAINS_NOTICE_HEIGHT').toBe(before.height);
 expect(indicator.isConnected,'REPLAY_RETAINS_ORIGINAL_INDICATOR_NODE').toBe(true);
 expect(document.querySelector('[data-safety-details]')!.textContent,'RECONNECT_DISCARDS_UNSUBMITTED_SCOPE_CHOICE').not.toContain('Mark this input as safe');
 expect((await patch()).commits,'RECONNECT_DOES_NOT_SEND_A_DECISION').toBe(0);
});

test('two live owner views keep independent review scope and converge after every verdict',async()=>{
 await scene(320,'light',true);
 const first={ui:ui!,socket:socket!,renderer:renderer!,host:host!,client:safetyClient!};
 // A second root and socket, with separate caches and UI state, read the same
 // real writer. Disposal restores ownership so every resource is closed.
 ui=undefined;socket=undefined;renderer=undefined;host=undefined;safetyClient=undefined;
 try{
  await view(true);const second={ui:ui!,host:host!};
  for(let remaining=3;remaining>0;remaining--){
   const active=remaining%2===1?first:second;
   const indicator=[...active.host.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')].find(button=>button.getClientRects().length>0&&button.getAttribute('aria-label')?.startsWith('Safety restrictions'))!;
   await userEvent.click(indicator);
   await userEvent.click(page.getByRole('button',{name:'Mark as safe',exact:true}).first());
   await userEvent.click(page.getByRole('button',{name:'Mark this input as safe',exact:true}));
   for(const current of [first,second]){
    await expect.poll(()=>current.ui.stores.safety.getState().status==='ready'&&current.ui.stores.safety.getState().projection?.unresolvedCount===remaining-1,{timeout:5000}).toBe(true);
    expect(current.host.textContent?.includes('Normal policy restored'),'TWO_VIEWS_RESTORE_ONLY_AFTER_LAST_VERDICT').toBe(remaining===1);
   }
   await userEvent.keyboard('{Escape}');
  }
  expect((await patch()).commits,'TWO_VIEWS_COMMIT_EXACTLY_ONE_VERDICT_PER_TRIGGER').toBe(3);
  await patch({action:'add',id:'tool_d',finalized:false});
  for(const current of [first,second]){
   await expect.poll(()=>current.ui.stores.safety.getState().projection?.unresolvedCount,{timeout:5000}).toBe(1);
   expect(current.host.textContent,'TWO_VIEWS_FUTURE_INPUT_RESTRICTS_AGAIN').not.toContain('Normal policy restored');
  }
 }finally{
  await disposeView();ui=first.ui;socket=first.socket;renderer=first.renderer;host=first.host;safetyClient=first.client;
 }
});

for(const width of [320,1280])for(const theme of ['light','dark'])test(`${width} ${theme}: historical source admission is distinct from a human verdict`,async()=>{
 await scene(width,theme);
 const initialWidth=document.documentElement.scrollWidth;
 const records={...ui!.stores.safety.getState().records};
 for(const [id,r] of Object.entries(records))if(r.kind==='occurrence')records[id]={...r,admission:{trusted:true as const,ruleId:'ithaca-source',policyHash:'a'.repeat(64),trustRevision:'7',collectionRevision:'3'}};
 flushSync(()=>ui!.stores.safety.setState({records}));
 const indicator=[...host!.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')].find(b=>b.getAttribute('aria-label')?.startsWith('Trusted at admission'))!;
 expect(indicator,'SOURCE_DECISION_NEVER_READS_AS_UNRESOLVED_OR_HUMAN_VERDICT').toBeTruthy();await userEvent.click(indicator);
 await expect.poll(()=>document.querySelector('[data-safety-details]')?.textContent).toContain('Source rule ithaca-source · trust revision 7');
 expect(document.querySelector('[data-safety-details]')?.textContent).toContain('grants no current recipient permission');
 expect([...document.querySelectorAll('[data-safety-details] button')].some(b=>b.textContent==='Mark as safe')).toBe(false);
 const bounds=document.querySelector('[data-safety-details]')!.getBoundingClientRect();
 expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(innerWidth);
 expect(document.documentElement.scrollWidth,'ADMISSION_DETAILS_ADD_NO_PAGE_OVERFLOW').toBeLessThanOrEqual(initialWidth);
});

for(const theme of ['light','dark'])test(`${theme}: a mixed reviewed group names its remaining unresolved source on hover and focus`,async()=>{
 await scene(320,theme);
 const indicator=buttonForTool();
 await userEvent.click(indicator);
 await userEvent.click(page.getByRole('button',{name:'Mark as safe',exact:true}).first());
 await userEvent.click(page.getByRole('button',{name:'Mark this input as safe',exact:true}));
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(2);
 await userEvent.keyboard('{Escape}');
 const tooltip=indicator.parentElement!.querySelector<HTMLElement>('[role=tooltip]')!;
 expect(indicator.getAttribute('aria-label'),'GROUP_REASON_NAMES_UNRESOLVED_SOURCE').toContain('Workspace read');
 expect(indicator.getAttribute('aria-label')).not.toContain('Web fetch');
 indicator.focus();
 await expect.poll(()=>getComputedStyle(tooltip).opacity).toBe('1');
 expect(tooltip.textContent,'FOCUS_REASON_NAMES_UNRESOLVED_SOURCE').toContain('Workspace read');
 await userEvent.click(page.getByRole('button',{name:'Outside safety details'}));
 await userEvent.hover(indicator);
 await expect.poll(()=>getComputedStyle(tooltip).opacity).toBe('1');
 expect(tooltip.textContent,'HOVER_REASON_NAMES_UNRESOLVED_SOURCE').toContain('Workspace read');
 await userEvent.click(indicator);
 expect(document.querySelectorAll('[data-safety-trigger]')).toHaveLength(2);
 expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Marked safe by you');
});

for(const width of [320,1280])for(const theme of ['light','dark'])for(const mode of ['reviewed','unresolved','both'] as const)test(`${width} ${theme}: mixed trusted history keeps each verdict kind (${mode})`,async()=>{
 await scene(width,theme);const state=ui!.stores.safety.getState(),rows=Object.values(state.records).filter(r=>r.kind==='occurrence');expect(rows.length).toBeGreaterThanOrEqual(3);
 const at=Date.UTC(2026,6,12,10),hasReviewed=mode!=='unresolved',hasUnresolved=mode!=='reviewed';
 const base=(r:typeof rows[number])=>({...r,turnId:message.turnId!,entry:{kind:'tool' as const,toolUseId:'tool_a'},observedAt:at});
 const trusted={...base(rows[0]!),source:'web_fetch' as const,admission:{trusted:true as const,ruleId:'ithaca-source',policyHash:'a'.repeat(64),trustRevision:'7',collectionRevision:'3'}};
 const reviewed={...base(rows[1]!),source:'mcp_document' as const,admission:{trusted:false as const,policyHash:null,trustRevision:'0'}};
 const unresolved={...base(rows[2]!),source:'workspace_read' as const,admission:{trusted:false as const,policyHash:null,trustRevision:'0'}};
 const records:Record<string,SafetyRecord>={[trusted.id]:trusted};if(hasReviewed){records[reviewed.id]=reviewed;const identity=state.identity;if(!identity||!('sessionId' in identity))throw new Error('Missing session');records.mixed_verdict={id:'mixed_verdict',sequence:'999999',observedAt:at,turnId:message.turnId!,bindingId:reviewed.bindingId,occurrenceId:reviewed.id,detailPruned:false,kind:'safe_decision',session:identity,requestId:'mixed_request',principalId:'odysseus',verdict:'safe',channel:'owner_history'};}if(hasUnresolved)records[unresolved.id]=unresolved;
 flushSync(()=>ui!.stores.safety.setState({records,projection:{...state.projection!,unresolvedCount:hasUnresolved?1:0,earliestUnresolvedId:hasUnresolved?unresolved.id:null,restriction:hasUnresolved?'restricted':'normal',reasons:hasUnresolved?['unresolved']:[]},normal:!hasUnresolved&&state.projection?.coverage.state==='complete'}));
 const indicator=[...host!.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')].find(b=>b.getClientRects().length>0)!;expect(indicator).toBeTruthy();
 if(hasUnresolved)expect(indicator.getAttribute('aria-label'),'MIXED_GROUP_NAMES_ONLY_ITS_UNRESOLVED_SOURCE').toContain('Workspace read · Review one input at a time');
 if(hasReviewed)expect(indicator.getAttribute('aria-label'),'MIXED_HISTORY_NAMES_BOTH_TRUST_AND_HUMAN_VERDICT').toContain('1 marked safe by you');
 await userEvent.click(indicator);const panel=document.querySelector('[data-safety-details]')!;expect(panel.textContent).toContain('Trusted at admission');if(hasReviewed)expect(panel.textContent).toContain('Marked safe by you');
 const bounds=panel.getBoundingClientRect();expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(innerWidth);
});

for(const width of [320,1280])for(const theme of ['light','dark'])for(const tunnel of [false,true])test(`${width} ${theme}: IPv6 safety authority stays unambiguous (tunnel ${tunnel})`,async()=>{
 await scene(width,theme);const records={...ui!.stores.safety.getState().records};
 for(const [id,r] of Object.entries(records))if(r.kind==='occurrence')records[id]={...r,admission:{trusted:true,ruleId:'ithaca-source',policyHash:'a'.repeat(64),trustRevision:'7',collectionRevision:'3'},provenance:tunnel?{kind:'tunnel_authority',authority:{host:'::1',port:443},verifiedBy:'host_proxy'}:{kind:'web_origin',origin:{scheme:'http',host:'::1',port:8080},verifiedBy:'host_transport'}};
 flushSync(()=>ui!.stores.safety.setState({records}));const indicator=[...host!.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')].find(b=>b.getAttribute('aria-label')?.startsWith('Trusted at admission'))!;await userEvent.click(indicator);
 const expected=tunnel?'[::1]:443':'http://[::1]:8080';await expect.poll(()=>document.querySelector('[data-safety-details]')?.textContent,{message:'IPV6_HISTORY_BRACKETS_THE_EXACT_AUTHORITY'}).toContain(expected);
});

for(const width of [320,1280])for(const allow of [false,true])test(`${width}: future origin review, recipient ${allow}, exact bytes then A only and reload`,async()=>{
 await scene(width,'light');await patch({action:'add_verified'});
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(4);
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);
 const section=()=>[...document.querySelectorAll<HTMLElement>('[data-safety-trigger]')].find(e=>e.textContent?.includes('https://ithaca.invalid'))!;
 const mark=section().querySelector<HTMLElement>('[role=button],button')!;await userEvent.click(mark);
 const only=section().querySelector<HTMLInputElement>('input[type=radio]')!;expect(only.parentElement!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);expect(only.checked,'COMBINED_DEFAULT_ONLY_THIS_TRIGGER').toBe(true);
 await userEvent.click(page.getByRole('radio',{name:/Also trust future input from/}));
 const recipient=page.getByRole('checkbox',{name:'Allow sending data while restricted'});
 await expect.element(recipient).not.toBeChecked();
 if(allow)await userEvent.click(recipient);
 await userEvent.click(page.getByRole('button',{name:'Review future rule',exact:true}));
 await expect.element(page.getByRole('group',{name:'Exact future rule review'})).toBeVisible();
 expect(section().textContent).toContain('ithaca.invalid');expect((await patch()).commits).toBe(0);
 await userEvent.click(page.getByRole('button',{name:allow?'Save rule, allow sending while restricted, and mark this input safe':'Save future source rule and mark this input safe',exact:true}));
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(3);
 expect((await patch()).decisions).toHaveLength(1);
 expect(document.body.textContent).not.toContain('Normal policy restored');
 await disposeView();await view();
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);
 await expect.poll(()=>document.querySelector('[data-safety-details]')?.textContent).toContain('Future rule: present');
 expect((await patch()).commits,'COMBINED_RELOAD_STATUS_NEVER_REPLAYS').toBe(1);
});

async function futureReviewScene(width:number,partial=false){
 await scene(width,'light');await patch({action:'add_verified'});
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(4);
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);
 const section=()=>[...document.querySelectorAll<HTMLElement>('[data-safety-trigger]')].find(e=>e.textContent?.includes('https://ithaca.invalid'))!;
 await userEvent.click(section().querySelector<HTMLElement>('[role=button],button')!);
 await userEvent.click(page.getByRole('radio',{name:/Also trust future input from/}));
 await userEvent.click(page.getByRole('button',{name:'Review future rule',exact:true}));
 await expect.element(page.getByRole('group',{name:'Exact future rule review'})).toBeVisible();
 if(partial)await patch({action:'fail_combined_verdict'});
 await userEvent.click(page.getByRole('button',{name:'Save future source rule and mark this input safe',exact:true}));
 await expect.poll(()=>ui!.stores.safety.getState().status).toBe('ready');
 return section;
}
for(const width of [320,1280])test(`${width} review F3: focus refresh replaces commit-time rule presence`,async()=>{
 const section=await futureReviewScene(width);
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(3);
 await expect.poll(()=>section().textContent).toContain('Future rule: present');
 await patch({action:'remove_future_rule'});window.dispatchEvent(new Event('focus'));
 await expect.poll(()=>section().textContent).toContain('Future rule: removed');
 expect(section().textContent,'F3_NO_STALE_COMMIT_TIME_PRESENCE').not.toContain('currently present');
 expect(section().textContent).not.toContain('Future rule: present');
});
for(const width of [320,1280])test(`${width} review F4: partial operation is distinct from another tab's safe verdict`,async()=>{
 const section=await futureReviewScene(width,true);
 await expect.poll(()=>section().textContent).toContain('Rule publication proved');
 await patch({action:'individual_safe'});
 await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(3);
 window.dispatchEvent(new Event('focus'));
 await expect.poll(()=>section().textContent).toContain('Marked safe by you');
 expect(section().textContent,'F4_PARTIAL_RECEIPT_IS_NOT_CURRENT_TRIGGER_STATE').not.toContain('this input is still unresolved');
 expect(section().textContent).not.toContain('this input remains unresolved');
});

for(const width of [320,1280])for(const older of ['success','error'] as const)test(`${width} matrix CS-O ${older}: an older focus response cannot overwrite newer revocation`,async()=>{
 const section=await futureReviewScene(width);
 await expect.poll(()=>section().textContent).toContain('Future rule: present');
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),returned=Promise.withResolvers<void>();let held=false;
 const occurrenceId=section().dataset.safetyTrigger;
 statusBarrier=async body=>{if(!held&&body.occurrenceId===occurrenceId){held=true;entered.resolve();await release.promise;returned.resolve();if(older==='error')throw new Error('Older status read failed');}};
 try{
 window.dispatchEvent(new Event('focus'));await entered.promise;
 await patch({action:'remove_future_rule'});window.dispatchEvent(new Event('focus'));
 await expect.poll(()=>section().textContent).toContain('Future rule: removed');
 release.resolve();await returned.promise;
 // The transport already holds a complete JSON body; drain its promise chain
 // and React's render frames after releasing the deliberately older response.
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 expect(section().textContent,'R2F2_LATE_PRESENT_CANNOT_OVERWRITE_REMOVED').toContain('Future rule: removed');
 expect(section().textContent).not.toContain('Future rule: present');
 }finally{release.resolve();statusBarrier=undefined;}
});

for(const width of [320,1280])test(`${width} matrix CS-F initial / CS-R recovery: failed first read of a partial operation is not JSON null (round 3 F3)`,async()=>{
 const old=await futureReviewScene(width,true);await expect.poll(()=>old().textContent).toContain('Rule publication proved');
 const target=old().dataset.safetyTrigger;await disposeView();await view();
 const entered=Promise.withResolvers<void>();statusBarrier=async body=>{if(body.occurrenceId===target){entered.resolve();throw new Error('Controlled first status-read loss');}};
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);await entered.promise;
 const section=()=>document.querySelector<HTMLElement>(`[data-safety-trigger="${target}"]`)!;
 await expect.poll(()=>section().textContent).toContain('Could not verify');
 expect(section().textContent).not.toContain('Future rule: present');expect(ui!.stores.safety.getState().projection?.unresolvedCount).toBe(4);
 statusBarrier=undefined;window.dispatchEvent(new Event('focus'));
 await expect.poll(()=>section().textContent).toContain('Future rule: present');expect(section().textContent).not.toContain('Could not verify');
});
for(const width of [320,1280])test(`${width} matrix CS-M: a status response for another target cannot set presence`,async()=>{
 const old=await futureReviewScene(width,true);await expect.poll(()=>old().textContent).toContain('Rule publication proved');
 const target=old().dataset.safetyTrigger;await disposeView();await view();
 statusBarrier=async(body,result)=>{if(body.occurrenceId===target)result.body={...(result.body as Record<string,unknown>),occurrenceId:'wrong_occurrence'};};
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);
 const section=()=>document.querySelector<HTMLElement>(`[data-safety-trigger="${target}"]`)!;
 await expect.poll(()=>section().textContent).toContain('Could not verify');expect(section().textContent).not.toContain('Future rule: present');
});

for(const width of [320,1280])test(`${width} matrix CS-F later / CS-E: expired receipt null clears display without hiding read failure`,async()=>{
 const section=await futureReviewScene(width,true);await expect.poll(()=>section().textContent).toContain('Future rule: present');
 const target=section().dataset.safetyTrigger;
 statusBarrier=async body=>{if(body.occurrenceId===target)throw new Error('Later read failed');};window.dispatchEvent(new Event('focus'));
 await expect.poll(()=>section().textContent).toContain('Could not verify');
 await patch({action:'expire_future_receipts'});statusBarrier=undefined;window.dispatchEvent(new Event('focus'));
 await expect.poll(()=>section().textContent).not.toContain('Could not verify');expect(section().textContent).not.toContain('Future rule:');expect(ui!.stores.safety.getState().projection?.unresolvedCount).toBe(4);
});

for(const future of [false,true])test(`fable F1 browser: ${future?'combined':'individual'} live update precedes commit response`,async()=>{
 await page.viewport(320,900);fixture=await commands.safetyServer({op:'start'}) as typeof fixture;await view();
 await patch({action:'add_verified'});await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(4);
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);
 const section=()=>[...document.querySelectorAll<HTMLElement>('[data-safety-trigger]')].find(e=>e.textContent?.includes('https://ithaca.invalid'))!;
 let responseObserved=false;
 commitBarrier=async result=>{
  const receipt=result.body as {stage?:string;receipt?:{stage:string};currentProjection:{evidenceRevision:string}};
  expect(result.status).toBe(200);expect(receipt.stage??receipt.receipt?.stage).toBe('verdict_committed');
  await expect.poll(()=>ui!.stores.safety.getState().revision,{timeout:watchdogMs(5000)}).toBe(receipt.currentProjection.evidenceRevision);
  responseObserved=true;
 };
 await userEvent.click(section().querySelector<HTMLElement>('[role=button],button')!);
 if(future){await userEvent.click(page.getByRole('radio',{name:/Also trust future input from/}));await userEvent.click(page.getByRole('button',{name:'Review future rule',exact:true}));await expect.element(page.getByRole('group',{name:'Exact future rule review'})).toBeVisible();await userEvent.click(page.getByRole('button',{name:'Save future source rule and mark this input safe',exact:true}));}
 else await userEvent.click(page.getByRole('button',{name:'Mark this input as safe',exact:true}));
 // Protected publication and response delivery have no one-second product deadline.
 // First await the real committed response with its own live update observed;
 // then await React's acknowledgement. Both are bounded hang watchdogs.
 await expect.poll(()=>responseObserved,{timeout:watchdogMs(5000)}).toBe(true);
 await expect.poll(()=>section().textContent,{timeout:watchdogMs(5000)}).toContain(future?'This operation recorded a safe verdict':'Decision recorded');expect(section().textContent).not.toContain('Review cancelled');
},watchdogMs(20000));
test('fable F2 browser: cancel future preparation then individual review remains Decision recorded',async()=>{
 await page.viewport(320,900);fixture=await commands.safetyServer({op:'start'}) as typeof fixture;await view();await patch({action:'add_verified'});await expect.poll(()=>ui!.stores.safety.getState().projection?.unresolvedCount).toBe(4);
 await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-safety-turn-event] button')!);
 const section=()=>[...document.querySelectorAll<HTMLElement>('[data-safety-trigger]')].find(e=>e.textContent?.includes('https://ithaca.invalid'))!;
 await userEvent.click(section().querySelector<HTMLElement>('[role=button],button')!);await userEvent.click(page.getByRole('radio',{name:/Also trust future input from/}));await userEvent.click(page.getByRole('button',{name:'Review future rule',exact:true}));await expect.element(page.getByRole('group',{name:'Exact future rule review'})).toBeVisible();await userEvent.click(page.getByRole('button',{name:'Cancel future rule review',exact:true}));
 await userEvent.click(section().querySelector<HTMLElement>('[role=button],button')!);await userEvent.click(page.getByRole('radio',{name:'Only this input',exact:true}));await userEvent.click(page.getByRole('button',{name:'Mark this input as safe',exact:true}));
 await expect.poll(()=>section().textContent).toContain('Decision recorded');ui!.stores.safety.getState().refresh();await expect.poll(()=>ui!.stores.safety.getState().status).toBe('ready');expect(section().textContent).not.toContain('No decision was sent');
});
