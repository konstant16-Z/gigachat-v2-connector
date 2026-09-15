/**
 * Function-tool normalization for the GigaChat V2 boundary (plan §9
 * "normalize").
 *
 * The official spec constrains custom function names: "только латинские
 * буквы" and "не должно начинаться с цифры" (docs/external/gigachat-api.yml,
 * CustomFunction.name). OpenAI/OpenCode tool names can be arbitrary (e.g.
 * `shell --- workdir /home/user`), so the legacy connector aliased them with a
 * *global* Map. The V2 path replaces that with a **session-scoped**
 * `ToolNameRegistry`: one instance per session, no module-level mutable state
 * (agents.md §14: state must be scoped).
 *
 * The pure mappers keep passing names through unchanged; the registry is the
 * primitive the session-aware integration uses at the boundary.
 */
import type { NormalizedToolCall } from "../../../core/types";

/** Spec-valid function name: Latin letters/digits/underscores, no leading digit. */
export const V2_FUNCTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Validate a function name against the V2 constraint. Returns an error message
 * or `null` when the name is spec-valid.
 */
export function validateFunctionName(name: string): string | null {
  if (name.length === 0) return "function name must not be empty";
  if (!V2_FUNCTION_NAME_PATTERN.test(name)) {
    return (
      `function name "${name}" must start with a Latin letter and contain only ` +
      "Latin letters, digits and underscores (V2 spec: CustomFunction.name)"
    );
  }
  return null;
}

/** A tool-call reference used for id-based linkage (name resolution). */
export type ToolCallRef = Pick<NormalizedToolCall, "id" | "name">;

/**
 * Session-scoped deterministic alias registry for V2-unsafe function names.
 *
 * - valid names pass through unchanged (no bookkeeping, response names match
 *   request names → minimal reversal work);
 * - invalid names get a deterministic `tool_<n>` alias; reverse lookup is
 *   available via `originalOf`.
 * - instance-scoped: create one per session; nothing lives at module scope.
 */
export class ToolNameRegistry {
  private readonly byOriginal = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private counter = 0;

  /** Normalize a tool name for the V2 wire; deterministic per registry. */
  aliasFor(originalName: string): string {
    const existing = this.byOriginal.get(originalName);
    if (existing !== undefined) return existing;
    if (validateFunctionName(originalName) === null) {
      // Spec-valid: pass through without storing.
      return originalName;
    }
    this.counter += 1;
    const alias = `tool_${this.counter}`;
    this.byOriginal.set(originalName, alias);
    this.byAlias.set(alias, originalName);
    return alias;
  }

  /** Reverse lookup: V2 alias → original name (passthrough when unknown). */
  originalOf(name: string): string {
    return this.byAlias.get(name) ?? name;
  }

  /** Number of aliased (non-passthrough) names tracked in this registry. */
  get size(): number {
    return this.byOriginal.size;
  }
}
