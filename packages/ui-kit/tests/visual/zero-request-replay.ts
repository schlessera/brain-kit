import type {Page} from "playwright";

/** A replay may consume inline bytes only. Never authorize loopback resources
 * merely because the original runner could serve them. Record all requests,
 * including requests a service worker could answer before route interception.
 */
export async function zeroRequestReplay(page:Page){
  const attempted:string[]=[];
  page.on("request",request=>attempted.push(request.url()));
  page.on("websocket",socket=>attempted.push(socket.url()));
  await page.route("**/*",async route=>{attempted.push(route.request().url());await route.abort();});
  await page.routeWebSocket("**/*",socket=>{attempted.push(socket.url());socket.close();});
  return {
    assert(stage:string){if(attempted.length)throw new Error(`Ghost replay attempted resource load (${stage}): ${attempted.join(", ")}`);},
  };
}
