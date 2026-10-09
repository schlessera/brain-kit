import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const source = resolve(import.meta.dir, '../public/assets/shares');
const directory = await mkdtemp(resolve(tmpdir(), 'odyssey-share-proof-'));
const index = await Bun.file(resolve(source, 'index.json')).json();
const receipt = await Bun.file(resolve(source, 'provenance.json')).json();
assert(Object.keys(index.exports).length > 1 && Object.keys(receipt.assets).length > 1, 'Share proof needs distinct, non-empty artifacts');
async function check(value: object, expected?: string) {
  await Bun.write(resolve(directory, 'index.json'), JSON.stringify(value));
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'check-shares.ts'), directory], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (!expected) assert.equal(code, 0, stderr);
  else { assert.notEqual(code, 0, `Share guard accepted ${expected}`); assert(stderr.includes(expected), `Guard failed for a different reason: ${stderr}`); }
}
try {
  await Bun.write(resolve(directory, 'provenance.json'), JSON.stringify(receipt));
  for (const asset of Object.keys(receipt.assets)) await symlink(resolve(source, asset), resolve(directory, asset));
  await check(index);
  await check({ ...index, recipeHash: '0'.repeat(64) }, 'Demo exports are stale');
  const wrong = structuredClone(index);
  const keys = Object.keys(index.exports).filter(key => index.exports[key].png);
  wrong.exports[keys[0]].png = index.exports[keys[1]].png;
  await check(wrong, 'Share target belongs to another document');
  console.log('Share guard proof passed: clean fixture accepted; stale recipes and unrelated export mappings refused for the expected reasons.');
} finally { await rm(directory, { recursive: true, force: true }); }
