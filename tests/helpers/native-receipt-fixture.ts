/** Explicit private receipt capture for guard unit fixtures, separate from stderr. */
import { captureNativeReceipts } from "../../scripts/native-test-receipts";
export function spawnGuardFixture(argv:string[],options:Record<string,any>={}) {
 const capture=captureNativeReceipts();
 let child:Bun.Subprocess<"ignore","pipe","pipe">;
 try{child=Bun.spawn(argv,{...options,stdin:options.stdin??"ignore",stdout:"pipe",stderr:"pipe",env:{...(options.env??process.env),...capture.env}});}catch(error){capture.dispose();throw error;}
 let reading:Promise<string>|undefined;
 return Object.assign(child,{guardOutput(){return reading??=Promise.all([new Response(child.stderr).text(),child.exited]).then(([text])=>text+capture.read()).finally(()=>capture.dispose());}});
}
