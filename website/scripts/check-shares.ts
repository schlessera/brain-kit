import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { exportRecipeHash, repository } from './export-recipe.ts';
import { demoDocuments, documentByPath } from '../src/demo/odyssey.ts';
import { splitFrontmatter } from '@schlessera/brain-ui-react';
import { exportKey } from '../src/demo/export-key.ts';

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
  const key = await exportKey({ content: record.kind === 'markdown' ? body : record.content, contentType: record.kind, format: 'png', title: record.path.split('/').at(-1) });
  assert(index.exports[key]?.png && index.exports[key]?.pdf, `File lacks complete exports: ${record.path}`);
}
console.log(`Verified ${demoDocuments.length} linked records, frontmatter, export freshness and ${Object.keys(provenance.assets).length} PNG/PDF artifact signatures and digests.`);
