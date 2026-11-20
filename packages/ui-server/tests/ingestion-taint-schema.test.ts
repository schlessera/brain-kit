import {expect,test} from 'bun:test';
import {outputTaintSignals,searchOutputContext} from '../src/activity/ingestion-taint';
const glob=(filenames:string[],extra={})=>JSON.stringify({durationMs:1,numFiles:filenames.length,filenames,truncated:false,...extra});
const grep=(filenames:string[],extra={})=>JSON.stringify({numFiles:filenames.length,filenames,...extra});
for(const [name,tool,input,output,expected] of [
 ['overlapping numeric delimiters','grep',{},'notes/voyage:2:7:sirens',['user_marked','legacy_unknown']],
 ['Glob text block rejected','Glob',{},JSON.stringify([{type:'text',text:'notes/voyage:2:home.md'}]),['legacy_unknown']],
 ['plain clipped Glob rejected','Glob',{},'notes/voy...',['legacy_unknown']],
 ['padded Pi sentinel','grep',{},' No matches. ',['legacy_unknown']],
 ['mixed Pi sentinel','grep',{},'notes/voyage.md:1:sirens\nNo matches.',['user_marked','legacy_unknown']],
 ['Claude pagination','Grep',{},grep(['notes/loom.md'],{totalFiles:2}),['legacy_unknown']],
 ['arbitrary Pi JSON sentinel','grep',{},JSON.stringify({matches:'No matches.'}),['legacy_unknown']],
 ['clipped Glob JSON','Glob',{},'{"filenames":["notes/voyage.md"',['legacy_unknown']],
 ['Claude no line numbers','Grep',{output_mode:'content','-n':false},grep([],{content:'notes/voyage.md:signal:2:echo',numLines:1}),['user_marked','legacy_unknown']],
 ['marked exact Glob','Glob',{},glob(['notes/voyage:2:home.md']),['user_marked']],
 ['complete Glob','Glob',{},glob(['notes/loom.md']),[]],
 ['Glob total omitted','Glob',{},glob(['notes/loom.md'],{totalMatches:2}),['legacy_unknown']],
 ['Glob lower bound','Glob',{},glob(['notes/loom.md'],{countIsComplete:false}),['legacy_unknown']],
 ['Glob truncated flag','Glob',{},glob(['notes/loom.md'],{truncated:true}),['legacy_unknown']],
 ['Glob clipped filename','Glob',{},glob(['notes/voy...']),['legacy_unknown']],
 ['Glob unknown key','Glob',{},glob([],{unexpected:true}),['legacy_unknown']],
 ['Glob invalid count','Glob',{},glob(['notes/loom.md'],{numFiles:0}),['legacy_unknown']],
 ['Glob missing fields','Glob',{},JSON.stringify({filenames:['notes/voyage.md']}),['legacy_unknown']],
 ['Grep wrong mode','Grep',{},grep([],{mode:'content'}),['legacy_unknown']],
 ['Grep omitted lines','Grep',{output_mode:'content'},grep([],{content:'notes/loom.md:1:sirens',numLines:1,totalLines:2}),['legacy_unknown']],
 ['Grep offset','Grep',{offset:1},grep([]),['legacy_unknown']],
 ['Grep count colon filename','Grep',{output_mode:'count'},grep([],{content:'notes/voyage:2:7'}),['user_marked']],
 ['Grep numbered content','Grep',{output_mode:'content'},grep([],{content:'notes/voyage.md:1:sirens',numLines:1}),['user_marked']],
 ['Grep ambiguous content','Grep',{output_mode:'content'},grep([],{content:'notes/voyage:2:7:sirens',numLines:1}),['user_marked','legacy_unknown']],
 ['Pi exact sentinel','grep',{},'No matches.',[]],
 ['Pi transport sentinel','grep',{},JSON.stringify([{type:'text',text:'No matches.'}]),['legacy_unknown']],
 ['Pi multiple blocks','grep',{},JSON.stringify([{type:'text',text:'No matches.'},{type:'text',text:''}]),['legacy_unknown']],
 ['Pi unknown transport key','grep',{},JSON.stringify([{type:'text',text:'No matches.',other:true}]),['legacy_unknown']],
 ['Pi malformed JSON','grep',{},'{"matches":',['legacy_unknown']],
 ['Pi quoted sentinel','grep',{},JSON.stringify('No matches.'),['legacy_unknown']],
] as const)test(`recognized search shape: ${name}`,()=>{
 const marked=(path:string)=>['notes/voyage.md','notes/voyage:2','notes/voyage:2:home.md'].includes(path);
 const signals=outputTaintSignals(tool,output,'/srv/odysseus/brain',marked,searchOutputContext(tool,input));
 expect(signals.map(s=>s.source),'ONLY_RECOGNIZED_COMPLETE_SHAPES_CAN_REMAIN_HEALTHY').toEqual([...expected]);
});
