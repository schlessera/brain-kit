/** No installed runtime is launched: validate the native proof's oracle. */
import {expect,test} from 'bun:test';
import {assertNativeSameToolProof} from './helpers/native-safety-proof';
const first={admitted:2,results:1,nativeSecondHeld:true};
const exposure={kind:'exposure',detector:null,state:'interrupted_unknown'};
const output={kind:'occurrence',detector:'tool_search_output',state:'open'};
test('native oracle accepts one delivered output and a held second search',()=>{
 expect(()=>assertNativeSameToolProof(first,[exposure,output])).not.toThrow();
});
test('native oracle rejects an input-only occurrence despite its interrupted exposure',()=>{
 expect(()=>assertNativeSameToolProof(first,[exposure,{kind:'occurrence',detector:'tool_file_input',state:'open'}])).toThrow('NATIVE_SAME_TOOL_OUTPUT_DETECTOR');
});
test('native oracle rejects two delivered results',()=>{
 expect(()=>assertNativeSameToolProof({...first,results:2},[exposure,output])).toThrow('NATIVE_EXACTLY_ONE_RESULT');
});
test('native oracle rejects an unheld second search',()=>{
 expect(()=>assertNativeSameToolProof({...first,nativeSecondHeld:false},[exposure,output])).toThrow('NATIVE_SECOND_SEARCH_OUTPUT_IS_HELD');
});
