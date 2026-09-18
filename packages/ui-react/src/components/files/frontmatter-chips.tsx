import { Chip, Disclosure } from "@schlessera/brain-ui-kit";
import type { FrontmatterField } from "../../lib/frontmatter.js";

/**
 * A file's frontmatter as the design's `1f` screen draws it: key/value
 * chips (`type: talk`, `status: active`) behind a `Disclosure` whose summary
 * says how much is hidden. Rendered from props (S7); `FrontmatterPanel` is
 * the container that keeps the collapsed choice in the file store so it
 * survives moving between files.
 *
 * A list-valued field is one chip per element, keyed by the field; an empty
 * value is an explicit em dash, because a blank chip reads as nothing.
 */
export interface FrontmatterChipsProps {
  fields: FrontmatterField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FrontmatterChips(p: FrontmatterChipsProps) {
  if (p.fields.length === 0) return null;
  const summary = p.fields.slice(0, 3).map((f) => f.key).join(", ") + (p.fields.length > 3 ? "…" : "");
  return (
    <div className="mb-4">
      <Disclosure
        label={`frontmatter · ${p.fields.length} ${p.fields.length === 1 ? "field" : "fields"}`}
        meta={p.open ? undefined : summary}
        icon="file"
        open={p.open}
        onOpenChange={p.onOpenChange}
      >
        <div className="flex flex-wrap gap-1.5">
          {p.fields.flatMap((f) =>
            f.list
              ? f.list.map((item, i) => <Chip key={`${f.key}-${i}`} label={`${f.key}: ${item}`} variant="kv" tone="neutral" />)
              : [<Chip key={f.key} label={`${f.key}: ${f.value || "—"}`} variant="kv" tone="neutral" />],
          )}
        </div>
      </Disclosure>
    </div>
  );
}
