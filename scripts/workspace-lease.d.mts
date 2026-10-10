export function ensureWorkspaceLease(root: string, mode: "read" | "write", entry?: "test"): Promise<number | undefined>;
export function inheritWorkspaceLease<T>(options: T, defaultStderr?: "pipe" | "inherit", pipeOnly?: boolean): T;
export function workspaceTestAccess(): "read" | "write";
