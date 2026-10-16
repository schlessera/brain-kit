import type {
  StorageStatus,
  StorageFilter,
  StorageTreeFilter,
  StoragePage,
  StorageTreePage,
  StorageReferenceEvidence,
  StorageMaintenanceRow,
  StorageMaintenanceReceipt,
  StorageMaintenanceKind,
  StorageRemovalCapability,
  StorageRemovalReceipt,
} from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { ApiRequestError } from "./api-client.js";
/** Uses the root's account-lifetime guarded request; no ambient transport or shared cache. */
export function storageApi(root: Pick<BrainUiServices, "request" | "apiBase">) {
  async function call<T>(
    path: string,
    signal?: AbortSignal,
    method = "GET",
    body?: unknown
  ): Promise<T> {
    const response = await root.request(root.apiBase() + "/storage" + path, {
      method,
      signal,
      credentials: "include",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok)
      throw new ApiRequestError(
        `Storage request failed (${response.status}).`,
        response.status
      );
    return (await response.json()) as T;
  }
  const query = (filter: StorageFilter | StorageTreeFilter) =>
    new URLSearchParams(
      Object.entries(filter)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    ).toString();
  return {
    status: (signal?: AbortSignal) => call<StorageStatus>("", signal),
    scan: (signal?: AbortSignal) =>
      call<StorageStatus>("/scans", signal, "POST", {}),
    cancelScan: (id: string, signal?: AbortSignal) =>
      call<StorageStatus>(`/scans/${encodeURIComponent(id)}`, signal, "DELETE"),
    tree: (id: string, filter: StorageTreeFilter, signal?: AbortSignal) =>
      call<StorageTreePage>(
        `/scans/${encodeURIComponent(id)}/tree?${query(filter)}`,
        signal
      ),
    files: (id: string, filter: StorageFilter, signal?: AbortSignal) =>
      call<StoragePage>(
        `/scans/${encodeURIComponent(id)}/entries?${query(filter)}`,
        signal
      ),
    references: (scan: string, entry: string, signal?: AbortSignal) =>
      call<StorageReferenceEvidence>(
        `/scans/${encodeURIComponent(scan)}/entries/${encodeURIComponent(
          entry
        )}/references`,
        signal
      ),
    maintenance: (signal?: AbortSignal) =>
      call<{ operations: StorageMaintenanceRow[] }>("/maintenance", signal),
    maintain: (
      id: string,
      operation: StorageMaintenanceKind,
      signal?: AbortSignal
    ) =>
      call<StorageMaintenanceReceipt>("/maintenance", signal, "POST", {
        id,
        operation,
      }),
    maintenanceReceipt: (id: string, signal?: AbortSignal) =>
      call<StorageMaintenanceReceipt>(
        `/maintenance/${encodeURIComponent(id)}`,
        signal
      ),
    cancelMaintenance: (id: string, signal?: AbortSignal) =>
      call<StorageMaintenanceReceipt>(
        `/maintenance/${encodeURIComponent(id)}`,
        signal,
        "DELETE"
      ),
    removal: (signal?: AbortSignal) =>
      call<StorageRemovalCapability>("/removals", signal),
    review: (id: string, paths: string[], signal?: AbortSignal) =>
      call<StorageRemovalReceipt>("/removals/reviews", signal, "POST", {
        id,
        paths,
      }),
    undo: (
      id: string,
      sourceId: string,
      paths: string[],
      signal?: AbortSignal
    ) =>
      call<StorageRemovalReceipt>("/removals/undo-reviews", signal, "POST", {
        id,
        sourceId,
        paths,
      }),
    remove: (id: string, fingerprint: string, signal?: AbortSignal) =>
      call<StorageRemovalReceipt>("/removals", signal, "POST", {
        id,
        fingerprint,
      }),
    receipt: (id: string, signal?: AbortSignal) =>
      call<StorageRemovalReceipt>(
        `/removals/${encodeURIComponent(id)}`,
        signal
      ),
    cancelRemoval: (id: string, signal?: AbortSignal) =>
      call<StorageRemovalReceipt>(
        `/removals/${encodeURIComponent(id)}`,
        signal,
        "DELETE"
      ),
  };
}
