/** One serial, quota-aware transport for discovery, logs, enrichment and seeds. */
import type { TimingAPI } from "./ci-timings";

export class TimingBudgetStop extends Error {
  override name = "TimingBudgetStop";
}
export class TimingClient implements TimingAPI {
  readonly budget: { limit: number; reserve: number; requests: number; remaining: number | null; stopped: string | null };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private repository: string, limit = 200, reserve = 500) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(reserve) || reserve < 0) throw new Error("Invalid request budget/reserve");
    this.budget = { limit, reserve, requests: 0, remaining: null, stopped: null };
  }
  private stop(reason: string): never {
    this.budget.stopped ??= reason;
    throw new TimingBudgetStop(this.budget.stopped);
  }
  private async response(path: string): Promise<{ body: Uint8Array; status: number; remaining: number | null; code: number; error: string }> {
    const child = Bun.spawn(["gh", "api", "--include", "--allow-escape-sequences", path],
      { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    const [code, buffer, error] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
    let body = Buffer.from(buffer), status = 0, remaining: number | null = null;
    // gh may include redirect headers. Keep the quota from the API response
    // even when the final log/archive response comes from artifact storage.
    while (body.subarray(0, 5).toString() === "HTTP/") {
      const separator = body.indexOf("\r\n\r\n");
      if (separator < 0) this.stop("quota response headers unavailable");
      const headers = body.subarray(0, separator).toString();
      status = Number(/^HTTP\/\S+ (\d+)/.exec(headers)?.[1]);
      const value = /^x-ratelimit-remaining:\s*(\d+)\s*$/im.exec(headers)?.[1];
      if (value !== undefined) remaining = Math.min(remaining ?? Infinity, Number(value));
      body = body.subarray(separator + 4);
    }
    return { body, status, remaining, code, error };
  }
  private async fetch(path: string): Promise<Uint8Array> {
    if (this.budget.stopped) this.stop(this.budget.stopped);
    if (!this.budget.requests) {
      // GET /rate_limit does not consume the primary quota, but still counts
      // against this invocation's hard request ceiling.
      this.budget.requests++;
      const first = await this.response("rate_limit");
      if (first.code) this.stop("quota unavailable; no collection requests issued");
      let remaining: unknown;
      try { remaining = JSON.parse(new TextDecoder().decode(first.body)).resources?.core?.remaining; }
      catch { this.stop("quota unavailable; no collection requests issued"); }
      if (typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 0) this.stop("quota unavailable; no collection requests issued");
      this.budget.remaining = Math.min(remaining, first.remaining ?? remaining);
    }
    if (this.budget.requests >= this.budget.limit) this.stop(`request limit ${this.budget.limit} reached before ${path}`);
    if (this.budget.remaining! <= this.budget.reserve) this.stop(`quota reserve ${this.budget.reserve} reached before ${path}`);
    this.budget.requests++;
    this.budget.remaining = this.budget.remaining! - 1;
    const result = await this.response(`repos/${this.repository}/${path}`);
    if (result.remaining !== null) this.budget.remaining = Math.min(this.budget.remaining!, result.remaining);
    if (result.status === 429 || result.status === 403 && (this.budget.remaining === 0 || /rate limit|abuse/i.test(result.error + new TextDecoder().decode(result.body)))) {
      this.stop(`GitHub rate limit response at ${path}; no retry`);
    }
    if (result.code !== 0) throw new Error(`GitHub evidence unavailable (${path}): ${result.error.trim()}`);
    if (result.remaining === null && !/\/(?:logs|zip)$/.test(path)) this.stop(`quota response headers unavailable at ${path}`);
    return result.body;
  }
  bytes(path: string): Promise<Uint8Array> {
    // Admission and quota updates share one queue, including callers using
    // Promise.all. A stop is sticky; queued callers never dispatch afterward.
    const result = this.queue.then(() => this.fetch(path));
    this.queue = result.catch(() => {});
    return result;
  }
  async json(path: string): Promise<any> { return JSON.parse(new TextDecoder().decode(await this.bytes(path))); }
  async log(job: number): Promise<string> { return new TextDecoder().decode(await this.bytes(`actions/jobs/${job}/logs`)); }
}
