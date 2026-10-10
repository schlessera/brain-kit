import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { exportRecipeHash, repository } from './export-recipe.ts';
import { demoDocuments, documentByPath, wikilinks } from '../src/demo/corpus.ts';
import { knowledgeResponse } from '../src/demo/knowledge.ts';
import { library } from '../../packages/ui-kit/fixtures/library/index.ts';
import { splitFrontmatter } from '../../packages/ui-react/src/lib/frontmatter.ts';
import { exportKey } from '../src/demo/export-key.ts';

// The whole library is browsable, graphed and searchable, not only staged.
// Checked before export freshness, which a content change also trips.
const markdown = demoDocuments.filter(record => record.kind === 'markdown');
assert(library.length >= 400 && library.every(record => documentByPath[record.path] && !documentByPath[record.path].featured), 'Library records are missing from the demo');
const meta = await knowledgeResponse(new URL('https://demo.invalid/api/graph/meta'))!.json();
assert.equal(meta.nodeCount, markdown.length, 'Graph omits demo records');
const reach = await knowledgeResponse(new URL('https://demo.invalid/api/graph/maintenance'))!.json();
const libraryPaths = new Set(library.map(record => record.path));
assert.deepEqual(reach.unreachable.map((node: { path: string }) => node.path).filter((path: string) => libraryPaths.has(path)), [], 'Library records unreachable from the goal');
for (const record of library) {
  const results = (await knowledgeResponse(new URL(`https://demo.invalid/api/brain/search?limit=500&q=${encodeURIComponent(record.title)}`))!.json()).results;
  assert(results.some((result: { path: string }) => result.path === record.path), `Search cannot find ${record.path} by its title`);
}
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(repository, 'website/public/assets/shares');
const index = await Bun.file(resolve(output, 'index.json')).json();
assert.equal(index.recipeHash, await exportRecipeHash(), 'Demo exports are stale. Run bun run website:shares, review the generated assets, then rebuild.');
const provenance = await Bun.file(resolve(output, 'provenance.json')).json();
assert.equal(provenance.recipeHash, index.recipeHash);
for (const [asset, receipt] of Object.entries(provenance.assets) as [string, { sha256: string; bytes: number }][]) {
  const bytes = new Uint8Array(await Bun.file(resolve(output, asset)).arrayBuffer());
  assert.equal(bytes.byteLength, receipt.bytes, `Truncated share target: ${asset}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256, `Changed share target: ${asset}`);
  assert(asset.endsWith('.png') ? Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-', `Invalid export bytes: ${asset}`);
}
for (const [key, formats] of Object.entries(index.exports) as [string, Record<string, string>][]) for (const [format, asset] of Object.entries(formats)) if (asset) {
  assert(provenance.assets[asset], `Share target missing its receipt: ${asset}`);
  assert.equal(provenance.assets[asset].key, key, `Share target belongs to another document: ${asset}`);
  assert.equal(provenance.assets[asset].format, format, `Share target has the wrong format: ${asset}`);
}
for (const record of demoDocuments) {
  for (const link of record.links) assert(documentByPath[link], `Unresolved fictional link: ${record.path} -> ${link}`);
  if (record.kind === 'text') continue;
  const { fields, body } = splitFrontmatter(record.content);
  if (record.kind === 'markdown') assert(fields.some(field => field.key === 'type') && fields.some(field => field.key === 'updated'), `Missing file metadata: ${record.path}`);
  if (record.kind === 'markdown') for (const [, slug] of body.matchAll(/\[\[([^\]|#]+)/g)) assert(wikilinks[slug.trim().toLowerCase()] || documentByPath[slug.trim()], `Unresolved wiki-link: ${record.path} -> [[${slug}]]`);
  // Library records share as text formats; only featured records carry PNG/PDF.
  if (!record.featured) continue;
  const key = await exportKey({ content: record.kind === 'markdown' ? body : record.content, contentType: record.kind, format: 'png', title: record.path.split('/').at(-1) });
  assert(index.exports[key]?.png && index.exports[key]?.pdf, `File lacks complete exports: ${record.path}`);
}
console.log(`Verified ${demoDocuments.length} linked records (${library.length} library), graph and search coverage, frontmatter, export freshness and ${Object.keys(provenance.assets).length} PNG/PDF artifact signatures and digests.`);
