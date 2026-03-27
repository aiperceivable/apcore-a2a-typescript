import { A2ADiscoveryError } from "./exceptions.js";

export class AgentCardFetcher {
  private url: string;
  private ttl: number;
  private headers: Record<string, string>;
  private cached: Record<string, unknown> | null = null;
  private cachedAt = 0;

  constructor(baseUrl: string, opts?: { ttl?: number; headers?: Record<string, string> }) {
    this.url = `${baseUrl}/.well-known/agent.json`;
    this.ttl = opts?.ttl ?? 300;
    this.headers = opts?.headers ?? {};
  }

  async fetch(): Promise<Record<string, unknown>> {
    const now = performance.now() / 1000;
    if (this.cached && now - this.cachedAt < this.ttl) {
      return this.cached;
    }

    const response = await fetch(this.url, { headers: this.headers });
    if (!response.ok) {
      throw new A2ADiscoveryError(
        `Agent Card fetch failed: HTTP ${response.status} from ${this.url}`,
      );
    }

    let card: Record<string, unknown>;
    try {
      card = (await response.json()) as Record<string, unknown>;
    } catch (e) {
      throw new A2ADiscoveryError(`Invalid JSON in Agent Card from ${this.url}: ${e}`);
    }

    this.cached = card;
    this.cachedAt = now;
    return card;
  }
}
