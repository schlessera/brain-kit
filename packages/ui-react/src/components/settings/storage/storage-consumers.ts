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
  /**
   * The folded members other than the database, each a row of its own with
   * its own action. The map keeps a tile per member, so the list reaches
   * every member too; their bytes are already in this row's size.
   */
  parts?: StorageConsumer[];
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
  const folded = new Map<string, StorageTreeNode[]>();
  // A store's sidecar is its own root with the same owner; a file's is a file
  // beside it in the same root. A folder or link with a sidecar name is not one.
  const database = (node: StorageTreeNode, base: string) =>
    page.nodes.find(
      (value) =>
        value.name === base &&
        (node.kind === "root"
          ? value.kind === "root" && value.owner === node.owner
          : node.kind === "file" && value.kind === "file" && value.rootId === node.rootId)
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
      action: head.kind === "root" || head.kind === "directory" ? "drill" : "inspect",
      kind: KIND[head.kind],
      size: value === null ? null : format(shared ? own! : value),
      bytes: value,
      members,
    };
    if (nodes.length > 1)
      row.parts = members.slice(1).map((member): StorageConsumer => {
        const node = nodes.find((value) => value.id === member.id)!;
        const part: StorageConsumer = {
          id: node.id,
          nodeId: node.id,
          name: node.name,
          owner: node.owner,
          action: node.kind === "root" || node.kind === "directory" ? "drill" : "inspect",
          kind: KIND[node.kind],
          meta: `part of ${head.name}`,
          size: member.bytes === null ? null : format(member.bytes),
          bytes: member.bytes,
          members: [member],
        };
        if (member.bytes !== null && member.coverage !== "complete") part.atLeast = true;
        if (member.reason) part.reason = member.reason;
        return part;
      });
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
  for (const row of all.flatMap((value) => [value, ...(value.parts ?? [])]))
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

/** What the list draws, and what the legend counts. */
interface StorageListed {
  /** The rows to draw, a folded database's parts after it. */
  listed: StorageConsumer[];
  /** The rows the legend counts, each once. */
  counted: StorageConsumer[];
}

/**
 * The list for one page. With `shown`, the ids the map draws as tiles of
 * their own, only what the map gathers into "N smaller items" is listed.
 */
export function storageListing(
  derived: StorageConsumerRows,
  options: { shown?: ReadonlySet<string> | null; showEmpty?: boolean } = {}
): StorageListed {
  const drawn = (nodeId: string) => !!options.shown?.has(nodeId);
  const rows = [...derived.rows, ...(options.showEmpty ? derived.empty : [])].filter((row) => !drawn(row.nodeId));
  // A folded database's members follow it, each with its own action: the
  // map has a tile for each, so the list reaches each (#4549 review).
  const listed = rows.flatMap((row) => [row, ...(row.parts ?? []).filter((part) => !drawn(part.nodeId))]);
  return { listed, counted: rows };
}
