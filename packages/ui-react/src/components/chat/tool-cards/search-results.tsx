import { SearchResultCard } from "@schlessera/brain-ui-kit";
import type { ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { useBrainUiRoot } from "../../../root-context.js";
import { parseSnippet } from "../../../lib/search-snippet.js";
import { openableSearchPath, parseSearchResults, type SearchHit } from "../../../lib/search-results.js";
import { ClampedPre } from "../tool-views.js";

/** Shared by Search and tool output; the caller owns selection and navigation. */
export function SearchHitCard({ hit, index, active, onClick }: { hit: SearchHit; index: number; active?: boolean; onClick?: () => void }) {
  return <SearchResultCard path={hit.path} title={hit.title} type={hit.type}
    score={typeof hit.score === "number" && Number.isFinite(hit.score) ? String(hit.score) : ""}
    segments={parseSnippet(hit.snippet ?? "")} index={index} active={active}
    onClick={openableSearchPath(hit.path) ? onClick : undefined} />;
}

export function SearchResultsOutput({ tool }: { tool: ToolCallView }) {
  const root = useBrainUiRoot();
  const result = !tool.isError && tool.output ? parseSearchResults(tool.output) : null;
  if (!result) return tool.output ? <ClampedPre text={tool.output} isError={tool.isError} /> : null;
  return <div className="space-y-2">
    {result.warnings.map((warning, index) => <p key={index} className="text-xs text-muted-foreground">{warning}</p>)}
    {result.results.length === 0 ? <p className="text-xs text-muted-foreground">No results found.</p> : null}
    {result.results.map((hit, index) => <SearchHitCard key={`${index}:${hit.path}`} hit={hit} index={index} onClick={() => {
      root.stores.ui.getState().setFilePanelOpen(true);
      void root.stores.file.getState().openFile(hit.path);
    }} />)}
  </div>;
}
