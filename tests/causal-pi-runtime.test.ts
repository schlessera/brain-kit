/** Real installed Pi dispatch, isolated by an OS network namespace. */
import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {watchdogMs} from '../scripts/test-deadlines';

for(const mode of ['healthy','evidence','evidence-blind'] as const)test(`installed Pi dispatch fences its held post-card input: ${mode}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'odysseus-causal-pi-'));mkdirSync(join(root,'home'));
 const repo=join(import.meta.dir,'..');
 const child=Bun.spawn(['bwrap','--unshare-net','--bind','/','/','--proc','/proc','--dev','/dev',process.execPath,'--preload',join(repo,'scripts/test-network-child-preload.ts'),join(import.meta.dir,'fixtures/causal-pi-dispatch.ts'),mode,root,readlinkSync('/proc/self/ns/net')],{cwd:repo,env:{PATH:process.env.PATH!,HOME:join(root,'home'),LANG:'C.UTF-8',...(process.env.BRAIN_TEST_DEADLINE_FACTOR?{BRAIN_TEST_DEADLINE_FACTOR:process.env.BRAIN_TEST_DEADLINE_FACTOR}:{})},stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),watchdogMs(110000));
 try{
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code,err||out).toBe(0);
  const result=JSON.parse(out.trim().split('\n').at(-1)!);
  expect(result.isolatedNetwork,'NATIVE_PI_OS_OFFLINE_BOUNDARY').toBe(true);
  expect(result.held,'NATIVE_PI_REAL_BACKEND_REACHED_INPUT_WAIT').toBe(true);
  expect(result.approvals,'NATIVE_PI_ACTUALLY_RECEIVED_OUTWARD_APPROVAL').toBeGreaterThan(0);
  expect(result.requests).toBe(2);
  expect(result.ownInputs,'NATIVE_PI_ACTUALLY_COLLECTED_ITS_OWN_INPUT').toBe(1);
  expect(result.after,'NATIVE_PI_OWN_INPUT_REALLY_ADVANCES_EVIDENCE').not.toBe(result.before);
  const marker=join(root,'brain/.brain/scratch/causal-dispatch');
  expect(existsSync(marker),'NATIVE_PI_DISPATCHES_ONLY_WITH_CURRENT_APPROVAL').toBe(mode!=='evidence');
  if(mode!=='evidence')expect(readFileSync(marker,'utf8'),'NATIVE_PI_PROCESS_EFFECT_IS_INDEPENDENT_OF_RESULT_DELIVERY').toBe('Ithaca\n');
  if(mode!=='evidence')expect(result.frames.filter((frame:{type:string;toolUseId?:string})=>frame.type==='tool_result'&&frame.toolUseId==='call_causal'),'NATIVE_PI_ACTUAL_BACKEND_RESULT_PRECEDES_ANY_FILTER').toHaveLength(1);
  if(mode==='evidence-blind')expect(result.deliveredFrames.filter((frame:{type:string})=>frame.type==='tool_result')).toEqual([]);
  expect(result.owed,'NATIVE_PI_REFUSED_CALL_LEAVES_NO_FALSE_RESULT_GAP').toEqual({n:0});
  expect(result.failure).toEqual({failure:null});
 }finally{clearTimeout(timer);if(child.exitCode===null){child.kill();await child.exited;}rmSync(root,{recursive:true,force:true});}
},watchdogMs(120000));
