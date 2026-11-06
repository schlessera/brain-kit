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
