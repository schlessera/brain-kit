import {afterEach,expect,test} from "bun:test";
import {chmodSync,cpSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {diagramInstallationIdentity} from "../scripts/diagram-export-installation.mjs";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"odysseus-native-install-"));roots.push(root);mkdirSync(join(root,"node_modules/fixture-package"),{recursive:true});writeFileSync(join(root,"node_modules/fixture-package/package.json"),JSON.stringify({name:"fixture-package",version:"1.0.0"}));writeFileSync(join(root,"node_modules/fixture-package/index.js"),'export const world="Odysseus";');return root;}
test("native installed identity binds complete bytes, modes, additions and names",()=>{
 const root=fixture(),base=diagramInstallationIdentity(root);
 writeFileSync(join(root,"node_modules/fixture-package/index.js"),'export const world="Ithaca";');expect(diagramInstallationIdentity(root).sha256).not.toBe(base.sha256);
 writeFileSync(join(root,"node_modules/fixture-package/index.js"),'export const world="Odysseus";');expect(diagramInstallationIdentity(root)).toEqual(base);
 chmodSync(join(root,"node_modules/fixture-package/index.js"),0o755);expect(diagramInstallationIdentity(root).sha256).not.toBe(base.sha256);
 chmodSync(join(root,"node_modules/fixture-package/index.js"),0o644);writeFileSync(join(root,"node_modules/fixture-package/added.js"),'export const extra=true;');expect(diagramInstallationIdentity(root).sha256).not.toBe(base.sha256);
});
test("native installed identity is stable through independent snapshot package links",()=>{
 const root=fixture(),snapshot=mkdtempSync(join(tmpdir(),"odysseus-native-snapshot-"));roots.push(snapshot);mkdirSync(join(snapshot,"node_modules"));symlinkSync(join(root,"node_modules/fixture-package"),join(snapshot,"node_modules/fixture-package"),"dir");expect(diagramInstallationIdentity(snapshot)).toEqual(diagramInstallationIdentity(root));
});
test("native installed identity binds package alias and rejects escaping nested links",()=>{
 const root=fixture(),base=diagramInstallationIdentity(root);symlinkSync("./index.js",join(root,"node_modules/fixture-package/local.js"));expect(diagramInstallationIdentity(root).sha256).not.toBe(base.sha256);
 writeFileSync(join(root,"outside.js"),'export const outside=true;');symlinkSync("../../outside.js",join(root,"node_modules/fixture-package/escape.js"));expect(()=>diagramInstallationIdentity(root)).toThrow("Unsupported native dependency alias");
});
test("native installed identity excludes only roots omitted by the actual materializer",()=>{
 const root=fixture(),base=diagramInstallationIdentity(root);mkdirSync(join(root,"node_modules/.cache"));writeFileSync(join(root,"node_modules/.cache/data"),"generated unused cache");mkdirSync(join(root,"node_modules/@schlessera/brain"),{recursive:true});writeFileSync(join(root,"node_modules/@schlessera/brain/source"),"workspaces are independently owned source inputs");expect(diagramInstallationIdentity(root)).toEqual(base);
});

test("native dependency aliases cannot mix different installation origins with identical bytes",()=>{
 const root=fixture(),other=fixture();cpSync(join(root,"node_modules/fixture-package"),join(root,"node_modules/second-package"),{recursive:true});writeFileSync(join(root,"node_modules/second-package/package.json"),JSON.stringify({name:"second-package",version:"1.0.0"}));
 cpSync(join(root,"node_modules/second-package"),join(other,"node_modules/second-package"),{recursive:true});
 rmSync(join(root,"node_modules/second-package"),{recursive:true});symlinkSync(join(other,"node_modules/second-package"),join(root,"node_modules/second-package"),"dir");
 expect(()=>diagramInstallationIdentity(root)).toThrow("NATIVE_DEPENDENCY_ORIGIN_CHANGED");
});
