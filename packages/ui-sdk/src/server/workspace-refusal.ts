/** Explain a failed tool result; the kernel and host routes enforce writes. */
import { WORKSPACES_WRITE_REFUSAL } from "@schlessera/brain-common/internal/worker-areas";
import type { WorkerSandbox } from "./worker-sandbox.js";
import { textParts } from "./content-text.js";

export function workspaceWriteRefusal(sandbox: WorkerSandbox | undefined, _toolName: string, _input: unknown, _cwd?: string, failure?: unknown): string | undefined {
  if (!sandbox?.areas.some(area => area.name === "workspaces" && !area.mount.writable && area.mount.readOnlyPath) || failure == null) return;
  const detail = failure as { code?: unknown; stderr?: unknown; error?: unknown; message?: unknown; content?: unknown };
  const parts = textParts(detail.content);
  const text = typeof failure === "string" ? failure : [...parts, detail.code, detail.stderr, detail.error, detail.message].filter(value => typeof value === "string").join("\n");
  if (text.includes(WORKSPACES_WRITE_REFUSAL) || !/\bEROFS\b|read[- ]only/iu.test(text)) return;
  return WORKSPACES_WRITE_REFUSAL;
}
