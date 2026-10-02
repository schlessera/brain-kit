import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { geoConfigSchema } from "../../src/config.js";
import { GeoTransport } from "../../src/server/io.js";

const [root,id]=process.argv.slice(2);
if (!root || !id) throw new Error("Expected fixture root/id.");
const config=geoConfigSchema.parse({userAgent:"brain-geo-fixture/1.0",minimumIntervalMs:0,cacheDir:join(root,id)});
const io=new GeoTransport(config,{admissionDir:join(root,"admission"),fetchImpl:async()=>{
  await appendFile(join(root,"events.jsonl"),JSON.stringify({id,stage:"start",at:Date.now()})+"\n");
  await Bun.sleep(1_300);
  await appendFile(join(root,"events.jsonl"),JSON.stringify({id,stage:"end",at:Date.now()})+"\n");
  return Response.json({places:["Ithaca"]});
}});
const url="https://nominatim.openstreetmap.org";
const result=await io.request("nominatim",url,url+"/search?q="+id,{},raw=>raw);
process.stdout.write(JSON.stringify(result));
if (result.error) process.exitCode=1;
