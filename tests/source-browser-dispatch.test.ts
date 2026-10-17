import {afterEach,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {browserImporters} from "../scripts/bound-browser-runtime-inputs";
import {sourceBrowserDispatch} from "../scripts/source-browser-dispatch";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],base="packages/ui-react/src/hooks/websocket-handlers/",owner=base+"index.ts",stats="packages/ui-react/src/lib/stats/context-text.ts";
const files=[owner,stats,...["chat","activity","mask","provider","connection","handoff"].map(name=>base+name+".ts")];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"source-browser-dispatch-"));roots.push(root);const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};symlinkSync(join(repo,"node_modules"),join(root,"node_modules"),"dir");for(const file of files)write(file,readFileSync(join(repo,file),"utf8"));return{root,write};}
test("private finite registries bind their existing predicate and copied handler source",()=>{
  const {root}=fixture(),bindings=sourceBrowserDispatch(root,files,browserImporters(root,files));
  expect(bindings.get(owner)?.has("serverMessageHandlers[msg.type](msg as never, context)")).toBe(true);
  expect(bindings.get(stats)?.has('REQUIRED[kind as StatsSection["kind"]](section as Record<string, unknown>)')).toBe(true);
});
test("an additional importer cannot mutate a handler map before the private dispatcher copies it",()=>{
  const {root,write}=fixture();write("extra.ts",`import {providerFrameHandlers} from "./${base}provider.ts"; providerFrameHandlers.session_info=external;`);
  expect(sourceBrowserDispatch(root,[...files,"extra.ts"],browserImporters(root,[...files,"extra.ts"])).has(owner)).toBe(false);
});
test("audited imports of a different chat helper cannot gain the handler map through drift",()=>{
  const {root,write}=fixture(),consumers=["packages/ui-react/src/connection.ts","packages/ui-react/src/hooks/use-websocket.ts"],selected=[...files,...consumers];
  for(const file of consumers)write(file,readFileSync(join(repo,file),"utf8"));
  expect(sourceBrowserDispatch(root,selected,browserImporters(root,selected)).has(owner)).toBe(true);
  write(consumers[0]!,readFileSync(join(repo,consumers[0]!),"utf8")+`\nimport {chatFrameHandlers} from "./hooks/websocket-handlers/chat.js"; chatFrameHandlers.text=external;\n`);
  expect(sourceBrowserDispatch(root,selected,browserImporters(root,selected)).has(owner)).toBe(false);
});
test("registry escape, owner drift and changed imported handler definitions remain unknown",()=>{
  for(const file of [owner,stats,base+"provider.ts"]){const {root,write}=fixture();write(file,readFileSync(join(root,file),"utf8")+"\n// source drift\n");expect(sourceBrowserDispatch(root,files,browserImporters(root,files)).has(file===stats?stats:owner)).toBe(false);}
  const {root,write}=fixture();write(owner,readFileSync(join(root,owner),"utf8")+"\nexport const escaped=serverMessageHandlers;\n");expect(sourceBrowserDispatch(root,files,browserImporters(root,files)).has(owner)).toBe(false);
});
test("unreviewed terminal chat handling cannot gain a trusted dispatch binding",()=>{
  const {root,write}=fixture(),chat=base+"chat.ts",text=readFileSync(join(root,chat),"utf8");
  const reviewed="context.state.endTurnQuestions(context.key, context.frameTurnId);";
  expect(text).toContain(reviewed);
  write(chat,text.replace(reviewed,"unreviewed(msg, context);"));
  expect(sourceBrowserDispatch(root,files,browserImporters(root,files)).has(owner),"UNREVIEWED_CHAT_HANDLER_REFUSED").toBe(false);
});
