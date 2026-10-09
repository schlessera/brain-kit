export {};
const canonical = /^@schlessera\/brain@\d+\.\d+\.\d+$/;
async function git(args: string[]) {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw Error('Cannot select website release');
  return output.trim();
}
const tags = (await git(['tag', '--list', '@schlessera/brain@*', '--sort=-version:refname'])).split('\n');
const latest = tags.find(tag => canonical.test(tag));
if (!latest) throw Error('No stable canonical brain-kit release tag found');
const requested = process.env.REQUESTED_TAG || '';
const eventTag = process.env.RELEASE_TAG || (process.env.EVENT_REF?.startsWith('refs/tags/') ? process.env.EVENT_REF.slice('refs/tags/'.length) : '');
const selected = requested || latest;
if (!canonical.test(selected)) throw Error('Invalid canonical release tag');
let publish = !eventTag || eventTag === latest;
if (process.env.EVENT_NAME === 'schedule') {
  const productSha = await git(['rev-parse', `${selected}^{commit}`]);
  const response = await fetch('https://schlessera.github.io/brain-kit/build-manifest.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (response.ok) {
    const deployed = await response.json() as { brainKit?: { sourceSha?: string; tag?: string } };
    publish = deployed.brainKit?.tag !== selected || deployed.brainKit?.sourceSha !== productSha;
  } else if (response.status !== 404) throw Error(`Cannot inspect deployed website: HTTP ${response.status}`);
}
if (process.env.GITHUB_ENV) await Bun.write(process.env.GITHUB_ENV, (await Bun.file(process.env.GITHUB_ENV).text()) + `BRAIN_KIT_TAG=${selected}\n`);
if (process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT, (await Bun.file(process.env.GITHUB_OUTPUT).text()) + `publish=${publish}\n`);
console.log(`${publish ? 'Rebuild' : 'Skip'} website: ${selected}${eventTag && eventTag !== latest ? ' (superseded or noncanonical release event)' : ''}`);
