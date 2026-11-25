/**
 * Breakdown rows (#4546): the `StorageConsumerRow` props for one tree page.
 *
 * SQLite sidecars (`-wal`, `-shm`, `-journal`) fold into their database (a
 * #3250 requirement). Each tree node's `area` already counts a hard-linked
 * object once, so folding adds a database's own members and nothing else.
 * Unknown rows stay, with their reason; known, complete zero-byte rows are
 * hidden by default but returned, so the pane can reveal them.
 */
import type { StorageSnapshot, StorageTreeNode, StorageTreePage } from "@schlessera/brain-ui-sdk/protocol";
import {
  storageUnknownReason,
  type StorageConsumerRowProps,
  type StorageSortDirection,
  type StorageSortKey,
} from "@schlessera/brain-ui-kit";
import { bytes, type StorageMetric } from "./storage-model.js";

const SIDECAR = /-(wal|shm|journal)$/;
/** The database a sidecar name belongs to, or `null` for any other name. */
export function sidecarBase(name: string): string | null {
  return SIDECAR.test(name) ? name.replace(SIDECAR, "") : null;
}
/** Labels with each sidecar folded into its database, when the database is listed. */
export function foldSidecarLabels(labels: readonly string[]): string[] {
  const present = new Set(labels);
  return [
    ...new Set(
      labels.filter((label) => {
        const base = sidecarBase(label);
        return base === null || !present.has(base);
      })
    ),
  ];
}

interface StorageConsumerMember {
  id: string;
  name: string;
  /** `null` when this member's size was not measured. */
  bytes: number | null;
  coverage: StorageTreeNode["area"]["coverage"];
}

/** One row: the kit's props without callbacks, plus what the pane keys on. */
interface StorageConsumer extends Omit<StorageConsumerRowProps, "onActivate" | "highlighted" | "onHighlight"> {
  id: string;
  /** The node the row opens: the database for a folded row. */
  nodeId: string;
  /** In the active basis. `null` when nothing is known; a lower bound when `atLeast`. */
  bytes: number | null;
  /** The database and its folded sidecars; one entry for any other row. */
  members: StorageConsumerMember[];
  /** A hard-linked alias: its size is real, its area already counted in another row. */
  shared?: boolean;
}

interface StorageConsumerRows {
  /** Ranked rows to draw, unknown sizes last. */
  rows: StorageConsumer[];
  /** Known, complete, zero-byte rows: hidden by default, ranked the same way. */
  empty: StorageConsumer[];
}

const KIND: Record<StorageTreeNode["kind"], string> = {
  root: "store",
  directory: "folder",
  file: "file",
  symlink: "link",
  special: "special file",
  metadata: "folder metadata",
};

function sizeOf(members: readonly StorageConsumerMember[]) {
  const known = members.filter((member) => member.bytes !== null);
  // A lower bound keeps what is known; nothing known stays unknown, never 0.
  const value = known.length ? known.reduce((sum, member) => sum + member.bytes!, 0) : null;
  const complete = known.length === members.length && members.every((member) => member.coverage === "complete");
  return { value, complete };
}

function reasonFor(node: StorageTreeNode, inventory: StorageSnapshot | null | undefined, complete: boolean, known: boolean) {
  if (complete) return undefined;
  const error = node.kind === "root" ? inventory?.errors.find((value) => value.rootId === node.rootId)?.reason : undefined;
  const reason = node.reason ?? error ?? (known ? "partial" : null);
  return storageUnknownReason(reason);
}

/**
 * Ranked rows for one page in one basis. `sort` follows the list header:
 * size descending by default; an unknown size stays last either way.
 */
export function storageConsumerRows(
  page: StorageTreePage,
  metric: StorageMetric,
  options: {
    inventory?: StorageSnapshot | null;
    sort?: { key: StorageSortKey; direction: StorageSortDirection };
    format?: (value: number) => string;
  } = {}
): StorageConsumerRows {
  const format = options.format ?? ((value: number) => bytes(value));
  const sort = options.sort ?? { key: "size", direction: "descending" };
  const folded = new Map<string, StorageTreeNode[]>();
  // A store's sidecar is its own root with the same owner; a file's sits
  // beside it in the same root.
  const database = (node: StorageTreeNode, base: string) =>
    page.nodes.find(
      (value) =>
        value.name === base &&
        (node.kind === "root"
          ? value.kind === "root" && value.owner === node.owner
          : value.kind === "file" && value.rootId === node.rootId)
    );
  for (const node of page.nodes) {
    const base = sidecarBase(node.name);
    const owner = base === null ? undefined : database(node, base);
    const key = owner?.id ?? node.id;
    folded.set(key, [...(folded.get(key) ?? []), node]);
  }
  const category = (node: StorageTreeNode) =>
    node.kind === "root" ? options.inventory?.roots.find((root) => root.id === node.rootId)?.category : undefined;
  const all = [...folded.entries()].map(([id, nodes]): StorageConsumer => {
    const head = nodes.find((node) => node.id === id) ?? nodes[0]!;
    const members = nodes
      .slice()
      .sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : a.name.localeCompare(b.name)))
      .map((node) => ({ id: node.id, name: node.name, bytes: node.area[metric], coverage: node.area.coverage }));
    const { value, complete } = sizeOf(members);
    const sidecars = members.slice(1).map((member) => member.name.slice(head.name.length));
    // A hard-linked alias: its object is already counted in another row's
    // area, so it adds no area here, but its own size is real (storage.md).
    const own = head.totals[metric];
    const shared = members.length === 1 && value === 0 && own !== null && own > 0;
    const meta = [category(head), sidecars.length ? `with ${sidecars.join(", ")}` : undefined, shared ? "Shared · counted once" : undefined]
      .filter(Boolean)
      .join(" · ");
    const row: StorageConsumer = {
      id,
      nodeId: head.id,
      name: head.name,
      owner: head.owner,
      action: head.kind === "root" || head.kind === "directory" ? "drill" : "inspect",
      kind: KIND[head.kind],
      size: value === null ? null : format(shared ? own! : value),
      bytes: value,
      members,
    };
    if (meta) row.meta = meta;
    if (shared) row.shared = true;
    if (value !== null && !complete) row.atLeast = true;
    const reason = reasonFor(head, options.inventory, complete, value !== null);
    if (reason) row.reason = reason;
    return row;
  });
  const largest = Math.max(0, ...all.map((row) => row.bytes ?? 0));
  for (const row of all)
    if (row.bytes !== null && largest > 0) {
      row.share = row.bytes / largest;
      row.shareLabel = `${Math.round(row.share * 100)}% of largest`;
    }
  const direction = sort.direction === "ascending" ? 1 : -1;
  const ranked = all.sort((a, b) => {
    if (a.bytes === null && b.bytes !== null) return 1;
    if (b.bytes === null && a.bytes !== null) return -1;
    if (sort.key === "size" && a.bytes !== null && b.bytes !== null && a.bytes !== b.bytes)
      return direction * (a.bytes - b.bytes);
    const byName = a.name.localeCompare(b.name);
    return (sort.key === "name" ? direction : 1) * byName || a.id.localeCompare(b.id);
  });
  const isEmpty = (row: StorageConsumer) => row.bytes === 0 && !row.atLeast && !row.reason && !row.shared;
  return { rows: ranked.filter((row) => !isEmpty(row)), empty: ranked.filter(isEmpty) };
}
