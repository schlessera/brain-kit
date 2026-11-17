/** Bounded read-only GitHub client for proof identities: candidate admission,
 * draft feedback admission, the merge path and the cost refresh. It carries no
 * passing-result cache and reads nothing a job could have written as a claim. */
export interface API { json(path: string): Promise<any>; log(job: number): Promise<string>; }

export class GitHubProofAPI implements API {
  private readonly deadline = Date.now() + 45000;
  private requests = 0;
  constructor(private readonly repository: string, private readonly token: string) {}
  private async read(path: string, log = false): Promise<string> {
    if (++this.requests > 32 || Date.now() >= this.deadline) throw new Error("Proof lookup budget exhausted");
    let url = `https://api.github.com/repos/${this.repository}/${path}`;
    let response: Response;
    for (let redirects = 0;; redirects++) {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(Math.min(8000, this.deadline - Date.now())),
        headers: { Accept: "application/vnd.github+json", ...(url.startsWith("https://api.github.com/") ? { Authorization: `Bearer ${this.token}` } : {}) } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects >= 2 || !log) throw new Error("Unexpected proof API redirect");
      await response.body?.cancel();
      url = new URL(response.headers.get("location") ?? "", url).href;
      if (!url.startsWith("https://")) throw new Error("Unsafe log redirect");
    }
    if (!response.ok) throw new Error(`Proof API refused ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing proof API response");
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > (log ? 16000000 : 2000000)) { await reader.cancel(); throw new Error("Unbounded proof response"); }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  async json(path: string): Promise<any> {
    const text = await this.read(path);
    try { return JSON.parse(text); }
    catch { throw new Error(`Invalid GitHub proof JSON: ${path}`); }
  }
  async log(job: number): Promise<string> { return this.read(`actions/jobs/${job}/logs`, true); }
}
