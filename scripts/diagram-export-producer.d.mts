export const diagramProducerImage:string;
export const diagramProducerImageIdentity:string;
export function diagramProducerRuntime():{image:string;bun:string;executable:string;bytes:Uint8Array;sha256:string};
export function prepareDiagramNativeArtifacts(repo:string,projects:string[],expected?:{source:string;installation:string;runtime?:string}):string|undefined;

export function diagramNativeDockerArgs(repo: string, source: string, runtime: { image: string }, volumes: { source: string; modules: string; output: string; runtime: string }, container: string, program: string): string[];
