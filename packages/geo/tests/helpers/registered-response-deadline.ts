import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Capture only the registered response deadline; all fixture watchdogs stay native. */
export function registeredResponseDeadline() {
  const source=readFileSync(new URL("../../src/server/io.ts",import.meta.url),"utf8").split("\n");
  const registration="timer=setTimeout(()=>controller.abort(),this.config.timeoutMs)";
  const sites=source.flatMap((line,index)=>line.includes(registration) ? [index+1] : []);
  assert.equal(sites.length,1,"GEO_ONE_RESPONSE_DEADLINE_OWNER");
  const owner=`io.ts:${sites[0]}:`;
  const setDescriptor=Object.getOwnPropertyDescriptor(globalThis,"setTimeout")!;
  const clearDescriptor=Object.getOwnPropertyDescriptor(globalThis,"clearTimeout")!;
  const nativeSet=setTimeout, nativeClear=clearTimeout;
  let primary: {callback:()=>void;handle:ReturnType<typeof setTimeout>;cleared:boolean} | undefined;
  let fired=false;
  function restore() {
    Object.defineProperty(globalThis,"setTimeout",setDescriptor);
    Object.defineProperty(globalThis,"clearTimeout",clearDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,"setTimeout"),setDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,"clearTimeout"),clearDescriptor);
  }
  try {
    Object.defineProperty(globalThis,"setTimeout",{...setDescriptor,value:(callback:(...args:unknown[])=>void,ms:number,...args:unknown[])=>{
      const caller=new Error().stack?.match(/\/geo\/src\/server\/(io\.ts:\d+:)/)?.[1];
      if(caller!==owner) return nativeSet(callback,ms,...args);
      assert.equal(ms,500,"GEO_PRODUCTION_RESPONSE_BUDGET_IS_500_MS");
      assert.equal(primary,undefined,"GEO_SINGLE_RESPONSE_DEADLINE");
      primary={callback:()=>callback(...args),handle:{} as ReturnType<typeof setTimeout>,cleared:false};
      return primary.handle;
    }});
    Object.defineProperty(globalThis,"clearTimeout",{...clearDescriptor,value:(handle:ReturnType<typeof setTimeout>)=>{
      if(primary?.handle===handle) primary.cleared=true;
      else nativeClear(handle);
    }});
  } catch(error) { restore();throw error; }
  return {
    advanceTo(ms:number) {
      assert(primary,"GEO_REGISTERED_RESPONSE_DEADLINE_CAPTURED");
      if(ms>=500 && !primary.cleared && !fired) { fired=true;primary.callback(); }
    },
    assertCleared() {
      assert(fired,"GEO_RESPONSE_DEADLINE_DELIVERED");
      assert(primary?.cleared,"GEO_RESPONSE_DEADLINE_CLEARED");
    },
    restore,
  };
}
