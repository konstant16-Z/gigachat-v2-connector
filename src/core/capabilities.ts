/**
 * Model capability model (plan §5 "capabilities").
 *
 * Only the shape is defined here; the per-model capability *resolver*
 * (getModelCapabilities) arrives in PHASE 8.
 */
export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  structuredOutput: boolean;
  webSearch: boolean;
  files: boolean;
}