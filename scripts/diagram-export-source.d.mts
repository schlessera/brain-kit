export const diagramSourceDomains: readonly string[];
export const diagramSourceSetup: readonly string[];
export function isDiagramSource(path:string):boolean;
export function materializeDiagramExportSource(repo:string,state:string,checkout?:string):string;
