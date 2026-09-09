/**
 * Low-level conversion helpers used by the translator.
 * Faithfully reproduces the logic that was inlined in the production bundle.
 */

/**
 * Parse function arguments. They may arrive as a JSON string (OpenAI) or
 * already be an object. Anything unparseable degrades to {}.
 */
export function parseArgumentsToObject(args?: string | Record<string, unknown> | null): Record<string, unknown> {
  if (args === null || args === undefined) return {};
  if (typeof args === "object") return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Serialize arguments for the OpenAI-compatible response (always a string).
 */
export function stringifyArguments(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

/**
 * Recursively strip keys that GigaChat's function schema parser rejects
 * (additionalProperties, $schema, nullable) while keeping everything else.
 */
export function sanitizeFunctionParameters(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema" || key === "nullable") continue;
    const val = (params as Record<string, unknown>)[key];
    if (key === "properties" && typeof val === "object") {
      out[key] = {};
      for (const propKey of Object.keys(val as Record<string, unknown>)) {
        (out[key] as Record<string, unknown>)[propKey] = sanitizeFunctionParameters(
          (val as Record<string, unknown>)[propKey]
        );
      }
    } else if (Array.isArray(val)) {
      out[key] = val.map((item) => (typeof item === "object" ? sanitizeFunctionParameters(item) : item));
    } else if (typeof val === "object") {
      out[key] = sanitizeFunctionParameters(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}