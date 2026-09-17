/**
 * Structured observability for the GigaChat connector (plan §32).
 *
 * Emits ONE safe, machine-parseable line per request lifecycle event. Only
 * metadata is ever emitted — **never** request/response bodies, prompts,
 * headers, tokens or uploaded files:
 *
 *   request ID · endpoint · model · latency · retry count · HTTP status ·
 *   stream completion · tool name · normalized error category
 *
 * Output format (stable, greppable):
 *
 *   [GigaCode] [OBS] request_id=<id> endpoint=<path> model=<m> latency_ms=<n>
 *                    retries=<n> status=<s> stream=completed|error=<category>
 *
 * Content-level logging stays opt-in via `GIGACHAT_DEBUG` (see
 * `constants.ts`); a body accidentally passed through a metadata field is still
 * masked by `redactSecrets` before it reaches the console. The channel can be
 * disabled with `GIGACHAT_OBSERVABILITY=false`.
 */

import { redactSecrets } from "./redact.js";

/** Line prefix for machine parsing. */
export const OBS_PREFIX = "[GigaCode] [OBS]";

/** Coarse, normalized failure category (plan §32 "normalized error category"). */
export type ErrorCategory =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "client_error"
  | "server_error"
  | "malformed"
  | "cancelled"
  | "config"
  | "unknown";

/** Minimal shape read off an unknown thrown value / axios error. */
export interface ErrorLike {
  status?: number;
  name?: string;
  message?: string;
  code?: string;
}

/** Whether the observability channel is enabled (default: yes). */
export function observabilityEnabled(): boolean {
  const val = process.env.GIGACHAT_OBSERVABILITY;
  if (val === undefined) return true;
  const normalized = val.trim().toLowerCase();
  return (
    normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no"
  );
}

/**
 * Map an arbitrary error/status into a stable category. Never throws; an
 * unrecognized shape degrades to `"unknown"` rather than propagating.
 */
export function normalizeErrorCategory(input?: ErrorLike | null): ErrorCategory {
  if (!input) return "unknown";
  const status = typeof input.status === "number" ? input.status : undefined;
  const name = (input.name ?? "").toLowerCase();
  const message = (input.message ?? "").toLowerCase();
  const code = (input.code ?? "").toUpperCase();

  if (name.includes("abort") || message.includes("abort") || message.includes("cancel")) {
    return "cancelled";
  }
  if (
    name.includes("timeout") ||
    code === "ECONNABORTED" ||
    message.includes("timeout") ||
    message.includes("timed out")
  ) {
    return "timeout";
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate_limit";
    if (status === 408 || status === 504) return "timeout";
    if (status >= 500) return "server_error";
    if (status >= 400) return "client_error";
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return "network";
  }
  if (message.includes("fetch failed") || message.includes("network")) return "network";
  if (message.includes("malformed")) return "malformed";
  if (
    message.includes("unsupported") ||
    message.includes("missing") ||
    message.includes("invalid") ||
    message.includes("refus") ||
    message.includes("requires")
  ) {
    return "config";
  }
  return "unknown";
}

/** Coerce an arbitrary thrown value into the minimal `ErrorLike` shape. */
export function errorLike(err: unknown): ErrorLike {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      status: typeof e.status === "number" ? e.status : undefined,
      name: typeof e.name === "string" ? e.name : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
    };
  }
  return { message: typeof err === "string" ? err : undefined };
}

/**
 * Extract the endpoint path from a URL for diagnostics. Malformed URLs return
 * `"?"` — the raw value is never echoed (it could carry credentials).
 */
export function endpointOf(url?: string | null): string {
  if (!url) return "?";
  try {
    const parsed = new URL(url);
    return parsed.pathname || "/";
  } catch {
    return "?";
  }
}

/** Safe metadata fields. All are optional so partial lifecycles can report. */
export interface ObservationFields {
  requestId?: string;
  endpoint?: string;
  model?: string;
  latencyMs?: number;
  retryCount?: number;
  status?: number;
  /** SSE lifecycle: `completed` at flush, `cancelled` on client abort. */
  stream?: "completed" | "cancelled";
  tool?: string;
  callId?: string;
  errorCategory?: ErrorCategory;
}

/** Render the canonical one-line observation. */
export function formatObservation(fields: ObservationFields): string {
  const parts: string[] = [];
  const add = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === "") return;
    parts.push(`${key}=${value}`);
  };
  add("request_id", fields.requestId);
  add("endpoint", fields.endpoint);
  add("model", fields.model);
  add(
    "latency_ms",
    fields.latencyMs !== undefined ? Math.max(0, Math.round(fields.latencyMs)) : undefined,
  );
  add("retries", fields.retryCount);
  add("status", fields.status);
  add("stream", fields.stream);
  add("tool", fields.tool);
  add("call_id", fields.callId);
  add("error", fields.errorCategory);
  return parts.length > 0 ? `${OBS_PREFIX} ${parts.join(" ")}` : OBS_PREFIX;
}

/**
 * Emit one observation line. Safe by construction (metadata only) and by
 * defense in depth (`redactSecrets`). Never throws; disabled via
 * `GIGACHAT_OBSERVABILITY=false`.
 */
export function emitObservation(fields: ObservationFields): void {
  if (!observabilityEnabled()) return;
  try {
    console.log(redactSecrets(formatObservation(fields)));
  } catch {
    // Diagnostics must never break a request.
  }
}

export interface RequestObservationInit {
  requestId: string;
  endpoint: string;
  model?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Per-request observation: records start time and retry count, and produces a
 * single safe snapshot at completion (`finish` is idempotent — a streaming
 * callback and a fallback path can both call it).
 */
export class RequestObservation {
  readonly requestId: string;
  readonly endpoint: string;
  readonly model: string | undefined;
  private readonly startedAt: number;
  private readonly now: () => number;
  private retries = 0;
  private finished = false;

  constructor(init: RequestObservationInit) {
    this.requestId = init.requestId;
    this.endpoint = init.endpoint;
    this.model = init.model;
    this.now = init.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Count one retry attempt (plan §32 "retry count"). */
  retry(): void {
    this.retries += 1;
  }

  get retryCount(): number {
    return this.retries;
  }

  /** Build the safe snapshot; latency is measured from construction. */
  snapshot(
    extra: Omit<
      ObservationFields,
      "requestId" | "endpoint" | "model" | "latencyMs" | "retryCount"
    > = {},
  ): ObservationFields {
    return {
      requestId: this.requestId,
      endpoint: this.endpoint,
      ...(this.model !== undefined ? { model: this.model } : {}),
      latencyMs: this.now() - this.startedAt,
      ...(this.retries > 0 ? { retryCount: this.retries } : {}),
      ...extra,
    };
  }

  /** First call returns the snapshot; later calls return `undefined`. */
  finish(
    extra: Omit<
      ObservationFields,
      "requestId" | "endpoint" | "model" | "latencyMs" | "retryCount"
    > = {},
  ): ObservationFields | undefined {
    if (this.finished) return undefined;
    this.finished = true;
    return this.snapshot(extra);
  }
}
