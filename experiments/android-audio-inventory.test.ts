import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('SDK inventory refuses a missing component or silently updated image revision', () => {
  const sdk = mkdtempSync(join(tmpdir(), 'odysseus-sdk-'));
  const components = [
    ['cmdline-tools/latest', '19.0'], ['emulator', '37.2.13'],
    ['platform-tools', '37.0.1'], ['system-images/android-35/google_apis/x86_64', '9'],
  ];
  const run = () => {
    const child = spawnSync('python3', ['scripts/probes/audio-commit-boundary/android-inventory.py', sdk], {encoding:'utf8'});
    if (child.error) throw child.error;
    return {exit:child.status, receipt:JSON.parse(child.stdout)};
  };
  try {
    expect(run().exit).toBe(1);
    for (const [component, version] of components) {
      mkdirSync(join(sdk,component),{recursive:true});
      writeFileSync(join(sdk,component,'source.properties'), `Pkg.Revision=${version}\n`);
    }
    expect(run()).toMatchObject({exit:0,receipt:{kind:'sdk-inventory-only',pass:true}});
    writeFileSync(join(sdk,components[3][0],'source.properties'), 'Pkg.Revision=10\n');
    const drift = run();
    expect(drift.exit).toBe(1);
    expect(drift.receipt.checks[3]).toEqual({component:components[3][0],expected:'9',actual:'10',pass:false});
  } finally { rmSync(sdk,{recursive:true,force:true}); }
});
