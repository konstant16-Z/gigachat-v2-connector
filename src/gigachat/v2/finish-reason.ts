/**
 * Shared V2 `finish_reason` → OpenAI-compatible mapping.
 *
 * Single source of truth for both the JSON response path and the streaming
 * state machine. Unknown values (including the `"error"` shown in the spec's
 * SSE example but missing from the enum — see V2-CONTRACT.md anomalies) are
 * NOT guessed: they map to `null`, and callers additionally surface them as
 * error events where applicable.
 */
import type { V2FinishReason } from "./types";

export function toOpenAiFinishReason(
  reason: V2FinishReason | string | undefined | null,
): string | null {
  switch (reason) {
    case undefined:
    case null:
      return null;
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "function_call":
      return "tool_calls";
    case "function_call_error":
      // Invalid tool arguments: the failure is surfaced in the message content
      // (JSON path) or as an error event (streaming path). Documented.
      return "stop";
    case "blacklist":
    case "request_blacklist":
    case "request_whitelist":
    case "request_filter":
    case "response_blacklist":
      // Closest OpenAI-compatible signal is content_filter (documented).
      return "content_filter";
    default:
      // Spec anomaly `"error"` and any future enum additions: do not guess.
      return null;
  }
}
