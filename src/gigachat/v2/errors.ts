/**
 * GigaChat V2 error contract (plan §6 "errors").
 *
 * Kept at the provider boundary: transport/http errors and their status bodies
 * are normalized here before they reach the adapter. No `any`.
 */

/** Status error bodies described in the OpenAPI spec (400/401/404/406/429/500). */
export interface V2ErrorBody {
  status?: number;
  code?: number;
  message?: string;
}

/** Uniform representation of a failed V2 call produced by the boundary. */
export interface V2ApiError {
  kind: "http" | "network" | "timeout" | "parse";
  httpStatus?: number;
  code?: number;
  message: string;
  /** Raw provider status body when available. */
  raw?: V2ErrorBody;
}