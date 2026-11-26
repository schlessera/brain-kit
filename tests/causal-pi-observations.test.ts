import {expect,test} from 'bun:test';
import {mapPiEvent} from '../packages/ui-backend-pi/src/event-adapter';
import {createPiDispatchObservations} from './fixtures/causal-pi-observations';

for(const suppress of [false,true])test(`Pi native oracle observes real adapter frames before host filtering (${suppress})`,()=>{
 const observed=createPiDispatchObservations(suppress);
 const frames=mapPiEvent({type:'tool_execution_end',toolCallId:'call_causal',toolName:'bash',isError:false,result:{content:[{type:'text',text:'Ithaca'}],details:{}}});
 for(const frame of frames)observed.emit(frame);
 expect(observed.frames,'RAW_BACKEND_EMISSION_CANNOT_BE_FILTERED_OUT_OF_THE_ORACLE').toEqual([{type:'tool_result',toolUseId:'call_causal',output:'Ithaca',isError:false}]);
 expect(observed.deliveredFrames).toEqual(suppress?[]:observed.frames);
});
