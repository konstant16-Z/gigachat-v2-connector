/**
 * Normalized, provider-agnostic content parts.
 *
 * The normalized layer deliberately uses its own neutral vocabulary so that
 * neither GigaChat field names (agents.md §9) nor OpenAI wrapper shapes leak
 * into the middle layer. V2 content items are *keyed objects without a `type`
 * discriminator*; they are produced only at the provider boundary
 * (`normalized-to-gigachat-v2`).
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  url: string;
  /** Client hint; neutral string so arbitrary provider values do not need guessing. */
  detail?: string;
}

export interface FilePart {
  type: "file";
  id: string;
  target?: "image" | "audio" | "3dmodel";
  mime?: string;
}

/**
 * Result of a tool/function invocation. `result` is the raw (usually JSON)
 * string produced by the tool, matching the V2 `function_result.result`
 * contract.
 */
export interface ToolResultPart {
  type: "tool_result";
  /** Id of the tool call this result answers (when known). */
  toolCallId?: string;
  /** Tool name when known; resolved at the boundary if absent. */
  name?: string;
  result: string;
}

export type NormalizedContentPart = TextPart | ImagePart | FilePart | ToolResultPart;
