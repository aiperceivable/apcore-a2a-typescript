import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentCardFetcher } from "../../src/client/card-fetcher.js";
import { A2ADiscoveryError } from "../../src/client/exceptions.js";

const BASE_URL = "http://localhost:3000";
const CARD_URL = `${BASE_URL}/.well-known/agent-card.json`;

const mockCard = { name: "TestAgent", skills: [] };

describe("AgentCardFetcher", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches and returns agent card JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCard),
    });

    const fetcher = new AgentCardFetcher(BASE_URL);
    const card = await fetcher.fetch();

    expect(card).toEqual(mockCard);
    expect(globalThis.fetch).toHaveBeenCalledWith(CARD_URL, expect.any(Object));
  });

  it("passes custom headers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCard),
    });

    const fetcher = new AgentCardFetcher(BASE_URL, {
      headers: { Authorization: "Bearer test" },
    });
    await fetcher.fetch();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      CARD_URL,
      expect.objectContaining({
        headers: { Authorization: "Bearer test" },
      }),
    );
  });

  it("caches result within TTL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCard),
    });

    const fetcher = new AgentCardFetcher(BASE_URL, { ttl: 300 });
    await fetcher.fetch();
    await fetcher.fetch();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const mockPerformance = vi.spyOn(performance, "now");
    mockPerformance.mockReturnValue(0);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCard),
    });

    const fetcher = new AgentCardFetcher(BASE_URL, { ttl: 10 });
    await fetcher.fetch();

    // Advance past TTL (10 seconds = 10000ms in performance.now)
    mockPerformance.mockReturnValue(11000);
    await fetcher.fetch();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    mockPerformance.mockRestore();
  });

  it("throws A2ADiscoveryError on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const fetcher = new AgentCardFetcher(BASE_URL);
    await expect(fetcher.fetch()).rejects.toThrow(A2ADiscoveryError);
  });

  it("throws A2ADiscoveryError on invalid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("Invalid JSON")),
    });

    const fetcher = new AgentCardFetcher(BASE_URL);
    await expect(fetcher.fetch()).rejects.toThrow(A2ADiscoveryError);
  });
});
