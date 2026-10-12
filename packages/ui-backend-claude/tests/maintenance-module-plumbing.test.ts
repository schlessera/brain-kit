import { expect, spyOn, test } from "bun:test";
import * as factory from "../src/backend";
import { backendModule } from "../src/module";
test("the existing module context carries trusted maintenance admission to backend startup",async()=>{
 const maintenance={tempLimits:{allowanceBytes:8388608,budgetBytes:16777216},tempDomain:{statePath:"/tmp/odysseus-ui.db"},maskPaths:["/tmp/odysseus-state"]};
 let received:unknown;
 const constructor=spyOn(factory,"createClaudeBackend").mockImplementation(options=>{received=options.maintenance;return {id:"claude"} as ReturnType<typeof factory.createClaudeBackend>;});
 try{
  const result=await backendModule.resolveFromEnv({brainPath:"/tmp/odysseus-workspace",config:{modelDiscovery:false},profiles:[],confirmBashPatterns:[],settings:{},maintenance});
  expect(result.ok).toBe(true);
  expect(received,"BACKEND_MODULE_SHARED_ADMISSION").toEqual(maintenance);
 }finally{constructor.mockRestore();}
});
