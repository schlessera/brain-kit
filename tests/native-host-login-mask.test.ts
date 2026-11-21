import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import ts from "typescript";
import {prepareWorkerSandbox,workerCommand} from "../packages/ui-sdk/src/server/worker-launcher";
import {workerPlanMasksHostLogin} from "../packages/ui-backend-claude/tests/helpers/native-host-login-mask";
test("actual turn runner puts the host login mask on the production worker plan",()=>{
 const root=mkdtempSync("/var/tmp/odysseus-host-login-plan-"),brain=join(root,"brain"),home=join(root,"outside-home"),config=join(home,".claude"),login=join(config,".credentials.json");
 mkdirSync(brain);mkdirSync(config,{recursive:true});writeFileSync(login,"odysseus-synthetic-login");
 try{
  const file=join(import.meta.dir,"../packages/ui-backend-claude/src/turn-runner.ts"),source=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  let fn:ts.FunctionDeclaration|undefined;function visit(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name?.text==="buildSdkTurn")fn=node;ts.forEachChild(node,visit);}visit(source);expect(fn).toBeDefined();
  const js=ts.transpileModule(fn!.getText(source)+';return buildSdkTurn;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const build=new Function("createClaudeSdkTurn","VOICE_ALLOWED_TOOLS","DEFAULT_ALLOWED_TOOLS",js)((input:unknown)=>input,[],[]);
  const built=build({options:{backend:{}}},{req:{workerSandbox:{maskPaths:[]}},profile:{},abortController:new AbortController()},{egress:{dir:"/run/odysseus-test-relay"},baseUrl:"http://localhost",hostLogin:{mask:[login]}},undefined);
  const sandbox=prepareWorkerSandbox(brain,{profile:"governed",areas:[],maskPaths:built.req.workerSandbox.maskPaths});
  expect(sandbox.profile,sandbox.fallbackReason).toBe("governed");
  const argv=workerCommand({brainPath:brain,sandbox,env:{},command:["/bin/true"]});
  expect(workerPlanMasksHostLogin(argv,login),"OUTSIDE_MASKS_PRODUCTION_LOGIN_MASK_PRESENT").toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
