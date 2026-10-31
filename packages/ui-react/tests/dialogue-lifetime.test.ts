import {expect,test} from "bun:test";
import {createBrainUiRoot} from "../src/root.js";

test("a changed principal clears durable and unsaved dialogue with its old capture identities",()=>{
 const root=createBrainUiRoot({storage:null});try{
  const client=root.connection.conversation;
  client.frame({type:"server_hello",protocolRev:5,principalKey:"odysseus",capabilities:{sessionDialogue:true}});
  client.state.setState({recognition:[{kind:"unassigned_input_fragment",sequence:0,text:"Private unsaved mast note.",conversationId:"mast",epoch:1,providerId:"gpt-live",sessionId:"ithaca",activation:1,contextual:true,unsaved:true}],outputs:[{conversationId:"mast",epoch:1,providerId:"gpt-live",sessionId:"ithaca",outputId:"reply",generated:"",unsavedGenerated:"Private unsaved reply.",unsavedFragments:1,playback:"unknown"}],dialogue:{ithaca:{ownerId:"mast",sessionId:"ithaca",generation:1,coverage:"partial",through:0,records:[]}}});
  client.frame({type:"server_hello",protocolRev:5,principalKey:"penelope",capabilities:{sessionDialogue:true}});
  expect(client.state.getState().recognition,"PRINCIPAL_CHANGE_DROPS_UNSAVED").toEqual([]);
  expect(client.state.getState().outputs).toEqual([]);expect(client.state.getState().dialogue).toEqual({});
  expect(client.state.getState().profile).toBeNull();expect(client.state.getState().active).toBe(false);
 }finally{root.dispose();}
});
