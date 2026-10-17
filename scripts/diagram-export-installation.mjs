/** Finite installed bytes actually exposed to the private native export view. */
import {createHash} from "node:crypto";
import {lstatSync,readFileSync,readdirSync,readlinkSync,realpathSync} from "node:fs";
import {isAbsolute,join,relative} from "node:path";
/** Top-level aliases select packages; internal relative file links are bounded.
 * Escaping/directory aliases and special files stay unsupported. */
export function diagramInstallationIdentity(repo){
 const hash=createHash("sha256");let files=0,bytes=0,packages=0,installationRoot;
 const walk=(base,path)=>{
  const absolute=path?join(base,path):base,stat=lstatSync(absolute);
  if(stat.isSymbolicLink()){
   const target=readlinkSync(absolute),real=realpathSync(absolute);
   if(isAbsolute(target)||!real.startsWith(base+"/")||!lstatSync(real).isFile())throw Error("Unsupported native dependency alias");
   hash.update(JSON.stringify([path,"link",target,relative(base,real)])+"\n");return;
  }
  if(stat.isDirectory()){
   hash.update(JSON.stringify([path,"directory",stat.mode&0o777])+"\n");
   for(const name of readdirSync(absolute).sort())walk(base,path?`${path}/${name}`:name);
  }else if(stat.isFile()){
   if(++files>250000||(bytes+=stat.size)>8*1024**3)throw Error("Unbounded native dependency inventory");
   hash.update(JSON.stringify([path,"file",stat.mode&0o777,createHash("sha256").update(readFileSync(absolute)).digest("hex")])+"\n");
  }else throw Error("Unsupported native dependency entry");
 };
 for(const top of readdirSync(join(repo,"node_modules")).sort()){
  if(top.startsWith("."))continue;
  const names=top.startsWith("@")?readdirSync(join(repo,"node_modules",top)).sort().map(child=>`${top}/${child}`):[top];
  for(const name of names){
   if(name.startsWith("@schlessera/"))continue;
   if(++packages>10000)throw Error("Unbounded native dependency packages");
   const base=realpathSync(join(repo,"node_modules",name));
   if(!base.endsWith("/"+name))throw Error("NATIVE_DEPENDENCY_ORIGIN_CHANGED");
   const origin=base.slice(0,-name.length-1);
   if(installationRoot!==undefined&&installationRoot!==origin)throw Error("NATIVE_DEPENDENCY_ORIGIN_CHANGED");
   installationRoot=origin;
   const manifest=JSON.parse(readFileSync(join(base,"package.json"),"utf8"));
   if(typeof manifest.name!=="string"||!manifest.name||typeof manifest.version!=="string")throw Error("Unsupported native dependency identity");
   hash.update(JSON.stringify([name,manifest.name,manifest.version])+"\n");walk(base,"");
  }
 }
 return{version:1,packages,files,bytes,sha256:hash.digest("hex")};
}
