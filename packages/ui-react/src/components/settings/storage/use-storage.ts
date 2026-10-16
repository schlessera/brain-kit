import { useEffect, useMemo, useRef, useState } from "react";
import type {
  StorageFileEntry,
  StorageStatus,
  StorageSnapshot,
  StorageTreePage,
  StoragePage,
  StorageRemovalCapability,
  StorageRemovalReceipt,
  StorageRemovalFile,
  StorageReferenceEvidence,
  StorageMaintenanceRow,
  StorageMaintenanceReceipt,
  StorageMaintenanceKind,
} from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../../../root.js";
import { storageApi } from "../../../lib/storage-api.js";
import { canonicalPath, type StorageMetric } from "./storage-model.js";
export const running = (state: string | undefined) =>
  state === "waiting" || state === "running";
export interface InspectedFile {
  entry: StorageFileEntry;
  path: string | null;
  facts: StorageRemovalFile | null;
  references: StorageReferenceEvidence | null;
  unchecked: string[];
  observedAt: number | null;
  error: string | null;
}
export function useStorage(root: BrainUiRoot) {
  const api = useMemo(() => storageApi(root), [root]),
    lifetime = useRef<AbortController | null>(null),
    posting = useRef(false);
  const [status, setStatus] = useState<StorageStatus | null>(null),
    [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [capability, setCapability] = useState<StorageRemovalCapability | null>(
      null
    ),
    [maintenance, setMaintenance] = useState<StorageMaintenanceRow[]>([]);
  const [owner, setOwner] = useState<"all" | "brain" | "app">("all"),
    [metric, setMetric] = useState<StorageMetric>("allocated"),
    [parent, setParent] = useState<string | undefined>(),
    [search, setSearch] = useState("");
  const [sort, setSort] = useState<"size" | "name">("size"),
    [direction, setDirection] = useState<"asc" | "desc">("desc"),
    [cursor, setCursor] = useState<string | undefined>();
  const [filtering, setFiltering] = useState(false),
    [larger, setLarger] = useState("5"),
    [where, setWhere] = useState("content"),
    [smaller, setSmaller] = useState(false);
  const [tree, setTree] = useState<StorageTreePage | null>(null),
    [chart, setChart] = useState<StorageTreePage | null>(null),
    [files, setFiles] = useState<StoragePage | null>(null),
    [loading, setLoading] = useState(false);
  const [inspected, setInspected] = useState<InspectedFile | null>(null),
    [evidence, setEvidence] = useState<Record<string, InspectedFile>>({}),
    [selected, setSelected] = useState<Record<string, InspectedFile>>({});
  const [receipt, setReceipt] = useState<StorageRemovalReceipt | null>(null),
    [reviewOpen, setReviewOpen] = useState(false),
    [reviewChanged, setReviewChanged] = useState(false),
    [maintenanceReceipt, setMaintenanceReceipt] =
      useState<StorageMaintenanceReceipt | null>(null),
    [maintenanceId, setMaintenanceId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refreshedReceipts = useRef(new Set<string>());
  const epoch = root.authLock.epoch();
  const acceptStatus = (next: StorageStatus) => {
    setStatus(next);
    setSnapshot((previous) => previous ?? next.snapshot);
  };
  function current(controller: AbortController) {
    return (
      !controller.signal.aborted &&
      root.authLock.epoch() === epoch &&
      lifetime.current === controller
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void Promise.allSettled([
      api.status(controller.signal),
      api.removal(controller.signal),
      api.maintenance(controller.signal),
    ]).then(([inventory, removal, owners]) => {
      if (!current(controller)) return;
      if (inventory.status === "fulfilled") acceptStatus(inventory.value);
      else
        setError(
          "Storage inspection is unavailable. Human-owner access is required."
        );
      if (removal.status === "fulfilled") {
        setCapability(removal.value);
        setReceipt(removal.value.latest);
      }
      if (owners.status === "fulfilled")
        setMaintenance(owners.value.operations);
    });
    return () => controller.abort();
    // The component is keyed to root and auth epoch by StorageTab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  useEffect(() => {
    if (status?.state !== "scanning") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api
        .status(controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) acceptStatus(next);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "Measurement response unavailable. Check measurement status."
            );
        });
    }, 750);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, status]);
  const threshold = Number(larger) * 1_000_000,
    validThreshold =
      larger.trim() !== "" && Number.isSafeInteger(threshold) && threshold >= 0;
  const content = snapshot?.roots.find((row) => row.category === "content")?.id;
  useEffect(() => {
    setCursor(undefined);
    setSmaller(false);
  }, [
    owner,
    metric,
    parent,
    search,
    sort,
    direction,
    filtering,
    larger,
    where,
    snapshot?.id,
  ]);
  useEffect(() => {
    if (!snapshot || (filtering && !validThreshold)) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    if (filtering) {
      void api
        .files(
          snapshot.id,
          {
            owner: "brain",
            ...(where === "content" ? { rootId: content } : {}),
            type: "pdf",
            largerThan: threshold,
            search,
            sort,
            metric,
            direction,
            cursor,
          },
          controller.signal
        )
        .then((page) => {
          if (!controller.signal.aborted) setFiles(page);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "File observation unavailable or expired. Refresh Storage to continue."
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    } else {
      const criteria = { owner, parentId: parent, search, metric };
      void Promise.all([
        api.tree(
          snapshot.id,
          { ...criteria, sort, direction, cursor },
          controller.signal
        ),
        api.tree(
          snapshot.id,
          { ...criteria, sort: "size", direction: "desc" },
          controller.signal
        ),
      ])
        .then(([page, map]) => {
          if (!controller.signal.aborted) {
            setTree(page);
            setChart(map);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "Folder observation unavailable or incomplete. Refresh Storage to continue."
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    return () => controller.abort();
  }, [
    api,
    snapshot,
    owner,
    metric,
    parent,
    search,
    sort,
    direction,
    cursor,
    filtering,
    threshold,
    validThreshold,
    where,
    content,
  ]);
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (!controller || posting.current) return;
    posting.current = true;
    setBusy(true);
    setError(null);
    try {
      await work(controller.signal);
    } catch {
      if (current(controller))
        setError(
          "The request was not confirmed. Check the original receipt before starting another operation."
        );
    } finally {
      if (current(controller)) {
        posting.current = false;
        setBusy(false);
      }
    }
  }
  const guarded = (signal: AbortSignal) =>
    !signal.aborted && root.authLock.epoch() === epoch;
  async function inspect(entry: StorageFileEntry) {
    if (!snapshot) return;
    const path = canonicalPath(entry, snapshot.roots),
      base: InspectedFile = {
        entry,
        path,
        facts: null,
        references: null,
        unchecked: [],
        observedAt: null,
        error: null,
      };
    setInspected(base);
    await action(async (signal) => {
      const [links, review] = await Promise.allSettled([
        api.references(snapshot.id, entry.id, signal),
        path && capability?.available
          ? api.review(crypto.randomUUID(), [path], signal)
          : Promise.resolve(null),
      ]);
      if (!guarded(signal)) return;
      const record = review.status === "fulfilled" ? review.value : null;
      const result: InspectedFile = {
        ...base,
        references: links.status === "fulfilled" ? links.value : null,
        facts: record?.review.files[0] ?? null,
        unchecked: record?.review.unchecked ?? [],
        observedAt: record?.review.observedAt ?? null,
        error:
          review.status === "rejected"
            ? "Eligibility could not be verified. No removal was started."
            : null,
      };
      setEvidence((previous) => ({ ...previous, [entry.id]: result }));
      setInspected(result);
    });
  }
  function toggle(file: InspectedFile) {
    if (
      !file.facts?.eligible ||
      !file.path ||
      busy ||
      running(receipt?.state) ||
      receipt?.state === "unknown"
    )
      return;
    setSelected((previous) => {
      const next = { ...previous };
      if (next[file.entry.id]) delete next[file.entry.id];
      else if (Object.keys(next).length < (capability?.limits.items ?? 0))
        next[file.entry.id] = file;
      return next;
    });
  }
  const selection = Object.values(selected),
    selectedBytes = selection.reduce(
      (sum, file) => sum + (file.entry.logical ?? 0),
      0
    );
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setAnnouncement(
          `${selection.length} selected; ${selectedBytes} bytes file size, not space freed.`
        ),
      250
    );
    return () => clearTimeout(timer);
  }, [selection.length, selectedBytes]);
  function applyReceipt(next: StorageRemovalReceipt) {
    setReceipt((previous) =>
      previous?.review.id === next.review.id &&
      !running(previous.state) &&
      previous.state !== "unknown" &&
      previous.state !== "review" &&
      running(next.state)
        ? previous
        : next
    );
    if (!running(next.state) && next.state !== "review")
      setAnnouncement(
        `Removal operation ${next.state}. ${
          next.items.filter((item) => item.state === "removed").length
        } removed, ${
          next.items.filter((item) => item.state === "restored").length
        } restored.`
      );
  }
  useEffect(() => {
    if (!receipt || !running(receipt.state)) return;
    const controller = new AbortController(),
      id = receipt.review.id,
      timer = setTimeout(() => {
        void api
          .receipt(id, controller.signal)
          .then((next) => {
            if (!controller.signal.aborted) applyReceipt(next);
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setReceipt((previous) =>
                previous?.review.id === id
                  ? { ...previous, state: "unknown" }
                  : previous
              );
          });
      }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, receipt]);
  const overSelectionLimit =
    selectedBytes > (capability?.limits.totalBytes ?? 0);
  const newest =
    [status?.snapshot, status?.previous]
      .filter((item): item is StorageSnapshot => !!item)
      .sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
  async function reviewSelection() {
    if (
      !selection.length ||
      overSelectionLimit ||
      running(receipt?.state) ||
      receipt?.state === "unknown"
    )
      return;
    await action(async (signal) => {
      const next = await api.review(
        crypto.randomUUID(),
        selection.map((file) => file.path!),
        signal
      );
      if (!guarded(signal)) return;
      const changed = next.review.files.some((file) => {
        const old = selection.find(
          (selectedFile) => selectedFile.path === file.path
        )?.facts;
        return old?.hash !== file.hash || old?.bytes !== file.bytes;
      });
      setReviewChanged(changed);
      setReceipt(next);
      setInspected(null);
      setReviewOpen(true);
    });
  }
  async function confirm() {
    if (
      !receipt ||
      receipt.state !== "review" ||
      reviewChanged ||
      receipt.review.expiresAt <= Date.now() ||
      !receipt.review.files.some((file) => file.eligible)
    )
      return;
    const original = receipt;
    await action(async (signal) => {
      setReceipt({ ...original, state: "unknown" });
      try {
        const next = await api.remove(
          original.review.id,
          original.review.fingerprint,
          signal
        );
        if (guarded(signal)) applyReceipt(next);
      } catch {
        if (guarded(signal)) {
          setError(
            "The response was not confirmed. Read the original receipt; removal will not be retried automatically."
          );
          try {
            const next = await api.receipt(original.review.id, signal);
            if (guarded(signal)) applyReceipt(next);
          } catch {
            /* The original unknown identity remains visible. */
          }
        }
      }
    });
  }
  async function undo(path: string) {
    if (
      !receipt ||
      !receipt.items.some((item) => item.path === path && item.undoAvailable)
    )
      return;
    const source = receipt.review.id;
    await action(async (signal) => {
      const next = await api.undo(crypto.randomUUID(), source, [path], signal);
      if (guarded(signal)) {
        setReceipt(next);
        setReviewChanged(false);
        setReviewOpen(true);
      }
    });
  }
  async function maintain(operation: StorageMaintenanceKind) {
    if (
      maintenanceId &&
      (!maintenanceReceipt ||
        running(maintenanceReceipt.state) ||
        maintenanceReceipt.state === "unknown")
    )
      return;
    await action(async (signal) => {
      const id = crypto.randomUUID();
      setMaintenanceId(id);
      setMaintenanceReceipt(null);
      try {
        const next = await api.maintain(id, operation, signal);
        if (guarded(signal)) setMaintenanceReceipt(next);
      } catch {
        if (guarded(signal))
          setError(
            "Maintenance response unavailable. Check its original receipt; it will not be retried."
          );
      }
    });
  }
  useEffect(() => {
    if (!maintenanceReceipt || !running(maintenanceReceipt.state)) return;
    const controller = new AbortController(),
      id = maintenanceReceipt.id,
      timer = setTimeout(() => {
        void api
          .maintenanceReceipt(id, controller.signal)
          .then((next) => {
            if (!controller.signal.aborted) setMaintenanceReceipt(next);
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setMaintenanceReceipt((previous) =>
                previous ? { ...previous, state: "unknown" } : null
              );
          });
      }, 750);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, maintenanceReceipt]);
  useEffect(() => {
    const done = [
      receipt &&
      receipt.state !== "review" &&
      !running(receipt.state) &&
      receipt.state !== "unknown"
        ? receipt.review.id
        : null,
      maintenanceReceipt &&
      !running(maintenanceReceipt.state) &&
      maintenanceReceipt.state !== "unknown"
        ? maintenanceReceipt.id
        : null,
    ].filter((id): id is string => !!id && !refreshedReceipts.current.has(id));
    if (!done.length) return;
    const controller = new AbortController();
    void Promise.allSettled([
      api.status(controller.signal),
      api.maintenance(controller.signal),
    ]).then(([inventory, owners]) => {
      if (controller.signal.aborted) return;
      done.forEach((id) => refreshedReceipts.current.add(id));
      if (inventory.status === "fulfilled") acceptStatus(inventory.value);
      if (owners.status === "fulfilled")
        setMaintenance(owners.value.operations);
    });
    return () => controller.abort();
  }, [api, receipt, maintenanceReceipt]);
  return {
    status,
    snapshot,
    newest,
    overSelectionLimit,
    error,
    busy,
    capability,
    maintenance,
    owner,
    setOwner,
    metric,
    setMetric,
    parent,
    setParent,
    search,
    setSearch,
    sort,
    setSort,
    direction,
    setDirection,
    cursor,
    setCursor,
    filtering,
    setFiltering,
    larger,
    setLarger,
    where,
    setWhere,
    smaller,
    setSmaller,
    tree,
    chart,
    files,
    loading,
    validThreshold,
    inspected,
    setInspected,
    evidence,
    selection,
    selectedBytes,
    selected,
    toggle,
    inspect,
    receipt,
    reviewOpen,
    setReviewOpen,
    reviewChanged,
    reviewSelection,
    confirm,
    undo,
    maintenanceReceipt,
    maintenanceId,
    maintain,
    announcement,
    refresh: () =>
      action(async (signal) => {
        const next = await api.scan(signal);
        if (guarded(signal)) acceptStatus(next);
      }),
    copyList: async () => {
      try {
        await navigator.clipboard.writeText(
          (files?.entries ?? [])
            .map(
              (entry) =>
                `${
                  canonicalPath(entry, snapshot?.roots ?? []) ?? entry.path
                }\t${entry.logical ?? "Unknown"} bytes`
            )
            .join("\n")
        );
        setAnnouncement("Visible file list copied.");
      } catch {
        setError(
          "The file list could not be copied. Select and copy the visible paths instead."
        );
      }
    },
    checkStatus: () =>
      action(async (signal) => {
        const next = await api.status(signal);
        if (guarded(signal)) acceptStatus(next);
      }),
    cancelScan: () =>
      action(async (signal) => {
        if (status?.activeScanId) {
          const next = await api.cancelScan(status.activeScanId, signal);
          if (guarded(signal)) acceptStatus(next);
        }
      }),
    adopt: () => {
      if (newest) {
        setSnapshot(newest);
        setSelected({});
        setEvidence({});
        setInspected(null);
        setParent(undefined);
        setAnnouncement(
          "New measurement shown. Previous selections cleared; inspect current versions before selecting."
        );
      }
    },
    checkReceipt: () =>
      action(async (signal) => {
        if (receipt) {
          const next = await api.receipt(receipt.review.id, signal);
          if (guarded(signal)) applyReceipt(next);
        }
      }),
    cancelRemoval: () =>
      action(async (signal) => {
        if (receipt) {
          const next = await api.cancelRemoval(receipt.review.id, signal);
          if (guarded(signal)) applyReceipt(next);
        }
      }),
    checkMaintenance: () =>
      action(async (signal) => {
        if (maintenanceId) {
          const next = await api.maintenanceReceipt(maintenanceId, signal);
          if (guarded(signal)) setMaintenanceReceipt(next);
        }
      }),
    cancelMaintenance: () =>
      action(async (signal) => {
        if (maintenanceId) {
          const next = await api.cancelMaintenance(maintenanceId, signal);
          if (guarded(signal)) setMaintenanceReceipt(next);
        }
      }),
  };
}
export type StorageView = ReturnType<typeof useStorage>;
