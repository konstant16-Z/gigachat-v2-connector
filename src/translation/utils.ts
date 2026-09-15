/**
 * Shared translation helpers (PHASE 2).
 */

/**
 * `function_call.arguments` is a **JSON string** in V2 and a string in the
 * OpenAI-compat protocol. Convert it to a parsed object; malformed JSON
 * raises a controlled error instead of being guessed or crashing later.
 */
export function parseToolArguments(
  raw: string | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`malformed tool arguments JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `malformed tool arguments: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>;
}