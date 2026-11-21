/** Controlled native observations share the one scripted inference service. */
export function fixtureShellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}
export function createWorkerEffectWitness(paths: Record<string, string>) {
  const effects = Object.fromEntries(Object.keys(paths).map(key => [key, false]));
  const path = `/__fixture_effects/${crypto.randomUUID()}`;
  const witness = `import {existsSync} from "node:fs";
    const paths=${JSON.stringify(paths)};
    const socket=process.env.ANTHROPIC_UNIX_SOCKET;
    if(!socket)throw Error("Fixture effect witness requires the pinned scripted Unix service");
    const url=new URL(${JSON.stringify(path)},process.env.ANTHROPIC_BASE_URL);
    const response=await fetch(url,{unix:socket,method:"POST",body:JSON.stringify(
      Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,existsSync(path)])))});
    if(!response.ok) process.exit(1);`;
  return { effects, path,
    async fetch(request: Request): Promise<Response> {
      if(request.method!=="POST"||new URL(request.url).pathname!==path)return new Response(null,{status:404});
      const observed = await request.json();
      if (!Object.keys(effects).every(key => typeof observed[key] === "boolean")) return new Response(null, { status: 400 });
      for (const key of Object.keys(effects)) effects[key] = observed[key];
      return new Response(null, { status: 204 });
    },
    command: `${fixtureShellQuote(process.execPath)} -e ${fixtureShellQuote(witness)}`,
    sanitize: (text: string) => text.replaceAll(process.execPath, "<bun>").replaceAll(path, "<fixture-effects>"),
    stop() {},
  };
}
