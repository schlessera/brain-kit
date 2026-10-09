/** Real native write-day refusal after dispatch; fixed scripted transport only. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "./fixture";
import { workload } from "./workload";
import { installNativeSurface } from "./native-surface";
import { runNativePhase } from "./native-driver";
import { response } from "./offline-native";
async function main() {
  if(process.env.BRAIN_HYGIENE_OFFLINE!=="1")throw Error("Explicit offline namespace required");
  const destination=process.argv[2];if(!destination)throw Error("Protected output required");
  const fixture=workload.find(f=>f.id==="ogygia-mtime-day")!,env=prepare(fixture),source=new URL("../../../",import.meta.url).pathname;
  const path=Object.keys(fixture.files)[0];installNativeSurface(env.root,source,fixture);
  try {
    let physical=0;
    const receipt=await runNativePhase({root:env.root,source,destination,phase:"apply",token:`sk-ant-oat01-${"o".repeat(95)}AA`,offline:true,writeDayUTC:env.writeDayUTC,offlineWriteDayMismatchAfterDispatch:true,deadlineMs:10000,
      physicalFetch:async()=>response(++physical,{name:"Write",input:{file_path:join(env.root,path),content:fixture.expected[path]}})});
    if(readFileSync(join(env.root,path),"utf8")!==fixture.files[path])throw Error("Actual native changed a fixture file after mismatched UTC write-day admission");
    if(!receipt.tools.some(tool=>tool.name==="Write"&&!tool.allowed)||!receipt.writeDayRefused||!receipt.native.failure?.includes("UTC fixture write day"))throw Error("Actual native write-day refusal was not retained");
    if(!receipt.native.ownedChildDrained||!receipt.stdoutComplete||!receipt.stderrComplete)throw Error("Refused native writer did not really drain");
    console.log(JSON.stringify({passed:true,actualNative:true,writeDayUTC:env.writeDayUTC,writeDayRefused:true,ownedChildDrained:true,physical,externalRequests:0}));
  } finally {env.close();}
}
if(import.meta.main)await main();
