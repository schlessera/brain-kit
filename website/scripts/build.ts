import { resolve, dirname } from 'node:path';
import { mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { demoDocuments } from '../src/demo/corpus.ts';
import { stagedPaths } from '../src/demo/odyssey.ts';
import { sourceInputHash, snapshotName } from './publication-source.ts';
import { exportRecipeHash } from './export-recipe.ts';

const root = resolve(import.meta.dir, '../..');
const website = resolve(root, 'website');
const base = process.env.SITE_BASE || '/brain-kit/';
const snapshotFile = Bun.file(resolve(root, snapshotName));
const snapshot = await snapshotFile.exists() ? await snapshotFile.json() : null;
if (snapshot) {
  process.env.WEBSITE_SOURCE_SHA = snapshot.sourceSha;
  if (snapshot.editorialRoot) process.env.WEBSITE_CONTENT_ROOT = snapshot.editorialRoot;
}
const refreshShares = process.argv.includes('--refresh-shares');
const demoVersion = await exportRecipeHash();
process.env.DEMO_BUILD_ID = demoVersion;
async function run(cmd: string[], cwd = root) {
  const process = Bun.spawn(cmd, { cwd, env: { ...Bun.env, SITE_BASE: base }, stdout: 'inherit', stderr: 'inherit' });
  const code = await process.exited; if (code) throw new Error(`${cmd.join(' ')} exited ${code}`);
}
if (!await Bun.file(resolve(website, 'node_modules/node/bin/node')).exists()) throw new Error('Install website dependencies first: npm ci --prefix website');
// UI CSS and cross-package exports come from the same source as the real demo.
if (!process.argv.includes('--prepared')) await run(['bun', 'run', 'build']);
if (!refreshShares) await run(['bun', resolve(website, 'scripts/check-shares.ts')]);
await rm(resolve(website, '.astro'), { recursive: true, force: true });
await rm(resolve(website, 'dist'), { recursive: true, force: true });
await rm(resolve(website, 'public/assets/demo'), { recursive: true, force: true });
await mkdir(resolve(website, 'public/assets/demo'), { recursive: true });
await copyFile(resolve(root, 'packages/ui-react/dist/styles.css'), resolve(website, 'public/assets/product.css'));
const fontLock = await Bun.file(resolve(root, 'scripts/captures/font-lock.json')).json();
let css = await Bun.file(resolve(root, 'scripts/captures/fonts.css')).text();
for (const font of fontLock.assets) {
  const file = resolve(website, 'public/assets', font.file);
  const bytes = await Bun.file(file).arrayBuffer();
  if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== font.sha256) throw new Error(`Font checksum mismatch: ${font.file}`);
  css = css.replace(font.url, `${base}assets/${font.file}`);
}
await Bun.write(resolve(website, 'public/assets/fonts.css'), css);
const result = await Bun.build({ entrypoints: [resolve(website, 'src/demo/app.tsx')], outdir: resolve(website, 'public/assets/demo'), naming: { entry: 'app.js', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' }, target: 'browser', splitting: true, minify: true, define: { 'process.env.NODE_ENV': '"production"', '__DEMO_VERSION__': JSON.stringify(demoVersion) } });
if (!result.success) throw new AggregateError(result.logs, 'Demo bundle failed');
const worker = await Bun.build({ entrypoints: [resolve(website, 'src/demo/file-worker.ts')], outdir: resolve(website, 'public/demo'), naming: 'transport.js', target: 'browser', minify: true, define: { '__DEMO_VERSION__': JSON.stringify(demoVersion) } });
if (!worker.success) throw new AggregateError(worker.logs, 'Demo file transport failed');
// Sandboxed HTML navigations have an opaque origin and cannot be intercepted
// by the demo client's worker. This static route selects only embedded public
// fixtures; the production viewer keeps its original script-only sandbox.
const htmlFixtures = Object.fromEntries(demoDocuments.filter(record => record.kind === 'html').map(record => [record.path, record.content]));
// The worker embeds only the staged records; everything else it serves raw is
// fetched from this file on first use, so installing it costs no library bytes.
const unstaged = demoDocuments.filter(record => !stagedPaths.has(record.path));
// The library alone is several hundred records; an empty file means the
// staged snapshot was taken after the library joined it.
if (unstaged.length < 400) throw Error(`The worker's library file would hold only ${unstaged.length} records`);
await Bun.write(resolve(website, 'public/demo/library.json'), JSON.stringify(Object.fromEntries(unstaged.map(record => [record.path, { kind: record.kind, content: record.content }]))));
const embeddedHtml = JSON.stringify(htmlFixtures).replace(/</g, '\\u003c');
await Bun.write(resolve(website, 'public/demo/api/files/html/index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Brain demo HTML preview</title></head><body><script>const fixtures=${embeddedHtml};const path=new URL(location.href).searchParams.get('path');if(Object.hasOwn(fixtures,path)){document.open();document.write(fixtures[path]);document.close();}else{document.body.textContent='This file is outside the fictional demonstration.'}</script></body></html>`);
await run([resolve(website, 'node_modules/node/bin/node'), resolve(website, 'node_modules/astro/bin/astro.mjs'), 'build'], website);
const sourceSha = snapshot?.sourceSha || (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
const dirty = snapshot ? snapshot.sourceDirty || await sourceInputHash(root) !== snapshot.inputHash : (await Bun.$`git -C ${root} status --porcelain`.text()).trim().length > 0;
const brainKit = snapshot?.brainKit || { mode: 'workspace', version: (await Bun.file(resolve(root, 'packages/core/package.json')).json()).version, sourceSha, tag: null, registry: {} };
const sha256 = async (path: string) => createHash('sha256').update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest('hex');
const files: Record<string, string> = {};
async function inventory(path = '') {
  for (const entry of await readdir(resolve(website, 'dist', path), { withFileTypes: true })) {
    const next = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventory(next);
    else files[next] = await sha256(resolve(website, 'dist', next));
  }
}
await inventory();
const manifest = { schemaVersion: 1, sourceSha, dirty, base, brainKit, exportRecipeHash: await exportRecipeHash(), runtime: 'node-22.23.3', bun: Bun.version, astro: '7.3.5', lockHash: await sha256(resolve(website, 'package-lock.json')), workspaceLockHash: await sha256(resolve(root, 'bun.lock')), publicationHash: await sha256(resolve(website, 'publication.mjs')), demoRecipeHash: await sha256(resolve(website, 'src/demo/app.tsx')), fontLockHash: await sha256(resolve(root, 'scripts/captures/font-lock.json')), captureProvenanceHashes: await Promise.all(['provenance.json', 'purposeful-provenance.json'].map(name => sha256(resolve(website, '.impeccable/mocks/references', name)))), files };
await Bun.write(resolve(website, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (refreshShares) {
  await run(['bun', resolve(website, 'scripts/generate-shares.ts')]);
  await run(['bun', resolve(website, 'scripts/generate-previews.ts')]);
  await run(['bun', resolve(website, 'scripts/build.ts'), '--prepared', ...process.argv.includes('--check') ? ['--check'] : [], ...process.argv.includes('--no-capture') ? ['--no-capture'] : []]);
  process.exit(0);
}
if (process.argv.includes('--check')) {
  await run(['bunx', 'tsc', '-p', resolve(website, 'tsconfig.json')]);
  await run(['bun', resolve(website, 'scripts/check.ts'), ...process.argv.includes('--no-capture') ? ['--no-capture'] : []]);
}
console.log(`Static website built at ${base}; manifest records ${Object.keys(files).length} files, source ${sourceSha}${dirty ? ' (working tree)' : ''}.`);
