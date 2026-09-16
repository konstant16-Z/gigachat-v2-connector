/**
 * Unified error types for GigaChat V2 API (plan §18).
 *
 * Preserves: HTTP status, provider error message, request/correlation ID,
 * retryability classification. Never leaks credentials or secret headers.
 */

export interface GigaChatError extends Error {
  /** HTTP status code from the upstream response. */
  status: number;
  /** Provider-specific error code string (if present in the response). */
  providerCode?: string;
  /** Request correlation ID (RqUID) for tracing. */
  requestId?: string;
  /** Whether the request is safe to retry on this error. */
  retryable: boolean;
}

/**
 * Classify an HTTP status code into retryability.
 *
 * 429 and 5xx are retryable; 401 is retryable exactly once (token refresh);
 * everything else is not.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Create a structured GigaChatError from an HTTP response status + body.
 */
export function classifyUpstreamError(
  status: number,
  body: unknown,
  requestId?: string,
): GigaChatError {
  const message =
    body && typeof body === "object"
      ? String(
          (body as { message?: unknown }).message ??
            (body as { error?: { message?: unknown } }).error?.message ??
            "unknown error",
        )
      : "unknown error";
  const providerCode =
    body && typeof body === "object"
      ? String(
          (body as { status?: unknown }).status ??
            (body as { error?: { code?: unknown } }).error?.code ??
            "",
        )
      : undefined;
  const err = new Error(message) as GigaChatError;
  err.name = "GigaChatError";
  err.status = status;
  err.providerCode = providerCode || undefined;
  err.requestId = requestId;
  err.retryable = isRetryableStatus(status) || status === 401;
  return err;
}
