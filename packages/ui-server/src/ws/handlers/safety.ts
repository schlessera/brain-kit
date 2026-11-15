import { SafetyReadUnavailable } from "../../governance/safety-history.js";
import type { ClientMessageHandler } from "./context.js";

export const handleSafetyRead:ClientMessageHandler<"safety_read">=async({host,ws,connection},msg)=>{
  const live=()=>!connection.closed&&connection.authorization.valid&&host.isPrincipalValid(connection.principal);
  if(!connection.capabilities?.sessionSafetyHistory||!live())return;
  try{
    if(!host.safetyHistory)throw new SafetyReadUnavailable();
    const page=await host.safetyHistory.read(connection.principal,msg.target,msg.cursor??null,msg.limit,msg.includeEntries===true);
    host.safetyHistory.delivery(connection.principal,page.identity,page.snapshotId);
    if(live())host.sendMessage(ws,{type:"safety_history",requestId:msg.requestId,page});
  }catch(error){if(live())host.sendMessage(ws,{type:"safety_unavailable",requestId:msg.requestId,version:1,reason:error instanceof SafetyReadUnavailable?error.reason:"unavailable"});}
};
export const handleSafetySubscribe:ClientMessageHandler<"safety_subscribe">=({host,ws,connection},msg)=>{
  const live=()=>!connection.closed&&connection.authorization.valid&&host.isPrincipalValid(connection.principal)&&connection.capabilities?.sessionSafetyHistory===true;
  if(!live())return;
  try{
    if(!host.safetyHistory)throw new SafetyReadUnavailable();
    host.safetyHistory.subscribe((ws.raw??ws) as object,connection.principal,msg.identity,msg.afterRevision,msg.snapshotId,live,value=>{
      if(!live())return;
      host.sendMessage(ws,"fromRevision" in value?{type:"safety_update",update:value}:{type:"safety_unavailable",version:1,reason:value.reason,requestId:msg.requestId});
    });
  }catch(error){if(live())host.sendMessage(ws,{type:"safety_unavailable",version:1,requestId:msg.requestId,reason:error instanceof SafetyReadUnavailable?error.reason:"unavailable"});}
};
export const handleSafetyUnsubscribe:ClientMessageHandler<"safety_unsubscribe">=({host,ws})=>host.safetyHistory?.unsubscribe((ws.raw??ws) as object);
