/**
 * Unit tests: builtin tool wire entries (plan §9 "builtin").
 */
import { describe, expect, test } from "bun:test";
import { isKnownBuiltinTool, toV2BuiltinTool } from "../../src/gigachat/v2/tools/builtin";

describe("builtin tools", () => {
  test("known builtins map to keyed V2 entries", () => {
    // P1 builtins, live-verified 2026-09-16 (scripts/probe-builtin-tools.ts)
    expect(toV2BuiltinTool("web_search")).toEqual({ web_search: {} });
    expect(toV2BuiltinTool("url_content_extraction")).toEqual({ url_content_extraction: {} });
    expect(toV2BuiltinTool("image_generate")).toEqual({ image_generate: {} });
    expect(toV2BuiltinTool("model_3d_generate")).toEqual({ model_3d_generate: {} });
    expect(isKnownBuiltinTool("web_search")).toBe(true);
  });

  test("code_interpreter (live 422 unavailable) is not registered → controlled error", () => {
    expect(isKnownBuiltinTool("code_interpreter")).toBe(false);
    expect(() => toV2BuiltinTool("code_interpreter")).toThrow(
      /unknown builtin tool "code_interpreter"/,
    );
  });

  test("unknown builtin id raises a controlled error", () => {
    expect(isKnownBuiltinTool("zzz_not_a_real_tool")).toBe(false);
    expect(() => toV2BuiltinTool("zzz_not_a_real_tool")).toThrow(
      /unknown builtin tool "zzz_not_a_real_tool"/,
    );
  });
});
