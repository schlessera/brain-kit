import {expect,test} from "bun:test";
import {createRequire} from "node:module";
import {join} from "node:path";
import {nativeWorkerArgvNeedsIsolation,nativeWorkerBoundary} from "../scripts/test-native-guard";
import {spawnGuardFixture} from "./helpers/native-receipt-fixture";
const guard=join(import.meta.dir,"../scripts/test-native-guard.ts"),requireSdk=createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")),runtime=requireSdk.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");

test("positively non-native readiness stand-in preserves original worker metadata",()=>{
 const env={BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/bin/true"],argv:["/bin/sh","-c","exec sleep 30"],env:{}})};
 const boundary=nativeWorkerBoundary(env);expect(boundary.native,"NON_NATIVE_STANDIN_SKIPS_NATIVE_AGREEMENT").toBe(false);expect(boundary.env).toBe(env);
 expect(nativeWorkerArgvNeedsIsolation(["/bin/sh","-c","exec sleep 30"])).toBe(false);
});
for(const mode of ["native-argv","native-command","shell-native","shell-missing","shell-dynamic","shell-nested","shell-sequence","shell-eval","supervisor-native"] as const)test(`native worker admission refuses ${mode} mismatch`,async()=>{
 const code=`import {nativeWorkerBoundary} from ${JSON.stringify(guard)};
 import {WORKER_IDENTITY_SUPERVISOR} from ${JSON.stringify(join(import.meta.dir,"../packages/ui-sdk/src/server/worker-identity-program.ts"))};
 const runtime=${JSON.stringify(runtime)},mode=${JSON.stringify(mode)};
 let command=["/bin/true"],argv=["bwrap","--",runtime];
 if(mode==="native-command"){command=[runtime];argv=["bwrap","--","/bin/true"];}
 if(mode==="shell-native")argv=["/bin/sh","-c","exec "+runtime];
 if(mode==="shell-nested")argv=["/bin/sh","-c","exec /bin/sh -c "+JSON.stringify("exec "+runtime)];
 if(mode==="shell-sequence")argv=["/bin/sh","-c","true; "+runtime];
 if(mode==="shell-eval")argv=["/bin/sh","-c",'true; eval "$ODYSSEUS_COMMAND"'];
 if(mode==="shell-missing")argv=["/bin/sh","-c","exec /odysseus-unresolvable-runtime"];
 if(mode==="shell-dynamic")argv=["/bin/sh","-c",'exec "$ODYSSEUS_RUNTIME"'];
 if(mode==="supervisor-native")argv=["/usr/bin/python3","-I","-S","-c",WORKER_IDENTITY_SUPERVISOR,JSON.stringify({argv:["bwrap","--",runtime]})];
 try{nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command,argv,env:{}})});}catch{}`;
 const child=spawnGuardFixture([process.execPath,"-e",code]);const[exit,out]=await Promise.all([child.exited,child.guardOutput()]);
 expect(exit,"NATIVE_OR_UNKNOWN_WORKER_MISMATCH_REFUSED "+mode).not.toBe(0);expect(out).toContain("worker command and executable argv disagree");
});

test("unresolvable executable and dynamic exec targets never classify as non-native",()=>{
 for(const argv of [["/odysseus-missing-executable"],["/bin/sh","-c",'exec "$ODYSSEUS_RUNTIME"'],["/bin/sh","-c","exec /odysseus-missing-executable"]])expect(nativeWorkerArgvNeedsIsolation(argv),"UNKNOWN_WORKER_EXECUTABLE_REQUIRES_ISOLATION").toBe(true);
});
