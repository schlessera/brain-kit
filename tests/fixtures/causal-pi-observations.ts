import type {ServerMessage} from '@schlessera/brain-ui-sdk/server';

/** Observe the installed backend before simulating a host delivery filter. */
export function createPiDispatchObservations(suppressResults:boolean){
 const frames:ServerMessage[]=[],deliveredFrames:ServerMessage[]=[];
 return {frames,deliveredFrames,emit(frame:ServerMessage){
  frames.push(frame);
  if(suppressResults&&frame.type==='tool_result')return;
  deliveredFrames.push(frame);
 }};
}
