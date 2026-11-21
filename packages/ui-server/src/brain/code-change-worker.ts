/** Concrete Git capture in the existing credential-free maintenance boundary. */
import { runMaintenanceWorker, type MaintenanceHost } from "@schlessera/brain-ui-sdk/internal";
import type { CodeChangeReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { CODE_CHANGE_PROGRAM, CODE_CHECKOUT_LIST_PROGRAM, CODE_CHANGE_PREVIEW_PROGRAM } from "./code-change-program.js";

/** Capture transport ceiling; oversized checkouts retain file coverage and refuse a receipt grant. */
export const CODE_CHECKOUT_BYTES = 16 * 1024 * 1024;
type CodeChangeCapture = Omit<CodeChangeReceipt, "checkout" | "state"> & { pack: string };

export async function captureCodeChanges(brainPath: string, checkout: string, previous?: Pick<CodeChangeCapture, "tree_before" | "pack"> & { head_before?: CodeChangeReceipt["head_before"] },
  host: MaintenanceHost = {}, signal?: AbortSignal): Promise<CodeChangeCapture> {
  const result = await runMaintenanceWorker({ ...host, brainPath, credentials: false, env: { PATH: "/usr/bin:/bin" },
    command: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHANGE_PROGRAM, checkout, String(CODE_CHECKOUT_BYTES)],
    readPaths: [checkout], stdin: JSON.stringify(previous ?? {}), outputBytes: 64 * 1024 * 1024, tempKind: "git", timeoutMs: 60_000, signal });
  if (result.exitCode !== 0 || result.killed) throw new Error(`Git change capture refused: ${result.stderr.trim().slice(-1000) || "maintenance worker failed"}`);
  const receipt = JSON.parse(result.stdout) as CodeChangeCapture;
  const oid = (value: unknown) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
  if (!oid(receipt.tree_before) || !oid(receipt.tree_after) || !oid(receipt.head_before?.commit) || !oid(receipt.head_after?.commit)
    || !Array.isArray(receipt.paths) || receipt.paths.some(item => typeof item.path !== "string" || !["added", "deleted", "modified"].includes(item.kind) || typeof item.untracked !== "boolean")
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || !Number.isSafeInteger(receipt.untracked) || typeof receipt.ignore_changed !== "boolean"
    || typeof receipt.pack !== "string" || Buffer.from(receipt.pack, "base64").subarray(0, 4).toString() !== "PACK") throw new Error("Invalid Git change evidence");
  return receipt;
}

export async function listCodeCheckouts(brainPath: string, root: string, host: MaintenanceHost, signal?: AbortSignal): Promise<string[]> {
  const result = await runMaintenanceWorker({ ...host, brainPath, credentials: false, env: { PATH: "/usr/bin:/bin" },
    command: ["/usr/bin/python3", "-I", "-S", "-c", CODE_CHECKOUT_LIST_PROGRAM, root], readPaths: [root],
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
