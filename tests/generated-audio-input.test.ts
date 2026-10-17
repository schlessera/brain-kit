import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test("fake microphone source replaces wrong existing bytes before Chromium consumes them",async()=>{
  const root=mkdtempSync(join(tmpdir(),"generated-audio-binding-"));roots.push(root);
  const owner=resolve(import.meta.dir,"../packages/ui-react/tests/browser/offline/fake-microphone-file.ts");
  const generator=resolve(import.meta.dir,"../packages/ui-react/tests/browser/offline/audio-fixtures.ts");
  const code=`import {createHash} from "node:crypto"; import {mkdirSync,writeFileSync,readFileSync} from "node:fs"; import {dirname,join} from "node:path"; import {tmpdir} from "node:os"; import {fakeMicrophoneFile,FAKE_MICROPHONE_FIXTURE} from ${JSON.stringify(owner)}; import {generateWav} from ${JSON.stringify(generator)};
const bytes=generateWav(FAKE_MICROPHONE_FIXTURE); const hash=(value)=>createHash("sha256").update(value).digest("hex");const expected=hash(bytes);const file=join(tmpdir(),"brain-kit-audio-fixtures",FAKE_MICROPHONE_FIXTURE.name+"-"+expected.slice(0,16)+".wav");mkdirSync(dirname(file),{recursive:true});writeFileSync(file,"wrong existing bytes");const actual=fakeMicrophoneFile();const repeated=fakeMicrophoneFile();console.log(JSON.stringify({expected,actual:hash(readFileSync(actual)),samePath:actual===file,repeated:hash(readFileSync(repeated)),sameRepeatedPath:repeated===actual}));`;
  const child=Bun.spawn([process.execPath,"-e",code],{cwd:root,env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},stdout:"pipe",stderr:"pipe"});
  const [output,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(exit,error).toBe(0);
  const receipt=JSON.parse(output);expect(receipt.samePath).toBe(true);expect(receipt.actual).toBe(receipt.expected);expect(receipt.repeated).toBe(receipt.expected);expect(receipt.sameRepeatedPath).toBe(true);
});
