/**
 * Tool-name registry.
 *
 * GigaChat functions must start with a Latin letter and only contain Latin
 * letters, digits and underscores, and their arguments must be a plain JSON
 * object. OpenAI tools arrive with arbitrary names (e.g. "read", "edit",
 * "shell --- workdir /home/user"), so each original name is mapped to a
 * deterministic alias `tool_<counter>` and back.
 */

/** alias -> original tool name */
const toolNameMap = new Map<string, string>();
/** original tool name -> alias */
const originalToAliasMap = new Map<string, string>();
let toolCounter = 0;

/** Convert an arbitrary OpenAI tool name to a GigaChat-safe alias. */
export function getToolAlias(originalName?: string): string {
  if (!originalName) return "";
  if (originalToAliasMap.has(originalName)) {
    return originalToAliasMap.get(originalName)!;
  }
  toolCounter++;
  const alias = `tool_${toolCounter}`;
  toolNameMap.set(alias, originalName);
  originalToAliasMap.set(originalName, alias);
  return alias;
}

/** Convert a GigaChat alias back to the original OpenAI tool name. */
export function getOriginalToolName(alias?: string): string {
  if (!alias) return "";
  return toolNameMap.get(alias) || alias;
}