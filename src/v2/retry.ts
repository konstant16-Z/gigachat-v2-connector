/**
 * Retry/backoff helpers for GigaChat API calls (plan §19).
 *
 * Policy (per plan): 429 → exponential backoff; 5xx → retry; 400/403 → no
 * retry; 401 → token refresh + exactly one retry (handled by plugin/auth).
 *
 * Config via env (defaults in parentheses):
 *   GIGACHAT_MAX_RETRIES (3)   — max retry attempts after the first request
 *   GIGACHAT_BACKOFF_BASE_MS (500)
 *   GIGACHAT_BACKOFF_MAX_MS (30_000)
 *   GIGACHAT_TIMEOUT (120_000) — per-request timeout in ms
 */

export interface RetryConfig {
  /** Maximum number of retry attempts after the initial attempt. */
  maxAttempts: number;
  /** Base delay for the first backoff (ms). */
  baseDelayMs: number;
  /** Upper bound for any single backoff delay (ms). */
  maxDelayMs: number;
  /** Per-request timeout (ms); 0 = no timeout. */
  timeoutMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  timeoutMs: 120_000,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

/** Load retry config from environment, falling back to defaults. */
export function loadRetryConfig(overrides?: Partial<RetryConfig>): RetryConfig {
  return {
    maxAttempts: overrides?.maxAttempts ?? envInt("GIGACHAT_MAX_RETRIES", DEFAULT_RETRY_CONFIG.maxAttempts),
    baseDelayMs: overrides?.baseDelayMs ?? envInt("GIGACHAT_BACKOFF_BASE_MS", DEFAULT_RETRY_CONFIG.baseDelayMs),
    maxDelayMs: overrides?.maxDelayMs ?? envInt("GIGACHAT_BACKOFF_MAX_MS", DEFAULT_RETRY_CONFIG.maxDelayMs),
    timeoutMs: overrides?.timeoutMs ?? envInt("GIGACHAT_TIMEOUT", DEFAULT_RETRY_CONFIG.timeoutMs),
  };
}

/**
 * Compute the backoff delay for a given retry attempt (0-based), with
 * exponential growth, a hard cap, and ±25% jitter to avoid thundering herds.
 */
export function backoffDelayMs(attempt: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(capped + jitter));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}