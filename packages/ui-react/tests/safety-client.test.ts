import { expect,test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createSafetyStore } from "../src/stores/safety-state";
import { createSafetyClient } from "../src/lib/safety-client";
import type { BrainUiServices } from "../src/root";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";

test("an old host receives no safety read or unsubscribe frames and remains explicitly unavailable",()=>{
  for(const id of [null,"ithaca"]){
    const chat=createStore<{activeSessionId:string|null}>(()=>({activeSessionId:id})),safety=createSafetyStore(),sent:ClientMessage[]=[];
    const root={stores:{chat,safety}} as unknown as BrainUiServices;
    const client=createSafetyClient(root,message=>{sent.push(message);return true;});
    try{
      client.frame({type:"server_hello",protocolRev:2,capabilities:{multiSession:true}});
      expect(safety.getState().status,"OLD_HOST_SAFETY_UNAVAILABLE").toBe("unavailable");expect(safety.getState().normal).toBe(false);
      expect(sent,"OLD_HOST_RECEIVES_NO_UNKNOWN_SAFETY_FRAME").toEqual([]);
      chat.setState({activeSessionId:"troy"});client.refresh();expect(sent).toEqual([]);
    }finally{client.dispose();}
  }
});

test('entry correlation is requested only after the independent host capability',()=>{
 for(const entries of [false,true]){
  const chat=createStore<{activeSessionId:string|null}>(()=>({activeSessionId:'ithaca'})),safety=createSafetyStore(),sent:ClientMessage[]=[];
  const root={stores:{chat,safety}} as unknown as BrainUiServices,client=createSafetyClient(root,m=>{sent.push(m);return true;});
  try{
   client.frame({type:'server_hello',protocolRev:5,capabilities:{sessionSafetyHistory:true,...(entries?{sessionSafetyEntryCorrelation:true}:{})},safetyCapabilities:{version:1,read:true,review:false,originRules:false,repositoryRules:false,recipientRules:false,readOnlyReason:'owner_required',detectorVersion:1,limits:{pageRecords:100,frameBytes:262144,cursorBytes:512,cursorLifetimeMs:300000}}});
   const read=sent.find(m=>m.type==='safety_read');expect(read?.type).toBe('safety_read');
   if(entries)expect(read).toHaveProperty('includeEntries',true);else expect(read,'OLD_HOST_NEVER_RECEIVES_UNKNOWN_READ_FIELD').not.toHaveProperty('includeEntries');
   expect(safety.getState().capabilities?.review).toBe(false);
   safety.getState().refresh();expect(sent.filter(m=>m.type==='safety_read')).toHaveLength(2);expect(sent.every(m=>!m.type.includes('review'))).toBe(true);
  }finally{client.dispose();}
 }
});
