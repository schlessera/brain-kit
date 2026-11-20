/** The native test's oracle, shared with adversarial non-native checks. */
import {expect} from 'bun:test';
export function assertNativeSameToolProof(first:{admitted:number;results:number;nativeSecondHeld:boolean},records:readonly unknown[]):void {
 expect(first.admitted,'NATIVE_SAME_TOOL_ID_HAS_TWO_LOGICAL_ADMISSIONS').toBe(2);
 expect(first.nativeSecondHeld,'NATIVE_SECOND_SEARCH_OUTPUT_IS_HELD_BEFORE_POST_TOOL_USE').toBe(true);
 expect(first.results,'NATIVE_EXACTLY_ONE_RESULT_HOOK_ACTUALLY_FORWARDS').toBe(1);
 expect(records,'NATIVE_SAME_TOOL_OUTPUT_DETECTOR_REACHES_THE_LEDGER').toEqual(expect.arrayContaining([
  {kind:'exposure',detector:null,state:'interrupted_unknown'},
  {kind:'occurrence',detector:'tool_search_output',state:'open'}
 ]));
}
