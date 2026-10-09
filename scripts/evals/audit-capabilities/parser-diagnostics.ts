/** Source-backed shadow of suggestFixes parsing; it never changes its returned text. */
export function parserDiagnostic(text: string) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return { kind: "manual-fallback", reason: "no-array-match", rawEntries: null };
  let parsed: any;
  try { parsed = JSON.parse(match[0]); }
  catch { return { kind: "manual-fallback", reason: "invalid-array-json", rawEntries: null }; }
  // The shipped map accesses f.path before returning any row. A null entry throws
  // inside suggestFixes' catch and replaces the whole batch with manual suggestions.
  if (!Array.isArray(parsed) || parsed.some(entry => entry === null)) return { kind: "manual-fallback", reason: "entry-normalization-error", rawEntries: Array.isArray(parsed) ? parsed.length : null };
  return { kind: "parsed-array", reason: null, rawEntries: parsed.length,
    nonObjectEntries: parsed.filter(entry => typeof entry !== "object" || Array.isArray(entry)).length };
}
