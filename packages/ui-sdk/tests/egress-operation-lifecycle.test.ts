import { expect,test } from 'bun:test';
import { createEgressOperation,type EgressOperationState,type EgressOperationTerminal } from '../src/server/egress-operation';
const states:EgressOperationState[]=['pending','admitted','dispatched','finished','aborted'];
for(const initial of states)for(const event of ['approval wait','DNS wait','client close','concurrent budget exhaustion'])test(`lifecycle: ${event} at ${initial}`,async()=>{
 const rows:EgressOperationTerminal[]=[],order:string[]=[];let effects=0,dispatches=0;
 const op=createEgressOperation({decide:()=>{order.push('decide');},abort:()=>{order.push('abort');},observe:t=>{rows.push(t);order.push('observe');}});
 if(initial!=='pending'&&initial!=='aborted')expect(await op.admit(async()=>true)).toBe(true);
 if(initial==='dispatched'||initial==='finished')expect(op.dispatch(8,()=>true,()=>{},()=>{dispatches++;})).toBe(true);
 if(initial==='finished')op.finish('completed');if(initial==='aborted')op.finish('cancelled','client_disconnected');
 expect(op.state()).toBe(initial);
 if(event==='client close'){
  op.finish('cancelled','client_disconnected');expect(await op.admit(async()=>{effects++;return true;})).toBe(false);expect(await op.effect(()=>{effects++;})).toBe(false);expect(op.dispatch(8,()=>true,()=>{},()=>{dispatches++;})).toBe(false);expect(effects).toBe(0);expect(op.state()).toBe(initial==='finished'?'finished':'aborted');
 }else if(event==='concurrent budget exhaustion'){
  const sent=op.dispatch(0,()=>true,()=>{},()=>{dispatches++;});expect(sent).toBe(initial==='dispatched');
  expect(op.sendRefusal(0,0)).toBe(initial==='dispatched'?undefined:'turn_cancelled');
  expect(op.state()).toBe(initial==='finished'?'finished':initial==='dispatched'?'dispatched':'aborted');
 }else{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let started=0;
  const pending=op.admit(async()=>{started++;await gate;return op.effect(()=>{effects++;});});
  if(initial==='pending'){expect(started).toBe(1);op.finish('cancelled','client_disconnected');release();expect(await pending).toBe(false);expect(effects,'RESUMED_WAIT_HAS_NO_EFFECT_AFTER_ABORT').toBe(0);}
  else{release();expect(await pending).toBe(initial==='admitted'||initial==='dispatched');expect(started,'ADMISSION_IS_SINGLE_OWNER_AND_NEVER_RESTARTS').toBe(0);}
 }
 expect(dispatches).toBe(initial==='dispatched'||initial==='finished'?1:0);op.finish('cancelled','client_disconnected');op.finish('failed','proxy_error');await op.settled();expect(rows).toHaveLength(1);expect(order).toEqual(['decide','abort','observe']);
});

test('lifecycle: terminal observation joins an in-flight admission effect and releases once',async()=>{
 let release!:()=>void,entered!:()=>void,open=false;const gate=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{entered=r;});const rows:EgressOperationTerminal[]=[];
 const op=createEgressOperation({decide(){},abort(){},observe:t=>{expect(open).toBe(true);open=false;rows.push(t);}});
 const pending=op.admit(()=>op.effect(async()=>{entered();await gate;open=true;}));await reached;op.finish('cancelled','client_disconnected');expect(rows).toHaveLength(0);let settled=false;const closing=op.settled().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();expect(await pending).toBe(false);await closing;expect(open).toBe(false);expect(rows).toHaveLength(1);expect(await op.effect(()=>{open=true;})).toBe(false);
});

test('lifecycle: concurrent admissions share the same guarded transition',async()=>{
 let release!:()=>void,effects=0;const gate=new Promise<void>(r=>{release=r;});const op=createEgressOperation({decide(){},abort(){},observe(){}});
 const first=op.admit(async()=>{effects++;await gate;return true;}),second=op.admit(async()=>{effects++;return true;});expect(first).toBe(second);release();expect(await first).toBe(true);expect(op.state()).toBe('admitted');expect(effects).toBe(1);expect(op.sendRefusal(0,0)).toBe('max_bytes_per_turn');expect(op.dispatch(0,()=>true,()=>{throw new Error('No dispatch');})).toBe(false);expect(op.state()).toBe('aborted');
});


test('lifecycle: a declined admission cannot remain live and pending',async()=>{
 const rows:EgressOperationTerminal[]=[];const op=createEgressOperation({decide(){},abort(){},observe:t=>{rows.push(t);}});
 expect(await op.admit(async()=>false)).toBe(false);expect(op.state()).toBe('aborted');expect(rows).toEqual([{outcome:'denied',reason:'call_not_admitted',dispatched:false}]);
});

test('lifecycle: terminal cleanup releases every owner once before abort, including a throwing release',()=>{
 const order:string[]=[];const op=createEgressOperation({decide:()=>{order.push('decide');},abort:()=>{order.push('abort');},observe:()=>{order.push('observe');}});
 op.ownCleanup(()=>{order.push('first');});op.ownCleanup(()=>{order.push('throw');throw new Error('Odysseus release failed');});op.ownCleanup(()=>{order.push('last');});op.finish('denied','call_not_admitted');op.finish('failed','proxy_error');op.ownCleanup(()=>{order.push('late');});expect(order).toEqual(['decide','first','throw','last','abort','observe','late']);
});

test('review22: final fence precedes send, dispatched state and notification',async()=>{
 const order:string[]=[],rows:EgressOperationTerminal[]=[];const op=createEgressOperation({decide(){},abort(){},observe:r=>rows.push(r)});expect(await op.admit(async()=>true)).toBe(true);op.prepare(()=>{order.push('prepare');});
 expect(op.dispatch(8,()=>{expect(op.dispatched(),'NO_DISPATCH_FACT_BEFORE_FINAL_FENCE').toBe(false);order.push('fence');return true;},()=>{expect(op.dispatched()).toBe(false);order.push('send');},()=>{expect(op.dispatched()).toBe(true);order.push('notify');})).toBe(true);op.finish('failed','upstream_unreachable');expect(order).toEqual(['prepare','fence','send','notify']);expect(rows).toMatchObject([{dispatched:true,outcome:'failed'}]);
});

test('review25: a synchronous handoff failure leaves classification to its caller',async()=>{
 const rows:EgressOperationTerminal[]=[];let grants=0;const op=createEgressOperation({decide(){},abort(){},observe:r=>rows.push(r)});expect(await op.admit(async()=>true)).toBe(true);expect(()=>op.dispatch(8,()=>true,()=>{throw new Error('Odysseus transport unavailable');},()=>{grants++;})).toThrow('Upstream transport handoff failed');expect(op.state(),'TRANSPORT_THROW_CANNOT_PREEMPT_CALLER_CLASSIFICATION').toBe('admitted');expect(rows).toEqual([]);expect(grants,'THROW_BEFORE_RETURN_PUBLISHES_NO_GRANT').toBe(0);op.finish('failed','upstream_unreachable');expect(rows).toEqual([{outcome:'failed',reason:'upstream_unreachable',dispatched:false}]);
});
