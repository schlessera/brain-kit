import type {
  StorageFileEntry,
  StorageRemovalFile,
  StorageRoot,
  StorageTreeNode,
  StorageTreePage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { StorageMapItem } from "@schlessera/brain-ui-kit";
export type StorageMetric = "allocated" | "logical";
export const bytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  const units = ["bytes", "kB", "MB", "GB", "TB"],
    index =
      value === 0
        ? 0
        : Math.min(4, Math.max(0, Math.floor(Math.log10(Math.abs(value)) / 3)));
  return `${new Intl.NumberFormat("en", { maximumSignificantDigits: 3 }).format(
    value / 1000 ** index
  )} ${units[index]}`;
};
export const exactBytes = (value: number | null) =>
  value === null
    ? "Unknown"
    : `${new Intl.NumberFormat("en").format(value)} bytes`;
const percent = (value: number | null, total: number | null) =>
  value === null || total === null || total <= 0
    ? "Unknown share"
    : `${new Intl.NumberFormat("en", { maximumSignificantDigits: 3 }).format(
        (value / total) * 100
      )}% of measured parent`;
export const time = (value: number) => new Date(value).toLocaleString();
export const humanReason = (reason: string | null) =>
  reason ? reason.replaceAll("_", " ").replaceAll("-", " ") : "Unavailable";
/**
 * The links a file's removal inspection found, for its Find large files row,
 * or `null` when its reference coverage is unknown. The server marks the
 * whole inspection incomplete when its reference scan fails, hits a bound or
 * truncates a file's list, and refuses such a file as
 * `consequences_incomplete`; either way an empty list is not "no links".
 */
export const knownLinks = (
  inspected: { facts: StorageRemovalFile | null; complete: boolean } | undefined
): number | null =>
  inspected?.facts && inspected.complete && inspected.facts.reason !== "consequences_incomplete"
    ? inspected.facts.references.length
    : null;
export const canonicalPath = (
  entry: StorageFileEntry,
  roots: readonly StorageRoot[]
): string | null => {
  const root = roots.find((value) => value.id === entry.rootId);
  if (!root || root.owner !== "brain") return null;
  return root.category === "content"
    ? entry.path
    : root.category === "scratch"
    ? `.brain/scratch/${entry.path}`
    : root.category === "workspace"
    ? `workspaces/${entry.path}`
    : null;
};
const SIDECAR = /-(wal|shm|journal)$/;
/** The database a sidecar name belongs to, or `null` for any other name. */
export function sidecarBase(name: string): string | null {
  return SIDECAR.test(name) ? name.replace(SIDECAR, "") : null;
}
/**
 * A page's nodes as items, keyed by the item's own node: each SQLite sidecar
 * (`-wal`, `-shm`, `-journal`) joins its database, and every other node is
 * an item alone (#4546). The map and the list both fold this way, so a
 * database and its sidecars are one tile and one row, never separate items.
 */
export function foldSidecars(nodes: readonly StorageTreeNode[]): Map<string, StorageTreeNode[]> {
  // A store's sidecar is its own root with the same owner; a file's is a file
  // beside it in the same root. A folder or link with a sidecar name is not one.
  const database = (node: StorageTreeNode, base: string) =>
    nodes.find(
      (value) =>
        value.name === base &&
        (node.kind === "root"
          ? value.kind === "root" && value.owner === node.owner
          : node.kind === "file" && value.kind === "file" && value.rootId === node.rootId)
    );
  const folded = new Map<string, StorageTreeNode[]>();
  for (const node of nodes) {
    const base = sidecarBase(node.name);
    const key = (base === null ? undefined : database(node, base))?.id ?? node.id;
    folded.set(key, [...(folded.get(key) ?? []), node]);
  }
  return folded;
}
export function mapItems(
  page: StorageTreePage,
  metric: StorageMetric,
  phone: boolean
): StorageMapItem[] {
  const total = page.totals[metric];
  if (total === null || total <= 0) return [];
  const folded = [...foldSidecars(page.nodes)].map(([id, members]) => ({
    head: members.find((node) => node.id === id) ?? members[0]!,
    area: members.reduce((sum, node) => sum + (node.area[metric] ?? 0), 0),
  }));
  const known = folded.filter((item) => item.area > 0).sort((a, b) => b.area - a.area);
  const shown = known
    .filter((item) => item.area / total >= 0.01)
    .slice(0, phone ? 6 : known.length);
  const items: StorageMapItem[] = shown.map(({ head, area }) => ({
    id: head.id,
    name: head.name,
    owner: head.owner,
    bytes: area,
    interactive: head.kind !== "metadata",
    label: `${bytes(area)} · ${percent(area, total).replace(" of measured parent", "")}`,
  }));
  const remainder = Math.max(
    0,
    total - shown.reduce((sum, item) => sum + item.area, 0)
  );
  // Items, not nodes: the page's undrawn items, plus the matched nodes past it.
  const smaller = folded.length - shown.length + Math.max(0, page.matched - page.nodes.length);
  if (remainder > 0)
    items.push({
      id: "smaller",
      name: `${Math.max(1, smaller)} smaller items`,
      owner: "operator",
      bytes: remainder,
      label: `${bytes(remainder)} · ${percent(remainder, total).replace(
        " of measured parent",
        ""
      )}`,
      smaller: true,
    } as StorageMapItem);
  return items;
}
