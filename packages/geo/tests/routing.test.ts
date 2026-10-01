import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeoConfigInput, RoutingDataset, RoutingMode } from "../src/config.js";
import { GeoClient } from "../src/server/client.js";
import type { GeoRuntimeOptions } from "../src/server/io.js";

const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function client(fetchImpl:GeoRuntimeOptions["fetchImpl"],routing:GeoConfigInput["routing"],extra:GeoConfigInput={}) {
  const root=await mkdtemp(join(tmpdir(),"brain-geo-route-"));roots.push(root);
  return new GeoClient({userAgent:"brain-geo-fixture/1.0",cacheDir:root,minimumIntervalMs:0,routing,...extra},{fetchImpl,admissionDir:join(root,"admission")});
}
const points=[{lat:38.36,lon:20.71},{lat:38.37,lon:20.72}];
const dataset=(mode:RoutingMode): RoutingDataset=>({url:`https://route.example.invalid/${mode}/route/v1`,profile:"driving",preparedMode:mode,
  dataset:`fixture prepared ${mode}`,verification:`Recorded fixture prepared with the ${mode} routing dataset.`});
const reply={code:"Ok",waypoints:[{location:[20.711,38.361],name:"First stop",distance:10},{location:[20.721,38.371],name:"Last stop",distance:15}],
  routes:[{geometry:{type:"LineString",coordinates:[[20.711,38.361],[20.716,38.366],[20.721,38.371]]},distance:1_667,duration:60,legs:[{distance:1_667,duration:60}]}]};
const eligible={enabled:true,noncommercialLightUse:true};

describe("configured OSRM routing and explicit demo fallback",()=>{
  test("configured primary wins, preserves requested/snapped stops and reports the actual dataset",async()=>{
    const urls:string[]=[],primary=dataset("foot");
    const geo=await client(async(url)=>{urls.push(url);return Response.json(reply);},{endpoints:{foot:primary},demo:eligible});
    const result=await geo.route(points,"foot");
    expect(result.value!.geometry[0]).toHaveLength(3);
    expect(result.value!.waypoints[0]).toMatchObject({requested:points[0],snapped:{lat:38.361,lon:20.711}});
    expect(result.value!.measurements).toEqual({distance:{value:1_667,unit:"m"},duration:{value:60,unit:"s"}});
    expect(result.source).toMatchObject({endpoint:primary.url,dataset:{name:primary.dataset,preparedMode:"foot",profile:"driving"},fallback:{used:false}});
    expect(result.attempts).toHaveLength(1);
    expect(new URL(urls[0]!).pathname).toBe("/foot/route/v1/driving/20.71,38.36;20.72,38.37");
    expect(new URL(urls[0]!).searchParams.get("geometries")).toBe("geojson");
    const cached=await geo.route(points,"foot");
    expect(cached.source).toMatchObject({fromCache:true,dataset:{preparedMode:"foot"},fallback:{used:false},transfer:{sent:false}});
    expect(urls).toHaveLength(1);
  });

  test("disabled demo emits zero public traffic after a genuine primary failure",async()=>{
    const urls:string[]=[];
    const geo=await client(async(url)=>{urls.push(url);throw new Error("offline");},{endpoints:{car:dataset("car")},demo:{enabled:false,noncommercialLightUse:true}});
    const result=await geo.route(points,"car");
    expect(result.error).toMatchObject({code:"network"});
    expect(urls).toHaveLength(1);
    expect(result.attempts).toHaveLength(1);
    expect(new URL(urls[0]!).hostname).toBe("route.example.invalid");
  });

  test("eligible bounded fallback and its cached result retain source, cause and transfer attempts",async()=>{
    const urls:string[]=[];
    const geo=await client(async(url)=>{
      urls.push(url);return new URL(url).hostname==="route.example.invalid" ? new Response("down",{status:503}) : Response.json(reply);
    },{endpoints:{bike:dataset("bike")},demo:eligible});
    const result=await geo.route(points,"bike");
    expect(result.value!.geometry[0]).toHaveLength(3);
    expect(result.source).toMatchObject({endpoint:"https://routing.openstreetmap.de/routed-bike/route/v1",dataset:{preparedMode:"bike",profile:"driving"},
      fallback:{used:true,reason:"http",primaryEndpoint:dataset("bike").url},transfer:{sent:true}});
    expect(result.attempts).toHaveLength(2);
    expect(result.attribution.some(a=>a.url.endsWith("/fixthemap"))).toBe(true);
    const cached=await geo.route(points,"bike");
    expect(cached.source).toMatchObject({fromCache:true,fallback:{used:true},dataset:{preparedMode:"bike"},transfer:{sent:false}});
    expect(cached.attempts.map(a=>a.requestSent)).toEqual([true,false]);
    expect(cached.source!.fetchedAt).toBe(result.source!.fetchedAt);
    expect(urls.filter(u=>new URL(u).hostname==="routing.openstreetmap.de")).toHaveLength(1);
  });

  test("verified car, foot and bike presets select distinct prepared endpoints with the same URL profile",async()=>{
    for(const mode of ["car","foot","bike"] as const) {
      const urls:string[]=[];
      const geo=await client(async(url)=>{urls.push(url);return Response.json(reply);},{demo:eligible});
      const result=await geo.route(points,mode);
      expect(result.value!.geometry[0]).toHaveLength(3);
      expect(new URL(urls[0]!).pathname).toBe(`/routed-${mode}/route/v1/driving/20.71,38.36;20.72,38.37`);
      expect(result.source!.dataset.preparedMode).toBe(mode);
      expect(result.source!.fallback).toMatchObject({used:true,reason:"primary_not_configured"});
    }
  });

  test("missing capability, mismatched prepared mode and ineligible demo give no fabricated route or request",async()=>{
    let requests=0;
    for(const [routing,mode,code] of [
      [{},"foot","disabled"],
      [{endpoints:{car:dataset("car")}},"foot","capability"],
      [{endpoints:{foot:dataset("car")},demo:eligible},"foot","capability"],
      [{demo:{enabled:true,noncommercialLightUse:false}},"foot","ineligible"],
      [{endpoints:{foot:{...dataset("foot"),url:"https://routing.openstreetmap.de/routed-car/route/v1"}},demo:eligible},"foot","capability"],
      [{endpoints:{foot:{...dataset("foot"),url:"https://routing.openstreetmap.de/routed-foot/route/v1",profile:"foot"}},demo:eligible},"foot","capability"],
      [{endpoints:{foot:{...dataset("foot"),url:"https://routing.openstreetmap.de/routed-foot/route/v1"}}},"foot","ineligible"],
    ] as const) {
      const geo=await client(async()=>{requests++;return Response.json(reply);},routing);
      const result=await geo.route(points,mode);
      expect(result.error).toMatchObject({code});
      expect(result.value).toBeNull();
    }
    expect(requests).toBe(0);
  });

  test("no-route differs from no-segment, invalid input and disabled dataset; only genuine no-route caches",async()=>{
    for(const [serviceCode,code] of [["NoRoute",null],["NoSegment","no_segment"],["InvalidQuery","input"],["DisabledDataset","capability"]] as const) {
      let requests=0;
      const geo=await client(async()=>{requests++;return Response.json({code:serviceCode},{status:400});},{endpoints:{car:dataset("car")}});
      const result=await geo.route(points,"car");
      if(code===null) {
        expect(result).toMatchObject({status:"no_route",value:null,error:null});
        expect((await geo.route(points,"car")).source!.fromCache).toBe(true);
        expect(requests).toBe(1);
      } else {
        expect(result.error).toMatchObject({code,serviceCode});
        await geo.route(points,"car");
        expect(requests).toBe(2);
      }
    }
  });

  test("admission/denial and no-route never escape to another service, even with cached demo data",async()=>{
    for(const status of [401,403,429]) {
      const urls:string[]=[];
      const geo=await client(async(url)=>{urls.push(url);return new Response("denied",{status});},{endpoints:{car:dataset("car")},demo:eligible});
      expect((await geo.route(points,"car")).error).toMatchObject({code:"admission_denied",httpStatus:status});
      expect(urls).toHaveLength(1);
    }
    const urls:string[]=[];
    const geo=await client(async(url)=>{urls.push(url);return Response.json({code:"NoRoute"});},{endpoints:{car:dataset("car")},demo:eligible});
    expect((await geo.route(points,"car")).status).toBe("no_route");
    expect(urls).toHaveLength(1);
    const calls:string[]=[];
    let primaryCalls=0;
    const cachedDemo=await client(async(url)=>{
      calls.push(url);
      if(new URL(url).hostname==="route.example.invalid") return new Response("primary unavailable/denied",{status:++primaryCalls===1 ? 503 : 429});
      return Response.json(reply);
    },{endpoints:{bike:dataset("bike")},demo:eligible});
    const seeded=await cachedDemo.route(points,"bike");
    expect(seeded.value!.geometry[0]).toHaveLength(3);
    expect(seeded.source!.fallback.used).toBe(true);
    expect((await cachedDemo.route(points,"bike")).error).toMatchObject({code:"admission_denied"});
    expect(calls).toHaveLength(3);
    expect(calls.filter(u=>new URL(u).hostname==="routing.openstreetmap.de")).toHaveLength(1);
  });

  test("missing duration remains unknown while real zero distances and durations remain zero",async()=>{
    const zero=structuredClone(reply);zero.routes[0]!.distance=0;zero.routes[0]!.duration=0;zero.routes[0]!.legs[0]={distance:0,duration:0};
    const known=await client(async()=>Response.json(zero),{endpoints:{car:dataset("car")}});
    expect((await known.route(points,"car")).value!.measurements).toEqual({distance:{value:0,unit:"m"},duration:{value:0,unit:"s"}});
    const unknown=await client(async()=>Response.json({...reply,routes:[{...reply.routes[0],duration:null}]}),{endpoints:{car:dataset("car")}});
    const result=await unknown.route(points,"car");
    expect(result.status).toBe("partial");
    expect(result.value!.measurements.duration.value).toBeNull();
    expect(result.value!.unknown).toContainEqual({field:"duration",reason:"provider_missing_or_invalid"});
  });

  test("malformed geometry, timeout and a disabled primary dataset can use exactly one eligible fallback",async()=>{
    for(const failure of ["malformed","timeout","DisabledDataset"]) {
      const urls:string[]=[];
      const geo=await client(async(url,init)=>{
        urls.push(url);
        if(new URL(url).hostname!=="route.example.invalid") return Response.json(reply);
        if(failure==="malformed") return Response.json({...reply,routes:[{...reply.routes[0],geometry:{type:"LineString",coordinates:[[0,91],[0,0]]}}]});
        if(failure==="DisabledDataset") return Response.json({code:"DisabledDataset"},{status:400});
        return new Promise((_,reject)=>init.signal!.addEventListener("abort",()=>reject(new Error("timeout")),{once:true}));
      },{endpoints:{foot:dataset("foot")},demo:eligible},{timeoutMs:100});
      expect((await geo.route(points,"foot")).value!.geometry[0]).toHaveLength(3);
      expect(urls).toHaveLength(2);
    }
  });

  test("a failing demo used as the configured endpoint is not retried as its own fallback",async()=>{
    let requests=0;
    const geo=await client(async()=>{requests++;return new Response("down",{status:503});},
      {endpoints:{foot:{...dataset("foot"),url:"https://routing.openstreetmap.de/routed-foot/route/v1"}},demo:eligible});
    expect((await geo.route(points,"foot")).error).toMatchObject({code:"http",httpStatus:503});
    expect(requests).toBe(1);
  });

  test("failure of both primary and demo stops after two attempts with no fabricated geometry",async()=>{
    const urls:string[]=[];
    const geo=await client(async(url)=>{urls.push(url);return Response.json({code:"Unexpected"});},{endpoints:{foot:dataset("foot")},demo:eligible});
    const result=await geo.route(points,"foot");
    expect(urls).toHaveLength(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.error).toMatchObject({code:"bad_response"});
    expect(result.value).toBeNull();
    expect(result.request.points).toEqual(points);
  });

  test("changing a prepared dataset's identity cannot relabel an old cached route",async()=>{
    const root=await mkdtemp(join(tmpdir(),"brain-geo-dataset-"));roots.push(root);
    let requests=0;
    const runtime={admissionDir:join(root,"admission"),fetchImpl:async()=>{requests++;return Response.json(reply);}};
    for(const name of ["prepared foot dataset one","prepared foot dataset two"]) {
      const geo=new GeoClient({userAgent:"brain-geo-fixture/1.0",cacheDir:root,minimumIntervalMs:0,routing:{endpoints:{foot:{...dataset("foot"),dataset:name}}}},runtime);
      expect((await geo.route(points,"foot")).source).toMatchObject({fromCache:false,dataset:{name}});
    }
    expect(requests).toBe(2);
  });

  test("invalid requested coordinates and size refuse before transferring any points",async()=>{
    let requests=0;
    const geo=await client(async()=>{requests++;return Response.json(reply);},{endpoints:{car:dataset("car")},demo:eligible});
    for(const input of [[],[points[0]!],Array.from({length:101},()=>points[0]!),[{lat:91,lon:0},points[1]!]]) {
      expect((await geo.route(input,"car")).error).toMatchObject({code:"input"});
    }
    expect(requests).toBe(0);
  });

  test("a caller changing its input while the primary waits cannot change fallback coordinates",async()=>{
    const input=structuredClone(points),urls:string[]=[];
    const geo=await client(async(url)=>{
      urls.push(url);
      if(new URL(url).hostname==="route.example.invalid") {
        input[0]!.lon=42;
        return new Response("unavailable",{status:503});
      }
      return Response.json(reply);
    },{endpoints:{foot:dataset("foot")},demo:eligible});
    const result=await geo.route(input,"foot");
    expect(new URL(urls[1]!).pathname).toBe("/routed-foot/route/v1/driving/20.71,38.36;20.72,38.37");
    expect(result.request.points).toEqual(points);
  });
});
