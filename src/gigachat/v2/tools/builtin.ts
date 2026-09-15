/**
 * Builtin-tool registry for the GigaChat V2 boundary (plan §9 "builtin").
 *
 * The V2 spec declares exactly two builtin tools
 * (`docs/external/gigachat-api.yml`: `image_generate`, `model_3d_generate`).
 * Unknown builtin ids raise a controlled error — never a guess. Runtime
 * execution of builtin tools lands in PHASE 7; this module only shapes the
 * wire entries.
 */
import type { V2Tool } from "../types";

export const KNOWN_BUILTIN_TOOLS = ["image_generate", "model_3d_generate"] as const;

export type KnownBuiltinTool = (typeof KNOWN_BUILTIN_TOOLS)[number];

export function isKnownBuiltinTool(id: string): id is KnownBuiltinTool {
  return (KNOWN_BUILTIN_TOOLS as readonly string[]).includes(id);
}

export function toV2BuiltinTool(id: string): V2Tool {
  switch (id) {
    case "image_generate":
      return { image_generate: {} };
    case "model_3d_generate":
      return { model_3d_generate: {} };
    default:
      throw new Error(`unknown builtin tool "${id}" (image_generate|model_3d_generate expected)`);
  }
}
