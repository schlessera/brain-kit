/// <reference types="@vitest/browser-playwright" />
import {afterAll,afterEach,beforeAll,expect,test} from 'vitest';
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
import type {ClientMessage,SafetyPage} from '@schlessera/brain-ui-sdk/protocol';
let fixture:{id:string;url:string}|undefined,ui:BrainUiRoot|undefined,socket:WebSocket|undefined,renderer:Root|undefined,host:HTMLDivElement|undefined;
let safetyClient:ReturnType<typeof createSafetyClient>|undefined;
let styles:HTMLStyleElement;const oldTheme=document.documentElement.dataset.theme,viewport={width:innerWidth,height:innerHeight};
beforeAll(async()=>{styles=document.createElement('style');styles.textContent=await commands.formConsumerStyles();document.head.append(styles);});
afterAll(async()=>{styles.remove();await page.viewport(viewport.width,viewport.height);});
async function disposeView(){safetyClient?.dispose();safetyClient=undefined;if(renderer)flushSync(()=>renderer!.unmount());renderer=undefined;ui?.dispose();ui=undefined;socket?.close();socket=undefined;host?.remove();host=undefined;}
afterEach(async()=>{await disposeView();if(fixture)await commands.safetyServer({op:'stop',id:fixture.id});fixture=undefined;if(oldTheme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=oldTheme;});
const patch=(patch:Record<string,unknown>={})=>commands.safetyServer({op:'set',id:fixture!.id,patch}) as Promise<{page:SafetyPage;commits:number;prepares:number;decisions:Array<{occurrence_id:string}>}>;
const noop=()=>{};
const message:ChatMessage={id:'odysseus-answer',turnId:'voyage',role:'assistant',content:'Voyage notes retained.',isStreaming:false,timestamp:Date.UTC(2026,6,12,10),
 toolCalls:[{id:'tool_a',name:'WebFetch',inputJson:'{}',input:{url:'https://example.com/odyssey'},output:'Odysseus voyage notes',status:'complete'},{id:'tool_c',name:'WebFetch',inputJson:'{}',input:{url:'https://example.com/odyssey'},output:'Penelope voyage notes',status:'complete'}],
 parts:[{kind:'tool',toolIndex:0},{kind:'tool',toolIndex:1},{kind:'text',text:'Voyage notes retained.'}]};
async function view(){
 const f=fixture!;
 ui=createBrainUiRoot({storage:null,config:{backendUrl:f.url},request:async(url,init)=>{
  if(!String(url).includes('/safety/reviews/'))return Response.json({providers:[]});
  const result=await patch({action:'request',path:new URL(url).pathname,body:init?.body}) as unknown as {status:number;body:unknown};
  if(init?.signal?.aborted)throw new DOMException('Aborted','AbortError');return Response.json(result.body,{status:result.status});
 }});
 const frames:unknown[]=[],sent:unknown[]=[];const current=ui;current.stores.chat.setState({activeSessionId:'ithaca',buffers:{ithaca:{messages:[message],isStreaming:false,askUser:null,lastTouched:message.timestamp}}});
 current.stores.connection.getState().setWsStatus('connected');
 socket=new WebSocket(f.url.replace('http:','ws:')+'/ws');const ws=socket;
 current.connection.send=(m:ClientMessage)=>{sent.push(m);if(ws.readyState!==WebSocket.OPEN)return false;ws.send(JSON.stringify(m));return true;};
 const client=safetyClient=createSafetyClient(current,m=>{sent.push(m);if(socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(m));return true;});
 ws.onopen=()=>ws.send(JSON.stringify({type:'client_hello',protocolRev:5,capabilities:{sessionSafetyHistory:true,chatDeletion:true}}));
 ws.onmessage=e=>{frames.push(JSON.parse(String(e.data)));const parsed=parseServerMessage(String(e.data));if(!parsed.ok)throw new Error(parsed.error);client.frame(parsed.message);};
 host=document.createElement('div');host.style.maxWidth='100%';document.body.append(host);renderer=createRoot(host);
 flushSync(()=>renderer!.render(<BrainUiProvider root={current}><button type="button">Outside safety details</button><SessionSafety/><MessageBubble message={message} journalVisible={false} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>));
 try{await expect.poll(()=>current.stores.safety.getState().status,{timeout:5000}).toBe('ready');}catch(error){throw new Error(`${String(error)} Frames:${JSON.stringify(frames)} Sent:${JSON.stringify(sent)} Safety:${JSON.stringify(current.stores.safety.getState())} Session:${current.stores.chat.getState().activeSessionId}`);}
}
async function scene(width:number,theme:string){await page.viewport(width,900);document.documentElement.dataset.theme=theme;fixture=await commands.safetyServer({op:'start'}) as typeof fixture;await view();}
function buttonForTool(){const all=[...host!.querySelectorAll<HTMLButtonElement>('[data-safety-indicator] button')];return all.find(b=>b.getAttribute('aria-label')?.includes('2 unresolved'))!;}

for(const width of [320,1280])for(const theme of ['light','dark'])test(`${width} ${theme}: collapsed counts, native touch, exact scope, A/B/C and reload`,async()=>{
 await scene(width,theme);
 expect(host!.textContent,'OPAQUE_TRAFFIC_HAS_OWN_NAMED_TURN_EVENT').toContain('Network input; tool attribution unavailable');
 const indicator=buttonForTool();expect(indicator,'COLLAPSED_RUN_RETAINS_BOTH_TRIGGERS').toBeTruthy();
 const box=indicator.getBoundingClientRect();expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
 indicator.focus();await expect.poll(()=>getComputedStyle(indicator.parentElement!.querySelector('[role=tooltip]')!).opacity).toBe('1');
 const tooltipLayer=getComputedStyle(indicator.parentElement!.querySelector('[role=tooltip]')!).zIndex;
 await commands.rankTap({x:box.x+box.width/2,y:box.y+box.height/2});
 const panel=page.getByRole('dialog',{name:'Safety trigger details'});await expect.element(panel).toBeVisible();
 const popoverLayer=getComputedStyle(document.documentElement).getPropertyValue('--bk-z-popover').trim();expect(popoverLayer).not.toBe('');
 expect({tooltip:tooltipLayer,details:getComputedStyle(document.querySelector('[data-safety-details]')!).zIndex},'SAFETY_SURFACES_USE_NAMED_POPOVER_LAYER').toEqual({tooltip:popoverLayer,details:popoverLayer});
 expect(indicator.getAttribute('aria-expanded')).toBe('true');expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Source provenance unavailable');
 await userEvent.click(page.getByRole('button',{name:'Mark as safe',exact:true}).first());
 expect(document.querySelector('[data-safety-details]')!.textContent).toContain('Only this trigger');
 expect(document.querySelector('[data-safety-details]')!.textContent).not.toMatch(/trust this origin|future repositories|Verified safe/i);
 await userEvent.click(page.getByRole('button',{name:'Mark this trigger as safe',exact:true}));
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
  await userEvent.click(page.getByRole('button',{name:'Mark this trigger as safe',exact:true}));
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
 await userEvent.click(buttonForTool());const panel=page.getByRole('dialog',{name:'Safety trigger details'});await expect.element(panel).toBeVisible();
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
 expect(document.querySelector('[data-safety-details]')!.textContent).not.toContain('Mark this trigger as safe');
 socket=new WebSocket(fixture!.url.replace('http:','ws:')+'/ws');const next=socket;
 next.onopen=()=>next.send(JSON.stringify({type:'client_hello',protocolRev:5,capabilities:{sessionSafetyHistory:true,chatDeletion:true}}));
 next.onmessage=e=>{const parsed=parseServerMessage(String(e.data));if(!parsed.ok)throw new Error(parsed.error);client.frame(parsed.message);};
 await expect.poll(()=>current.stores.safety.getState().status,{timeout:5000}).toBe('ready');
 expect(notice.getBoundingClientRect().height,'REPLAY_RETAINS_NOTICE_HEIGHT').toBe(before.height);
 expect(indicator.isConnected,'REPLAY_RETAINS_ORIGINAL_INDICATOR_NODE').toBe(true);
 expect(document.querySelector('[data-safety-details]')!.textContent,'RECONNECT_DISCARDS_UNSUBMITTED_SCOPE_CHOICE').not.toContain('Mark this trigger as safe');
 expect((await patch()).commits,'RECONNECT_DOES_NOT_SEND_A_DECISION').toBe(0);
});
