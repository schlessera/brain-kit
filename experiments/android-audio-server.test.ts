import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loopback scaffold serves the desktop probe and bounds stored receipts', async () => {
  const out = mkdtempSync(join(tmpdir(),'odysseus-receipts-'));
  // Bun children inherit the repository offline preload. The server itself has
  // no outbound transport; requests below use guarded loopback fetch.
  const child = Bun.spawn([process.execPath,'scripts/probes/audio-commit-boundary/android-server.mjs',out], {stdout:'pipe',stderr:'pipe'});
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain('http://127.0.0.1:8765');
    const origin = 'http://127.0.0.1:8765';
    expect(await (await fetch(origin+'/page.js')).text()).toContain('window.probeReady = true');
    expect((await fetch(origin+'/missing')).status).toBe(404);
    expect((await fetch(origin+'/receipt', {method:'POST',body:'{'})).status).toBe(400);
    expect((await fetch(origin+'/receipt', {method:'POST',body:JSON.stringify({kind:'snapshot',value:{delivered:2}})})).status).toBe(204);
    const row = JSON.parse(readFileSync(join(out,'receipts.jsonl'),'utf8'));
    expect(row).toMatchObject({kind:'snapshot',value:{delivered:2}});
    expect(Number.isFinite(row.receivedWall)).toBe(true);
    expect((await fetch(origin+'/receipt',{method:'POST',body:JSON.stringify({value:'x'.repeat(1024*1024)})})).status).toBe(413);
  } finally {
    child.kill();
    await child.exited;
    rmSync(out,{recursive:true,force:true});
  }
});
