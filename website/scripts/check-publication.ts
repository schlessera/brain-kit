import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sourceInputHash, snapshotName } from './publication-source.ts';

const built = await Bun.file(resolve(import.meta.dir, '../dist/build-manifest.json')).json();
assert(Object.keys(built.files).length > 0, 'The artifact fixture must have emitted files');
const root = await mkdtemp(resolve(tmpdir(), 'brain-kit-pages-proof-'));
await Bun.write(resolve(root, 'source.txt'), 'unchanged build input\n');
const clean = { ...built, dirty: false, base: '/brain-kit/' };
const snapshot = { sourceSha: built.sourceSha, sourceDirty: false, brainKit: built.brainKit, inputHash: await sourceInputHash(root) };
const shares = { sourceSha: built.sourceSha, recipeHash: built.exportRecipeHash, brainKit: built.brainKit };
const previews = await Bun.file(resolve(import.meta.dir, '../dist/assets/previews/provenance.json')).json();
async function check(manifest = clean, source = snapshot, exports = shares, failure?: string) {
  await Bun.write(resolve(root, snapshotName), JSON.stringify(source));
  await Bun.write(resolve(root, 'website/dist/build-manifest.json'), JSON.stringify(manifest));
  await Bun.write(resolve(root, 'website/dist/assets/shares/provenance.json'), JSON.stringify(exports));
  await Bun.write(resolve(root, 'website/dist/assets/previews/provenance.json'), JSON.stringify(previews));
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'verify-publication.ts'), root], {
    env: { ...Bun.env, WEBSITE_SOURCE_SHA: built.sourceSha, EXPECTED_BRAIN_KIT_SHA: built.brainKit.sourceSha, EXPECTED_BRAIN_KIT_TAG: built.brainKit.tag || '', GITHUB_STEP_SUMMARY: '' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (failure) {
    assert.notEqual(code, 0, `Publication guard accepted ${failure}`);
    assert(stderr.includes(failure), `Guard failed for a different reason: ${stderr}`);
  } else assert.equal(code, 0, `Matching artifact was refused: ${stderr}`);
}
try {
  await check();
  await check(clean, { ...snapshot, sourceDirty: true }, shares, 'Website checkout was dirty');
  await check({ ...clean, sourceSha: '0'.repeat(40) }, snapshot, shares, 'Website source does not match');
  await check({ ...clean, brainKit: { ...clean.brainKit, sourceSha: '0'.repeat(40) } }, snapshot, shares, 'Demo does not match the selected product commit');
  await check({ ...clean, base: '/' }, snapshot, shares, 'Wrong Pages base');
  await check(clean, snapshot, { ...shares, recipeHash: 'stale' }, 'Exports were not regenerated');
  await check(clean, snapshot, { ...shares, brainKit: { ...shares.brainKit, version: '0.0.0' } }, 'Exports belong to another product build');
  await Bun.write(resolve(root, 'source.txt'), 'unexpected source mutation\n');
  await check(clean, snapshot, shares, 'Publication source inputs changed during the build');
  await Bun.write(resolve(root, 'source.txt'), 'unchanged build input\n');
  await check();
  console.log('Publication proof passed: matching artifact accepted; dirty/changed source, wrong website/product/base and stale or mismatched exports refused by the actual publication command.');
} finally { await rm(root, { recursive: true, force: true }); }
