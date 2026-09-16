/**
 * Unit tests: retry/backoff helpers (plan §19) + error classification (§18).
 *
 * Pure logic only — no network. Backoff is validated for growth, caps and
 * jitter bounds; status classification follows the plan policy.
 */
import { describe, expect, test } from "bun:test";
import { classifyUpstreamError, isRetryableStatus } from "../../src/gigachat/v2/errors";
import { backoffDelayMs, DEFAULT_RETRY_CONFIG, loadRetryConfig, sleep } from "../../src/v2/retry";

describe("isRetryableStatus (plan §19)", () => {
  test("429 and 5xx are retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  test("400/403/404 and 2xx are not retryable", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  test("grows exponentially and stays within [1, maxDelayMs]", () => {
    const config = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000, timeoutMs: 0 };
    for (const attempt of [0, 1, 2, 3, 4]) {
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelayMs(attempt, config);
        expect(delay).toBeGreaterThanOrEqual(1);
        expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
      }
    }
    // No jitter can push the exponential below its own floor repeatedly;
    // average over many draws must be within jitter bounds of the base.
    const avg0 =
      Array.from({ length: 200 }, () => backoffDelayMs(0, config)).reduce((a, b) => a + b, 0) / 200;
    expect(avg0).toBeGreaterThan(375); // 500 * 0.75
    expect(avg0).toBeLessThan(625); // 500 * 1.25
    // Capped near the max for high attempts.
    expect(backoffDelayMs(10, config)).toBeLessThanOrEqual(
      config.maxDelayMs + 0.25 * config.maxDelayMs,
    );
  });
});

describe("loadRetryConfig", () => {
  test("defaults match DEFAULT_RETRY_CONFIG", () => {
    expect(loadRetryConfig()).toEqual(DEFAULT_RETRY_CONFIG);
  });

  test("env vars override defaults and invalid values fall back", () => {
    process.env.GIGACHAT_MAX_RETRIES = "2";
    process.env.GIGACHAT_BACKOFF_BASE_MS = "100";
    process.env.GIGACHAT_BACKOFF_MAX_MS = "not-a-number";
    process.env.GIGACHAT_TIMEOUT = "-5";
    try {
      const cfg = loadRetryConfig();
      expect(cfg.maxAttempts).toBe(2);
      expect(cfg.baseDelayMs).toBe(100);
      expect(cfg.maxDelayMs).toBe(DEFAULT_RETRY_CONFIG.maxDelayMs);
      expect(cfg.timeoutMs).toBe(DEFAULT_RETRY_CONFIG.timeoutMs);
    } finally {
      delete process.env.GIGACHAT_MAX_RETRIES;
      delete process.env.GIGACHAT_BACKOFF_BASE_MS;
      delete process.env.GIGACHAT_BACKOFF_MAX_MS;
      delete process.env.GIGACHAT_TIMEOUT;
    }
  });

  test("explicit overrides win over env", () => {
    process.env.GIGACHAT_MAX_RETRIES = "9";
    try {
      expect(loadRetryConfig({ maxAttempts: 1 }).maxAttempts).toBe(1);
    } finally {
      delete process.env.GIGACHAT_MAX_RETRIES;
    }
  });
});

describe("sleep", () => {
  test("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test("rejects when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(50, ac.signal)).rejects.toThrow("aborted");
  });

  test("rejects when aborted mid-sleep", async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
  });
});

describe("classifyUpstreamError (plan §18)", () => {
  test("extracts status/message and marks 429 retryable", () => {
    const err = classifyUpstreamError(
      429,
      { error: { message: "rate limited", code: "RATE" } },
      "rq-1",
    );
    expect(err.status).toBe(429);
    expect(err.message).toBe("rate limited");
    expect(err.requestId).toBe("rq-1");
    expect(err.retryable).toBe(true);
  });

  test("400 is not retryable", () => {
    const err = classifyUpstreamError(400, { message: "bad request" });
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
  });

  test("does not leak credentials/headers into the message", () => {
    const err = classifyUpstreamError(500, { message: "boom" });
    expect(err.message).not.toMatch(/Authorization|Bearer|password/i);
  });
});
