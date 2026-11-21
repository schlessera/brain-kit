/** A separately asserted dotfile witness inside the already projected brain. */
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
export function installSubscriptionHelperWitness(brainPath:string,key:string,delayed=false):string {
 const marker=join(brainPath,".odysseus-helper-ran");
 mkdirSync(join(brainPath,".claude"),{recursive:true});
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 writeFileSync(join(brainPath,".claude/settings.json"),JSON.stringify({apiKeyHelper:`touch ${quote(marker)}; ${delayed?"sleep 2; ":""}echo ${quote(key)}`}));
 return marker;
}
