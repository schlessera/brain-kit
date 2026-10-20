import type {
  StorageFileEntry,
  StorageRoot,
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
export const percent = (value: number | null, total: number | null) =>
  value === null || total === null || total <= 0
    ? "Unknown share"
    : `${new Intl.NumberFormat("en", { maximumSignificantDigits: 3 }).format(
        (value / total) * 100
      )}% of measured parent`;
export const time = (value: number) => new Date(value).toLocaleString();
export const ownerName = (owner: string) =>
  owner === "brain" ? "Brain" : owner === "app" ? "App" : "Operator";
export const humanReason = (reason: string | null) =>
  reason ? reason.replaceAll("_", " ").replaceAll("-", " ") : "Unavailable";
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
export function mapItems(
  page: StorageTreePage,
  metric: StorageMetric,
  phone: boolean
): StorageMapItem[] {
  const total = page.totals[metric];
  if (total === null || total <= 0) return [];
  const known = page.nodes
    .filter((node) => node.area[metric] !== null && node.area[metric]! > 0)
    .sort((a, b) => b.area[metric]! - a.area[metric]!);
  const shown = known
    .filter((node) => node.area[metric]! / total >= 0.01)
    .slice(0, phone ? 6 : known.length);
  const items: StorageMapItem[] = shown.map((node) => ({
    id: node.id,
    name: node.name,
    owner: node.owner,
    bytes: node.area[metric]!,
    interactive: node.kind !== "metadata",
    label: `${bytes(node.area[metric])} · ${percent(
      node.area[metric],
      total
    ).replace(" of measured parent", "")}`,
  }));
  const remainder = Math.max(
    0,
    total - shown.reduce((sum, node) => sum + node.area[metric]!, 0)
  );
  if (remainder > 0)
    items.push({
      id: "smaller",
      name: `${Math.max(1, page.matched - shown.length)} smaller items`,
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
