import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoClient } from "../src/server/client.js";
import { geoConfigSchema, type GeoConfigInput } from "../src/config.js";
import type { GeoRuntimeOptions } from "../src/server/io.js";

const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function client(fetchImpl: GeoRuntimeOptions["fetchImpl"], config: GeoConfigInput = {}) {
  const root=await mkdtemp(join(tmpdir(),"brain-geo-geocode-"));roots.push(root);
  return new GeoClient({userAgent:"brain-geo-fixture/1.0",cacheDir:root,minimumIntervalMs:0,
    geocoding:{enabled:true,url:"https://geo.example.invalid/nominatim"},...config},{fetchImpl,admissionDir:join(root,"admission")});
}
const place={display_name:"Ithaca, Greece",lat:"38.36",lon:"20.71",address:{town:"Ithaca",country:"Greece"},
  osm_type:"node",osm_id:123,boundingbox:["38.35","38.37","20.70","20.72"]};

describe("configured Nominatim operations",()=>{
  test("forward ambiguity retains nonempty candidates, source, unknown accuracy and attribution",async()=>{
    const requests: {url:string;init:RequestInit}[]=[];
    const geo=await client(async(url,init)=>{requests.push({url,init});return Response.json([place,{...place,osm_id:124,display_name:"Another Ithaca"}]);});
    const result=await geo.geocode(" Ithaca ");
    expect(result.status).toBe("ambiguous");
    expect(result.value).toHaveLength(2);
    expect(result.value![0]).toMatchObject({point:{lat:38.36,lon:20.71},bounds:[20.70,38.35,20.72,38.37],accuracyM:null});
    expect(result.value![0]!.unknown).toEqual([{field:"accuracyM",reason:"not_provided"}]);
    expect(result.attribution[0]!.url).toBe("https://www.openstreetmap.org/copyright");
    expect(result.source).toMatchObject({endpoint:"https://geo.example.invalid/nominatim",fromCache:false,transfer:{data:"text_query",sent:true}});
    const url=new URL(requests[0]!.url);
    expect(url.pathname).toBe("/nominatim/search");
    expect(url.searchParams.get("q")).toBe("Ithaca");
    expect(new Headers(requests[0]!.init.headers).get("User-Agent")).toBe("brain-geo-fixture/1.0");
    expect(requests[0]!.init.redirect).toBe("manual");
    const cached=await geo.geocode("Ithaca");
    expect(cached.value).toEqual(result.value);
    expect(cached.source).toMatchObject({fromCache:true,transfer:{data:"text_query",sent:false},fetchedAt:result.source!.fetchedAt});
    expect(requests).toHaveLength(1);
  });

  test("reverse query preserves zero coordinates and returns a qualified mapped address",async()=>{
    let requested: URL | null=null;
    const geo=await client(async(url)=>{requested=new URL(url);return Response.json({...place,lat:"0",lon:"0"});});
    const result=await geo.reverse(0,0);
    expect(result.value![0]!.point).toEqual({lat:0,lon:0});
    expect(result.value![0]!.summary).toBe("Ithaca, Greece");
    expect(requested!.searchParams.get("lat")).toBe("0");
    expect(requested!.searchParams.get("lon")).toBe("0");
    expect(result.source!.transfer).toEqual({data:"coordinates",sent:true});
    expect(result.warnings.some(w=>w.includes("nearest suitable"))).toBe(true);
  });

  test("genuine no-match replies cache; a malformed reply remains an error and is retried",async()=>{
    let count=0;
    const geo=await client(async()=>{count++;return Response.json(count===1 ? [{...place,lat:""}] : []);});
    expect((await geo.geocode("missing")).error).toMatchObject({code:"bad_response"});
    expect((await geo.geocode("missing")).status).toBe("no_match");
    const cached=await geo.geocode("missing");
    expect(cached).toMatchObject({status:"no_match",value:[],source:{fromCache:true}});
    expect(count).toBe(2);
  });

  test("partially malformed candidates retain usable matches and disclose omissions even from cache",async()=>{
    let count=0;
    const geo=await client(async()=>{count++;return Response.json([place,{...place,lat:"invalid"}]);});
    const result=await geo.geocode("Ithaca");
    expect(result.value).toHaveLength(1);
    expect(result).toMatchObject({status:"partial",counts:{input:2,retained:1,omitted:1}});
    expect(result.warnings.some(w=>w.includes("1 malformed"))).toBe(true);
    const cached=await geo.geocode("Ithaca");
    expect(cached).toMatchObject({status:"partial",counts:{input:2,retained:1,omitted:1},source:{fromCache:true}});
    expect(count).toBe(1);
  });

  test("only the recognized reverse no-match response accepts a 404",async()=>{
    const absent=await client(async()=>Response.json({error:"Unable to geocode"},{status:404}));
    expect(await absent.reverse(0,0)).toMatchObject({status:"no_match",value:[]});
    expect((await absent.reverse(0,0)).source!.fromCache).toBe(true);
    const broken=await client(async()=>Response.json({error:"Endpoint not found"},{status:404}));
    expect((await broken.reverse(0,0)).error).toMatchObject({code:"bad_response"});
  });

  test("disabled, missing endpoint and public eligibility refuse distinctly with zero requests",async()=>{
    let requests=0;
    for (const [geocoding,code] of [[{enabled:false},"disabled"],[{enabled:true},"configuration"],
      [{enabled:true,url:"https://nominatim.openstreetmap.org"},"ineligible"]] as const) {
      const geo=await client(async()=>{requests++;return Response.json([place]);},{geocoding});
      expect((await geo.geocode("Ithaca")).error).toMatchObject({code});
      expect((await geo.reverse(0,0)).error).toMatchObject({code});
    }
    expect(requests).toBe(0);
  });

  test("endpoint replacement uses configuration and never dispatches to the former endpoint",async()=>{
    const urls: string[]=[];
    const geo=await client(async(url)=>{urls.push(url);return Response.json([place]);},
      {geocoding:{enabled:true,url:"https://another.example.invalid/geo"}});
    expect((await geo.geocode("Ithaca")).value).toHaveLength(1);
    expect(new URL(urls[0]!).origin).toBe("https://another.example.invalid");
    expect(urls).toHaveLength(1);
  });

  test("the actual HTTP client sends identifying requests and serves repeats without network",async()=>{
    const requests: {path:string;userAgent:string|null}[]=[];
    const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
      requests.push({path:new URL(request.url).pathname,userAgent:request.headers.get("User-Agent")});
      return Response.json([place]);
    }});
    const root=await mkdtemp(join(tmpdir(),"brain-geo-http-"));roots.push(root);
    try {
      const geo=new GeoClient({userAgent:"brain-geo-fixture/1.0",cacheDir:root,minimumIntervalMs:0,
        geocoding:{enabled:true,url:server.url.href.replace(/\/$/,"")+"/nominatim"}},{admissionDir:join(root,"admission")});
      expect((await geo.geocode("Ithaca")).value).toHaveLength(1);
      expect((await geo.geocode("Ithaca")).source).toMatchObject({fromCache:true,requestSent:false});
      expect(requests).toEqual([{path:"/nominatim/search",userAgent:"brain-geo-fixture/1.0"}]);
    } finally {server.stop(true);}
  });

  test("invalid inputs and endpoint/header configuration reject without network",async()=>{
    let requests=0;
    const geo=await client(async()=>{requests++;return Response.json([place]);});
    for (const query of [""," ","x".repeat(501),"Ithaca\n"]) expect((await geo.geocode(query)).error!.code).toBe("input");
    for (const point of [[NaN,0],[91,0],[0,181]]) expect((await geo.reverse(point[0]!,point[1]!)).error!.code).toBe("input");
    expect(requests).toBe(0);
    for (const url of ["ftp://geo.example.invalid","https://user:secret@geo.example.invalid","https://geo.example.invalid?q=x"]) {
      expect(()=>geoConfigSchema.parse({geocoding:{enabled:true,url}})).toThrow();
    }
    expect(()=>geoConfigSchema.parse({userAgent:"application\r\nHeader: value"})).toThrow();
    expect(geoConfigSchema.parse({}).geocoding.enabled).toBe(false);
  });
});
