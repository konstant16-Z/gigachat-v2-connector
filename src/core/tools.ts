/**
 * Normalized tool model (plan §5 "tools").
 *
 * Describes identity, description, JSON Schema, call id, result and state in a
 * provider-neutral way. Provider-specific extras (V2 `few_shot_examples`,
 * `return_parameters`, builtin tool ids) are carried as opaque optional fields
 * and interpreted only at the provider boundary.
 */

export interface NormalizedTool {
  name: string;
  description?: string;
  /** JSON Schema describing accepted parameters. */
  parameters?: unknown;
  /** Provider-specific learning examples (V2 `few_shot_examples`). */
  fewShotExamples?: Array<{ request: string; params: Record<string, unknown> }>;
  /** Provider-specific schema of tool output (V2 `return_parameters`). */
  returnParameters?: unknown;
  /**
   * Opaque id of a provider builtin tool (e.g. `image_generate`,
   * `model_3d_generate`). Interpreted only at the provider boundary; unknown
   * values raise a controlled error rather than being guessed.
   */
  builtin?: string;
}

export interface NormalizedToolCall {
  /** Stable id used to link an assistant tool call to its tool result. */
  id: string;
  name: string;
  /** Parsed arguments object; `undefined` when the call carried none. */
  arguments?: Record<string, unknown>;
}

export type NormalizedToolChoice = "none" | "auto" | { functionName: string };
