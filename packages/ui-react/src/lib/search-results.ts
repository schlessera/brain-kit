/** The existing core JSON and pi text result formats; no model-authored schema. */
export interface SearchHit {
  path: string;
  title: string;
  type?: string;
  snippet?: string | null;
  score?: number | null;
}
export interface SearchResults { results: SearchHit[]; warnings: string[] }

export function openableSearchPath(path: string): boolean {
  return Boolean(path) && !/^[\/\\]|^[a-z][a-z\d+.-]*:|[\u0000-\u001f\u007f\\?#]/i.test(path)
    && path.split("/").every(part => part !== ".." && part !== "." && part !== "");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSearchResults(output: string): SearchResults | null {
  try {
    const value: unknown = JSON.parse(output);
    if (!record(value) || !Array.isArray(value.results) || !Array.isArray(value.warnings)
      || !value.warnings.every(w => typeof w === "string")) return null;
    if (!value.results.every(hit => record(hit) && typeof hit.path === "string" && hit.path.length > 0
      && typeof hit.title === "string" && (hit.type === undefined || typeof hit.type === "string")
      && (hit.snippet == null || typeof hit.snippet === "string")
      && (hit.score == null || (typeof hit.score === "number" && Number.isFinite(hit.score))))) return null;
    return { results: value.results as SearchHit[], warnings: value.warnings };
  } catch {
    // pi returns a clipped, formatted list and omits scores entirely.
    if (/\n… \[truncated \d+ bytes\]$/.test(output)) return null;
    const lines = output.split("\n");
    const warnings: string[] = [];
    while (lines[0]?.startsWith("> ")) warnings.push(lines.shift()!.slice(2));
    if (lines.length === 1 && lines[0] === "No results found.") return { results: [], warnings };
    const results: SearchHit[] = [];
    for (const line of lines) {
      const match = /^- (.+?) — (.*) \[([^\]\r\n]*)\]$/.exec(line);
      if (match && line.split(" — ").length !== 2) return null;
      if (match) results.push({ path: match[1], title: match[2], type: match[3], snippet: "" });
      else if (results.length && (line.startsWith("    ") || line === "")) {
        const last = results[results.length - 1];
        last.snippet += (last.snippet ? "\n" : "") + (line.startsWith("    ") ? line.slice(4) : line);
      } else return null;
    }
    return results.length ? { results, warnings } : null;
  }
}
