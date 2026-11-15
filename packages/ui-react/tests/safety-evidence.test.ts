import {test,expect} from 'bun:test';
import {entryEvidence,safetyEvidence} from '../src/lib/safety-evidence';
import type {SafetyRecord} from '@schlessera/brain-ui-sdk/protocol';
const occurrence=(id:string,turnId:string,toolUseId?:string):SafetyRecord=>({kind:'occurrence',id,sequence:'1',observedAt:Date.UTC(2026,6,12,10),turnId,bindingId:'voyage_binding',occurrenceId:id,detailPruned:false,epochId:'voyage_binding',detector:'tool_web_input',source:'web_fetch',operationId:'tool_a',signalId:'signal_a',exposureId:'exposure_a',exposure:'open',summary:'Recorded input exposure',provenance:null,...(toolUseId?{entry:{kind:'tool',toolUseId}}:{})});

test('only an explicit exact turn/tool pair can attach evidence, including repeated tool IDs',()=>{
 const records={a:occurrence('a','turn_a','tool_a'),b:occurrence('b','turn_b','tool_a'),legacy:occurrence('legacy','turn_a')};
 expect(entryEvidence(records,'turn_a',['tool_a']).map(e=>e.occurrence.id),'EXACT_TURN_TOOL_JOIN').toEqual(['a']);
 expect(entryEvidence(records,'turn_c',['tool_a']),'DIFFERENT_TURN_CANNOT_BORROW_TOOL_ID').toEqual([]);
 expect(entryEvidence(records,undefined,['tool_a'])).toEqual([]);
 expect(entryEvidence(records,'turn_a',['other'])).toEqual([]);
 expect(entryEvidence({legacy:records.legacy},'turn_a',['tool_a']),'OPERATION_ID_NEVER_STANDS_IN_FOR_TOOL_ID').toEqual([]);
});

test('exposure and human decisions join only their immutable occurrence, independent of delivery order',()=>{
 const a=occurrence('a','turn_a','tool_a'),b=occurrence('b','turn_a','tool_b');
 const record=(id:string,sequence:string,occurrenceId:string,state:'finalized'|'interrupted_unknown'):SafetyRecord=>({kind:'exposure',id,sequence,observedAt:0,turnId:'turn_a',bindingId:'voyage_binding',occurrenceId,detailPruned:false,state});
 const records={a,b,newer:record('final','3','a','finalized'),older:record('old','2','a','interrupted_unknown'),decision:{id:'decision',sequence:'4',observedAt:1,turnId:'turn_a',bindingId:'voyage_binding',occurrenceId:'a',detailPruned:false,kind:'safe_decision',session:{sessionId:'ithaca',historyOwnerId:'odysseus',historyGeneration:'1'},requestId:'request',principalId:'owner',verdict:'safe',channel:'owner_history'} as SafetyRecord};
 const entries=safetyEvidence(records);expect(entries.get('a')?.exposure).toBe('finalized');expect(entries.get('a')?.decision?.id).toBe('decision');
 expect(entries.get('b')?.decision,'A_VERDICT_NEVER_RESOLVES_B').toBeNull();expect(entries.get('b')?.exposure).toBe('open');
});
