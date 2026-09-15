/**
 * Custom-function shaping for the GigaChat V2 boundary (plan §9 "function").
 *
 * The spec marks `name` and `parameters` as required (CustomFunction,
 * `required: ["name", "parameters"]`). Missing data is a controlled error —
 * never a guessed default (agents.md RULE 13). Provider-specific extras
 * (`few_shot_examples`, `return_parameters`) pass through when provided.
 */
import type { NormalizedTool } from "../../../core/types";
import type { CustomFunction } from "../types";

export function toCustomFunction(tool: NormalizedTool): CustomFunction {
  if (!tool.name) {
    throw new Error(
      "V2 CustomFunction requires a non-empty `name` (spec: required [name, parameters])",
    );
  }
  if (
    tool.parameters === undefined ||
    tool.parameters === null ||
    typeof tool.parameters !== "object" ||
    Array.isArray(tool.parameters)
  ) {
    throw new Error(
      `V2 CustomFunction "${tool.name}" requires \`parameters\` as a JSON Schema object ` +
        "(spec: required [name, parameters]); refusing to guess",
    );
  }
  const fn: CustomFunction = {
    name: tool.name,
    parameters: tool.parameters as Record<string, unknown>,
  };
  if (tool.description !== undefined) fn.description = tool.description;
  if (tool.fewShotExamples !== undefined) fn.few_shot_examples = tool.fewShotExamples;
  if (tool.returnParameters !== undefined) {
    fn.return_parameters = tool.returnParameters as Record<string, unknown>;
  }
  return fn;
}
