export function ensureWorkspaceLease(root: string, mode: "read" | "write", entry?: "test"): Promise<number | undefined>;
export function inheritWorkspaceLease<T>(options: T, defaultStderr?: "pipe" | "inherit", pipeOnly?: boolean): T;
export function workspaceTestAccess(): "read" | "write";
export function processIdentity(pid: number): { parent: number; start: string } | undefined;
export function liveAncestor(ownerPid: number, ownerStart: string): boolean;
export interface WorkspaceLeaseIdentity {
  mode: "read" | "write";
  root: string;
  rootDev: number;
  rootIno: number;
  dev: number;
  ino: number;
  ownerPid: number;
  ownerFd: number;
  ownerStart: string;
}
export function workspaceLeaseIdentity(root: string): WorkspaceLeaseIdentity | undefined;
