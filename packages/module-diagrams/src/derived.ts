import { createHash } from "node:crypto";
export const BUILD_GENERATOR="brain-diagram-build-v1";
export function sourceHash(value:string):string{return createHash("sha256").update(value).digest("hex");}
export interface DerivedIdentity {id:string;source:string;document:string}
export function markDerived(svg:string,identity:DerivedIdentity):string {
 if(!/^[a-z][a-z0-9-]{0,79}$/.test(identity.id)||![identity.source,identity.document].every(value=>/^[a-f0-9]{64}$/.test(value)))throw Error("Invalid derived identity");
 return svg.replace(/(<svg[^>]*>)/,`$1<metadata data-generator="${BUILD_GENERATOR}" data-id="${identity.id}" data-source="${identity.source}" data-document="${identity.document}"></metadata>`);
}
export function derivedIdentity(svg:string):DerivedIdentity|null {
 const match=/<metadata data-generator="brain-diagram-build-v1" data-id="([a-z][a-z0-9-]{0,79})" data-source="([a-f0-9]{64})" data-document="([a-f0-9]{64})"><\/metadata>/.exec(svg);return match?{id:match[1]!,source:match[2]!,document:match[3]!}:null;
}
