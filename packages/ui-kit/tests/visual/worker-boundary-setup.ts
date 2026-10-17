import {afterEach,aroundAll,inject} from "vitest";
import {installWorkerBoundary} from "../../../../scripts/browser-worker-boundary.js";

// Runs before product imports. The complete selected source capability is
// separately audited; new callers/realms/data require fresh execution and audit.
declare module "vitest" {interface ProvidedContext {proofWorkerMode:string;}}
const mode=inject("proofWorkerMode");
if(mode==="selected-zero-v1"){
 const boundary=installWorkerBoundary(globalThis);
 afterEach(()=>boundary.assert("after test hooks"));
 aroundAll(async runSuite=>{
  try{
    await runSuite();
  }finally{
    try{
      // aroundAll encloses afterAll, returned beforeAll cleanups and file
      // fixture cleanup in the pinned Vitest runner. Caught app errors cannot
      // hide an attempt in any of those hooks.
      boundary.assert("after suite cleanup");
      console.info("P02126_WORKER_BOUNDARY",JSON.stringify({document:location.href,attempts:boundary.count(),version:1}));
    }finally{boundary.restore();}
  }
 });
}else if(mode!=="fresh-worker-runtime-v1")throw new Error("Unknown browser Worker proof mode");
