export interface DiagramSourceArchive {
 version:2; sourceIdentity:string; installation:import("./diagram-export-installation.mjs").DiagramInstallationIdentity; immutable:boolean; checkout:string|null; base:string; domains:string[];
 inputs:{path:string;mode:string;sha256:string;bytes:string}[];
}
export function prepareDiagramExportSource(repo:string,immutable?:boolean,expected?:{source:string;installation:string}):DiagramSourceArchive;
