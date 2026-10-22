export interface DiagramInstallationIdentity {version:1;packages:number;files:number;bytes:number;sha256:string;}
export function diagramInstallationIdentity(repo:string):DiagramInstallationIdentity;
