export const diagramSourceDomains: readonly string[];
export const diagramSourceSetup: readonly string[];
export function isDiagramSource(path:string):boolean;
export function materializeDiagramExportSource(repo:string,state:string,checkout?:string,expected?:{source:string;installation:string}):string;
export function diagramSourceIdentity(inputs:readonly {path:string;mode:string;sha256:string}[]):string;
