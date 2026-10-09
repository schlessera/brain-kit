/** Exact verified research and offline compatibility pairs; future versions are refused. */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import {hashFrozenFile} from "./frozen-file";
export const verifiedPairs={"0.3.292":"2.1.292","0.3.293":"2.1.293"} as const;
/** The original research pair is independent of the public backend's current SDK. */
export function researchSdkEntry(source:string){
  return Bun.resolveSync("claude-agent-sdk-research-292",join(source,"packages/ui-backend-claude/src"));
}
export function actualNativeRuntime(source:string,offline:boolean){
  const entry=researchSdkEntry(source);
  const sdk=JSON.parse(readFileSync(join(dirname(entry),"package.json"),"utf8")).version as keyof typeof verifiedPairs;
  const expected=verifiedPairs[sdk];if(!expected||!offline&&sdk!=="0.3.292")throw Error("Installed SDK is not the exact research/verified offline pair");
  const native=bundledClaudeBinary(entry);if(!native)throw Error("Exact installed native binary absent");
  const process=Bun.spawnSync([native,"--version"],{env:{PATH:"/usr/bin:/bin",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"},stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:3000});
  const text=process.stdout.toString().trim(),cli=/^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(text)?.[1];
  if(process.exitCode!==0||cli!==expected)throw Error("Actual native version does not match the exact verified SDK pair");
  return{sdk,cli,native:realpathSync(native),nativeSha:hashFrozenFile(native),sdkSha:hashFrozenFile(entry),offlineCompatibility:offline};
}
