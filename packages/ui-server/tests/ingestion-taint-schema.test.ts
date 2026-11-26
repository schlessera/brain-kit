import {afterAll,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safetyResultInput} from '../../ui-backend-pi/src/worker-protocol';
import {brainFileLookup,outputTaintSignals,searchOutputContext} from '../src/activity/ingestion-taint';
const glob=(filenames:string[],extra={})=>JSON.stringify({durationMs:1,numFiles:filenames.length,filenames,truncated:false,...extra});
const grep=(filenames:string[],extra={})=>JSON.stringify({numFiles:filenames.length,filenames,...extra});
for(const [name,tool,input,output,expected] of [
 ['Pi bracket filename and independent later mark','grep',{},'[voyage]/log.md:\0'+'1:sirens\nnotes/voyage.md:\0'+'2:echo\n',['user_marked','user_marked']],
 ['Pi malformed line retains later mark','grep',{},'{malformed\nnotes/voyage.md:2:echo',['user_marked','legacy_unknown']],
 ['Grep at page limit without total','Grep',{},grep(['notes/loom.md'],{appliedLimit:1}),['legacy_unknown']],
 ['Grep inconsistent reported limit','Grep',{},grep(['notes/loom.md'],{appliedLimit:1,totalFiles:1}),['legacy_unknown']],
 ['Grep input limit without metadata','Grep',{head_limit:1},grep(['notes/loom.md']),['legacy_unknown']],
 ['Grep empty count claims matches','Grep',{output_mode:'count'},grep([],{content:'',numMatches:3}),['legacy_unknown']],
 ['Grep wrong sum','Grep',{output_mode:'count'},grep([],{content:'notes/loom.md:2',numMatches:3}),['legacy_unknown']],
 ['Grep correct sum','Grep',{output_mode:'count'},grep([],{numFiles:1,content:'notes/loom.md:2',numMatches:2}),[]],
 ['Grep empty content claims matches','Grep',{output_mode:'content'},grep([],{content:'',numMatches:3}),['legacy_unknown']],
 ['Grep empty files claims matches','Grep',{},grep([],{numMatches:3}),['legacy_unknown']],
 ['Grep files have missing content','Grep',{output_mode:'content'},grep(['notes/loom.md'],{content:''}),['legacy_unknown']],
 ['Grep files have missing counts','Grep',{output_mode:'count'},grep(['notes/loom.md'],{content:''}),['legacy_unknown']],
 ['Grep duplicate filenames','Grep',{},grep(['notes/loom.md','notes/loom.md']),['legacy_unknown']],
 ['Glob duplicate filenames','Glob',{},glob(['notes/loom.md','notes/loom.md']),['legacy_unknown']],
 ['Glob missing completed count','Glob',{},glob([],{countIsComplete:true}),['legacy_unknown']],
 ['Glob bad duration','Glob',{},glob([],{durationMs:-1}),['legacy_unknown']],
 ['Grep invalid optional number','Grep',{},grep([],{numMatches:-1}),['legacy_unknown']],
 ['Grep unexpected key','Grep',{},grep([],{unexpected:true}),['legacy_unknown']],
 ['Grep hidden line count in files','Grep',{},grep([],{numLines:3}),['legacy_unknown']],
 ['Grep hidden total lines in files','Grep',{},grep([],{totalLines:3}),['legacy_unknown']],
 ['Grep content at limit without total','Grep',{output_mode:'content'},grep([],{content:'notes/loom.md:1:sirens',appliedLimit:1}),['legacy_unknown']],
 ['Grep count at limit without total','Grep',{output_mode:'count'},grep([],{content:'notes/loom.md:2',appliedLimit:1}),['legacy_unknown']],
 ['Grep zero count entry','Grep',{output_mode:'count'},grep([],{content:'notes/loom.md:0',numMatches:0}),['legacy_unknown']],
 ['Grep wrong reported offset','Grep',{offset:1},grep([],{appliedOffset:0}),['legacy_unknown']],
 ['Grep unbounded limit','Grep',{head_limit:0},grep(['notes/loom.md']),[]],
 ['Grep content has no reported filename count','Grep',{output_mode:'content'},grep([],{content:'notes/loom.md:1:sirens',numLines:1,totalLines:1}),[]],
 ['Grep count mismatched filenames','Grep',{output_mode:'count'},grep(['notes/other.md'],{content:'notes/loom.md:1',numMatches:1}),['legacy_unknown']],
 ['Grep reported unlimited cannot hide input limit','Grep',{head_limit:1},grep(['notes/loom.md'],{appliedLimit:0}),['legacy_unknown']],
 ['Grep content count contradicts lines','Grep',{output_mode:'content'},grep(['notes/loom.md'],{content:'notes/loom.md:1:sirens',numMatches:2}),['legacy_unknown']],
 ['Grep filename count contradicts matches','Grep',{},grep(['notes/loom.md'],{numMatches:0}),['legacy_unknown']],
 ['Grep null output selector','Grep',{output_mode:null},grep([]),['legacy_unknown']],
 ['Grep null line selector','Grep',{'-n':null},grep([]),['legacy_unknown']],
 ['Grep null limit selector','Grep',{head_limit:null},grep([]),['legacy_unknown']],
 ['Grep null offset selector','Grep',{offset:null},grep([]),['legacy_unknown']],
 ['Glob mixed filename types','Glob',{},JSON.stringify({durationMs:1,numFiles:2,filenames:['notes/voyage.md',false],truncated:false}),['user_marked','legacy_unknown']],
 ['Grep mixed filename types','Grep',{},JSON.stringify({numFiles:2,filenames:['notes/voyage.md',false]}),['user_marked','legacy_unknown']],
 ['Glob bad metadata retains filename','Glob',{},glob(['notes/voyage.md'],{durationMs:-1}),['user_marked','legacy_unknown']],
 ['Grep bad metadata retains content','Grep',{output_mode:'content'},grep([],{content:'notes/voyage.md:1:sirens',numLines:-1}),['user_marked','legacy_unknown']],
 ['Grep bad metadata retains count','Grep',{output_mode:'count'},grep([],{content:'notes/voyage.md:2',numMatches:-1}),['user_marked','legacy_unknown']],
 ['Grep exceeds page limit','Grep',{head_limit:1},grep(['notes/loom.md','notes/raft.md'],{appliedLimit:1,totalFiles:2}),['legacy_unknown']],
 ['Grep content exceeds page limit','Grep',{head_limit:1,output_mode:'content'},grep(['notes/loom.md'],{content:'notes/loom.md:1:sirens\nnotes/loom.md:2:echo',appliedLimit:1,totalFiles:1,totalLines:2}),['legacy_unknown']],
 ['Grep count exceeds page limit','Grep',{head_limit:1,output_mode:'count'},grep(['notes/loom.md','notes/raft.md'],{content:'notes/loom.md:1\nnotes/raft.md:2',appliedLimit:1,totalFiles:2,totalLines:2}),['legacy_unknown']],
 ['Pi healthy bracket path','grep',{},'[raft]/log.md:\0'+'1:sirens\n',[]],
 ['Glob exceeds installed file cap','Glob',{},glob(Array.from({length:101},(_,i)=>`notes/loom-${i}.md`)),['legacy_unknown']],
 ['Glob legal CR LF filename','Glob',{},glob(['workspaces/voyage/log\r\n.md']),['workspace_read','user_marked']],
 ['Grep legal CR LF filename','Grep',{},grep(['workspaces/voyage/log\r\n.md']),['workspace_read','user_marked']],
 ['Pi sentinel plus image','grep',{},safetyResultInput('grep',[{type:'text',text:'No matches.'},{type:'image'}]),['legacy_unknown']],
 ['Pi sentinel incomplete original','grep',{},safetyResultInput('grep',[{type:'text',text:'No matches.'}],false),['legacy_unknown']],
 ['Pi marked row plus image','grep',{},safetyResultInput('grep',[{type:'text',text:'notes/voyage.md:1:sirens'},{type:'image'}]),['user_marked','legacy_unknown']],
 ['Pi sentinel plus empty block','grep',{},safetyResultInput('grep',[{type:'text',text:'No matches.'},{type:'text',text:''}]),['legacy_unknown']],
 ['Pi inconsistent frame salvages visible path','grep',{},safetyResultInput('grep',[{type:'text',text:'notes/voyage.md:1:sirens'}],true,false,{search:{exitCode:0,stderr:false,truncated:false,framedOutput:'notes/loom.md:\0'+'1:echo\n'}}),['user_marked','legacy_unknown']],
 ['Pi truncated frame cannot omit visible paths','grep',{},safetyResultInput('grep',[{type:'text',text:'notes/loom.md:1:echo\nnotes/voyage.md:1:sirens'}],true,false,{search:{exitCode:0,stderr:false,truncated:true,framedOutput:'notes/loom.md:\0'+'1:echo\n',visibleText:'notes/loom.md:1:echo\nnotes/voyage.md:1:sirens'}}),['user_marked','legacy_unknown']],
 ['Pi exact original sentinel','grep',{},safetyResultInput('grep',[{type:'text',text:'No matches.'}],true,false,{search:{stdoutEmpty:true,exitCode:1,stderr:false,truncated:false}}),[]],
 ['Pi sentinel with missing zero-byte proof','grep',{},safetyResultInput('grep',[{type:'text',text:'No matches.'}],true,false,{search:{exitCode:1,stderr:false,truncated:false}}),['legacy_unknown']],
 ['Pi sentinel with nonempty stdout','grep',{},safetyResultInput('grep',[{type:'text',text:'No matches.'}],true,false,{search:{stdoutEmpty:false,exitCode:1,stderr:false,truncated:false}}),['legacy_unknown']],
 ['Grep duplicate per-file count rows','Grep',{output_mode:'count'},grep(['notes/loom.md'],{content:'notes/loom.md:1\nnotes/loom.md:1',numMatches:2}),['legacy_unknown']],
 ['Pi newline filename ambiguity is never healthy legacy evidence','grep',{},'./raft:1:sail\nloom.md:1:sirens',['legacy_unknown']],
 ['Pi NUL newline filename','grep',{},'./raft:1:sail\nloom.md:\0'+'1:sirens\n',['user_marked']],
 ['Pi NUL whitespace filename','grep',{},' notes/loom.md :\0'+'1:sirens\n',[]],
 ['Pi NUL malformed line number retains path','grep',{},'notes/voyage.md:\0'+'zero:sirens\n',['user_marked','legacy_unknown']],
 ['Pi NUL clipped next path retains first mark','grep',{},'notes/voyage.md:\0'+'1:sirens\nnotes/loo...',['user_marked','legacy_unknown']],
 ['overlapping numeric delimiters','grep',{},'notes/voyage:2:7:sirens',['user_marked','legacy_unknown']],
 ['Glob text block rejected','Glob',{},JSON.stringify([{type:'text',text:'notes/voyage:2:home.md'}]),['legacy_unknown']],
 ['plain clipped Glob rejected','Glob',{},'notes/voy...',['legacy_unknown']],
 ['padded Pi sentinel','grep',{},' No matches. ',['legacy_unknown']],
 ['mixed Pi sentinel','grep',{},'notes/voyage.md:1:sirens\nNo matches.',['user_marked','legacy_unknown']],
 ['Claude pagination','Grep',{},grep(['notes/loom.md'],{totalFiles:2}),['legacy_unknown']],
 ['arbitrary Pi JSON sentinel','grep',{},JSON.stringify({matches:'No matches.'}),['legacy_unknown']],
 ['clipped Glob JSON','Glob',{},'{"filenames":["notes/voyage.md"',['user_marked','legacy_unknown']],
 ['Claude no line numbers','Grep',{output_mode:'content','-n':false},grep([],{content:'notes/voyage.md:signal:2:echo',numLines:1}),['user_marked','legacy_unknown']],
 ['marked exact Glob','Glob',{},glob(['notes/voyage:2:home.md']),['user_marked']],
 ['complete Glob','Glob',{},glob(['notes/loom.md']),[]],
 ['Glob literal omission filename','Glob',{},glob(['notes/omitted.md'],{countIsComplete:true,totalMatches:1}),[]],
 ['Glob literal truncation filename','Glob',{},glob(['notes/truncated.md'],{countIsComplete:true,totalMatches:1}),[]],
 ['Grep literal omission content','Grep',{output_mode:'content'},grep([],{content:'notes/loom.md:1:omitted',numLines:1,totalLines:1}),[]],
 ['Grep literal omission count path','Grep',{output_mode:'count'},grep([],{numFiles:1,content:'notes/omitted.md:2',numMatches:2}),[]],
 ['Pi exact literal omission path','grep',{},'notes/omitted.md:\0'+'1:sirens\n',[]],
 ['Glob total omitted','Glob',{},glob(['notes/loom.md'],{totalMatches:2}),['legacy_unknown']],
 ['Glob lower bound','Glob',{},glob(['notes/loom.md'],{countIsComplete:false}),['legacy_unknown']],
 ['Glob truncated flag','Glob',{},glob(['notes/loom.md'],{truncated:true}),['legacy_unknown']],
 ['Glob literal ellipsis filename','Glob',{},glob(['notes/voy...']),[]],
 ['Glob unknown key','Glob',{},glob([],{unexpected:true}),['legacy_unknown']],
 ['Glob invalid count','Glob',{},glob(['notes/loom.md'],{numFiles:0}),['legacy_unknown']],
 ['Glob missing fields','Glob',{},JSON.stringify({filenames:['notes/voyage.md']}),['user_marked','legacy_unknown']],
 ['Grep wrong mode','Grep',{},grep([],{mode:'content'}),['legacy_unknown']],
 ['Grep omitted lines','Grep',{output_mode:'content'},grep([],{content:'notes/loom.md:1:sirens',numLines:1,totalLines:2}),['legacy_unknown']],
 ['Grep offset','Grep',{offset:1},grep([]),['legacy_unknown']],
 ['Grep count colon filename','Grep',{output_mode:'count'},grep([],{numFiles:1,content:'notes/voyage:2:7',numMatches:7}),['user_marked']],
 ['Grep mode mismatch salvages content','Grep',{output_mode:'files_with_matches'},grep([],{mode:'content',content:'notes/voyage.md:1:sirens',numLines:1}),['user_marked','legacy_unknown']],
 ['Grep numbered content','Grep',{output_mode:'content'},grep([],{content:'notes/voyage.md:1:sirens',numLines:1,totalLines:1}),['user_marked']],
 ['Grep ambiguous content','Grep',{output_mode:'content'},grep([],{content:'notes/voyage:2:7:sirens',numLines:1}),['user_marked','legacy_unknown']],
 ['Pi exact sentinel','grep',{},'No matches.',[]],
 ['Pi transport sentinel','grep',{},JSON.stringify([{type:'text',text:'No matches.'}]),['legacy_unknown']],
 ['Pi multiple blocks','grep',{},JSON.stringify([{type:'text',text:'No matches.'},{type:'text',text:''}]),['legacy_unknown']],
 ['Pi unknown transport key','grep',{},JSON.stringify([{type:'text',text:'No matches.',other:true}]),['legacy_unknown']],
 ['Pi malformed JSON','grep',{},'{"matches":',['legacy_unknown']],
 ['Pi quoted sentinel','grep',{},JSON.stringify('No matches.'),['legacy_unknown']],
] as const)test(`recognized search shape: ${name}`,()=>{
 const marked=(path:string)=>['raft:1:sail\nloom.md','workspaces/voyage/log\r\n.md','[voyage]/log.md','notes/voyage.md','notes/voyage:2','notes/voyage:2:home.md'].includes(path);
 const observation=typeof output==='string'?{output,outputStatus:undefined}:output;
 const signals=outputTaintSignals(tool,observation.output,'/srv/odysseus/brain',marked,{...searchOutputContext(tool,input),outputComplete:observation.outputStatus?.complete});
 expect(signals.map(s=>s.source),'ONLY_RECOGNIZED_COMPLETE_SHAPES_CAN_REMAIN_HEALTHY').toEqual([...expected]);
});

for(const terminated of [false,true])for(const shape of ['incomplete','image'] as const)test(`explicit Pi completeness is independent of row text: ${shape}-${terminated?'terminated':'unterminated'}`,()=>{
 const text='notes/loom.md:\0'+'1:sirens'+(terminated?'\n':'');
 const converted=safetyResultInput('grep',[{type:'text',text},...(shape==='image'?[{type:'image'}]:[])],shape!=='incomplete',false,{search:{exitCode:0,stderr:false,truncated:false}});
 expect(converted.output,'STATUS_NEVER_REWRITES_RESULT_TEXT').toBe(text);
 const signals=outputTaintSignals('grep',converted.output,'/srv/odysseus/brain',()=>false,{...searchOutputContext('grep',{}),outputComplete:converted.outputStatus.complete});
 expect(signals.map(signal=>signal.source),'EXPLICIT_INCOMPLETE_RESULT_STAYS_UNKNOWN').toEqual(['legacy_unknown']);
});

for(const filename of ['123','{"durationMs":1,"numFiles":0,"filenames":[],"truncated":false}','notes/voyage\nloom.md'])test(`display-only Glob treats filename bytes literally: ${JSON.stringify(filename)}`,()=>{
 const signals=outputTaintSignals('Glob',filename,undefined,path=>path===filename,{displayOnly:true,backendId:'claude'});
 expect(signals.map(signal=>({source:signal.source,key:signal.key})).sort((a,b)=>a.source.localeCompare(b.source)),'DISPLAY_BOUNDARIES_NEVER_HIDE_MARKS_OR_UNKNOWN').toEqual([{source:'legacy_unknown',key:'unknown_remainder'},{source:'user_marked',key:filename}]);
});

test('exactly empty display fallback has no ambiguous filename bytes',()=>{
 expect(outputTaintSignals('Glob','',undefined,()=>false,{displayOnly:true,backendId:'claude'})).toEqual([]);
});

for(const mode of ['content','count'] as const)test(`display Grep ${mode} guards parsed paths rather than match text`,()=>{
 const output=mode==='content'?`notes/loom.md:7:${'s'.repeat(1100)}`:`notes/loom.md:${'7'.repeat(1100)}`;
 const signals=outputTaintSignals('Grep',output,undefined,path=>path==='notes/loom.md',{displayOnly:true,backendId:'claude',outputMode:mode,lineNumbers:true});
 expect(signals.map(signal=>signal.source).sort(),'LONG_CONTENT_RETAINS_MARK_AND_UNKNOWN').toEqual(['legacy_unknown','user_marked']);
});
test('unparseable oversized candidates retain independent later marks without throwing',()=>{
 const signals=outputTaintSignals('Grep',`${'x'.repeat(1100)}:1:echo\nnotes/loom.md:2:sirens`,undefined,path=>path==='notes/loom.md',{displayOnly:true,backendId:'claude',outputMode:'content',lineNumbers:true});
 expect(signals.map(signal=>signal.source).sort()).toEqual(['legacy_unknown','user_marked']);
});

test('malformed mode never coerces and retains marked siblings',()=>{
 const signals=outputTaintSignals('Grep',grep(['notes/loom.md'],{mode:{toString:null}}),undefined,path=>path==='notes/loom.md',searchOutputContext('Grep',{}));
 expect(signals.map(signal=>signal.source).sort()).toEqual(['legacy_unknown','user_marked']);
});
test('display filename marks after row 256 remain identifiable within the byte budget',()=>{
 const rows=[...Array.from({length:256},(_,i)=>`notes/ordinary-${i}.md`),'notes/loom.md'];
 const signals=outputTaintSignals('Grep',rows.join('\n'),undefined,path=>path==='notes/loom.md',{backendId:'claude',displayOnly:true,outputMode:'files_with_matches'});
 expect(signals.map(signal=>signal.source).sort()).toEqual(['legacy_unknown','user_marked']);
});
for(const count of [256,257])test(`complete search signal boundary: ${count}`,()=>{
 const paths=Array.from({length:count},(_,i)=>`notes/loom-${i}.md`);
 const signals=outputTaintSignals('Grep',grep(paths),undefined,()=>true,searchOutputContext('Grep',{head_limit:0}));
 expect(signals.filter(signal=>signal.source==='user_marked')).toHaveLength(count===256?256:255);
 expect(signals.filter(signal=>signal.source==='legacy_unknown')).toHaveLength(count===256?0:1);
});
test('unexpected detector failure retains marks already found plus unknown',()=>{
 const context={backendId:'claude',outputMode:'content',get lineNumbers():boolean{throw new Error('Malformed selector');}};
 const signals=outputTaintSignals('Grep',grep(['notes/loom.md'],{content:'notes/loom.md:1:sirens'}),undefined,()=>true,context);
 expect(signals.map(signal=>signal.source).sort()).toEqual(['legacy_unknown','user_marked']);
});
test('oversized structured content retains complete filename fields inside the parse budget',()=>{
 const output=grep(['notes/loom.md'],{content:'s'.repeat(1048577)});
 const signals=outputTaintSignals('Grep',output,undefined,path=>path==='notes/loom.md',searchOutputContext('Grep',{output_mode:'content'}));
 expect(signals.map(signal=>signal.source).sort()).toEqual(['legacy_unknown','user_marked']);
});

test('byte cutoff at every array position retains every complete filename element',()=>{
 const paths=['workspaces/voyage/raft.md','notes/lo"om.md','notes/a\nb.md'],array=JSON.stringify(paths);
 let end=1;const ends=paths.map(path=>{end+=JSON.stringify(path).length;const result=end;end++;return result;});
 for(let cut=0;cut<=array.length;cut++){
  const before='{"padding":"',after='","filenames":',padding=1048576-before.length-after.length-cut;
  const output=before+' '.repeat(padding)+after+array+',"content":"'+ 's'.repeat(100)+'"}';
  const signals=outputTaintSignals('Grep',output,undefined,path=>paths.includes(path),searchOutputContext('Grep',{head_limit:0}));
  const expected=paths.filter((_,index)=>ends[index]!<=cut).flatMap(path=>[...(path.startsWith('workspaces/')?['workspace_read:'+path]:[]),'user_marked:'+path]);
  expected.push('legacy_unknown:unknown_remainder');
  expect(signals.map(signal=>signal.source+':'+signal.key).sort(),'ARRAY_BYTE_CUT_'+cut).toEqual(expected.sort());
 }
});

for(const [name,input,output] of [
 ['empty content',{output_mode:'content'},{mode:'content',numFiles:0,filenames:[],content:'',numLines:0,totalLines:0}],
 ['empty count',{output_mode:'count'},{mode:'count',numFiles:0,filenames:[],content:'',numMatches:0}],
 ['empty filenames',{}, {mode:'files_with_matches',numFiles:0,filenames:[],totalFiles:0}],
 ['unnumbered context',{output_mode:'content','-n':false,context:1},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md-sails\nnotes/loom.md:sirens',numLines:2,totalLines:2}],
 ['context group separator',{output_mode:'content',context:1},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md:1:sirens\n--\nnotes/raft.md:4:sirens',numLines:3,totalLines:3}],
 ['ISO date content',{output_mode:'content'},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md:3:due 2026-11-20',numLines:1,totalLines:1}],
 ['date slug filename',{output_mode:'content'},{mode:'content',numFiles:0,filenames:[],content:'notes/2026-11-20-standup.md:3:sirens',numLines:1,totalLines:1}],
 ['content directory match',{output_mode:'content'},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md:1:sirens',numLines:1,totalLines:1}],
 ['content context and match',{output_mode:'content',context:1},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md-12-sails\nnotes/loom.md:13:sirens',numLines:2,totalLines:2}],
 ['content without numbers',{output_mode:'content','-n':false},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md:sirens',numLines:1,totalLines:1}],
 ['count directory matches',{output_mode:'count'},{mode:'count',numFiles:2,filenames:[],content:'notes/loom.md:2\nnotes/raft.md:3',numMatches:5}],
 ['count reaches known total',{output_mode:'count',head_limit:1},{mode:'count',numFiles:1,filenames:[],content:'notes/loom.md:2',numMatches:2}],
 ['files with matches',{}, {mode:'files_with_matches',numFiles:2,filenames:['notes/loom.md','notes/raft.md'],totalFiles:2}],
] as const)test(`installed Grep construction remains healthy: ${name}`,()=>{
 expect(outputTaintSignals('Grep',JSON.stringify(output),undefined,()=>false,searchOutputContext('Grep',input))).toEqual([]);
});
test('a paginated numbered context row retains its marked filename',()=>{
 const output={mode:'content',numFiles:0,filenames:[],content:'notes/loom.md-12-sails',numLines:1,totalLines:2,appliedOffset:1};
 expect(outputTaintSignals('Grep',JSON.stringify(output),undefined,path=>path==='notes/loom.md',searchOutputContext('Grep',{output_mode:'content',context:1,head_limit:1,offset:1})).map(s=>s.source).sort()).toEqual(['legacy_unknown','user_marked']);
});
test('partial arrays below the byte budget retain every complete filename',()=>{
 const paths=['workspaces/voyage/raft.md','notes/lo"om.md','notes/a\nb.md'],array=JSON.stringify(paths);let end=1;const ends=paths.map(path=>{end+=JSON.stringify(path).length;const result=end;end++;return result;});
 for(let cut=0;cut<array.length;cut++){
  const output='{"durationMs":1,"numFiles":3,"filenames":'+array.slice(0,cut);
  const expected=paths.filter((_,i)=>ends[i]!<=cut).flatMap(path=>[...(path.startsWith('workspaces/')?['workspace_read:'+path]:[]),'user_marked:'+path]);expected.push('legacy_unknown:unknown_remainder');
  expect(outputTaintSignals('Glob',output,undefined,path=>paths.includes(path),{backendId:'claude'}).map(s=>s.source+':'+s.key).sort(),'SMALL_ARRAY_CUT_'+cut).toEqual(expected.sort());
 }
});
for(const [name,input,value] of [
 ['content missing totals',{output_mode:'content'},{mode:'content',numFiles:0,filenames:[],content:'notes/loom.md:1:sirens',numLines:1}],
 ['count missing total matches',{output_mode:'count'},{mode:'count',numFiles:1,filenames:[],content:'notes/loom.md:2'}],
 ['context separator without a source',{output_mode:'content',context:1},{mode:'content',numFiles:0,filenames:[],content:'--',numLines:1,totalLines:1}],
] as const)test(`incomplete Grep construction stays unknown: ${name}`,()=>{
 expect(outputTaintSignals('Grep',JSON.stringify(value),undefined,()=>false,searchOutputContext('Grep',input)).map(s=>s.source)).toEqual(['legacy_unknown']);
});

/** Colon-number-colon candidates against the files the host can see (#4347).
 * Real installed Claude Grep content rows; the brain holds Odysseus's notes. */
const odysseusBrain=(()=>{
 const root=mkdtempSync(join(tmpdir(),'ithaca-brain-'));
 for(const path of ['notes/loom.md','notes/log:12:00.md','notes/voyage','notes/voyage:2'])mkdirSync(join(root,path,'..'),{recursive:true}),writeFileSync(join(root,path),'Odysseus sails at dawn.\n');
 mkdirSync(join(root,'notes/harbour:4'),{recursive:true});
 return root;
})();
afterAll(()=>rmSync(odysseusBrain,{recursive:true,force:true}));
for(const [name,content,marks,lookup,expected] of [
 ['clock time beside its one existing source','notes/loom.md:3:sails at 10:30:00',[],'brain',[]],
 ['clock time keeps the marked source','notes/loom.md:3:sails at 10:30:00',['notes/loom.md'],'brain',['user_marked']],
 ['filename with colon-number-colon','notes/log:12:00.md:4:sails',['notes/log:12:00.md'],'brain',['user_marked']],
 ['a directory candidate is no source','notes/harbour:4:7:sails',[],'brain',['legacy_unknown']],
 ['several existing candidates','notes/voyage:2:7:sirens',[],'brain',['legacy_unknown']],
 ['several existing candidates keep every mark','notes/voyage:2:7:sirens',['notes/voyage','notes/voyage:2'],'brain',['user_marked','user_marked','legacy_unknown']],
 ['no existing candidate','notes/raft.md:3:sails at 10:30:00',[],'brain',['legacy_unknown']],
 ['no filesystem evidence','notes/loom.md:3:sails at 10:30:00',[],'none',['legacy_unknown']],
 ['unknown evidence for one candidate','notes/loom.md:3:sails at 10:30:00',[],'partial',['legacy_unknown']],
 ['a failing lookup','notes/loom.md:3:sails at 10:30:00',[],'throws',['legacy_unknown']],
 ['each identifiable marked candidate','notes/loom.md:3:sails at 10:30:00',['notes/loom.md','notes/loom.md:3:sails at 10'],'brain',['user_marked','user_marked']],
] as const)test(`Grep colon candidates against existing files: ${name}`,()=>{
 const brain=brainFileLookup(odysseusBrain);
 const existingFile=lookup==='brain'?brain:lookup==='partial'?(path:string)=>path==='notes/loom.md'?true:undefined
  :lookup==='throws'?()=>{throw new Error('The loom is unravelled');}:undefined;
 const output=grep([],{content,numLines:1,totalLines:1});
 const signals=outputTaintSignals('Grep',output,odysseusBrain,path=>(marks as readonly string[]).includes(path),{...searchOutputContext('Grep',{output_mode:'content'}),existingFile});
 expect(signals.map(s=>s.source),'COLON_CANDIDATES_RESOLVE_ONLY_AGAINST_ONE_EXISTING_FILE').toEqual([...expected]);
});

test('brain file evidence is unknown outside the brain and false only for proven absence',()=>{
 const exists=brainFileLookup(odysseusBrain);
 expect(['notes/loom.md',`${odysseusBrain}/notes/loom.md`,'notes/raft.md','notes/loom.md/inner','notes/harbour:4','/srv/elsewhere/loom.md','../loom.md','']
  .map(exists),'HOST_FILE_EVIDENCE_NEVER_GUESSES').toEqual([true,true,false,false,false,undefined,undefined,undefined]);
 expect(brainFileLookup(undefined)('notes/loom.md')).toBeUndefined();
});
