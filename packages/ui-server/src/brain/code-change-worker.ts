/** Concrete Git capture in the existing credential-free maintenance boundary. */
import { runMaintenanceWorker, type MaintenanceHost } from "@schlessera/brain-ui-sdk/internal";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { CodeChangeReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { CODE_CHANGE_PROGRAM, CODE_CHECKOUT_LIST_PROGRAM, CODE_CHANGE_PREVIEW_PROGRAM } from "./code-change-program.js";

/** Explicit in-brain checkout content bound; managed checkouts use their pool allowance. */
export const CODE_CHECKOUT_BYTES = 16 * 1024 * 1024;
/** The existing 64 MiB maintenance wire leaves room for base64 and path metadata. */
export const CODE_EVIDENCE_BYTES = 48 * 1024 * 1024;
/** Check every worker-supplied component on the sealed checkpoint without following links. */
export async function checkedCodeDirectory(root: string, relative = ""): Promise<string> {
  let path = root;
  for (const part of ["", ...relative.split("/").filter(Boolean)]) {
    if (part === "." || part === ".." || part.includes("\\")) throw Error("Invalid checkout directory");
    if (part) path = join(path, part);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Checkout path is not a real directory");
  }
  return path;
}
type CodeChangeCapture = Omit<CodeChangeReceipt, "checkout" | "state"> & { pack: string };

export async function captureCodeChanges(brainPath: string, checkout: string, previous?: { tree_before: string; pack_path: string; pack_hash: string } & { head_before?: CodeChangeReceipt["head_before"] },
  host: MaintenanceHost = {}, signal?: AbortSignal, maximum: number = CODE_CHECKOUT_BYTES): Promise<CodeChangeCapture> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid checkout capture allowance");
  const result = await runMaintenanceWorker({ ...host, brainPath, credentials: false, env: { PATH: "/usr/bin:/bin" },
    command: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, checkout, String(maximum)],
    readPaths: [checkout, ...(previous ? [previous.pack_path] : [])], stdin: JSON.stringify(previous ?? {}), outputBytes: 64 * 1024 * 1024, tempKind: "git", timeoutMs: 60_000, signal });
  if (result.exitCode !== 0 || result.killed) throw new Error(`Git change capture refused: ${result.stderr.trim().slice(-1000) || "maintenance worker failed"}`);
  const receipt = JSON.parse(result.stdout) as CodeChangeCapture;
  const oid = (value: unknown) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
  if (!oid(receipt.tree_before) || !oid(receipt.tree_after) || !oid(receipt.head_before?.commit) || !oid(receipt.head_after?.commit)
    || !Array.isArray(receipt.paths) || receipt.paths.some(item => typeof item.path !== "string" || !["added", "deleted", "modified"].includes(item.kind) || typeof item.untracked !== "boolean")
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || !Number.isSafeInteger(receipt.untracked) || typeof receipt.ignore_changed !== "boolean"
    || typeof receipt.pack !== "string" || Buffer.byteLength(receipt.pack, "base64") > CODE_EVIDENCE_BYTES || Buffer.from(receipt.pack.slice(0, 8), "base64").subarray(0, 4).toString() !== "PACK") throw new Error("Invalid Git change evidence");
  return receipt;
}

export async function listCodeCheckouts(brainPath: string, root: string, host: MaintenanceHost, signal?: AbortSignal): Promise<string[]> {
  let workspaces: string;
  try { workspaces = await checkedCodeDirectory(root, "workspaces"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result = await runMaintenanceWorker({ ...host, brainPath, credentials: false, env: { PATH: "/usr/bin:/bin" },
    command: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHECKOUT_LIST_PROGRAM, workspaces], readPaths: [workspaces],
    outputBytes: 1024 * 1024, tempKind: "git", timeoutMs: 30_000, signal });
  if (result.exitCode !== 0 || result.killed) throw new Error("Writable checkout classification is unavailable");
  const paths: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || !/^workspaces\/[^/\\\u0000]+$/.test(path) || path.endsWith("/.."))) throw new Error("Invalid checkout inventory");
  return paths as string[];
}

export async function previewCodeChanges(brainPath: string, input: { tree_before: string; tree_after: string; pack: string }, host: MaintenanceHost) {
  const result = await runMaintenanceWorker({ ...host, brainPath, credentials: false, env: { PATH: "/usr/bin:/bin" },
    command: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHANGE_PREVIEW_PROGRAM], stdin: JSON.stringify(input),
    outputBytes: 2 * 1024 * 1024, tempKind: "git", timeoutMs: 60_000 });
  if (result.exitCode !== 0 || result.killed) throw new Error("Code change preview is unavailable");
  return JSON.parse(result.stdout) as { inline: boolean; diff?: string; reason?: string };
}
