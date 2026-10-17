export interface DiagramSourceArchive {
 version:1; immutable:boolean; checkout:string|null; base:string; domains:string[];
 inputs:{path:string;mode:string;sha256:string;bytes:string}[];
}
export function prepareDiagramExportSource(repo:string,immutable?:boolean):DiagramSourceArchive;
