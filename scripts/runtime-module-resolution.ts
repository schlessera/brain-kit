/** Explicit JavaScript executes as JavaScript, even beside TypeScript declarations. */
import {dirname,isAbsolute,resolve} from "node:path";
import ts from "typescript";
export function resolveRuntimeModule(specifier:string,containingFile:string,options:ts.CompilerOptions):ts.ResolvedModuleFull|undefined{
 const explicit=(specifier.startsWith(".")||isAbsolute(specifier))&&/\.(?:mjs|cjs|js)$/.test(specifier);
 if(explicit){
  const file=resolve(dirname(containingFile),specifier);
  if(ts.sys.fileExists(file))return{resolvedFileName:file,isExternalLibraryImport:false,
   extension:specifier.endsWith(".mjs")?ts.Extension.Mjs:specifier.endsWith(".cjs")?ts.Extension.Cjs:ts.Extension.Js};
 }
 const result=ts.resolveModuleName(specifier,containingFile,options,ts.sys).resolvedModule;
 if(explicit&&result&&/\.d\.(?:ts|mts|cts)$/.test(result.resolvedFileName))return;
 return result;
}
