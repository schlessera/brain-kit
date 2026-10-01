import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GeoConfig } from "../config.js";

export type GeoErrorCode = "disabled" | "configuration" | "ineligible" | "capability" | "input"
  | "timeout" | "network" | "http" | "admission_denied" | "admission_timeout"
  | "bad_response" | "response_limit" | "cache_unavailable";
export interface GeoError { code: GeoErrorCode; message: string; httpStatus?: number; retryAfterMs?: number }
export interface ServiceSource {
  kind: "service";
  service: "nominatim" | "osrm" | "overpass";
  endpoint: string;
  fromCache: boolean;
  fetchedAt: string | null;
  cacheAgeMs: number | null;
  requestSent: boolean;
}
export interface GeoIoResult<T> { value: T | null; source: ServiceSource; error: GeoError | null }
export interface GeoRuntimeOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** All cooperating CLI/SDK processes must share this directory. Defaults to the user's global geo state. */
  admissionDir?: string;
}
interface AdmissionState { nextStart: number; blockedUntil: number }
interface CacheEntry { version: 1; fetchedAt: number; payload: unknown }
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const globalDirectory = (): string => join(homedir(),".cache","brain-kit","geo");
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted=new Promise<never>((_,reject)=> {
    onAbort=()=>reject(signal.reason);
    signal.addEventListener("abort",onAbort,{once:true});
  });
  try { return await Promise.race([promise,aborted]); }
  finally { signal.removeEventListener("abort",onAbort); }
}

/** Public operators share a single admission group even across endpoint aliases. */
function group(endpoint: string): {key: string; floorMs: number} {
  const host=new URL(endpoint).hostname.toLowerCase();
  if (host==="nominatim.openstreetmap.org") return {key:"public-nominatim",floorMs:1_000};
  if (host==="routing.openstreetmap.de" || host==="overpass-api.de" || host.endsWith(".overpass-api.de")) {
    return {key:"fossgis-services",floorMs:1_000};
  }
  return {key:new URL(endpoint).origin,floorMs:0};
}

/** Shared disk cache and cross-process admission for the concrete geo clients. */
export class GeoTransport {
  constructor(private config: GeoConfig, private runtime: GeoRuntimeOptions = {}) {}

  async request<T>(service: ServiceSource["service"], endpoint: string, url: string, init: RequestInit,
    decode: (data: unknown) => T, acceptedStatuses: number[] = []): Promise<GeoIoResult<T>> {
    const source: ServiceSource={kind:"service",service,endpoint,fromCache:false,fetchedAt:null,cacheAgeMs:null,requestSent:false};
    const failed=(error: GeoError): GeoIoResult<T>=>({value:null,source,error});
    if (!this.config.userAgent.trim() || /^(?:node|bun|undici|fetch|python-requests)(?:\/|$)/i.test(this.config.userAgent.trim())) {
      return failed({code:"configuration",message:"Configure a User-Agent identifying the application before geo requests."});
    }
    const cacheDirectory=join(this.config.cacheDir ?? globalDirectory(),"responses"), stateDirectory=this.runtime.admissionDir ?? join(globalDirectory(),"admission");
    const key=hash(JSON.stringify([service,endpoint,url,init.method ?? "GET",String(init.body ?? ""),this.config.userAgent]));
    const cachePath=join(cacheDirectory,key+".json");
    try {
      const cached=JSON.parse(await readFile(cachePath,"utf8")) as CacheEntry;
      const age=Date.now()-cached.fetchedAt;
      if (cached.version===1 && Number.isFinite(cached.fetchedAt) && age>=0 && age<this.config.cacheTtlMs) {
        const value=decode(cached.payload);
        source.fromCache=true; source.fetchedAt=new Date(cached.fetchedAt).toISOString(); source.cacheAgeMs=age;
        return {value,source,error:null};
      }
    } catch { /* A missing, expired or corrupt disposable cache is a miss. */ }
    const operator=group(endpoint), prefix=join(stateDirectory,hash(operator.key)), lockPath=prefix+".lock", statePath=prefix+".json";
    const deadline=Date.now()+this.config.admissionWaitMs;
    let lock: Awaited<ReturnType<typeof open>> | null=null, release=true;
    try {
      await mkdir(stateDirectory,{recursive:true,mode:0o700});
      while (!lock) {
        try { lock=await open(lockPath,"wx",0o600); }
        catch (error) {
          if (code(error)!=="EEXIST") throw error;
          if (Date.now()>=deadline) return failed({code:"admission_timeout",message:"Geo request admission is busy; no request sent. A crashed owner's lock requires operator recovery."});
          await delay(Math.min(25,Math.max(1,deadline-Date.now())));
        }
      }
      await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now(),token:randomUUID()}));
      let state: AdmissionState={nextStart:0,blockedUntil:0};
      try {
        const stored=JSON.parse(await readFile(statePath,"utf8")) as AdmissionState;
        if (![stored.nextStart,stored.blockedUntil].every(n=>Number.isFinite(n) && n>=0)) throw new Error("Invalid geo admission state.");
        state=stored;
      } catch (error) { if (code(error)!=="ENOENT") return failed({code:"admission_denied",message:"Geo admission state is unreadable; no request sent."}); }
      if (state.blockedUntil>Date.now()) return failed({code:"admission_denied",message:"The operator's admission/cooldown response still applies; no request sent.",retryAfterMs:state.blockedUntil-Date.now()});
      const wait=Math.max(0,state.nextStart-Date.now());
      if (Date.now()+wait>deadline) return failed({code:"admission_timeout",message:"Geo rate admission exceeds the wait budget; no request sent.",retryAfterMs:wait});
      if (wait) await delay(wait);
      // Another process may have filled this exact query's cache while we waited.
      try {
        const cached=JSON.parse(await readFile(cachePath,"utf8")) as CacheEntry, age=Date.now()-cached.fetchedAt;
        if (cached.version===1 && Number.isFinite(cached.fetchedAt) && age>=0 && age<this.config.cacheTtlMs) {
          const value=decode(cached.payload);
          source.fromCache=true;source.fetchedAt=new Date(cached.fetchedAt).toISOString();source.cacheAgeMs=age;
          return {value,source,error:null};
        }
      } catch { /* Still a miss. */ }
      state.nextStart=Date.now()+Math.max(operator.floorMs,this.config.minimumIntervalMs);
      await this.writeAtomic(statePath,state);
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),this.config.timeoutMs);
      try {
        source.requestSent=true;
        const pending=(this.runtime.fetchImpl ?? fetch)(url,{...init,redirect:"manual",headers:{...Object.fromEntries(new Headers(init.headers)),"User-Agent":this.config.userAgent,"Accept":"application/json"},signal:controller.signal});
        void pending.catch(()=>{});
        // Anchor the floor after dispatch. Fsync before dispatch can otherwise
        // make the interval between actual network starts shorter than the floor.
        state.nextStart=Date.now()+Math.max(operator.floorMs,this.config.minimumIntervalMs);
        try { await this.writeAtomic(statePath,state); }
        catch { release=false;controller.abort();return failed({code:"cache_unavailable",message:"Geo rate state could not be persisted; admission stays locked."}); }
        const response=await untilAbort(pending,controller.signal);
        if (!response.ok && !acceptedStatuses.includes(response.status)) {
          void response.body?.cancel().catch(()=>{});
          const admission=[401,403,429].includes(response.status) || service==="overpass" && response.status===504;
          const header=response.headers.get("Retry-After");
          const retry=header ? /^\d+$/.test(header) ? Number(header)*1_000 : Math.max(0,Date.parse(header)-Date.now()) : 60_000;
          if (admission) {
            state.blockedUntil=Date.now()+Math.max(1_000,Number.isFinite(retry) ? retry : 60_000);
            try { await this.writeAtomic(statePath,state); }
            catch { release=false; return failed({code:"admission_denied",message:"Operator admission was denied and cooldown storage failed; admission stays locked.",httpStatus:response.status}); }
          }
          return failed({code:admission ? "admission_denied" : "http",message:`Geo service returned HTTP ${response.status}.`,httpStatus:response.status,...(admission ? {retryAfterMs:state.blockedUntil-Date.now()} : {})});
        }
        const reader=response.body?.getReader(), chunks: Uint8Array[]=[];
        let size=0;
        if (!reader) return failed({code:"bad_response",message:"Geo service returned an empty response body."});
        while (true) {
          let next: Awaited<ReturnType<typeof reader.read>>;
          try { next=await untilAbort(reader.read(),controller.signal); }
          catch (error) { void reader.cancel().catch(()=>{}); throw error; }
          if (next.done) break;
          size+=next.value.byteLength;
          if (size>5*1024*1024) { controller.abort(); void reader.cancel().catch(()=>{}); return failed({code:"response_limit",message:"Geo response exceeds 5 MiB."}); }
          chunks.push(next.value);
        }
        const text=Buffer.concat(chunks).toString("utf8");
        let payload: unknown, value: T;
        try { payload=JSON.parse(text); value=decode(payload); }
        catch { return failed({code:"bad_response",message:"Geo service returned malformed or unsupported data."}); }
        const fetchedAt=Date.now();source.fetchedAt=new Date(fetchedAt).toISOString();source.cacheAgeMs=0;
        try {
          await mkdir(cacheDirectory,{recursive:true,mode:0o700});
          await this.writeAtomic(cachePath,{version:1,fetchedAt,payload});
        } catch { return failed({code:"cache_unavailable",message:"Geo response could not be cached; check the configured cache directory."}); }
        return {value,source,error:null};
      } catch {
        return failed({code:controller.signal.aborted ? "timeout" : "network",message:controller.signal.aborted ? "Geo request timed out." : "Geo request failed before a valid response."});
      } finally { clearTimeout(timer); }
    } catch {
      return failed({code:"cache_unavailable",message:"Geo admission/cache storage is unavailable; no usable result."});
    } finally {
      if (lock) {
        try { await lock.close(); } catch { release=false; }
        // Failed cleanup leaves admission closed rather than allowing a second request.
        if (release) { try { await unlink(lockPath); } catch { /* Operator recovery required. */ } }
      }
    }
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    const temporary=path+"."+randomUUID()+".tmp";
    try {
      const file=await open(temporary,"wx",0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary,path);
    } finally { try { await unlink(temporary); } catch { /* Preserve the original write error; an orphan temporary is disposable. */ } }
  }
}
