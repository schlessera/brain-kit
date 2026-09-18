import type { FrontmatterField } from "../../lib/frontmatter.js";
import { useFileStore } from "../../stores/file-store.js";
import { FrontmatterChips } from "./frontmatter-chips.js";

/**
 * The container (S7): the collapsed choice lives in the file store so it
 * carries from one file to the next; `FrontmatterChips` draws from props.
 */
export function FrontmatterPanel({ fields }: { fields: FrontmatterField[] }) {
  const collapsed = useFileStore((s) => s.frontmatterCollapsed);
  const toggle = useFileStore((s) => s.toggleFrontmatter);
  return <FrontmatterChips fields={fields} open={!collapsed} onOpenChange={() => toggle()} />;
}
