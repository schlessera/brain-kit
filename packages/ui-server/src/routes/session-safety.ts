import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import { SafetyHistory, SafetyReadUnavailable } from "../governance/safety-history.js";

/** Authenticated read only; retirement and live auth rechecked at delivery. */
export function createSessionSafetyRoutes(history:SafetyHistory,valid:(principal:Principal)=>boolean):Hono<AppEnv> {
  return new Hono<AppEnv>().get("/sessions/:id/safety",async c=>{
    c.header("Cache-Control","no-store");
    const principal=c.get("principal");
    if(!principal||!valid(principal))return c.json({version:1,reason:"unauthorized"},401);
    if(Buffer.byteLength(c.req.url)>8192||Object.keys(c.req.query()).some(k=>!["cursor","limit","entries"].includes(k))||Object.values(c.req.queries()).some(values=>values.length!==1)||c.req.query("entries")!==undefined&&c.req.query("entries")!=="1")return c.json({version:1,reason:"unavailable"},400);
    const target={sessionId:c.req.param("id")},cursor=c.req.query("cursor")??null,raw=c.req.query("limit");
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(target.sessionId)||cursor!==null&&(!cursor||cursor.length>512)||raw!==undefined&&(!/^[1-9][0-9]{0,2}$/.test(raw)||Number(raw)>100))return c.json({version:1,reason:"unavailable"},400);
    try{
      const page=await history.read(principal,target,cursor,raw?Number(raw):50,c.req.query("entries")==="1");
      if(!valid(principal))return c.json({version:1,reason:"unauthorized"},401);
      history.delivery(principal,page.identity,page.snapshotId);
      return c.json(page);
    }catch(error){
      if(!valid(principal))return c.json({version:1,reason:"unauthorized"},401);
      const reason=error instanceof SafetyReadUnavailable?error.reason:"unavailable";
      return c.json({version:1,reason},reason==="unauthorized"?401:reason==="capacity"?503:reason==="expired"||reason==="generation_changed"||reason==="gap"?409:404);
    }
  });
}
