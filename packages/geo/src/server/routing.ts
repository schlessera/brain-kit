import { z } from "zod";
import type { GeoConfig, RoutingDataset, RoutingMode } from "../config.js";
import { routePoint, type RoutePoint } from "../track.js";
import type { GeoResult } from "./client.js";
import { GeoReplyError, GeoTransport, type GeoError } from "./io.js";

type Coordinate = Pick<RoutePoint,"lat"|"lon">;
export interface CalculatedRoute {
  kind: "calculated";
  geometry: RoutePoint[][];
  waypoints: {requested: Coordinate; snapped: Coordinate; name: string; snapDistanceM: number | null}[];
  legs: {index: number; from: Coordinate; to: Coordinate; distanceM: number | null; durationS: number | null}[];
  measurements: {distance: {value: number | null;unit:"m"};duration: {value: number | null;unit:"s"}};
  unknown: {field: string;reason: string}[];
  method: {distance: "provider_route_network";duration: "provider_estimate";geometry: "provider_geojson_full"};
}
export interface RoutingResult extends GeoResult<CalculatedRoute> {
  request: {mode: RoutingMode;points: Coordinate[]};
  source: (NonNullable<GeoResult<CalculatedRoute>["source"]> & {
    dataset: {name: string;preparedMode: RoutingMode;profile: string;verification: string};
    fallback: {used: boolean;reason: string | null;primaryEndpoint: string | null};
  }) | null;
  attempts: {endpoint: string;fromCache: boolean;requestSent: boolean;error: GeoError | null}[];
}
const verification="https://github.com/fossgis-routing-server/osrm-frontend/blob/master/src/leaflet_options.js";
const DEMO: Record<RoutingMode,RoutingDataset> = {
  car:{url:"https://routing.openstreetmap.de/routed-car/route/v1",profile:"driving",preparedMode:"car",dataset:"FOSSGIS car",verification},
  foot:{url:"https://routing.openstreetmap.de/routed-foot/route/v1",profile:"driving",preparedMode:"foot",dataset:"FOSSGIS foot",verification},
  bike:{url:"https://routing.openstreetmap.de/routed-bike/route/v1",profile:"driving",preparedMode:"bike",dataset:"FOSSGIS bike",verification},
};
const coordinateSchema=z.tuple([z.number().finite(),z.number().finite()]);
const waypoint=z.object({location:coordinateSchema,name:z.string().default(""),distance:z.number().finite().nonnegative().optional()});
const usableMeasure=(raw: unknown): number | null => typeof raw==="number" && Number.isFinite(raw) && raw>=0 ? raw : null;

function decodeRoute(raw: unknown, requested: Coordinate[]): CalculatedRoute | null {
  const reply=z.object({code:z.string()}).parse(raw);
  if (reply.code==="NoRoute") return null;
  if (reply.code!=="Ok") {
    const code=reply.code==="NoSegment" ? "no_segment" : ["DisabledDataset","InvalidService","InvalidVersion","NotImplemented"].includes(reply.code)
      ? "capability" : ["InvalidValue","InvalidQuery","InvalidUrl","TooBig"].includes(reply.code) ? "input" : "bad_response";
    throw new GeoReplyError({code,message:`OSRM returned ${reply.code}; no calculated route.`,serviceCode:reply.code});
  }
  const data=z.object({routes:z.array(z.object({geometry:z.object({type:z.literal("LineString"),coordinates:z.array(coordinateSchema).min(2).max(200_000)}),
    distance:z.unknown().optional(),duration:z.unknown().optional(),legs:z.array(z.object({distance:z.unknown().optional(),duration:z.unknown().optional()}))})).min(1).max(3),
    waypoints:z.array(waypoint).length(requested.length)}).parse(raw);
  const route=data.routes[0]!;
  if (route.legs.length!==requested.length-1) throw new Error("OSRM leg count differs from the requested stops.");
  const geometry=route.geometry.coordinates.map(([lon,lat])=>routePoint(lat,lon));
  const unknown: CalculatedRoute["unknown"]=[];
  const measure=(field:string,value:unknown): number | null=>{
    const number=usableMeasure(value);if(number===null) unknown.push({field,reason:"provider_missing_or_invalid"});return number;
  };
  return {kind:"calculated",geometry:[geometry],
    waypoints:data.waypoints.map((p,i)=>{
      const point=routePoint(p.location[1],p.location[0]);
      return {requested:{...requested[i]!},snapped:{lat:point.lat,lon:point.lon},name:p.name,snapDistanceM:measure(`waypoints.${i}.snapDistanceM`,p.distance)};
    }),legs:route.legs.map((leg,i)=>({index:i,from:{...requested[i]!},to:{...requested[i+1]!},distanceM:measure(`legs.${i}.distanceM`,leg.distance),durationS:measure(`legs.${i}.durationS`,leg.duration)})),
    measurements:{distance:{value:measure("distance",route.distance),unit:"m"},duration:{value:measure("duration",route.duration),unit:"s"}},unknown,
    method:{distance:"provider_route_network",duration:"provider_estimate",geometry:"provider_geojson_full"}};
}
const eligibleFailure = (error: GeoError): boolean => ["network","timeout","bad_response","response_limit"].includes(error.code)
  || error.code==="http" && (error.httpStatus===408 || (error.httpStatus ?? 0)>=500)
  || error.code==="capability" && error.serviceCode==="DisabledDataset";

/** Configured prepared datasets first; one eligible, explicit demo attempt after genuine unavailability. */
export async function calculateRoute(config: GeoConfig, transport: GeoTransport, points: Coordinate[], mode: RoutingMode): Promise<RoutingResult> {
  const request={mode,points:points.map(p=>({lat:p.lat,lon:p.lon}))};
  const attempts: RoutingResult["attempts"]=[];
  const fail=(error:GeoError,source:RoutingResult["source"]=null): RoutingResult=>({status:error.code==="disabled" ? "disabled" : "error",value:null,source,error,warnings:[],attribution:[],request,attempts});
  if (!["car","foot","bike"].includes(mode) || points.length<2 || points.length>100) return fail({code:"input",message:"Routing needs a car/foot/bike mode and 2–100 ordered points."});
  try {for(const p of points) routePoint(p.lat,p.lon);} catch {return fail({code:"input",message:"Routing points must be finite in-range latitude/longitude."});}
  const primary=config.routing.endpoints[mode], demo=config.routing.demo;
  if (primary && primary.preparedMode!==mode) return fail({code:"capability",message:"Configured endpoint's verified prepared dataset does not support the requested mode."});
  if (!primary && !demo.enabled) return fail({code:Object.keys(config.routing.endpoints).length ? "capability" : "disabled",message:"No configured endpoint for this mode; demo routing is disabled."});
  const demoGuard=(dataset:RoutingDataset): GeoError | null=>{
    if (new URL(dataset.url).hostname.toLowerCase()!=="routing.openstreetmap.de") return null;
    if (!demo.enabled || !demo.noncommercialLightUse) return {code:"ineligible",message:"FOSSGIS demo routing needs explicit enablement and noncommercial/light-use eligibility."};
    if (dataset.url.replace(/\/$/,"")!==DEMO[mode].url || dataset.profile!==DEMO[mode].profile) return {code:"capability",message:"The FOSSGIS endpoint/profile does not match its verified prepared dataset for this mode."};
    return null;
  };
  const perform=async(dataset:RoutingDataset,fallback:boolean,reason:string|null)=>{
    const url=new URL(dataset.url.replace(/\/$/,"")+"/"+dataset.profile+"/"+request.points.map(p=>`${p.lon},${p.lat}`).join(";"));
    url.searchParams.set("geometries","geojson");url.searchParams.set("overview","full");url.searchParams.set("steps","false");url.searchParams.set("alternatives","false");
    const result=await transport.request("osrm",dataset.url,url.href,{},raw=>decodeRoute(raw,request.points),[400,404],JSON.stringify([mode,dataset]));
    const source: NonNullable<RoutingResult["source"]>={...result.source,transfer:{data:"coordinates",sent:result.source.requestSent},
      dataset:{name:dataset.dataset,preparedMode:dataset.preparedMode,profile:dataset.profile,verification:dataset.verification},
      fallback:{used:fallback,reason,primaryEndpoint:primary?.url ?? null}};
    attempts.push({endpoint:source.endpoint,fromCache:source.fromCache,requestSent:source.requestSent,error:result.error});
    return {result,source};
  };
  let selected=primary ?? DEMO[mode], fallback=!primary, reason=primary ? null : "primary_not_configured";
  const firstGuard=demoGuard(selected);if(firstGuard) return fail(firstGuard);
  let outcome=await perform(selected,fallback,reason);
  if (outcome.result.error && primary && primary.url.replace(/\/$/,"")!==DEMO[mode].url && demo.enabled && eligibleFailure(outcome.result.error)) {
    selected=DEMO[mode];
    const guard=demoGuard(selected);
    if (guard) return {...fail(guard,outcome.source),warnings:["Configured routing failed; the demo fallback is ineligible."]};
    fallback=true;reason=outcome.result.error.serviceCode ?? outcome.result.error.code;
    outcome=await perform(selected,fallback,reason);
  }
  if (outcome.result.error) return fail(outcome.result.error,outcome.source);
  const value=outcome.result.value;
  return {status:value===null ? "no_route" : value.unknown.length ? "partial" : "ok",value,source:outcome.source,error:null,request,attempts,
    warnings:["Calculated geometry and duration are planning estimates; they do not prove travel.",
      ...(new URL(selected.url).hostname.toLowerCase()==="routing.openstreetmap.de" ? ["FOSSGIS demo routing has no availability/data-update guarantee."] : []),
      ...(fallback ? ["Using the explicitly enabled FOSSGIS demo fallback."] : [])],
    attribution:[{text:"© OpenStreetMap contributors (ODbL)",url:"https://www.openstreetmap.org/copyright"},
      ...(new URL(selected.url).hostname.toLowerCase()==="routing.openstreetmap.de" ? [{text:"FOSSGIS routing — contribute/report an error",url:"https://www.openstreetmap.org/fixthemap"},
        {text:"FOSSGIS service terms",url:"https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/"}] : [])]};
}
