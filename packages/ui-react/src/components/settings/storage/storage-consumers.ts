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
  type StorageMapLegendOwner,
  type StorageSortDirection,
  type StorageSortKey,
} from "@schlessera/brain-ui-kit";
import { bytes, foldSidecars, sidecarBase, type StorageMetric } from "./storage-model.js";

export { sidecarBase };
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
  /** Why this member's size is unknown or a lower bound; absent when it is complete. */
  reason?: string;
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

/** A node's own reason, or for a store the scan's error for its root. */
function causeOf(node: StorageTreeNode, inventory: StorageSnapshot | null | undefined): string | null {
  const error = node.kind === "root" ? inventory?.errors.find((value) => value.rootId === node.rootId)?.reason : undefined;
  return node.reason ?? error ?? null;
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
  const folded = foldSidecars(page.nodes);
  const category = (node: StorageTreeNode) =>
    node.kind === "root" ? options.inventory?.roots.find((root) => root.id === node.rootId)?.category : undefined;
  const all = [...folded.entries()].map(([id, nodes]): StorageConsumer => {
    const head = nodes.find((node) => node.id === id) ?? nodes[0]!;
    const members = nodes
      .slice()
      .sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : a.name.localeCompare(b.name)))
      .map((node) => {
        const member: StorageConsumerMember = { id: node.id, name: node.name, bytes: node.area[metric], coverage: node.area.coverage };
        if (member.bytes === null || member.coverage !== "complete")
          member.reason = storageUnknownReason(causeOf(node, options.inventory) ?? (member.bytes !== null ? "partial" : null));
        return member;
      });
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
      // A folder's own metadata has no entry to inspect: its row is text.
      action: head.kind === "root" || head.kind === "directory" ? "drill" : head.kind === "metadata" ? "none" : "inspect",
      kind: KIND[head.kind],
      size: value === null ? null : format(shared ? own! : value),
      bytes: value,
      members,
    };
    if (meta) row.meta = meta;
    if (shared) row.shared = true;
    if (value !== null && !complete) row.atLeast = true;
    if (!complete) {
      // The database's own reason first, then the first folded member's: an
      // unreadable sidecar is why a readable database's row is incomplete.
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const cause = members.map((member) => causeOf(byId.get(member.id)!, options.inventory)).find((value) => value !== null);
      row.reason = storageUnknownReason(cause ?? (value !== null ? "partial" : null));
    }
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

/**
 * The rows the list draws and the legend counts, for one page. With `shown`,
 * the ids the map draws as tiles of their own, only what the map gathers
 * into "N smaller items" is listed.
 */
export function storageListing(
  derived: StorageConsumerRows,
  options: { shown?: ReadonlySet<string> | null; showEmpty?: boolean } = {}
): StorageConsumer[] {
  const drawn = (nodeId: string) => !!options.shown?.has(nodeId);
  return [...derived.rows, ...(options.showEmpty ? derived.empty : [])].filter((row) => !drawn(row.nodeId));
}

/**
 * The ownership legend for one page: the owners present with their totals,
 * and the unknown rows the legend's `?` chip counts and jumps to. `cursor` is
 * the cursor the page was fetched with; `nextCursor` is the page's own.
 *
 * An owner's total counts the page's every row, never the "smaller items"
 * subset `shown` leaves listed, and only when the page is the whole folder.
 * A folder of more pages has no complete per-owner evidence on any one of
 * them, so its owners print without a total.
 */
export function storageLegend(
  derived: StorageConsumerRows,
  options: { cursor?: string; nextCursor: string | null; shown?: ReadonlySet<string> | null; showEmpty?: boolean }
): { owners: StorageMapLegendOwner[]; unknown: StorageConsumer[] } {
  const all = storageListing(derived, { showEmpty: options.showEmpty ?? false });
  const whole = !options.cursor && options.nextCursor === null;
  const owners = (["brain", "app", "operator"] as const)
    .filter((owner) => all.some((row) => row.owner === owner))
    .map((owner): StorageMapLegendOwner => {
      if (!whole) return { owner, total: undefined };
      const mine = all.filter((row) => row.owner === owner);
      const sum = mine.reduce((total, row) => total + (row.bytes ?? 0), 0);
      const partial = mine.some((row) => row.bytes === null || row.atLeast);
      // A measured zero is "none"; an owner with unknown stores has only a lower bound, or none.
      const total = sum > 0 ? `${partial ? "≥ " : ""}${bytes(sum)}` : partial ? undefined : "none";
      return { owner, total };
    });
  const listed = storageListing(derived, { shown: options.shown ?? null, showEmpty: options.showEmpty ?? false });
  return { owners, unknown: listed.filter((row) => row.bytes === null) };
}
