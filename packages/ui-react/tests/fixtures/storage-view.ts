import type {
  StorageFileEntry,
  StorageSnapshot,
  StorageTreeNode,
  StorageTreePage,
  StorageRemovalReceipt,
  StorageRemovalFile,
  StorageRemovalCapability,
} from "@schlessera/brain-ui-sdk/protocol";
const id = (n: number) => n.toString(16).padStart(32, "0"),
  stamp = Date.UTC(2026, 6, 12, 9, 41),
  hash = "a".repeat(64);
export type StorageScene =
  | "dense"
  | "separate"
  | "empty"
  | "partial"
  | "unsupported"
  | "never"
  | "alias";
/** Synthetic Odysseus walkthrough. No host path, credentials or provider is needed. */
export function storageViewFixture(scene: StorageScene = "dense") {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let measured = scene !== "never",
    scanReads = 0,
    scanning = false;
  let receipt: StorageRemovalReceipt | null = null,
    changed = false,
    dropConfirm = false,
    confirms = 0;
  const files: StorageFileEntry[] = [
    ["Calypso-notes.pdf", 4_900_000],
    ["Aeaea-boundary.pdf", 5_000_000],
    ["Sirens-score.pdf", 5_100_000],
    ["Ithaca-harbor.pdf", 48_200_000],
    ["Troy-charts.PDF", 48_200_000],
  ].map(([name, logical], index) => ({
    id: id(100 + index),
    parentId: id(40),
    rootId: id(1),
    path: `attachments/${name}`,
    name: String(name),
    kind: "file",
    objectId: id(scene === "alias" && index === 4 ? 103 : 100 + index),
    version: hash,
    capacityId: id(90),
    aliasOf: scene === "alias" && index === 4 ? id(103) : null,
    logical: Number(logical),
    allocated: Number(logical) + 4096,
    links: scene === "alias" && index >= 3 ? 2 : 1,
    references: {
      state: "unchecked",
      count: null,
      observedAt: null,
      unchecked: ["external consumers"],
    },
  }));
  const roots = Array.from({ length: 12 }, (_, index) => ({
    id: id(index + 1),
    label: [
      "Brain files",
      "Git store",
      "App journal",
      "Backups",
      "Upload staging",
      "Scratch",
      "Workspaces",
      "Transcripts",
      "Index",
      "App state",
      "Temporary files",
      "Native retained store",
    ][index]!,
    category: (
      [
        "content",
        "git",
        "journal",
        "backup",
        "staging",
        "scratch",
        "workspace",
        "transcripts",
        "index",
        "database",
        "temporary",
        "native",
      ] as const
    )[index]!,
    owner: (index === 0 ||
    index === 1 ||
    index === 5 ||
    index === 6 ||
    index === 8
      ? "brain"
      : index === 3
      ? "operator"
      : "app") as "brain" | "app" | "operator",
    logical: index === 11 ? null : Math.floor(6_000_000_000 / (index + 1)),
    allocated: index === 11 ? null : Math.floor(6_000_000_000 / (index + 1)),
    coverage: index === 11 ? ("unknown" as const) : ("complete" as const),
    reason: index === 11 ? "shared-extent-attribution-unknown" : null,
  }));
  if (scene === "empty")
    for (const root of roots) {
      root.logical = 0;
      root.allocated = 0;
      root.coverage = "complete";
      root.reason = null;
    }
  const sum = (owner: string) =>
    roots
      .filter((root) => owner === "all" || root.owner === owner)
      .reduce((sum, root) => sum + (root.allocated ?? 0), 0);
  const snapshot: StorageSnapshot = {
    id: "odysseus-scan",
    startedAt: stamp - 1000,
    observedAt: stamp,
    staleAfter: stamp + 60_000,
    coverage: scene === "empty" ? "complete" : "partial",
    consistency: "live-observation",
    basis: "512 * st_blocks; shared extents may be charged more than once",
    roots,
    capacities: [
      {
        id: id(90),
        rootIds: roots.map((root) => root.id),
        total: 64_000_000_000,
        used: 40_000_000_000,
        free: 24_000_000_000,
        available: 20_000_000_000,
        provenance: "statfs",
        kind: "filesystem",
        identity: "resolved",
        quota: null,
        measured: null,
        other: null,
        reason: "shared-extent-partition-unknown",
      },
    ],
    totals: {
      all: { logical: sum("all"), allocated: sum("all"), coverage: "partial" },
      brain: {
        logical: sum("brain"),
        allocated: sum("brain"),
        coverage: "complete",
      },
      app: { logical: sum("app"), allocated: sum("app"), coverage: "partial" },
      operator: {
        logical: sum("operator"),
        allocated: sum("operator"),
        coverage: "complete",
      },
    },
    entries: 1204,
    errors:
      scene === "partial"
        ? [
            { rootId: id(1), reason: "permission-denied" },
            { rootId: id(1), reason: "entry-budget" },
          ]
        : [],
    omittedErrors: 0,
  };
  if (scene === "separate")
    snapshot.capacities.push({
      ...snapshot.capacities[0]!,
      id: id(91),
      rootIds: [id(11)],
      total: 2_000_000_000,
      used: 1_000_000_000,
      free: 1_000_000_000,
      available: 1_000_000_000,
      kind: "tmpfs",
    });
  const capability: StorageRemovalCapability = {
    available: scene !== "unsupported",
    reason:
      scene === "unsupported" ? "qualified_native_recovery_unavailable" : null,
    latest: null,
    limits: {
      items: 32,
      fileBytes: 67_108_864,
      totalBytes: 134_217_728,
      milliseconds: 300_000,
      reviewMilliseconds: 60_000,
      receiptBytes: 262_144,
      receipts: 128,
    },
  };
  function tree(
    parent: string | null,
    owner: string,
    search: string
  ): StorageTreePage {
    let nodes: StorageTreeNode[] = roots
      .filter((root) => owner === "all" || root.owner === owner)
      .map((root) => ({
        id: root.id,
        rootId: root.id,
        entry: null,
        path: "",
        name: root.label,
        kind: "root",
        owner: root.owner,
        totals: {
          logical: root.logical,
          allocated: root.allocated,
          coverage: root.coverage,
        },
        area: {
          logical: root.logical,
          allocated: root.allocated,
          coverage: root.coverage,
        },
        reason: root.reason,
      }));
    const breadcrumbs: Array<{ id: string | null; name: string }> = [
      { id: null, name: "All stores" },
    ];
    let name = "All stores";
    if (parent) {
      breadcrumbs.push({ id: id(1), name: "Brain files" });
      name = "Brain files";
      if (parent === id(40) || parent === id(41)) {
        breadcrumbs.push({ id: id(40), name: "attachments" });
        name = "attachments";
      }
      if (parent === id(41)) {
        breadcrumbs.push({ id: id(41), name: "papers" });
        name = "papers";
      }
      const next =
        parent === id(1)
          ? { id: id(40), name: "attachments" }
          : parent === id(40)
          ? { id: id(41), name: "papers" }
          : null;
      nodes = next
        ? [
            {
              ...nodes[0]!,
              ...next,
              kind: "directory",
              totals: {
                logical: 96_400_000,
                allocated: 96_400_000,
                coverage: "complete",
              },
              area: {
                logical: 96_400_000,
                allocated: 96_400_000,
                coverage: "complete",
              },
            },
          ]
        : files.map((entry) => ({
            id: entry.id,
            rootId: entry.rootId,
            entry,
            path: entry.path,
            name: entry.name,
            kind: "file",
            owner: "brain",
            totals: {
              logical: entry.logical,
              allocated: entry.allocated,
              coverage: "complete",
            },
            area: {
              logical: entry.aliasOf ? 0 : entry.logical,
              allocated: entry.aliasOf ? 0 : entry.allocated,
              coverage: "complete",
            },
            reason: null,
          }));
    }
    if (scene === "empty") nodes = [];
    nodes = nodes.filter((node) =>
      node.name.toLowerCase().includes(search.toLowerCase())
    );
    return {
      scanId: snapshot.id,
      parentId: parent,
      name,
      breadcrumbs,
      nodes,
      totals: {
        logical: nodes.reduce((sum, node) => sum + (node.area.logical ?? 0), 0),
        allocated: nodes.reduce(
          (sum, node) => sum + (node.area.allocated ?? 0),
          0
        ),
        coverage: scene === "partial" ? "partial" : "complete",
      },
      matched: nodes.length,
      nextCursor: null,
      stale: false,
    };
  }
  function facts(path: string): StorageRemovalFile {
    const file = files.find((row) => row.path === path)!;
    return {
      path,
      bytes: file.logical,
      hash: changed ? "b".repeat(64) : hash,
      eligible: file.name !== "Sirens-score.pdf" && file.links === 1,
      reason:
        file.links > 1
          ? "shared-object"
          : file.name === "Sirens-score.pdf"
          ? "outside-journal-policy"
          : null,
      git:
        file.name === "Troy-charts.PDF"
          ? "untracked"
          : file.name === "Sirens-score.pdf"
          ? "ignored"
          : "tracked",
      references:
        file.name === "Ithaca-harbor.pdf"
          ? [
              { source: "notes/voyage.md", certainty: "resolved" },
              { source: "plans/harbor.md", certainty: "possible" },
            ]
          : [],
      recovery: "requires-retention",
    };
  }
  const observe = {
    observedAt: stamp,
    coverage: "complete" as const,
    basis: snapshot.basis,
    stores: roots,
    capacities: snapshot.capacities,
    attribution: "concurrent-writers-possible" as const,
  };
  function review(body: { id: string; paths: string[]; sourceId?: string }) {
    const selected = body.paths.map(facts),reviewedAt=Date.now();
    receipt = {
      review: {
        id: body.id,
        action: body.sourceId ? "undo" : "remove",
        sourceId: body.sourceId ?? null,
        fingerprint: hash,
        observedAt: reviewedAt,
        expiresAt: reviewedAt + 600_000,
        files: selected,
        complete: false,
        unchecked: ["conversations", "other workspaces", "external consumers"],
        selectedFileBytes: selected.reduce(
          (sum, row) => sum + (row.bytes ?? 0),
          0
        ),
      },
      state: "review",
      requestedAt: stamp,
      startedAt: null,
      completedAt: null,
      reason: null,
      items: [],
      before: null,
      after: null,
      index: "not-requested",
      commit: "not-requested",
      sync: "not-requested",
      retained: {
        journal: "subject-to-retention",
        git: "unchanged-by-operation",
        backups: "not-measured",
      },
    };
    return receipt;
  }
  const request = async (
    url: string,
    init?: RequestInit
  ): Promise<Response> => {
    const parsed = new URL(url, "http://fixture.invalid"),
      path = parsed.pathname,
      method = init?.method ?? "GET",
      query = parsed.searchParams,
      body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, method, body });
    if (path === "/api/storage") {
      if (scanning && ++scanReads > 1) {
        scanning = false;
        measured = true;
      }
      return Response.json({
        version: 1,
        state: scanning ? "scanning" : "idle",
        activeScanId: scanning ? "odysseus-active" : null,
        snapshot: measured ? snapshot : null,
        previous: null,
        lastFailure: null,
        limits: {
          entries: 100_000,
          page: 200,
          roots: 32,
          milliseconds: 35_000,
          cacheBytes: 100_663_296,
        },
      });
    }
    if (path === "/api/storage/scans") {
      scanning = true;
      scanReads = 0;
      return Response.json({
        version: 1,
        state: "scanning",
        activeScanId: "odysseus-active",
        snapshot: measured ? snapshot : null,
        previous: null,
        lastFailure: null,
        limits: {
          entries: 100_000,
          page: 200,
          roots: 32,
          milliseconds: 35_000,
          cacheBytes: 100_663_296,
        },
      });
    }
    if (method === "DELETE" && path.includes("/scans/")) {
      scanning = false;
      return Response.json({
        version: 1,
        state: "idle",
        activeScanId: null,
        snapshot: measured ? snapshot : null,
        previous: null,
        lastFailure: {
          scanId: "odysseus-active",
          at: stamp,
          reason: "cancelled-or-revoked",
        },
        limits: {
          entries: 100_000,
          page: 200,
          roots: 32,
          milliseconds: 35_000,
          cacheBytes: 100_663_296,
        },
      });
    }
    if (path.endsWith("/tree"))
      return Response.json(
        tree(
          query.get("parentId"),
          query.get("owner") ?? "all",
          query.get("search") ?? ""
        )
      );
    if (path.endsWith("/entries")) {
      let selected =
        scene === "empty"
          ? []
          : files.filter(
              (file) =>
                file.logical! > Number(query.get("largerThan")) &&
                file.name
                  .toLowerCase()
                  .includes((query.get("search") ?? "").toLowerCase())
            );
      if (query.get("sort") === "name")
        selected.sort((a, b) => a.name.localeCompare(b.name));
      else
        selected.sort(
          (a, b) =>
            b[query.get("metric") === "logical" ? "logical" : "allocated"]! -
            a[query.get("metric") === "logical" ? "logical" : "allocated"]!
        );
      if (
        (query.get("direction") === "asc" && query.get("sort") !== "name") ||
        (query.get("direction") === "desc" && query.get("sort") === "name")
      )
        selected.reverse();
      const union = [
        ...new Map(selected.map((file) => [file.objectId, file])).values(),
      ];
      return Response.json({
        scanId: snapshot.id,
        entries: selected,
        nextCursor: null,
        stale: false,
        matched: selected.length,
        fileLogicalTotal: selected.reduce(
          (sum, file) => sum + file.logical!,
          0
        ),
        totals: {
          logical: union.reduce((sum, file) => sum + file.logical!, 0),
          allocated: union.reduce((sum, file) => sum + file.allocated!, 0),
          coverage: scene === "partial" ? "partial" : "complete",
        },
      });
    }
    if (path.endsWith("/references"))
      return Response.json({
        entryId: path.split("/").at(-2),
        observedAt: stamp,
        state: "observed",
        sources: [
          { path: "notes/voyage.md", indexedAt: "2026-07-12T09:41:00Z" },
        ],
        truncated: false,
        newestIndexedAt: "2026-07-12T09:41:00Z",
        freshness: "unchecked",
        unchecked: ["external consumers"],
      });
    if (path === "/api/storage/maintenance")
      return Response.json({
        operations: [
          {
            id: "pack-git",
            label: "Pack Git objects",
            owner: "core",
            scope: ["git"],
            effect: "Pack objects; history and reflogs remain.",
            available: false,
            reason: "headroom-unavailable",
            headroom: {
              requiredBytes: null,
              reservation: false,
              note: "Can grow before it shrinks; needs headroom.",
            },
            latest: null,
          },
        ],
      });
    if (path === "/api/storage/removals" && method === "GET")
      return Response.json({ ...capability, latest: receipt });
    if (path.endsWith("/reviews") || path.endsWith("/undo-reviews"))
      return Response.json(review(body));
    if (path === "/api/storage/removals" && method === "POST" && receipt) {
      confirms++;
      receipt = {
        ...receipt,
        state: "partial",
        startedAt: stamp,
        completedAt: stamp + 1000,
        items: receipt.review.files.map((file, index) => ({
          path: file.path,
          state:
            receipt!.review.action === "undo"
              ? "restored"
              : index === 0
              ? "removed"
              : "changed",
          reason: index === 0 ? null : "changed-since-review",
          undoAvailable: receipt!.review.action === "remove" && index === 0,
          undoReason: null,
        })),
        before: observe,
        after: { ...observe, observedAt: stamp + 1000 },
        index: "complete",
      };
      if (dropConfirm) {
        dropConfirm = false;
        throw new Error("Synthetic lost response after effect");
      }
      return Response.json(receipt, { status: 202 });
    }
    if (path.includes("/removals/") && receipt) return Response.json(receipt);
    return Response.json(
      { error: "Unknown synthetic request" },
      { status: 404 }
    );
  };
  return {
    request,
    requests,
    snapshot,
    files,
    get confirms() {
      return confirms;
    },
    changeVersion() {
      changed = true;
    },
    dropNextConfirmation() {
      dropConfirm = true;
    },
    get receipt() {
      return receipt;
    },
  };
}
