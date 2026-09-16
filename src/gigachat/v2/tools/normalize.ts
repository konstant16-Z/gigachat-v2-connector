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
import type {
  NormalizedRequest,
  NormalizedResponse,
  NormalizedToolCall,
} from "../../../core/types";

/**
 * Live-verified function name constraint (2026-09-15): "Only Latin letters
 * (A-Z or a-z), underscore (_), hyphen (-), dot (.) and digits (not leading)
 * are allowed." The spec (CustomFunction.name) only says Latin letters with
 * no leading digit; the live rejection of names outside this pattern (422)
 * is the working contract.
 */
export const V2_FUNCTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * Validate a function name against the live V2 constraint. Returns an error
 * message or `null` when the name is valid.
 */
export function validateFunctionName(name: string): string | null {
  if (name.length === 0) return "function name must not be empty";
  if (!V2_FUNCTION_NAME_PATTERN.test(name)) {
    return (
      `function name "${name}" must start with a Latin letter and contain only ` +
      "Latin letters, digits, underscores, hyphens and dots " +
      '(live API: "Only Latin letters (A-Z or a-z), underscore (_), hyphen (-), ' +
      'dot (.) and digits (not leading) are allowed.")'
    );
  }
  return null;
}

/**
 * Pure request-side aliasing: apply a registry to every tool name that will
 * cross the wire — declarations, assistant calls and tool-result names —
 * skipping builtin entries (their ids are fixed at the boundary). Returns a
 * new shallow request; spec-valid names pass through unchanged.
 *
 * Legacy parity (§23): the V1 connector aliased arbitrary OpenAI tool names
 * (e.g. `shell --- workdir /home/user`) via a *global* map; V2 does the same
 * per session through the registry passed by the integration, so no V1 working
 * behavior is lost and nothing lives at module scope (agents.md §14).
 */
export function aliasNamesInRequest(
  request: NormalizedRequest,
  registry: ToolNameRegistry,
): NormalizedRequest {
  const tools = request.tools?.map((tool) => {
    if (tool.builtin !== undefined) return tool;
    const name = registry.aliasFor(tool.name);
    return name === tool.name ? tool : { ...tool, name };
  });
  const messages = request.messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "tool_result" && part.name !== undefined) {
        const name = registry.aliasFor(part.name);
        return name === part.name ? part : { ...part, name };
      }
      return part;
    });
    const toolCalls = message.toolCalls?.map((call) => {
      const name = registry.aliasFor(call.name);
      return name === call.name ? call : { ...call, name };
    });
    return {
      ...message,
      content,
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    };
  });
  return { ...request, tools: tools ?? request.tools, messages };
}

/**
 * Pure response-side restoration: reverse every V2 alias back to the original
 * tool name (legacy `getOriginalToolName` parity, session-scoped). Names that
 * were never aliased pass through unchanged.
 */
export function restoreNamesInResponse(
  response: NormalizedResponse,
  registry: ToolNameRegistry,
): NormalizedResponse {
  const choices = response.choices.map((choice) => {
    const toolCalls = choice.message.toolCalls?.map(
      (call): NormalizedToolCall => ({ ...call, name: registry.originalOf(call.name) }),
    );
    return { ...choice, message: { ...choice.message, toolCalls } };
  });
  return { ...response, choices };
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
