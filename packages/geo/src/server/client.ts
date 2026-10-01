import { z } from "zod";
import { geoConfigSchema, type GeoConfig, type GeoConfigInput } from "../config.js";
import { routePoint } from "../track.js";
import { GeoTransport, type GeoError, type GeoRuntimeOptions, type ServiceSource } from "./io.js";

export interface GeoAttribution { text: string; url: string }
export interface GeoResult<T> {
  status: "ok" | "ambiguous" | "partial" | "no_match" | "no_route" | "disabled" | "error";
  value: T | null;
  source: (ServiceSource & {transfer: {data: "text_query" | "coordinates" | "query_geometry"; sent: boolean}}) | null;
  error: GeoError | null;
  warnings: string[];
  attribution: GeoAttribution[];
  counts?: {input: number; retained: number; omitted: number};
}
export interface GeocodeCandidate {
  displayName: string;
  summary: string;
  point: {lat: number; lon: number};
  address: Record<string,string>;
  bounds: [number,number,number,number] | null;
  osm: {type: "node" | "way" | "relation"; id: number} | null;
  accuracyM: null;
  unknown: {field: "accuracyM"; reason: "not_provided"}[];
}
const OSM: GeoAttribution={text:"© OpenStreetMap contributors (ODbL)",url:"https://www.openstreetmap.org/copyright"};
interface GeocodedMatches {items: GeocodeCandidate[]; omitted: number}
const nominatimPlace=z.object({display_name:z.string().min(1),lat:z.union([z.string(),z.number()]),lon:z.union([z.string(),z.number()]),
  address:z.record(z.string(),z.string()).optional(),boundingbox:z.array(z.union([z.string(),z.number()])).length(4).optional(),
  osm_type:z.enum(["node","way","relation"]).optional(),osm_id:z.number().int().positive().optional()});
function number(value: string | number): number {
  if (typeof value==="string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) throw new Error("Invalid coordinate.");
  const parsed=Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid coordinate.");
  return parsed;
}
function candidate(raw: unknown): GeocodeCandidate {
  const data=nominatimPlace.parse(raw), point=routePoint(number(data.lat),number(data.lon)), address=data.address ?? {};
  let bounds: GeocodeCandidate["bounds"]=null;
  if (data.boundingbox) {
    const [south,north,west,east]=data.boundingbox.map(number) as [number,number,number,number];
    routePoint(south,west);routePoint(north,east);
    if (south>north || west>east) throw new Error("Invalid bounding box.");
    bounds=[west,south,east,north];
  }
  const city=address.city || address.town || address.village || address.municipality || address.county || address.state;
  const area=address.suburb || address.neighbourhood || address.city_district || address.road;
  return {displayName:data.display_name,summary:[area,city,address.country].filter(Boolean).join(", ") || data.display_name,
    point:{lat:point.lat,lon:point.lon},address,bounds,osm:data.osm_type && data.osm_id ? {type:data.osm_type,id:data.osm_id} : null,
    accuracyM:null,unknown:[{field:"accuracyM",reason:"not_provided"}]};
}

/** Configured concrete OSM operations. Server I/O stays outside the geometry import. */
export class GeoClient {
  private readonly config: GeoConfig;
  private transport: GeoTransport;
  constructor(config: GeoConfigInput = {}, runtime: GeoRuntimeOptions = {}) {
    this.config=geoConfigSchema.parse(config);
    this.transport=new GeoTransport(this.config,runtime);
  }

  async geocode(query: string): Promise<GeoResult<GeocodeCandidate[]>> {
    const rejected=this.geocodingGuard();if (rejected) return rejected;
    if (typeof query!=="string" || !query.trim() || query.length>500 || /[\u0000-\u001f\u007f]/.test(query)) {
      return this.failure({code:"input",message:"Geocode query must contain 1–500 characters without controls."});
    }
    const endpoint=this.config.geocoding.url!, url=new URL(endpoint.replace(/\/$/,"")+"/search");
    url.searchParams.set("q",query.trim());url.searchParams.set("format","jsonv2");url.searchParams.set("addressdetails","1");url.searchParams.set("limit","10");
    return this.geocodingRequest(endpoint,url,"text_query",raw=> {
      if (!Array.isArray(raw) || raw.length>40) throw new Error("Invalid Nominatim search.");
      const items: GeocodeCandidate[]=[];
      let omitted=0;
      for (const item of raw) { try { items.push(candidate(item)); } catch { omitted++; } }
      if (omitted && !items.length) throw new Error("No valid candidates in a nonempty response.");
      return {items,omitted};
    });
  }

  async reverse(lat: number, lon: number): Promise<GeoResult<GeocodeCandidate[]>> {
    const rejected=this.geocodingGuard();if (rejected) return rejected;
    try { routePoint(lat,lon); } catch { return this.failure({code:"input",message:"Reverse query needs finite in-range latitude/longitude."}); }
    const endpoint=this.config.geocoding.url!, url=new URL(endpoint.replace(/\/$/,"")+"/reverse");
    url.searchParams.set("format","jsonv2");url.searchParams.set("lat",String(lat));url.searchParams.set("lon",String(lon));
    url.searchParams.set("addressdetails","1");url.searchParams.set("zoom","16");
    return this.geocodingRequest(endpoint,url,"coordinates",raw=> {
      if (typeof raw==="object" && raw!==null && "error" in raw && raw.error==="Unable to geocode") return {items:[],omitted:0};
      return {items:[candidate(raw)],omitted:0};
    },[404]);
  }

  private geocodingGuard(): GeoResult<never> | null {
    const service=this.config.geocoding;
    if (!service.enabled) return this.failure({code:"disabled",message:"Geocoding is disabled."});
    if (!service.url) return this.failure({code:"configuration",message:"Enabled geocoding needs a configured Nominatim-compatible endpoint."});
    if (new URL(service.url).hostname.toLowerCase()==="nominatim.openstreetmap.org" && !service.publicServiceEligible) {
      return this.failure({code:"ineligible",message:"Public Nominatim requires deliberate informed eligibility. Configure a suitable endpoint when its policy excludes this use."});
    }
    return null;
  }

  private async geocodingRequest(endpoint: string, url: URL, transfer: "text_query" | "coordinates",
    decode: (raw: unknown) => GeocodedMatches, acceptedStatuses: number[] = []): Promise<GeoResult<GeocodeCandidate[]>> {
    const result=await this.transport.request("nominatim",endpoint,url.href,{},decode,acceptedStatuses);
    const source={...result.source,transfer:{data:transfer,sent:result.source.requestSent}};
    if (result.error) return {...this.failure<GeocodeCandidate[]>(result.error),source};
    const {items:value,omitted}=result.value!;
    return {status:omitted ? "partial" : !value.length ? "no_match" : value.length>1 ? "ambiguous" : "ok",value,source,error:null,
      counts:{input:value.length+omitted,retained:value.length,omitted},
      warnings:["Provider matches have unverified coordinate/address accuracy.",
        ...(omitted ? [`${omitted} malformed candidate(s) omitted; available matches cover the usable response only.`] : []),
        ...(transfer==="coordinates" ? ["Reverse geocoding returns the nearest suitable mapped object; its address may differ from the queried position."] : [])],attribution:[OSM]};
  }

  private failure<T = never>(error: GeoError): GeoResult<T> {
    return {status:error.code==="disabled" ? "disabled" : "error",value:null,source:null,error,warnings:[],attribution:[]};
  }
}
