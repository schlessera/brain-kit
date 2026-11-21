/** Fixed test-only categories; adapter errors never contribute arbitrary text. */
import { nativeReceipt } from "./native-test-receipts";
import { nativeTestHead } from "./test-native-guard";
export function nativeRtkFailureCategory(error:unknown):string {
 const message=error instanceof Error?error.message:"";
 if(message==="native fixture RTK payload missing")return "no-owned-match";
 if(message==="native fixture RTK payload ambiguous")return "multiple-match";
 if(["native fixture RTK root identity changed","native fixture RTK audited identity changed","native fixture RTK payload identity changed","native fixture RTK identity changed"].includes(message))return "start-mismatch";
 if(["native fixture RTK executable changed","native fixture RTK executable unavailable"].includes(message))return "exe-mismatch";
 if(["native fixture RTK spawn is unregistered","native fixture RTK worker unavailable","native fixture RTK worker identity unavailable"].includes(message))return "launch-mismatch";
 return "register-refused";
}
export function diagnoseNativeFixtureRtk(register:()=>void):void {
 try{register();}catch(error){nativeReceipt({kind:"native-fixture-rtk-registration",head:nativeTestHead(),success:false,category:nativeRtkFailureCategory(error)});throw error;}
}
