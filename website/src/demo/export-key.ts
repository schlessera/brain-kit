import type { RenderRequest } from '@schlessera/brain-ui-sdk/protocol';

// Mermaid's monotonically numbered DOM IDs change with browsing order, and so
// do the static-export colour tokens named after them (`--bk-mermaid-<n>-…`,
// `staticMermaidSvg`). Only that render number is canonicalized; the token's
// pass and index, the content and the styling remain part of the digest.
// Never substitute a vaguely similar document on a miss.
export function canonicalExport(request: RenderRequest) {
  const content = request.content.replace(/brain-mermaid-\d+/g, 'brain-mermaid-export').replace(/--bk-mermaid-\d+-/g, '--bk-mermaid-export-');
  return JSON.stringify({ contentType: request.contentType, title: request.title || '', content });
}
export async function exportKey(request: RenderRequest) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalExport(request)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export interface ExportCatalogue {
  schemaVersion: 1;
  recipeHash: string;
  exports: Record<string, { png: string; pdf: string }>;
  files: Record<string, { asset: string; mime: string; size: number }>;
}
