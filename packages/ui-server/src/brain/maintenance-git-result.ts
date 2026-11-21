/** Trusted worker entry: observe old and current maintain reports without buffering them. */
import {writeFileSync} from "node:fs";
import {once} from "node:events";

const [receipt,...command]=process.argv.slice(2);
if(!receipt||!command.length)throw Error("Missing maintenance Git result arguments");
const child=Bun.spawn(command,{stdin:"inherit",stdout:"pipe",stderr:"inherit"});
const decoder=new TextDecoder();let tail="",packed=false;
function observe(text:string) {
  // Chunk boundaries can split any token. A report's Git prefix fits well
  // inside this window; arbitrarily long unrelated output never accumulates.
  for(let offset=0;offset<text.length;offset+=1024) {
    tail=(tail+text.slice(offset,offset+1024)).slice(-4096);
    const results=/(?:\{\s*"step"\s*:\s*"git"\s*,\s*"result"\s*:\s*"|(?:^|\n)  git\s+)(ok — packed \d+ loose object\(s\)|FAILED|skipped)/g;
    for(const result of tail.matchAll(results))packed=result[1]!.startsWith("ok — packed ");
  }
}
try {
  for await(const bytes of child.stdout) {
    observe(decoder.decode(bytes,{stream:true}));
    // Preserve streaming and backpressure instead of buffering a cron report.
    if(!process.stdout.write(bytes))await once(process.stdout,"drain");
  }
  observe(decoder.decode());const code=await child.exited;
  if(!child.signalCode&&packed)writeFileSync(receipt,"packed\n",{flag:"wx",mode:0o600});
  process.exitCode=code;
} catch(error) {
  child.kill("SIGKILL");await child.exited;throw error;
}
