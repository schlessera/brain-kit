import { test,expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { actualNativeRuntime,researchSdkEntry } from "../scripts/evals/mechanical-hygiene/native-runtime";
import { bundledClaudeBinary } from "../packages/core/src/providers/agents/claude-binary";

test("the actual hygiene research292 pair and public backend293 pair remain independent",()=>{
  const root=process.cwd(),research=actualNativeRuntime(root,true);
  expect(research.sdk).toBe("0.3.292");expect(research.cli).toBe("2.1.292");
  const entry=researchSdkEntry(root);
  expect(JSON.parse(readFileSync(join(dirname(entry),"package.json"),"utf8")).version).toBe("0.3.292");
  const current=Bun.resolveSync("@anthropic-ai/claude-agent-sdk",join(root,"packages/ui-backend-claude/src"));
  expect(JSON.parse(readFileSync(join(dirname(current),"package.json"),"utf8")).version).toBe("0.3.293");
  const native=bundledClaudeBinary(current);expect(native).not.toBeNull();expect(native).not.toBe(research.native);
  const child=Bun.spawnSync([native!,"--version"],{env:{PATH:"/usr/bin:/bin",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"},stdout:"pipe",stderr:"pipe"});
  expect(child.exitCode).toBe(0);expect(child.stdout.toString().trim()).toBe("2.1.293 (Claude Code)");
});
