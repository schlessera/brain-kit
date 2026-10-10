import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const directory = await mkdtemp(resolve(tmpdir(), 'brain-kit-release-selection-'));
const preloader = resolve(directory, 'offline.ts');
await Bun.write(preloader, `globalThis.fetch = async input => {
  if (String(input) !== 'https://schlessera.github.io/brain-kit/build-manifest.json') throw Error('Unexpected selector request');
  return Response.json(JSON.parse(process.env.FIXTURE_MANIFEST), { status: Number(process.env.FIXTURE_STATUS) });
};`);
const tags = Bun.spawn(['git', 'tag', '--list', '@schlessera/brain@*', '--sort=-version:refname'], { stdout: 'pipe' });
const latest = (await new Response(tags.stdout).text()).split('\n').find(tag => /^@schlessera\/brain@\d+\.\d+\.\d+$/.test(tag))!;
assert.equal(await tags.exited, 0); assert(latest);
const sha = Bun.spawn(['git', 'rev-parse', `${latest}^{commit}`], { stdout: 'pipe' });
const productSha = (await new Response(sha.stdout).text()).trim(); assert.equal(await sha.exited, 0);
async function check(event: string, manifest: object, expected: boolean | string, status = 200, tag = '', requested = '') {
  const output = resolve(directory, 'outputs'); await Bun.write(output, '');
  const child = Bun.spawn(['bun', '--preload', preloader, resolve(import.meta.dir, 'select-publication.ts')], {
    env: { ...Bun.env, EVENT_NAME: event, EVENT_REF: 'refs/heads/main', RELEASE_TAG: tag, REQUESTED_TAG: requested, FIXTURE_MANIFEST: JSON.stringify(manifest), FIXTURE_STATUS: String(status), GITHUB_ENV: '', GITHUB_OUTPUT: output }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (typeof expected === 'string') { assert.notEqual(code, 0); assert(error.includes(expected), error); }
  else { assert.equal(code, 0, error); assert((await Bun.file(output).text()).includes(`publish=${expected}\n`), `Release selection expected publish=${expected}`); }
}
try {
  await check('schedule', { brainKit: { tag: latest, sourceSha: productSha } }, false);
  await check('schedule', { brainKit: { tag: latest, sourceSha: 'stale' } }, true);
  await check('schedule', {}, true, 404);
  await check('schedule', {}, 'Cannot inspect deployed website: HTTP 503', 503);
  await check('release', {}, true, 200, latest);
  await check('release', {}, false, 200, '@schlessera/brain@0.0.0');
  await check('push', {}, true);
  await check('workflow_dispatch', {}, 'Invalid canonical release tag', 200, '', 'bad-tag');
  console.log('Offline release selection proof passed: current release skipped; new/missing deployment rebuilt; unavailable site, obsolete event and invalid input handled by the actual selector.');
} finally { await rm(directory, { recursive: true, force: true }); }
