import {expect,test} from "bun:test";
import type {Page} from "playwright";
import {zeroRequestReplay} from "../packages/ui-kit/tests/visual/zero-request-replay";
test("inline replay refuses routed HTTP, websocket and service-worker-visible request events",async()=>{
  for(const kind of ["request","route","websocket","routeWebSocket"]){
    const events=new Map<string,(value:any)=>unknown>();let aborted=false,closed=false;
    const page={on:(name:string,fn:(value:any)=>unknown)=>events.set(name,fn),route:async(_pattern:string,fn:(value:any)=>unknown)=>events.set("route",fn),routeWebSocket:async(_pattern:string,fn:(value:any)=>unknown)=>events.set("routeWebSocket",fn)};
    const replay=await zeroRequestReplay(page as unknown as Page);expect(()=>replay.assert("before")).not.toThrow();
    const url="http://127.0.0.1/odysseus-replay-probe.css";
    await events.get(kind)!({url:()=>url,request:()=>({url:()=>url}),abort:async()=>{aborted=true;},close:()=>{closed=true;}});
    expect(()=>replay.assert("after")).toThrow(`Ghost replay attempted resource load (after): ${url}`);
    if(kind==="route")expect(aborted).toBe(true);if(kind==="routeWebSocket")expect(closed).toBe(true);
  }
});
