/** Narrow native text slots in full author-provisional logs; never semantic approval. */
import type { EffectApproval } from "./effects";
export interface NativeFix { path: string; fix: string }
export function projectNativeLogDescriptions(provisional: EffectApproval, expectedChangedPaths: string[], input: unknown) {
  if (!Array.isArray(input) || input.length !== expectedChangedPaths.length) throw Error("Fixed path cardinality differs from approved source effects");
  const fixes: NativeFix[] = input.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "fix,path") throw Error("Malformed native fixed receipt");
    const {path,fix}=value;
    if(typeof path!=="string"||typeof fix!=="string"||!fix.trim()||fix.length>1600)throw Error("Unbounded native fix text or path");
    return {path,fix};
  });
  const paths=fixes.map(f=>f.path);
  if(new Set(paths).size!==paths.length||JSON.stringify([...paths].sort())!==JSON.stringify([...expectedChangedPaths].sort()))throw Error("Native fixed receipt claims a different source effect");
  const expected:EffectApproval=structuredClone(provisional);
  if(fixes.length){
    const path="context/hygiene/last-run.md", entry=expected[path];
    if(!entry)throw Error("Complete last-run expectation is missing");
    let text=Buffer.from(entry.bytesBase64,"base64").toString("utf8");
    // Exact independently reviewed slots are replaced, never the observed log.
    // Match the authored projection description once per known changed path.
    for(const fix of fixes){
      const slot=`- \`${fix.path}\`: Mechanical prototype repair`;
      if(text.split(slot).length!==2)throw Error("Expected literal fix-description slot is absent or ambiguous");
      text=text.replace(slot,`- \`${fix.path}\`: ${fix.fix.replace(/\s+/g," ").trim()}`);
    }
    expected[path]={...entry,bytesBase64:Buffer.from(text).toString("base64")};
  }
  return {expected,descriptions:fixes,descriptionSemanticApproval:false as const};
}
