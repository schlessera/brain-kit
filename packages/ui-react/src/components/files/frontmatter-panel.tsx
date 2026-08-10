import { ChevronRight } from "lucide-react";
import type { FrontmatterField } from "../../lib/frontmatter.js";
import { useFileStore } from "../../stores/file-store.js";
import { cn } from "../../lib/utils.js";

export function FrontmatterPanel({ fields }: { fields: FrontmatterField[] }) {
  const collapsed = useFileStore((s) => s.frontmatterCollapsed);
  const toggle = useFileStore((s) => s.toggleFrontmatter);

  if (fields.length === 0) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-md border border-border/60 bg-surface/50">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-surface-raised"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform",
            !collapsed && "rotate-90"
          )}
        />
        <span>frontmatter</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{fields.length} {fields.length === 1 ? "field" : "fields"}</span>
        {collapsed && (
          <span className="ml-auto truncate text-muted-foreground/40">
            {fields.slice(0, 3).map((f) => f.key).join(", ")}
            {fields.length > 3 ? "…" : ""}
          </span>
        )}
      </button>

      {!collapsed && (
        <table className="w-full border-collapse text-xs">
          <tbody>
            {fields.map((f) => (
              <tr
                key={f.key}
                className="border-t border-border/30 align-top first:border-t-0"
              >
                <th
                  scope="row"
                  className="w-32 max-w-[40%] whitespace-nowrap px-3 py-1.5 text-right font-[family-name:var(--font-mono)] font-normal text-muted-foreground"
                >
                  {f.key}
                </th>
                <td className="px-3 py-1.5 text-foreground/90">
                  {f.list ? (
                    <div className="flex flex-wrap gap-1">
                      {f.list.map((item, i) => (
                        <span
                          key={`${item}-${i}`}
                          className="rounded border border-border bg-background px-1.5 py-[1px] font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
                      {f.value || (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
