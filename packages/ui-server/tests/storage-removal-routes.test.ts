import { expect, test } from "bun:test";
import { httpContractApp } from "./helpers/http-contract-app";

test("attachment removal exposes an owner capability without deleting on read", async () => {
  const fixture = await httpContractApp();
  try {
    const response = await fixture.fetch("/api/storage/removals");
    expect(response.status, "STORAGE_REMOVAL_OWNER_ROUTE").toBe(200);
    expect(await response.json()).toHaveProperty("available");
  } finally { await fixture.close(); }
});

test("mounted removal enforces human authority, origin, exact review and durable native-worker readback",async()=>{
  const {generateSignedCookie}=await import("hono/cookie"),{createPrincipal}=await import("../src/db/principals"),{mkdirSync,writeFileSync,readFileSync,existsSync}=await import("node:fs"),{join}=await import("node:path");
  const secret="odysseus-removal-route-secret-0123456789",f=await httpContractApp({env:{AUTH_MODE:"password",BRAIN_UI_PASSWORD_HASH:"unused-fixture-hash",COOKIE_SECRET:secret,BRAIN_UI_ALLOW_LOOPBACK_ORIGIN:"1"}});
  try{
    const owner=createPrincipal(f.app.db,{authMethod:"password",label:"Odysseus",ttlSeconds:3600}),agent=createPrincipal(f.app.db,{authMethod:"delegated",createdBy:owner.id,label:"Athena",ttlSeconds:3600}),other=createPrincipal(f.app.db,{authMethod:"password",label:"Penelope",ttlSeconds:3600});
    const cookie=async(id:string)=>(await generateSignedCookie("brain_ui_session",id,secret)).split(";")[0]!,ownerCookie=await cookie(owner.id),agentCookie=await cookie(agent.id),otherCookie=await cookie(other.id);
    const request={id:"odysseus-route-removal",paths:["attachments/chart.pdf"]};
    for(const [method,path] of [["GET","/api/storage/removals"],["GET","/api/storage/removals/missing"],["POST","/api/storage/removals/reviews"],["POST","/api/storage/removals/undo-reviews"],["POST","/api/storage/removals"],["DELETE","/api/storage/removals/missing"]]){
      const init={method,headers:{cookie:agentCookie,"content-type":"application/json"},...(method==="POST"?{body:JSON.stringify(request)}:{})};
      expect((await f.fetch(path!,init)).status,"STORAGE_REMOVAL_AGENT_DENIED").toBe(403);
      expect((await f.fetch(path!,{...init,headers:{"content-type":"application/json"}})).status).toBe(401);
    }
    const post=(path:string,body:unknown,headers:Record<string,string>={})=>f.fetch(path,{method:"POST",headers:{cookie:ownerCookie,"content-type":"application/json",...headers},body:JSON.stringify(body)});
    expect((await post("/api/storage/removals/reviews",{...request,root:"/"})).status).toBe(400);
    expect((await post("/api/storage/removals/reviews",request,{origin:"https://troy.example"})).status).toBe(403);
    expect((await post("/api/storage/removals/reviews",request,{"content-type":"text/plain"})).status).toBe(415);
    expect((await post("/api/storage/removals/reviews",{...request,extra:"x".repeat(141000)})).status).toBe(413);
    mkdirSync(join(f.brainPath,"attachments"));const original=Buffer.from([37,80,68,70,0,255,13]);writeFileSync(join(f.brainPath,request.paths[0]!),original);writeFileSync(join(f.brainPath,"notes/arrival.md"),"[Harbor](../attachments/chart.pdf)\n");
    writeFileSync(join(f.brainPath,"attachments/keep.pdf"),"Penelope's unselected original");
    writeFileSync(join(f.brainPath,"brain.config.ts"),'import {rmSync} from "node:fs";rmSync(process.env.BRAIN_WORKER_DATA_ROOT+"/attachments/keep.pdf");export default {};\n');
    const reviewed=await post("/api/storage/removals/reviews",request),review=await reviewed.json();
    expect(reviewed.status,JSON.stringify(review)).toBe(200);
    expect(review.review.files[0],"STORAGE_HTTP_CURRENT_NATIVE_REFERENCE").toMatchObject({eligible:true,references:[{source:"notes/arrival.md",certainty:"resolved"}]});
    expect((await post("/api/storage/removals",{id:request.id,fingerprint:"a".repeat(64)})).status).toBe(409);
    const confirmed={id:request.id,fingerprint:review.review.fingerprint};expect((await post("/api/storage/removals",confirmed)).status).toBe(202);
    let result:any;
    for(let i=0;i<300;i++){const response=await f.fetch(`/api/storage/removals/${request.id}`,{headers:{cookie:ownerCookie}});expect(response.status).toBe(200);result=await response.json();if(!["waiting","running"].includes(result.state))break;await Bun.sleep(20);}
    expect(result,JSON.stringify(result)).toMatchObject({state:"complete",items:[{state:"removed",undoAvailable:true}]});
    expect(existsSync(join(f.brainPath,request.paths[0]!))).toBe(false);
    expect(existsSync(join(f.brainPath,"attachments/keep.pdf")),"STORAGE_INDEX_REFRESH_CANNOT_PUBLISH_UNSELECTED_REMOVAL").toBe(true);
    expect(readFileSync(join(f.brainPath,"attachments/keep.pdf"),"utf8")).toBe("Penelope's unselected original");
    expect(result.index).toBe("complete");expect(existsSync(join(f.brainPath,"brain.db"))).toBe(true);
    expect(readFileSync(join(f.brainPath,"notes/arrival.md"),"utf8")).toContain("attachments/chart.pdf");
    expect(await(await post("/api/storage/removals",confirmed)).json(),"STORAGE_HTTP_LOST_RESPONSE_READBACK").toEqual(result);
    expect((await f.fetch(`/api/storage/removals/${request.id}`,{headers:{cookie:otherCookie}})).status).toBe(404);
    f.app.db.query("UPDATE principals SET revoked_at=? WHERE id=?").run(Date.now(),owner.id);
    expect((await post("/api/storage/removals",confirmed)).status).toBe(401);
  }finally{await f.close();}
});
