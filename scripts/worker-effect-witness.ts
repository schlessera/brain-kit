/** Controlled native fixture observations; inference and witnesses stay on loopback. */
export function fixtureShellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export function createWorkerEffectWitness(paths: Record<string, string>) {
  const effects = Object.fromEntries(Object.keys(paths).map(key => [key, false]));
  const observer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const observed = await request.json();
    if (!Object.keys(effects).every(key => typeof observed[key] === "boolean")) return new Response(null, { status: 400 });
    for (const key of Object.keys(effects)) effects[key] = observed[key];
    return new Response(null, { status: 204 });
  } });
  const url = `http://127.0.0.1:${observer.port}`;
  const witness = `import {existsSync} from "node:fs";
    const paths=${JSON.stringify(paths)};
    const response=await fetch(${JSON.stringify(url)},{method:"POST",body:JSON.stringify(
      Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,existsSync(path)])))});
    if(!response.ok) process.exit(1);`;
  return {
    effects,
    command: `${fixtureShellQuote(process.execPath)} -e ${fixtureShellQuote(witness)}`,
    sanitize: (text: string) => text.replaceAll(process.execPath, "<bun>").replaceAll(url, "<loopback-effects>"),
    stop: () => observer.stop(true),
  };
}
