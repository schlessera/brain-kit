export const diagramProducerImage:string;
export const diagramProducerImageIdentity:string;
export function diagramProducerRuntime():{image:string;bun:string;executable:string;bytes:Uint8Array;sha256:string};
export function prepareDiagramNativeArtifacts(repo:string,projects:string[],expected?:{source:string;installation:string;runtime?:string}):string|undefined;
