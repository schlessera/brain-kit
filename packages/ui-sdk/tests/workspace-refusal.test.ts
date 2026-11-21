import {expect,test} from "bun:test";
import {workspaceWriteRefusal} from "../src/server/workspace-refusal.js";
import type {WorkerSandbox} from "../src/server/worker-sandbox.js";
const sentence="If this write was under workspaces/, the checkout is read-only in this turn: switch on code changes for this session (applies from the next message) or use a managed worktree.";
const sandbox:WorkerSandbox={brain:"/srv/odysseus-brain",profile:"strict",restricted:false,scratchAliasesRemoved:[],areas:[{name:"workspaces",rel:"workspaces",mount:{writable:false,readOnlyPath:"/srv/odysseus-brain/workspaces",reason:"inspection"}}]};
test.each([
 ["mkdir workspaces/ithaca/build","mkdir: cannot create directory 'workspaces/ithaca/build': Read-only file system"],
 ["mkdir -p workspaces/ithaca/build","mkdir: cannot create directory 'workspaces/ithaca/build': Read-only file system"],
 ["git add raft.md","fatal: Unable to create 'workspaces/ithaca/.git/index.lock': Read-only file system"],
 ["npm install","npm error code EROFS\nnpm error syscall mkdir"],
 ["touch /outside/raft.md","touch: cannot touch '/outside/raft.md': Read-only file system"],
])("inspection remedy is conditional and independent of operands: %s",(command,error)=>{
 expect(workspaceWriteRefusal(sandbox,"bash",{command},undefined,error),"EXACT_CONDITIONAL_REMEDY_FOR_EVERY_READ_ONLY_FAILURE").toBe(sentence);
});
test.each(["Write","write_file","mcp__brain__brain_write"])("file and host results receive the same conditional remedy: %s",tool=>{
 expect(workspaceWriteRefusal(sandbox,tool,{},undefined,{isError:true,content:[{type:"text",text:JSON.stringify({ok:false,message:"workspaces/ is read-only"})}]}),"STRUCTURED_FILE_AND_HOST_FAILURES_USE_THE_FIXED_SENTENCE").toBe(sentence);
});
test("remedy needs inspection and a read-only failure, and is appended once",()=>{
 for(const areas of [[],[{name:"workspaces" as const,rel:"workspaces",mount:{writable:false as const,missing:true as const,reason:"absent"}}],[{name:"workspaces" as const,rel:"workspaces",mount:{writable:true as const,path:"/srv/odysseus-brain/workspaces"}}]])expect(workspaceWriteRefusal({...sandbox,areas},"bash",{},undefined,"EROFS")).toBeUndefined();
 expect(workspaceWriteRefusal(sandbox,"bash",{},undefined,"assertion failed")).toBeUndefined();expect(workspaceWriteRefusal(sandbox,"bash",{},undefined,sentence)).toBeUndefined();
});
