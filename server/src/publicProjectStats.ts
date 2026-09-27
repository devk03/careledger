const URL = "https://api.github.com/repos/devk03/careledger";
const MIN_RETRY_MS = 5 * 60 * 1000;
const FRESH_MS = 60 * 60 * 1000;

export type PublicProjectStats = { stars: number | null;
  checked_at: number | null; stale: boolean };

/** Fixed public GitHub endpoint; no incoming request data or credentials. */
export class PublicProjectStatsCache {
  private value: PublicProjectStats = { stars: null, checked_at: null,
    stale: false };
  private retryAt = 0;
  private inFlight: Promise<PublicProjectStats> | null = null;

  constructor(private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  read(): Promise<PublicProjectStats> {
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.retryAt) return Promise.resolve({ ...this.value });
    this.retryAt = this.now() + MIN_RETRY_MS;
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(): Promise<PublicProjectStats> {
    try {
      const response = await this.fetcher(URL, { redirect: "manual",
        signal: AbortSignal.timeout(3000), headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Adeno-public-stars",
        } });
      if (!response.ok) throw new Error("GitHub unavailable");
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null ||
        !("stargazers_count" in payload) ||
        !Number.isSafeInteger(payload.stargazers_count) ||
        (payload.stargazers_count as number) < 0 ||
        (payload.stargazers_count as number) > 1_000_000_000)
        throw new Error("Invalid public count");
      this.value = { stars: payload.stargazers_count as number,
        checked_at: Math.floor(this.now() / 1000), stale: false };
      this.retryAt = this.now() + FRESH_MS;
    } catch {
      this.value = { ...this.value, stale: this.value.stars !== null };
    }
    return { ...this.value };
  }
}
