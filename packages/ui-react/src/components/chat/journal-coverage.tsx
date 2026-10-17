import { Disclosure } from "@schlessera/brain-ui-kit";
import { useEffect, useRef, useState } from "react";
import type { TurnJournalDetails, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";

/** Presentation only: every stored configuration path remains inspectable. */
export function JournalCoverage({ coverage, missing }: {
  coverage: TurnJournalSummary["configurationCoverage"];
  missing: TurnJournalDetails["missing"] | undefined;
}) {
  const [open, setOpen] = useState(false), [filter, setFilter] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef("");
  const paths = missing?.filter(item => item.reason === "configuration_inputs_not_fully_identified") ?? [];
  const filtered = paths.filter(item => item.path.toLowerCase().includes(filter.toLowerCase()));
  const count = !filter ? `${paths.length} shown` : filtered.length
    ? `${filtered.length} of ${paths.length} shown` : `0 of ${paths.length} shown. No path contains "${filter}".`;
  const currentCount = useRef(count); currentCount.current = count;
  useEffect(() => {
    if (filter === announced.current) return;
    const timer = setTimeout(() => { announced.current = filter; setAnnouncement(currentCount.current); }, 500);
    return () => clearTimeout(timer);
  }, [filter]);
  if (coverage === "unknown") return <p>Configuration coverage: unknown. Observation did not complete.</p>;
  if (!missing || coverage !== "incomplete" && (coverage !== undefined || !paths.length)) return null;
  return <Disclosure label={`Configuration coverage incomplete · ${paths.length} inputs not fully identified`} open={open} onOpenChange={setOpen}>
    <p>These configuration files could not be fully analysed (for example, they use computed imports), so files they depend on may be missing from Steering. Being listed here does not mean the file changed. Changed files appear under What changed.</p>
    <label className="grid gap-2">Find a path<input type="search" className="min-h-11 min-w-0 rounded border bg-background px-3 text-foreground" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => {
      if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); }
    }} /></label>
    <p>{count}</p>
    <span className="sr-only" role="status" aria-live="polite" data-coverage-announcement>{announcement}</span>
    <div role="region" aria-label={`Configuration inputs not fully identified, ${paths.length}`} tabIndex={0} className="min-w-0 overflow-auto focus-visible:outline" style={{ maxHeight: "50vh" }}>
      <ul className="grid gap-2 font-mono text-[11px]">{filtered.map((item, index) => <li key={`${item.path}-${index}`} className="break-all">{item.path}</li>)}</ul>
    </div>
  </Disclosure>;
}
