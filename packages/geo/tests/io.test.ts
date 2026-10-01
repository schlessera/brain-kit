import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geoConfigSchema } from "../src/config.js";
import { GeoTransport, type GeoRuntimeOptions } from "../src/server/io.js";
import { fileURLToPath } from "node:url";

const roots: string[]=[];
afterEach(async()=>{for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function setup(fetchImpl: GeoRuntimeOptions["fetchImpl"], options: Record<string,unknown> = {}) {
  const root=await mkdtemp(join(tmpdir(),"brain-geo-io-"));roots.push(root);
  const config=geoConfigSchema.parse({userAgent:"brain-geo-fixture/1.0",cacheDir:root,minimumIntervalMs:0,...options});
  return {root,config,io:new GeoTransport(config,{fetchImpl,admissionDir:join(root,"admission")})};
}
const decode=(raw: unknown): {places: string[]}=>{
  if (typeof raw!=="object" || raw===null || !("places" in raw) || !Array.isArray(raw.places) || !raw.places.every(x=>typeof x==="string")) throw new Error("Invalid fixture.");
  return {places:raw.places};
};
const endpoint="https://geo.example.invalid";
const ask=(io: GeoTransport,q="one",service: "nominatim" | "overpass" | "osrm" = "nominatim")=>io.request(service,endpoint,endpoint+"/search?q="+q,{},decode);

describe("shared geo request admission and cache",()=>{
  test("a separate client reads a nonempty disk cache with its actual fetch age",async()=>{
    let requests=0;
    const {root,config,io}=await setup(async()=>{requests++;return Response.json({places:["Ithaca"]});});
    const first=await ask(io), second=await ask(new GeoTransport(config,{fetchImpl:async()=>{throw new Error("Cache must answer");},admissionDir:join(root,"admission")}));
    expect(first.value!.places.length).toBeGreaterThan(0);
    expect(second.value).toEqual(first.value);
    expect(second.source).toMatchObject({fromCache:true,requestSent:false,fetchedAt:first.source.fetchedAt});
    expect(second.source.cacheAgeMs!).toBeGreaterThanOrEqual(0);
    expect(requests).toBe(1);
  });

  test("a genuine empty response caches while transient failures remain retryable",async()=>{
    let requests=0;
    const {io}=await setup(async()=>{requests++;return requests===1 ? new Response("down",{status:503}) : Response.json({places:[]});});
    expect((await ask(io)).error!.code).toBe("http");
    expect((await ask(io)).value).toEqual({places:[]});
    expect((await ask(io)).source.fromCache).toBe(true);
    expect(requests).toBe(2);
  });

  test("expired, future-dated and malformed cache entries cannot answer as fresh evidence",async()=>{
    let requests=0;
    const {root,io}=await setup(async()=>{requests++;return Response.json({places:["Ithaca"]});},{cacheTtlMs:60_000});
    await ask(io);
    const cachePath=join(root,"responses",(await readdir(join(root,"responses")))[0]!);
    for (const cached of [{version:1,fetchedAt:Date.now()-60_001,payload:{places:["stale"]}},
      {version:1,fetchedAt:Date.now()+60_000,payload:{places:["future"]}},
      {version:1,fetchedAt:Date.now(),payload:{wrong:"shape"}}]) {
      await writeFile(cachePath,JSON.stringify(cached));
      expect((await ask(io)).value).toEqual({places:["Ithaca"]});
    }
    expect(requests).toBe(4);
  });

  test("HTTP admission denial persists across clients and is distinct from no match",async()=>{
    let requests=0;
    const {root,config,io}=await setup(async()=>{requests++;return new Response("busy",{status:429,headers:{"Retry-After":"60"}});});
    const first=await ask(io);
    expect(first.error).toMatchObject({code:"admission_denied",httpStatus:429});
    const second=await ask(new GeoTransport(config,{fetchImpl:async()=>{requests++;return Response.json({places:["Should not request"]});},admissionDir:join(root,"admission")}),"two");
    expect(second.error).toMatchObject({code:"admission_denied"});
    expect(second.source.requestSent).toBe(false);
    expect(second.value).toBeNull();
    expect(requests).toBe(1);
  });

  test("Overpass 504 means resource admission; an OSRM 504 remains a genuine upstream failure",async()=>{
    const overpass=await setup(async()=>new Response("resource admission",{status:504}));
    expect((await ask(overpass.io,"one","overpass")).error!.code).toBe("admission_denied");
    const osrm=await setup(async()=>new Response("upstream timeout",{status:504}));
    expect((await ask(osrm.io,"one","osrm")).error).toMatchObject({code:"http",httpStatus:504});
  });

  test("the public floor cannot be lowered and applies between actual dispatch times",async()=>{
    const starts: number[]=[], {io}=await setup(async()=>{starts.push(Date.now());return Response.json({places:["Ithaca"]});});
    const url="https://nominatim.openstreetmap.org";
    const results=await Promise.all(["one","two","three"].map(q=>io.request("nominatim",url,url+"/search?q="+q,{},decode)));
    expect(results.map(r=>r.error)).toEqual([null,null,null]);
    expect(starts).toHaveLength(3);
    expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(1_000);
    expect(starts[2]!-starts[1]!).toBeGreaterThanOrEqual(1_000);
  });

  test("one connection covers FOSSGIS routing and Overpass endpoint aliases",async()=>{
    let active=0, peak=0;
    const starts: number[]=[], {io}=await setup(async()=>{
      starts.push(Date.now());active++;peak=Math.max(peak,active);
      await Bun.sleep(30);active--;return Response.json({places:["Ithaca"]});
    });
    const endpoints=["https://routing.openstreetmap.de/routed-foot/route/v1","https://overpass-api.de/api/interpreter","https://lz4.overpass-api.de/api/interpreter",
      "https://gall.openstreetmap.de/api/interpreter","https://lambert.openstreetmap.de/api/interpreter"];
    const results=await Promise.all(endpoints.map((url,i)=>io.request(i===0 ? "osrm" : "overpass",url,url,{},decode)));
    expect(results.every(r=>r.error===null)).toBe(true);
    expect(starts).toHaveLength(5);
    expect(peak).toBe(1);
    for(let i=1;i<starts.length;i++) expect(starts[i]!-starts[i-1]!).toBeGreaterThanOrEqual(1_000);
  });

  test("an orphaned lock fails closed within the admission budget without removing another owner",async()=>{
    let requests=0;
    const {root,io}=await setup(async()=>{requests++;return Response.json({places:["Ithaca"]});},{admissionWaitMs:100});
    await ask(io);
    const directory=join(root,"admission"), state=(await readdir(directory)).find(x=>x.endsWith(".json"))!;
    const lock=join(directory,state.replace(/\.json$/,".lock")), evidence=JSON.stringify({pid:123456789,token:"other-owner"});
    await writeFile(lock,evidence);
    const result=await ask(io,"other");
    expect(result.error).toMatchObject({code:"admission_timeout"});
    expect(result.source.requestSent).toBe(false);
    expect(requests).toBe(1);
    expect(await readFile(lock,"utf8")).toBe(evidence);
  });

  test("invalid or library-only User-Agent refuses before dispatch",async()=>{
    let requests=0;
    for (const userAgent of ["","undici","node/24"]) {
      const {io}=await setup(async()=>{requests++;return Response.json({places:["Ithaca"]});},{userAgent});
      expect((await ask(io)).error).toMatchObject({code:"configuration"});
    }
    expect(requests).toBe(0);
  });

  test("malformed, oversized and stalled bodies give bounded distinct failures and do not cache",async()=>{
    let requests=0;
    const {io,root}=await setup(async()=>{
      requests++;
      if (requests===1) return Response.json({wrong:"shape"});
      if (requests===2) return new Response("x".repeat(5*1024*1024+1));
      return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("{"));}}));
    },{timeoutMs:100});
    expect((await ask(io)).error!.code).toBe("bad_response");
    expect((await ask(io)).error!.code).toBe("response_limit");
    expect((await ask(io)).error!.code).toBe("timeout");
    expect(requests).toBe(3);
    expect((await readdir(root)).includes("responses")).toBe(false);
  });

  test("the timeout bounds response-body consumption as well as response headers",async()=>{
    let cancelled=false;
    const {io}=await setup(async()=>new Response(new ReadableStream({
      start(controller){
        controller.enqueue(new TextEncoder().encode("{"));
        setTimeout(()=>{if(!cancelled) controller.close();},300);
      },cancel(){cancelled=true;},
    })),{timeoutMs:100});
    const result=await Promise.race([ask(io),Bun.sleep(200).then(()=>({error:{code:"unsettled_after_budget"}}))]);
    expect(result.error).toMatchObject({code:"timeout"});
    expect(cancelled).toBe(true);
  });

  test("separate processes share one connection and the aggregate public allowance",async()=>{
    const root=await mkdtemp(join(tmpdir(),"brain-geo-process-"));roots.push(root);
    const worker=fileURLToPath(new URL("./fixtures/admission-worker.ts",import.meta.url));
    const children=["one","two"].map(id=>Bun.spawn([process.execPath,worker,root,id],{stdout:"pipe",stderr:"pipe"}));
    for (const child of children) {
      const [status,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect({status,err}).toEqual({status:0,err:""});
      expect(JSON.parse(out)).toMatchObject({value:{places:["Ithaca"]},source:{fromCache:false,requestSent:true},error:null});
    }
    const events=(await readFile(join(root,"events.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line) as {id:string;stage:string;at:number});
    const starts=events.filter(e=>e.stage==="start"), ends=events.filter(e=>e.stage==="end");
    expect(starts).toHaveLength(2);expect(ends).toHaveLength(2);
    expect(starts[1]!.at).toBeGreaterThanOrEqual(ends.find(e=>e.id===starts[0]!.id)!.at);
    expect(starts[1]!.at-starts[0]!.at).toBeGreaterThanOrEqual(1_000);
  });
});
