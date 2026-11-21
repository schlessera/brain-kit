/** No installed runtime is launched: validate the native proof's oracle. */
import {expect,test} from 'bun:test';
import {assertNativeSameToolProof} from './helpers/native-safety-proof';
const first={admitted:2,results:1,nativeSecondHeld:true,deliveredPaths:['workspaces/voyage/sirens.md']};
const exposure={kind:'exposure',detector:null,source:null,state:'interrupted_unknown'};
const output={kind:'occurrence',detector:'tool_search_output',source:'workspace_read',state:'open'};
test('native oracle accepts one delivered output and a held second search',()=>{
 expect(()=>assertNativeSameToolProof(first,[exposure,output])).not.toThrow();
});
test('native oracle rejects an input-only occurrence despite its interrupted exposure',()=>{
 expect(()=>assertNativeSameToolProof(first,[exposure,{kind:'occurrence',detector:'tool_file_input',source:'workspace_read',state:'open'}])).toThrow('NATIVE_SAME_TOOL_OUTPUT_DETECTOR');
});
test('native oracle rejects two delivered results',()=>{
 expect(()=>assertNativeSameToolProof({...first,results:2},[exposure,output])).toThrow('NATIVE_EXACTLY_ONE_RESULT');
});
test('native oracle rejects an unheld second search',()=>{
 expect(()=>assertNativeSameToolProof({...first,nativeSecondHeld:false},[exposure,output])).toThrow('NATIVE_SECOND_SEARCH_OUTPUT_IS_HELD');
});

test('native oracle rejects an unknown output instead of the returned workspace source',()=>{
 expect(()=>assertNativeSameToolProof(first,[exposure,{...output,source:'legacy_unknown'}])).toThrow('NATIVE_SAME_TOOL_OUTPUT_DETECTOR');
});
test('native oracle rejects a result that lost the actual returned filename',()=>{
 expect(()=>assertNativeSameToolProof({...first,deliveredPaths:[]},[exposure,output])).toThrow('NATIVE_DELIVERED_RESULT_NAMES');
});
