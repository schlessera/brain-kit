import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceInputHash, snapshotName } from './publication-source.ts';

const repository = resolve(import.meta.dir, '../..');
const output = process.env.PUBLICATION_WORKSPACE;
if (!output || !resolve(output).startsWith(resolve(process.env.RUNNER_TEMP || '/tmp') + '/')) throw Error('PUBLICATION_WORKSPACE must be inside RUNNER_TEMP (or /tmp locally)');
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: repository, stdout: 'pipe', stderr: 'inherit' });
  const text = await new Response(child.stdout).text();
  if (await child.exited) throw Error(`Publication preparation failed: ${args.join(' ')}`);
  return text.trim();
}
const sourceSha = await command(['git', 'rev-parse', 'HEAD']);
const sourceDirty = (await command(['git', 'status', '--porcelain'])).length > 0;
if (sourceDirty && !process.argv.includes('--allow-working-tree')) throw Error('Publication requires a clean website checkout');
const tag = process.env.BRAIN_KIT_TAG || '';
if (tag && !/^@schlessera\/brain@\d+\.\d+\.\d+$/.test(tag)) throw Error('Select a stable canonical @schlessera/brain@X.Y.Z tag');
const productSha = tag ? await command(['git', 'rev-parse', `${tag}^{commit}`]) : sourceSha;
await command(['git', 'merge-base', '--is-ancestor', productSha, sourceSha]);
await mkdir(output);
const archive = `${output}.tar`;
await command(['git', 'archive', '--format=tar', `--output=${archive}`, productSha]);
await command(['tar', '-xf', archive, '-C', output]);
await rm(archive);
// Current editorial/site sources around an independently selected product tree.
// The fixture library is fictional demo data, not product code: it imports only
// fixture types a release already has, so the site can show it before a release.
for (const path of ['website', 'docs', 'README.md', 'scripts/captures/font-lock.json', 'scripts/captures/fonts.css', 'tsconfig.json', 'packages/ui-kit/fixtures/library']) {
  await rm(resolve(output, path), { recursive: true, force: true });
  await cp(resolve(repository, path), resolve(output, path), { recursive: true, filter: source => !source.split('/').some(part => ['node_modules', 'dist', '.astro', 'test-results', 'review'].includes(part)) });
}
const product = await Bun.file(resolve(output, 'packages/core/package.json')).json();
const registry: Record<string, { version: string; integrity: string }> = {};
if (tag) {
  const version = tag.split('@').at(-1)!;
  if (product.version !== version) throw Error('Release tag and product manifest disagree');
  for (const directory of ['core', 'ui-react', 'ui-kit', 'ui-sdk', 'render-template', 'ui-render-puppeteer']) {
    const manifest = await Bun.file(resolve(output, 'packages', directory, 'package.json')).json();
    if (manifest.version !== version) throw Error(`Release package is not in lockstep: ${manifest.name}`);
    const metadata = JSON.parse(await command(['npm', 'view', `${manifest.name}@${version}`, 'version', 'dist.integrity', '--json']));
    if (metadata.version !== version || !metadata['dist.integrity']) throw Error(`Release is not available on npm: ${manifest.name}@${version}`);
    registry[manifest.name] = { version, integrity: metadata['dist.integrity'] };
  }
}
const brainKit = { mode: tag ? 'release' : 'workspace', version: product.version, sourceSha: productSha, tag: tag || null, registry };
await Bun.write(resolve(output, snapshotName), JSON.stringify({ schemaVersion: 1, sourceSha, sourceDirty, brainKit, editorialRoot: repository, editorialInputHash: await sourceInputHash(repository), inputHash: await sourceInputHash(output) }, null, 2) + '\n');
if (process.env.GITHUB_ENV) await Bun.write(process.env.GITHUB_ENV, (await Bun.file(process.env.GITHUB_ENV).text()) + `PAGES_WORKSPACE=${output}\nWEBSITE_SOURCE_SHA=${sourceSha}\nWEBSITE_CONTENT_ROOT=${repository}\nEXPECTED_BRAIN_KIT_SHA=${productSha}\nEXPECTED_BRAIN_KIT_TAG=${tag}\n`);
console.log(JSON.stringify({ website: sourceSha, brainKit, workspace: output }, null, 2));
